---
name: claude-review-code
description: Use when the user wants Claude Code to review code changes from within Codex, including uncommitted, staged, branch, or commit-based diffs.
---

# Claude Review Code

Use this skill when the user wants Claude Code to review code changes through the `codex-dialog` MCP server.

## Parse the user's invocation

Interpret the user's invocation text as:

- `diff_target`: `uncommitted` (default), `staged`, `branch`, or `commit:<sha>`
- `review_focus`: any remaining free text after stripping control tokens
- `rounds:N`: optional soft round budget override
- `effort:<level>`: optional Claude effort override. Valid levels are `low`, `medium`, `high`, `max`, and model-specific `xhigh`.
- `model:<name>`: optional Claude model override. Valid models are `claude-sonnet-4-6`, `claude-opus-4-6[1m]`, `claude-opus-4-7[1m]`, `claude-opus-4-8`, and `claude-opus-4-8[1m]`.
- `timeout:<minutes>` or `timeout:<minutes>m`: optional partner invocation timeout override, in minutes.

If no diff target is provided, use `uncommitted`.

Model and effort rules:

- `claude-sonnet-4-6`: accepts `low`, `medium`, `high`, `max`
- `claude-opus-4-6[1m]`: accepts `low`, `medium`, `high`, `max`
- `claude-opus-4-7[1m]`: accepts `low`, `medium`, `high`, `xhigh`, `max`
- `claude-opus-4-8`: accepts `low`, `medium`, `high`, `max`
- `claude-opus-4-8[1m]`: accepts `low`, `medium`, `high`, `xhigh`, `max`

If `model:<name>` is provided and is not one of the valid models above, stop and report the accepted model values.
If `effort:<level>` is provided and is not valid for the selected model, stop and report the accepted effort values for that model.
If `effort:xhigh` is provided without `model:claude-opus-4-7[1m]` or `model:claude-opus-4-8[1m]`, stop and explain that `xhigh` is only valid with `claude-opus-4-7[1m]` or `claude-opus-4-8[1m]`.
If `effort:max` is provided and no `timeout:*` override is provided, set `partner_timeout_ms: 1800000` so max-effort Opus runs have 30 minutes instead of the default 15.
If `timeout:*` is provided, convert minutes to milliseconds and pass `partner_timeout_ms`. Accepted server range is 1 to 60 minutes.

## Start the review

Determine the git root first. Use that as `project_path`.

Call `mcp__codex-dialog__start_code_review` with:

- `project_path`
- `diff_target`
- `review_focus`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if the user explicitly provided `rounds:N`
- `reasoning_effort` only if the user explicitly provided a valid `effort:<level>` for the selected model
- `model` only if the user explicitly provided a valid `model:<name>`
- `partner_timeout_ms` if the user explicitly provided `timeout:*`, or if `effort:max` was provided and no timeout override was provided

Always prepend this adversarial framing to `review_focus`:

```text
ADVERSARIAL REVIEW MODE: Your default assumption is that something is wrong, missing, or subtly broken in this code. You are not looking to confirm it works — you are looking to find what does not. Only accept something as correct once you have actively tried to break it and failed. For every function, ask: "What input would make this fail? What state would make this behave unexpectedly? What was the author probably not thinking about?" Check edge cases, error paths, concurrency, resource cleanup, and implicit assumptions. If you cannot find a flaw, explain what you checked and why you believe it holds — do not simply say it looks fine.

FEEDBACK FRAMING: Present findings as direct technical observations and open questions, not urgent demands. If you genuinely find nothing wrong after thorough investigation, say so clearly.
```

Save the returned `session_id`.

## Wait for Claude's review

Claude generates the initial review automatically.

Preferred wait strategy:

1. Call `mcp__codex-dialog__wait_for_partner_response` with `session_id` and `since_id: 0`. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.
2. If the wait tool is not exposed in the current session, fall back to tailing the session's `conversation.jsonl` until a partner message lands.
3. If neither wait tool nor shell tail is available, poll `mcp__codex-dialog__check_messages` every 5 seconds.

After every later `send_message`, call `mcp__codex-dialog__wait_for_partner_response` with `since_id` set to the returned `message_id`. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.

If `wait_result` is `timeout_processing` or `timeout_idle`:

1. Call `mcp__codex-dialog__check_partner_alive`
2. If the runner died, stop and report the error honestly
3. Inspect `last_error` from the tool response before deciding what to do next

## Discussion loop

For each Claude finding:

1. Read the actual code Claude referenced.
2. Decide whether the finding is valid, partially valid, or invalid.
3. If valid, fix the issue in code before replying.
4. If invalid, push back with file-level evidence.
5. Send one consolidated reply with `mcp__codex-dialog__send_message`.

Keep the discussion efficient:

- Bundle all fixes, disagreements, and answers into one message per round.
- If Claude appears to be drip-feeding findings, explicitly ask for the full remaining set in the next message.
- If the same disagreement persists across 2+ rounds, summarize both positions and ask the user to arbitrate.

## Completion

When `review_status.approved` is true in `check_messages` / `get_review_summary`, or the hard cap is reached:

1. Call `mcp__codex-dialog__get_review_summary`
2. Report the verdict from `review_status`, rounds used, and session id
3. Call `mcp__codex-dialog__end_dialog`

Do not claim approval unless the MCP `review_status.approved` field is true.
