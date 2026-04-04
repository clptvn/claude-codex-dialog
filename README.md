# claude-codex-dialog

An MCP server that enables back-and-forth discussions between [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex). Spawns background runners that manage conversation turns, letting the two AI assistants collaboratively analyze problems, review code, and debate solutions.

## Features

- **General Dialog** — Open-ended technical discussions between Claude and Codex about any problem
- **Code Review** — Codex automatically reviews a git diff and discusses findings with Claude, going back and forth on fixes

## How it works

### Dialog mode
1. Claude calls `start_dialog` with a problem description
2. The server spawns a background runner process
3. Claude sends messages via `send_message`, and the runner invokes Codex to respond
4. Claude polls for replies with `check_messages`
5. The conversation continues back and forth until ended or a turn/idle limit is reached

### Code review mode
1. Claude calls `start_code_review` with a project path and branch info
2. The server generates a git diff and spawns a review runner
3. Codex **automatically generates an initial review** from the diff — no first message needed
4. Claude reads the review via `check_messages` and responds with fixes or discussion
5. Back and forth continues until Codex says "LGTM" or the session is ended
6. Review findings are categorized as `[CRITICAL]`, `[SUGGESTION]`, `[QUESTION]`, or `[PRAISE]`

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Codex CLI](https://github.com/openai/codex) installed and available on your PATH (or specify a custom command)

## Install

```bash
git clone https://github.com/clptvn/claude-codex-dialog.git
cd claude-codex-dialog
npm run setup
```

This installs dependencies, registers the MCP server in your Claude Code settings, and installs the `/codex-review-code` and `/codex-review-plan` slash commands globally.

Restart Claude Code after installation to pick up the new MCP server.

To uninstall:
```bash
npm run uninstall
```

## MCP Tools

### Dialog

| Tool | Description |
|------|-------------|
| `start_dialog` | Start a new discussion session with Codex CLI |

### Code Review

| Tool | Description |
|------|-------------|
| `start_code_review` | Start a review session — Codex auto-generates an initial review from the git diff |
| `get_review_summary` | Get review metadata, structured findings, and approval status |

### Shared (work with both dialog and review sessions)

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to Codex in an ongoing session |
| `check_messages` | Poll for new messages from Codex |
| `get_full_history` | Get the complete conversation history |
| `check_partner_alive` | Check if the Codex runner process is still running |
| `end_dialog` | End the session and get the final conversation |
| `list_sessions` | List all dialog and review sessions |

## Usage

### Slash commands

After installation, two slash commands are available in Claude Code:

```
/codex-review-code                    Review uncommitted changes
/codex-review-code staged             Review only staged changes
/codex-review-code branch             Review current branch vs main
/codex-review-code commit:<sha>       Review a specific commit
/codex-review-code staged security    Review staged changes with security focus

/codex-review-plan                    Review an auto-detected plan file
/codex-review-plan path/to/plan.md    Review a specific plan file
```

### Natural language

You can also ask Claude directly:

**Dialog:**
> "Start a dialog with Codex about how to refactor the authentication module"

**Code review:**
> "Have Codex review my changes on this branch"

Claude will use the MCP tools to manage the discussion automatically. Session data is stored in `~/.claude/dialogs/`.

## Configuration

Both runners have sensible defaults. The review runner uses longer timeouts to account for both sides investigating code:

| Setting | Dialog | Review |
|---------|--------|--------|
| Max turns | 50 | 30 |
| Codex timeout per invocation | 5 min | 10 min |
| Idle timeout | 15 min | 30 min |
| Poll interval | 3s | 5s |

These can be adjusted in `src/dialog-runner.mjs` and `src/review-runner.mjs` respectively.

## License

MIT
