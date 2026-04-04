#!/usr/bin/env bash
set -euo pipefail

# ── Claude Codex Dialog - Uninstaller ───────────────────────────────────────

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
COMMANDS_DIR="$CLAUDE_DIR/commands"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " claude-codex-dialog uninstaller"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Remove slash commands
if [ -f "$COMMANDS_DIR/codex-review-code.md" ]; then
    rm "$COMMANDS_DIR/codex-review-code.md"
    echo "  Removed /codex-review-code ✓"
fi

if [ -f "$COMMANDS_DIR/codex-review-plan.md" ]; then
    rm "$COMMANDS_DIR/codex-review-plan.md"
    echo "  Removed /codex-review-plan ✓"
fi

# Remove MCP server from settings
if [ -f "$SETTINGS_FILE" ] && grep -q '"codex-dialog"' "$SETTINGS_FILE" 2>/dev/null; then
    node -e "
        const fs = require('fs');
        const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
        if (settings.mcpServers && settings.mcpServers['codex-dialog']) {
            delete settings.mcpServers['codex-dialog'];
            if (Object.keys(settings.mcpServers).length === 0) {
                delete settings.mcpServers;
            }
        }
        fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    "
    echo "  Removed MCP server from settings ✓"
fi

echo ""
echo "  Uninstalled. Restart Claude Code to apply changes."
echo ""
