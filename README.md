# claude-codex-dialog

An MCP server that enables back-and-forth discussions between [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex). Spawns a background runner that manages conversation turns, letting the two AI assistants collaboratively analyze problems, review code, and debate solutions.

## How it works

1. Claude Code calls `start_dialog` with a problem description
2. The server spawns a background runner process
3. Claude sends messages via `send_message`, and the runner invokes Codex CLI to respond
4. Claude polls for replies with `check_messages`
5. The conversation continues back and forth until ended or a turn/idle limit is reached

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Codex CLI](https://github.com/openai/codex) installed and available on your PATH (or specify a custom command)

## Install

```bash
git clone https://github.com/clpotvin/claude-codex-dialog.git
cd claude-codex-dialog
npm install
```

## Setup

Add the server to your Claude Code MCP configuration (`~/.claude/settings.json` or project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "codex-dialog": {
      "command": "node",
      "args": ["/absolute/path/to/claude-codex-dialog/src/dialog-server.mjs"]
    }
  }
}
```

Then restart Claude Code. The tools will be available automatically.

## MCP Tools

| Tool | Description |
|------|-------------|
| `start_dialog` | Start a new discussion session with Codex CLI |
| `send_message` | Send a message to Codex in an ongoing discussion |
| `check_messages` | Poll for new messages from Codex |
| `get_full_history` | Get the complete conversation history |
| `check_partner_alive` | Check if the Codex runner process is still running |
| `end_dialog` | End the session and get the final conversation |
| `list_dialogs` | List all dialog sessions (active and completed) |

## Usage

Once configured, ask Claude Code to start a dialog from within a conversation:

> "Start a dialog with Codex about how to refactor the authentication module"

Claude will use the MCP tools to manage the discussion automatically. Conversation data is stored in `~/.claude/dialogs/`.

## Configuration

The runner has sensible defaults that can be adjusted in `src/dialog-runner.mjs`:

- **MAX_TURNS** — max conversation turns (default: 50)
- **CODEX_TIMEOUT_MS** — timeout per Codex invocation (default: 5 min)
- **MAX_IDLE_MS** — idle timeout before auto-shutdown (default: 15 min)

## License

MIT
