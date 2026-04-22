#!/usr/bin/env bash
set -euo pipefail

# ── Claude Codex Dialog - Installer ─────────────────────────────────────────
# Installs the MCP server, slash commands, and validates prerequisites.
# Run: ./install.sh  or  npm run setup

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"
COMMANDS_DIR="$CLAUDE_DIR/commands"
HOOKS_DIR="$CLAUDE_DIR/hooks/codex-dialog"
SETTINGS_JSON="$CLAUDE_DIR/settings.json"
SERVER_PATH="$SCRIPT_DIR/src/dialog-server.mjs"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " claude-codex-dialog installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Check prerequisites ──────────────────────────────────────────────────

echo "[1/5] Checking prerequisites..."

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
echo "[2/5] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
echo "  Dependencies installed ✓"

# ── 3. Install slash commands ────────────────────────────────────────────────

echo ""
echo "[3/5] Installing slash commands..."

mkdir -p "$COMMANDS_DIR"

cp "$SCRIPT_DIR/.claude/commands/codex-review-code.md" "$COMMANDS_DIR/codex-review-code.md"
echo "  /codex-review-code ✓"

cp "$SCRIPT_DIR/.claude/commands/codex-review-plan.md" "$COMMANDS_DIR/codex-review-plan.md"
echo "  /codex-review-plan ✓"

cp "$SCRIPT_DIR/.claude/commands/codex-review-spec.md" "$COMMANDS_DIR/codex-review-spec.md"
echo "  /codex-review-spec ✓"

cp "$SCRIPT_DIR/.claude/commands/codex-audit.md" "$COMMANDS_DIR/codex-audit.md"
echo "  /codex-audit ✓"

# ── 4. Register MCP server globally ─────────────────────────────────────────

echo ""
echo "[4/5] Registering MCP server globally..."

if [ -f "$CLAUDE_JSON" ]; then
    node -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('$CLAUDE_JSON', 'utf-8'));
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers['codex-dialog'] = {
            command: 'node',
            args: ['$SERVER_PATH']
        };
        fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(config, null, 2) + '\n');
    "
else
    node -e "
        const fs = require('fs');
        const config = {
            mcpServers: {
                'codex-dialog': {
                    command: 'node',
                    args: ['$SERVER_PATH']
                }
            }
        };
        fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(config, null, 2) + '\n');
    "
fi
echo "  MCP server registered in ~/.claude.json ✓"

# ── 5. Install investigation-enforcement hooks ─────────────────────────────

echo ""
echo "[5/5] Installing investigation hooks..."

mkdir -p "$HOOKS_DIR"

cp "$SCRIPT_DIR/src/hooks/mark-needs-investigation.mjs" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/src/hooks/clear-investigation.mjs" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/src/hooks/enforce-investigation.mjs" "$HOOKS_DIR/"

# Remove old .sh hooks if present
rm -f "$HOOKS_DIR/mark-needs-investigation.sh" "$HOOKS_DIR/clear-investigation.sh" "$HOOKS_DIR/enforce-investigation.sh"

# Merge hooks into ~/.claude/settings.json
node -e "
    const fs = require('fs');
    const settingsPath = '$SETTINGS_JSON';
    const hooksDir = '$HOOKS_DIR';

    let config = {};
    if (fs.existsSync(settingsPath)) {
        try { config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    }

    if (!config.hooks) config.hooks = {};

    // PreToolUse: block send_message if no investigation happened
    if (!config.hooks.PreToolUse) config.hooks.PreToolUse = [];
    const preHooks = config.hooks.PreToolUse;
    const preIdx = preHooks.findIndex(h => h.matcher === 'mcp__codex-dialog__send_message');
    const preEntry = {
        matcher: 'mcp__codex-dialog__send_message',
        hooks: [{ type: 'command', command: 'node ' + hooksDir + '/enforce-investigation.mjs' }]
    };
    if (preIdx >= 0) preHooks[preIdx] = preEntry;
    else preHooks.push(preEntry);

    // PostToolUse: mark when codex findings arrive
    if (!config.hooks.PostToolUse) config.hooks.PostToolUse = [];
    const postHooks = config.hooks.PostToolUse;

    // Mark hook on both check_messages and get_full_history (both return Codex claims)
    const markTools = ['mcp__codex-dialog__check_messages', 'mcp__codex-dialog__get_full_history'];
    for (const tool of markTools) {
        const markEntry = {
            matcher: tool,
            hooks: [{ type: 'command', command: 'node ' + hooksDir + '/mark-needs-investigation.mjs' }]
        };
        const markIdx = postHooks.findIndex(h => h.matcher === tool && h.hooks?.[0]?.command?.includes('mark-needs'));
        if (markIdx >= 0) postHooks[markIdx] = markEntry;
        else postHooks.push(markEntry);
    }

    // PostToolUse: clear marker only on Read (exact file match, no Grep/Glob bypass)
    const clearEntry = {
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'node ' + hooksDir + '/clear-investigation.mjs' }]
    };
    const readIdx = postHooks.findIndex(h => h.matcher === 'Read' && h.hooks?.[0]?.command?.includes('clear-investigation'));
    if (readIdx >= 0) postHooks[readIdx] = clearEntry;
    else postHooks.push(clearEntry);

    // Remove old Grep/Glob clear hooks if present
    for (let i = postHooks.length - 1; i >= 0; i--) {
        if ((postHooks[i].matcher === 'Grep' || postHooks[i].matcher === 'Glob') &&
            postHooks[i].hooks?.[0]?.command?.includes('clear-investigation')) {
            postHooks.splice(i, 1);
        }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
"
echo "  enforce-investigation (PreToolUse on send_message) ✓"
echo "  mark-needs-investigation (PostToolUse on check_messages + get_full_history) ✓"
echo "  clear-investigation (PostToolUse on Read only) ✓"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " MCP server: $SERVER_PATH"
echo " Config:     $CLAUDE_JSON"
echo " Commands:   $COMMANDS_DIR/codex-{review-code,review-plan,review-spec,audit}.md"
echo " Hooks:      $HOOKS_DIR/ (enforces code investigation before responding)"
echo ""
echo " Restart Claude Code to pick up the new MCP server."
echo ""
echo " Usage:"
echo "   /codex-review-code          Review uncommitted code changes"
echo "   /codex-review-code staged   Review only staged changes"
echo "   /codex-review-plan          Review an implementation plan"
echo "   /codex-review-spec          Review a product/feature spec"
echo "   /codex-audit src/           Audit files for bugs and design issues"
echo ""
