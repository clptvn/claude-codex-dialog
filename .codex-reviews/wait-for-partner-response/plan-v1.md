# Plan: MCP wait_for_partner_response Tool

## Goal

Add a first-class MCP wait tool for codex-dialog sessions so the host agent can block until the partner replies, a session terminal condition occurs, or a long timeout expires. This should replace repeated `check_messages` / `check_partner_alive` polling in Codex skills while preserving the existing file-backed runner architecture.

## Current Behavior

- `start_dialog` and `start_code_review` create session directories under `~/.claude/dialogs/<session_id>`.
- Session conversation state is appended to `conversation.jsonl` through `appendMessage`.
- Dialog and review runners create `partner_processing`, invoke the partner CLI, append partner or system messages, then remove the processing marker.
- `check_messages` reads `conversation.jsonl`, `status.json`, `last_error.txt`, processing markers, budget, review status, and referenced files.
- `check_partner_alive` duplicates some status logic and reports runner liveness plus recent log tail.
- Codex skills currently prefer shell `tail -F` on `conversation.jsonl`, falling back to polling `check_messages` every 5 seconds.
- Partner CLI invocations time out after 15 minutes in both `dialog-runner.mjs` and `review-runner.mjs`.

## Desired Behavior

Add a shared MCP tool:

```text
wait_for_partner_response(session_id, since_id?, timeout_ms?, include_system?)
```

Default behavior:

- `timeout_ms`: 10 minutes.
- Explicit waits are clamped to the session's `partner_timeout_ms` minus 1 minute, with an absolute max of 60 minutes.
- `include_system`: true by default.
- Return immediately if there is already a partner message, or a system message when `include_system` is true, with `id > since_id`.
- Otherwise wait until one of these conditions occurs:
  - partner message appended to `conversation.jsonl`
  - system message appended when `include_system` is true
  - `last_error.txt` appears or changes
  - runner process exits
  - `end_signal` appears
  - hard cap is reached in the conversation
  - timeout expires
  - caller cancels the MCP request

The response should include the same operational payload as `check_messages`, plus:

- `wait_result`: `message`, `error`, `runner_exited`, `ended`, `hard_cap`, `timeout_processing`, `timeout_idle`, or `cancelled`
- `waited_ms`
- `timed_out`
- `next_since_id`: the latest message ID in the full conversation, matching the `latest_id` field. Callers should pass this value as the next `since_id`.

When multiple terminal conditions are true in the same check, classify `wait_result` using this priority:

1. `cancelled`
2. `error`
3. `ended`
4. `hard_cap`
5. `runner_exited`
6. `message`
7. `timeout_processing` or `timeout_idle`

The wake filter and response payload are different:

- Wake detection only considers partner messages, plus system messages when `include_system` is true.
- The returned `new_messages` field keeps exact `check_messages` semantics and includes all messages with `id > since_id`, including host messages.
- `referenced_files` remains based on the returned `new_messages`, as it is today.

## Implementation Steps

1. Factor `check_messages` response construction into a helper in `src/dialog-server.mjs`.
   - Suggested helper: `buildSessionSnapshot(sessionId, { sinceId })`.
   - Return `{ payload, internal }`, not a JSON string.
   - `payload` contains exactly the current `check_messages` public fields:
     - `new_messages`
     - `total_messages`
     - `latest_id`
     - `host_agent`
     - `partner_agent`
     - `partner_runner_alive`
     - `partner_currently_processing`
     - conditional legacy `codex_runner_alive` / `codex_currently_processing`
     - `last_error`
     - `budget`
     - `review_status`
     - `referenced_files`
   - `internal` contains values needed by the wait tool, for example `messages`, `status`, `sessionDir`, and `processingPath`.
   - `check_messages` must serialize only `snapshot.payload`; it must not accidentally include `internal`.
   - Preserve existing `check_messages` JSON fields exactly to avoid breaking clients.

2. Add helper functions in `src/dialog-server.mjs`.
   - `getLatestMessageId(messages)`
   - `getWakeMessages(messages, status, sinceId, includeSystem)`
     - Derive `partnerAgent` with `getSessionPartnerAgent(status)`.
     - Match `m.from === partnerAgent || (includeSystem && m.from === "system")`.
   - `hasHardCapReached(snapshot)`, implemented by reusing `snapshot.review_status.hard_cap_reached` and/or `snapshot.budget.hard_rounds_remaining === 0`, not by duplicating review-status parsing.

3. Implement `waitForSessionChange`.
   - Set up watchers before the first snapshot read, then read the snapshot and return immediately if wake messages already exist. This avoids a race where a partner response lands between an initial read and watcher setup.
   - Always try to watch the session directory, because terminal files such as `last_error.txt` and `end_signal` are often created after the wait starts.
   - Watch `conversation.jsonl` directly. It should always exist for valid sessions because session creation writes it as an empty file.
   - Watch `last_error.txt` and `end_signal` directly only if they already exist.
   - Wrap every `fs.watch` call in try/catch; any missing file or watcher failure degrades that path to polling only.
   - If every watcher setup fails, continue in polling-only mode.
   - Run a fallback interval every 5 seconds so missed filesystem events do not hang the request.
   - Every loop checks runner liveness and terminal files.
   - Clean up every watcher, timer, and abort listener on every exit path.
   - Use `extra.signal` from the MCP tool callback to detect caller cancellation.
   - Classify timeout as `timeout_processing` when `partner_currently_processing` is true at timeout, otherwise `timeout_idle`.

