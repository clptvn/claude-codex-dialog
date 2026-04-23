---
name: claude-review-plan
description: Use when the user wants Claude Code to adversarially review an implementation plan from within Codex.
---

# Claude Review Plan

Use this skill when the user wants Claude Code to review an implementation plan through the `codex-dialog` MCP server.

## Parse the user's invocation

Interpret the invocation text as:

- one optional plan path
- `rounds:N`
- `effort:<level>`
- `model:<name>`

If a plan path is not provided, auto-detect from:

- `.codex-reviews/*/plan-v*.md`
- `plan*.md`
- `PLAN.md`
- `.claude/plan*.md`

If multiple candidates exist, ask the user which one to review.
If none exist, ask the user for the path.

Read the plan file before starting the dialog.

## Start the dialog

Determine the git root and call `mcp__codex-dialog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if explicitly requested
- `reasoning_effort` only if explicitly requested
- `model` only if explicitly requested
- `problem_description`: a short summary such as `Implementation plan review for <path>. Claude Code will adversarially review feasibility, ordering, and completeness.`

Save the returned `session_id`.

## Kick off the review

Send the first message with `mcp__codex-dialog__send_message`. Use this structure:

```text
## Plan Review Request

ADVERSARIAL REVIEW MODE: Your default assumption is that this plan has gaps, incorrect assumptions, or hidden dependencies. You are not here to confirm the plan is good — you are here to find what is wrong with it. Read the actual codebase to verify claims. Do not trust the plan's description of current behavior without checking.

Deliver complete feedback in each round. Do not hold findings back for later rounds.

Review dimensions:
- Feasibility
- Completeness
- Correctness
- Risk
- Alternatives
- Ordering

Categorize findings as:
- [CRITICAL]
- [SUGGESTION]
- [QUESTION]
- [PRAISE]
- [NIT]

At the end, give one verdict:
- APPROVE
- NEEDS_DISCUSSION
- MAJOR_CONCERNS

<plan>
[FULL PLAN CONTENT]
</plan>
```

## Wait for Claude

Prefer waiting on the session file with a shell tail if available. Otherwise poll `mcp__codex-dialog__check_messages` every 5 seconds.

If Claude does not answer:

1. Call `mcp__codex-dialog__check_partner_alive`
2. If the runner died, report that and stop
3. Inspect `last_error` before restarting or abandoning the session

## Discussion loop

For each Claude finding:

1. Read the relevant code and the relevant part of the plan.
2. Decide whether you agree, partially agree, or disagree.
3. If the finding is valid, edit the plan file and explain what changed.
4. If invalid, rebut it with concrete evidence from the codebase or the plan text.
5. Send one consolidated response per round.

If Claude hints at drip-feeding, explicitly ask for all remaining concerns in the next reply.

If the same disagreement persists across 2+ rounds, summarize both positions and ask the user to decide.

## Completion

When Claude says `APPROVE`, or the hard cap is reached:

1. Summarize the outcome, path, rounds used, and session id
2. Call `mcp__codex-dialog__end_dialog`

Do not call it approved unless Claude actually used `APPROVE`.
