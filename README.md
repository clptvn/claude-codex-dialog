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
5. The review continues until the partner says `LGTM` or the session is ended

Session data is stored under `~/.claude/dialogs/`.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on your `PATH` if you want Claude-hosted commands or Claude as a review partner
- [Codex CLI](https://github.com/openai/codex) on your `PATH` if you want Codex-hosted skills or Codex as a review partner

For the full bidirectional install, both CLIs should be available.

## Install

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
./install.sh --claude
./install.sh --codex
./install.sh --both
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
| `get_review_summary` | Get review metadata, structured findings, and approval status |

### Shared

| Tool | Description |
|------|-------------|
| `send_message` | Send a message from the host agent into an ongoing session |
| `check_messages` | Read new partner messages and current runner status |
| `get_full_history` | Get the complete conversation history |
| `check_partner_alive` | Check whether the partner runner process is still running |
| `end_dialog` | End the session and return the final conversation |
| `list_sessions` | List all dialog and review sessions |

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

`start_dialog` also accepts:

- `tool_profile`: `read` by default. Use `implementation` only when the partner should edit files, such as the `/claude-ui-implementer` Codex skill.
- `subject_path`: optional path to a reviewed document, such as a plan or spec. The dialog runner rereads this file before every partner turn and includes the current contents as authoritative context.
- `subject_kind`: optional label for `subject_path`: `plan`, `spec`, or `document`.

The server still accepts `codex_command` for backward compatibility, and also accepts `claude_command` when Claude is the configured partner.

## Round budget

Each session has a soft round budget, default `5`, with a hard cap of `soft + 5`.

Every `check_messages`, `send_message`, and `check_partner_alive` response includes:

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
