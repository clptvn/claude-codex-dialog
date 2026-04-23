---
name: claude-review-spec
description: Use when the user wants Claude Code to adversarially review a feature or product spec from within Codex.
---

# Claude Review Spec

Use this skill when the user wants Claude Code to review a product or feature spec through the `codex-dialog` MCP server.

## Parse the user's invocation

Interpret the invocation text as:

- one optional spec path
- `rounds:N`
- `effort:<level>`
- `model:<name>`

If a spec path is not provided, auto-detect from:

- `docs/specs/*.md`
- `.claude/specs/*.md`
- `specs/*.md`
- `spec*.md`
- `SPEC.md`

If multiple candidates exist, ask the user which one to review.
If none exist, ask the user for the path.

Read the spec file before continuing.
Abort if the file is empty or is not markdown.

## Start the dialog

Determine the git root and call `mcp__codex-dialog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if explicitly requested
- `reasoning_effort` only if explicitly requested
- `model` only if explicitly requested
- `problem_description`: a short summary such as `Feature spec review for <path>. Claude Code will adversarially review ambiguity, gaps, and testability.`

Save the returned `session_id`.

## Kick off the review

Send the first message with `mcp__codex-dialog__send_message`. Use this structure:

```text
## Spec Review Request

ADVERSARIAL SPEC REVIEW MODE: Your default assumption is that this spec has gaps, ambiguous requirements, untestable acceptance criteria, or flows that break at the edges. A coding agent could implement directly from this document, so any ambiguity matters.

Read the actual codebase to verify claimed integration points or existing patterns. Do not trust the spec's claims about current behavior without checking.

Deliver complete feedback in each round. Do not hold findings back for later rounds.

Review dimensions:
- Completeness
- Clarity / ambiguity
- Testability
- Scope hygiene
- Data-model coherence
- UX soundness
- Feasibility sanity check
- Alignment to user stories

Categorize findings as:
- [GAP]
- [AMBIGUITY]
- [SCOPE]
- [FEASIBILITY]
- [UX]
- [TESTABILITY]
- [SUGGESTION]
- [QUESTION]
- [PRAISE]
- [NIT]

At the end, give one verdict:
- APPROVE
- NEEDS_DISCUSSION
- MAJOR_CONCERNS

<spec>
[FULL SPEC CONTENT]
</spec>
```

## Wait for Claude

Prefer waiting on the session file with a shell tail if available. Otherwise poll `mcp__codex-dialog__check_messages` every 5 seconds.

If Claude does not answer:

1. Call `mcp__codex-dialog__check_partner_alive`
2. If the runner died, stop and report it
3. Inspect `last_error`

## Discussion loop

For each Claude finding:

1. Read the relevant spec text and any referenced code.
2. Decide whether you agree, partially agree, or disagree.
3. If valid, update the spec file and explain exactly what changed.
4. If invalid, rebut it with evidence from the spec or codebase.
5. Send one consolidated reply per round.

If Claude is drip-feeding, explicitly ask for the complete remaining set of concerns.

If the same disagreement persists across 2+ rounds, summarize both positions and ask the user to decide.

## Completion

When Claude says `APPROVE`, or the hard cap is reached:

1. Summarize the outcome, file path, rounds used, and session id
2. Call `mcp__codex-dialog__end_dialog`

Do not say the spec is approved unless Claude actually said `APPROVE`.
