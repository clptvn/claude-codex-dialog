# claude-codex-dialog

A bidirectional MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex). It runs background review/dialog runners so either tool can host the conversation while the other acts as the reviewing partner.

## Features

- **Bidirectional host support** — Claude can host Codex reviews, or Codex can host Claude reviews
- **General Dialog** — open-ended technical discussions between the two agents
- **Code Review** — the partner agent auto-generates an initial review from a git diff
- **Plan Review** — adversarial review of implementation plans before code is written
- **Spec Review** — adversarial review of product/feature specs before planning or implementation
- **Code Audit** — deep audits of existing files for bugs, architecture issues, robustness, and security
- **UI implementation partnership** — Codex can delegate frontend/UI implementation to Claude Opus 4.7 while Codex owns backend/API/data integration
- **Claude-only enforcement hooks** — optional guardrails on the Claude side; no equivalent Codex hooks are installed

## How it works

### Dialog mode
1. The host agent calls `start_dialog`
2. The server spawns a background runner for the configured partner agent
3. The host sends messages with `send_message`
4. The runner invokes the partner CLI and appends replies to `conversation.jsonl`
5. The conversation continues until ended, idle timeout, or hard round cap

### Code review mode
1. The host agent calls `start_code_review`
2. The server generates a git diff and spawns a review runner
3. The partner agent auto-generates an initial review from the diff
4. The host reads findings via `check_messages`, investigates, fixes or rebuts, and replies with `send_message`
5. The review continues until MCP responses report `review_status.approved: true`, the hard cap is reached, or the session is ended

