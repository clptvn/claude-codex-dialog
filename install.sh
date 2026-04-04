#!/usr/bin/env bash
set -euo pipefail

# ── Claude Codex Dialog - Installer ─────────────────────────────────────────
# Installs the MCP server, slash commands, and validates prerequisites.
# Run: ./install.sh  or  npm run setup

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
COMMANDS_DIR="$CLAUDE_DIR/commands"
SERVER_PATH="$SCRIPT_DIR/src/dialog-server.mjs"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " claude-codex-dialog installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────────────────

echo "[1/4] Checking prerequisites..."

if ! command -v node &>/dev/null; then
    echo "  ERROR: Node.js is required but not found. Install it from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "  ERROR: Node.js >= 18 required, found $(node -v)"
    exit 1
fi
echo "  Node.js $(node -v) ✓"

if command -v codex &>/dev/null; then
    echo "  Codex CLI ✓"
else
    echo "  WARNING: Codex CLI not found on PATH."
    echo "  The MCP server will be installed but won't work until codex is available."
    echo "  Install it from: https://github.com/openai/codex"
    echo ""
fi

# ── 2. Install npm dependencies ─────────────────────────────────────────────

echo ""
echo "[2/4] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
echo "  Dependencies installed ✓"

# ── 3. Install slash commands ────────────────────────────────────────────────

echo ""
echo "[3/4] Installing slash commands..."

mkdir -p "$COMMANDS_DIR"

cp "$SCRIPT_DIR/.claude/commands/codex-review-code.md" "$COMMANDS_DIR/codex-review-code.md"
echo "  /codex-review-code ✓"

cp "$SCRIPT_DIR/.claude/commands/codex-review-plan.md" "$COMMANDS_DIR/codex-review-plan.md"
echo "  /codex-review-plan ✓"

# ── 4. Register MCP server ──────────────────────────────────────────────────

echo ""
echo "[4/4] Registering MCP server..."

mkdir -p "$CLAUDE_DIR"

# Build the MCP server entry
MCP_ENTRY=$(cat <<JSONEOF
{
  "command": "node",
  "args": ["$SERVER_PATH"]
}
JSONEOF
)

if [ -f "$SETTINGS_FILE" ]; then
    # Check if codex-dialog is already registered
    if grep -q '"codex-dialog"' "$SETTINGS_FILE" 2>/dev/null; then
        echo "  MCP server already registered, updating..."
        # Use node to safely update the JSON
        node -e "
            const fs = require('fs');
            const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
            if (!settings.mcpServers) settings.mcpServers = {};
            settings.mcpServers['codex-dialog'] = {
                command: 'node',
                args: ['$SERVER_PATH']
            };
            fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
        "
    else
        # Add mcpServers key with codex-dialog
        node -e "
            const fs = require('fs');
            const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
            if (!settings.mcpServers) settings.mcpServers = {};
            settings.mcpServers['codex-dialog'] = {
                command: 'node',
                args: ['$SERVER_PATH']
            };
            fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
        "
    fi
else
    # Create settings.json with just the MCP server
    node -e "
        const fs = require('fs');
        const settings = {
            mcpServers: {
                'codex-dialog': {
                    command: 'node',
                    args: ['$SERVER_PATH']
                }
            }
        };
        fs.mkdirSync('$CLAUDE_DIR', { recursive: true });
        fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    "
fi
echo "  MCP server registered ✓"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " MCP server: $SERVER_PATH"
echo " Settings:   $SETTINGS_FILE"
echo " Commands:   $COMMANDS_DIR/codex-review-{code,plan}.md"
echo ""
echo " Restart Claude Code to pick up the new MCP server."
echo ""
echo " Usage:"
echo "   /codex-review-code          Review uncommitted code changes"
echo "   /codex-review-code staged   Review only staged changes"
echo "   /codex-review-plan          Review an implementation plan"
echo ""
