---
name: claude-ui-implementer
description: Use when the user wants Codex to partner with Claude Opus 4.7 on frontend/UI implementation while Codex owns backend, data, API, and integration work. Starts an editable codex-dialog session with Claude as the frontend implementation partner, then coordinates the frontend/backend handoff until the feature is integrated.
---

# Claude UI Implementer

Use this skill when a user asks to build or modify a feature that has meaningful UI/frontend work and wants Claude to implement that UI through the `codex-dialog` MCP server.

Codex remains the host, integrator, and final verifier. Claude owns frontend/UI implementation.

## Preconditions

Before starting, confirm the `codex-dialog` MCP tools are available. If `mcp__codex-dialog__start_dialog` is not exposed in the current session, report that exact blocker and stop; do not pretend the collaboration is running.

## Parse the user's request

Interpret the invocation text as the feature request plus optional controls:

- `rounds:N`: optional soft round budget override
- `model:<name>`: optional Claude model override
- `effort:<level>`: optional Claude effort override

Defaults for this skill:

- `model`: `claude-opus-4-7`
- `reasoning_effort`: `xhigh`
- `tool_profile`: `implementation`

Only override the default model or effort if the user explicitly provided `model:*` or `effort:*`.

## Split the work

Determine the git root first and use it as `project_path`.

Inspect enough of the codebase to identify:

- frontend routes/components/styles/client state Claude should own
- backend/API/data/domain/test work Codex should own
- shared types, API contracts, schemas, or fixtures that require coordination
- validation commands likely needed for this repo

Create a concise ownership contract:

- **Claude owns:** frontend/UI files and client-side behavior.
- **Codex owns:** backend services, server actions/API routes, database/schema work, auth/security, tests, and final integration.
- **Shared boundary:** types, API response shapes, form contracts, and routing conventions. Claude may read and use these, but should ask before changing backend-owned files.

Do not send Claude a vague assignment. Give it concrete files or search targets when possible.

## Start Claude

Call `mcp__codex-dialog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `model: "claude-opus-4-7"` unless overridden
- `reasoning_effort: "xhigh"` unless overridden
- `tool_profile: "implementation"`
- `max_rounds` only if the user provided `rounds:N`
- `problem_description`: `Frontend implementation collaboration for: <short feature summary>. Claude owns UI/frontend implementation; Codex owns backend/API/data/integration and final verification.`

Save the returned `session_id`.

## First message to Claude

Send one `mcp__codex-dialog__send_message` with this structure:

```text
## UI Implementation Request

You are Claude Opus 4.7 working as the frontend/UI implementation partner. You may edit files, but keep edits scoped to the frontend/UI ownership described below.

### User Feature Request
[raw or summarized user request]

### Ownership
Claude owns:
- [frontend routes/components/styles/client state]

Codex owns:
- [backend/API/data/domain/test/integration work]

Shared boundary:
- [types/contracts/routes/props/API shapes that both sides must preserve]

### Frontend Task
[specific UI work Claude should implement]

### Existing Conventions To Follow
[design system, component library, routing/state patterns, relevant files]

### Constraints
- Implement the UI for real; do not leave TODOs, stubs, mock-only behavior, or placeholder wiring.
- Use existing project conventions and components.
- Do not rewrite backend, database, auth, billing, or infrastructure code.
- If you need a backend/API/type change, describe the requested contract instead of making broad backend edits.
- Keep the changed file set focused.
- After editing, summarize what changed, list changed files, and call out any integration needs or blockers.

### Expected Response
- Changed files
- Implementation summary
- Backend/API contract needed from Codex, if any
- Validation attempted and results
```

## Work in parallel

After sending the first message, immediately work on the Codex-owned backend/API/data/test side. Avoid editing the frontend files assigned to Claude while Claude is running.

Prefer waiting on the session file instead of repeated polling when practical:

```bash
tail -F -n 0 "$HOME/.claude/dialogs/<SESSION_ID>/conversation.jsonl" 2>/dev/null | grep -m 1 --line-buffered -E '"from":"(claude|system)"'
```

Then call `mcp__codex-dialog__check_messages` to read Claude's response.

If Claude does not answer:

1. Call `mcp__codex-dialog__check_partner_alive`.
2. If the runner died, inspect `last_error` and report it honestly.
3. Do not continue as if Claude completed the UI work.

## Integration loop

For each Claude response:

1. Read the files Claude changed before making any assumptions.
2. Check whether Claude stayed inside the frontend ownership boundary.
3. Integrate backend/API/type contract changes on the Codex side.
4. Resolve merge or wiring issues directly.
5. Run the relevant validation commands for the repo.
6. If validation exposes UI/frontend issues, send one consolidated message to Claude with the error output, file paths, and expected fix.

Keep each follow-up consolidated. One message should include all backend contract updates, validation failures, and UX concerns for that round.

If Claude touched backend-owned files unnecessarily, inspect the diff and either keep narrow valid integration edits or revert only edits you can verify came from this Claude session. Never revert unrelated user changes.

## Completion

Finish only when:

- Claude's frontend work is present in the working tree
- Codex has connected backend/API/data pieces as needed
- shared contracts are consistent
- validation has run or you can state exactly why it could not run
- no important unresolved Claude blockers remain

Before ending:

1. Call `mcp__codex-dialog__get_full_history` if you need the full collaboration record.
2. Call `mcp__codex-dialog__end_dialog`.
3. Report the session id, Claude-changed files, Codex-changed files, and validation results.