4. Add progress notifications / heartbeats when the client supplies a progress token.
   - Inspect `extra._meta?.progressToken`.
   - Every 25-30 seconds, call `extra.sendNotification` with:
     - `method: "notifications/progress"`
     - `params.progressToken`: the incoming token
     - `params.progress`: elapsed milliseconds or elapsed seconds
     - `params.total`: timeout value in the same unit
     - `params.message`: concise status, for example `Waiting for Claude response, 180s elapsed`
   - Ignore notification send errors so a client without progress support does not break the wait.

5. Register `wait_for_partner_response` after `check_messages`.
   - Inputs:
     - `session_id: string`
     - `since_id?: number`
     - `timeout_ms?: number` with min 1000 and a dynamic cap of `partner_timeout_ms - 60000`, absolute max 3600000
     - `include_system?: boolean`
   - Tool description should clearly say it is a long-poll wait and may remain open for up to 10 minutes by default.
   - Return the same JSON string style as existing tools.
   - Use the two-argument tool callback form, `async (args, extra) => { ... }`, because this is the first tool in the file that needs `extra.signal`, `extra._meta`, and `extra.sendNotification`.

6. Update documentation and Codex skills.
   - README shared tools table adds `wait_for_partner_response`.
   - Usage docs explain the preferred wait flow:
     - after `start_code_review`, call `wait_for_partner_response(session_id, since_id: 0)`
     - after `send_message`, call `wait_for_partner_response(session_id, since_id: message_id)`
   - Update Codex skill files that currently recommend `tail -F` or 5-second polling:
     - `codex-skills/claude-review-code/SKILL.md`
     - `codex-skills/claude-review-plan/SKILL.md`
     - `codex-skills/claude-review-spec/SKILL.md`
     - `codex-skills/claude-audit/SKILL.md`
     - `codex-skills/claude-ui-implementer/SKILL.md`
   - Keep shell tail as an optional fallback only if the wait tool is not exposed.

7. Validate.
   - There is no `npm test` script currently, so run `node --check` against changed `.mjs` files.
   - Add a small smoke script, for example `scripts/smoke-wait-tool.mjs`, that spawns the MCP server over stdio with the TypeScript SDK client and creates fixture session directories under `~/.claude/dialogs`.
   - The smoke script should validate:
     - immediate return when a message already exists after `since_id`
     - wake path where the script starts a wait with `timeout_ms: 5000`, then appends a partner message after a short delay
     - timeout path with a short `timeout_ms`
     - timeout path without a progress token, confirming missing progress metadata does not crash the wait
     - error path when `last_error.txt` exists
     - runner-exited path when status has a dead PID
   - Validate the practical client timeout separately in the current Codex session after implementation:
     - call `wait_for_partner_response` with `timeout_ms` greater than 60 seconds and append a fixture partner message after roughly 65 seconds
     - if the client cancels before the event, document the observed limit and adjust skill guidance to use repeated waits below the client limit
     - do not claim a 10-minute wait works in Codex unless a long wait or equivalent progress-heartbeat test confirms the client keeps the tool call open
   - Start a short real dialog with `partner_agent: "claude"` only if practical and low-risk after fixture validation passes.

## Risks And Mitigations

- Client-side MCP timeout may still interrupt long requests.
  - Mitigation: default the server-side tool to 10 minutes as requested, emit progress every 25-30 seconds when a progress token exists, cleanly handle cancellation, and validate the current Codex client behavior before documenting the flow as a confirmed 10-minute wait.
- `fs.watch` behavior varies by platform and can miss events.
  - Mitigation: keep a 5-second fallback interval and allow polling-only mode if watcher setup fails.
- Waiting for any new message could wake on the host's own message.
  - Mitigation: filter wake messages to partner messages and optional system messages only, while preserving all-message `new_messages` response semantics.
- The conversation file may be updated while a lock exists.
  - Mitigation: use the existing `readConversation` parser and retry through the fallback interval; do not read partial lines as valid messages.
- Multiple simultaneous waiters may watch the same session.
  - Mitigation: keep waiters independent and read-only; avoid writing any wait state files.

## Follow-up Extension

The implemented server also supports a configurable per-partner invocation timeout:

- `start_dialog` and `start_code_review` accept `partner_timeout_ms`.
- Default partner timeout remains 15 minutes.
- Maximum partner timeout is 60 minutes.
- Codex skills should use `partner_timeout_ms: 1800000` for explicit `effort:max` Claude runs unless the user supplied a different `timeout:*` control.

## Non-goals

- Do not replace the background runner polling loop in `dialog-runner.mjs` or `review-runner.mjs`.
- Do not introduce a new transport or daemon.
- Do not depend on MCP resource subscriptions, since client support is less certain than a regular tool call.
- Do not change `check_messages` or `check_partner_alive` response compatibility.