Session data is stored under `~/.claude/dialogs/`.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on your `PATH` if you want Claude-hosted commands or Claude as a review partner
- [Codex CLI](https://github.com/openai/codex) on your `PATH` if you want Codex-hosted skills or Codex as a review partner

For the full bidirectional install, both CLIs should be available.

Native Windows, macOS/Linux, and WSL are supported. On Windows, PowerShell may block npm's `.ps1` shims under the current execution policy; the server and installer use Windows-compatible command resolution so the npm `.cmd` shims still work.

## Install

macOS, Linux, WSL, Git Bash, or Windows PowerShell:

```bash
git clone https://github.com/clptvn/claude-codex-dialog.git
cd claude-codex-dialog
npm run setup
```

Default install mode is `--both`, which does all of the following:

- registers the MCP server for Claude
- installs Claude slash commands:
  - `/codex-review-code`
  - `/codex-review-plan`
  - `/codex-review-spec`
  - `/codex-audit`
- installs Claude-only investigation hooks
- registers the MCP server for Codex
- installs Codex skills:
  - `/claude-review-code`
  - `/claude-review-plan`
  - `/claude-review-spec`
  - `/claude-audit`
  - `/claude-ui-implementer`

You can also install only one side:

```bash
npm run setup -- --claude
npm run setup -- --codex
npm run setup -- --both
```

POSIX shell wrappers are still available:

```bash
./install.sh --claude
./install.sh --codex
./install.sh --both
```

PowerShell wrappers are also available:

```powershell
.\install.ps1 -Claude
.\install.ps1 -Codex
.\install.ps1 -Both
```

To uninstall:

```bash
npm run uninstall
```

Or remove only one side:

```bash
./uninstall.sh --claude
./uninstall.sh --codex
./uninstall.sh --both
```

Or in PowerShell:

```powershell
.\uninstall.ps1 -Claude
.\uninstall.ps1 -Codex
.\uninstall.ps1 -Both
```

Restart the relevant CLI after installation or uninstall so it reloads MCP config and commands/skills.

## MCP Tools

### Dialog

| Tool | Description |
|------|-------------|
| `start_dialog` | Start a new dialog session with a configurable host/partner agent pair |

### Code Review

| Tool | Description |
|------|-------------|
| `start_code_review` | Start a review session where the configured partner auto-generates an initial review from a git diff |
| `get_review_summary` | Get review metadata, structured findings, and `review_status` approval state |

### Shared

| Tool | Description |
|------|-------------|
| `send_message` | Send a message from the host agent into an ongoing session |
| `check_messages` | Read new partner messages, current runner status, and parsed `review_status` |
| `wait_for_partner_response` | Long-poll until the partner replies, the session reaches a terminal condition, or the wait times out |
| `get_full_history` | Get the complete conversation history |
| `check_partner_alive` | Check whether the partner runner process is still running |
| `end_dialog` | End the session and return the final conversation |
| `list_sessions` | List all dialog and review sessions |

`review_status` uses closed enum values:

- `state`: `approved`, `changes_requested`, `needs_discussion`, `in_progress`, `hard_cap_reached`
- `verdict`: `APPROVE`, `CHANGES_REQUESTED`, `NEEDS_DISCUSSION`, `IN_PROGRESS`, `HARD_CAP_REACHED`, or `null`
- `source`: `structured_verdict`, `legacy_lgtm`, `legacy_approve`, `blocking_findings`, `hard_cap`, `none`
- `close_allowed_reason`: `approved`, `hard_cap`, or `null`
- Always-present fields: `schema_version`, `state`, `approved`, `close_allowed`, `close_allowed_reason`, `verdict`, `source`, `source_message_id`, `partner_agent`, `allows_approve_verdict`, and `hard_cap_reached`

### Waiting for partner responses

Use `wait_for_partner_response` instead of repeatedly polling while the background runner is invoking the partner CLI.

- After `start_code_review`, call `wait_for_partner_response` with `since_id: 0` to wait for the initial review.
- After `send_message`, call `wait_for_partner_response` with `since_id` set to the returned `message_id`.
- The default wait timeout is 10 minutes. Explicit waits are clamped to the session's `partner_timeout_ms` minus 1 minute, with an absolute max of 60 minutes.
- The tool returns the same public payload as `check_messages`, plus `wait_result`, `waited_ms`, `timed_out`, and `next_since_id`.
- `wait_result` is one of `message`, `error`, `runner_exited`, `ended`, `hard_cap`, `timeout_processing`, `timeout_idle`, or `cancelled`.

## Usage

### In Claude Code

After Claude-side install:

```text
/codex-review-code
/codex-review-code staged security
/codex-review-plan path/to/plan.md
/codex-review-spec docs/specs/foo.md
/codex-audit src/
```

### In Codex

After Codex-side install:

```text
/claude-review-code
/claude-review-code staged security
/claude-review-plan path/to/plan.md
/claude-review-spec docs/specs/foo.md
/claude-audit src/
/claude-ui-implementer implement the settings billing UI
```

## Configuration

Defaults preserve the original flow:

- `host_agent` defaults to `claude`
- `partner_agent` defaults to `codex`
- `partner_command` defaults based on `partner_agent`

To invert the flow, set:

- `host_agent: "codex"`
- `partner_agent: "claude"`

Both `start_dialog` and `start_code_review` also accept:

- `partner_command`
- `model`
- `reasoning_effort`
- `max_rounds`
- `partner_timeout_ms`: maximum time for each partner CLI invocation. Defaults to `900000` (15 minutes) and accepts up to `3600000` (60 minutes). Use `1800000` for 30 minute max-effort Claude runs.

`start_dialog` also accepts:

- `tool_profile`: `read` by default. Use `implementation` only when the partner should edit files, such as the `/claude-ui-implementer` Codex skill.
- `subject_path`: optional path to a reviewed document, such as a plan or spec. The dialog runner rereads this file before every partner turn and includes the current contents as authoritative context.
- `subject_kind`: optional label for `subject_path`: `plan`, `spec`, or `document`.

The server still accepts `codex_command` for backward compatibility, and also accepts `claude_command` when Claude is the configured partner.

## Round budget

Each session has a soft round budget, default `5`, with a hard cap of `soft + 5`.

Every `check_messages`, `wait_for_partner_response`, `send_message`, and `check_partner_alive` response includes:

```json
{
  "max_rounds": 5,
  "hard_cap": 10,
  "rounds_used": 2,
  "rounds_remaining": 3,
  "hard_rounds_remaining": 8,
  "past_soft_cap": false
}
```

The runners explicitly instruct the partner agent to deliver complete feedback each round instead of drip-feeding findings.

## Hooks

The investigation-enforcement hooks are installed only for Claude-hosted flows. They are intentionally not installed for Codex-hosted flows.

## License

MIT
