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
- `effort:<level>`: optional Claude effort override
- `model:<name>`: optional Claude model override

If no diff target is provided, use `uncommitted`.

## Start the review

Determine the git root first. Use that as `project_path`.

Call `mcp__codex-dialog__start_code_review` with:

- `project_path`
- `diff_target`
- `review_focus`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if the user explicitly provided `rounds:N`
- `reasoning_effort` only if the user explicitly provided `effort:<level>`
- `model` only if the user explicitly provided `model:<name>`

Always prepend this adversarial framing to `review_focus`:

```text
ADVERSARIAL REVIEW MODE: Your default assumption is that something is wrong, missing, or subtly broken in this code. You are not looking to confirm it works — you are looking to find what does not. Only accept something as correct once you have actively tried to break it and failed. For every function, ask: "What input would make this fail? What state would make this behave unexpectedly? What was the author probably not thinking about?" Check edge cases, error paths, concurrency, resource cleanup, and implicit assumptions. If you cannot find a flaw, explain what you checked and why you believe it holds — do not simply say it looks fine.

FEEDBACK FRAMING: Present findings as direct technical observations and open questions, not urgent demands. If you genuinely find nothing wrong after thorough investigation, say so clearly.
```

Save the returned `session_id`.

## Wait for Claude's review

Claude generates the initial review automatically.

Preferred wait strategy:

1. If a shell tool is available, tail the session's `conversation.jsonl` until a partner message lands.
2. Otherwise poll `mcp__codex-dialog__check_messages` every 5 seconds.

If there is no reply within a reasonable window:

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

When Claude says `LGTM`, or the hard cap is reached:

1. Call `mcp__codex-dialog__get_review_summary`
2. Report the verdict, rounds used, and session id
3. Call `mcp__codex-dialog__end_dialog`

Do not claim approval unless Claude actually said `LGTM`.
