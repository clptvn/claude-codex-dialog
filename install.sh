#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"
CLAUDE_COMMANDS_DIR="$CLAUDE_DIR/commands"
CLAUDE_HOOKS_DIR="$CLAUDE_DIR/hooks/codex-dialog"
CLAUDE_SETTINGS_JSON="$CLAUDE_DIR/settings.json"
CODEX_DIR="$HOME/.codex"
CODEX_SKILLS_DIR="$CODEX_DIR/skills"
CODEX_CONFIG_TOML="$CODEX_DIR/config.toml"
SERVER_PATH="$SCRIPT_DIR/src/dialog-server.mjs"

INSTALL_CLAUDE=1
INSTALL_CODEX=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --claude)
            INSTALL_CLAUDE=1
            INSTALL_CODEX=0
            ;;
        --codex)
            INSTALL_CLAUDE=0
            INSTALL_CODEX=1
            ;;
        --both)
            INSTALL_CLAUDE=1
            INSTALL_CODEX=1
            ;;
        *)
            echo "ERROR: Unknown option: $1"
            echo "Usage: ./install.sh [--claude|--codex|--both]"
            exit 1
            ;;
    esac
    shift
done

mode_label() {
    if [[ "$INSTALL_CLAUDE" -eq 1 && "$INSTALL_CODEX" -eq 1 ]]; then
        echo "Claude + Codex"
    elif [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
        echo "Claude only"
    else
        echo "Codex only"
    fi
}

check_node() {
    if ! command -v node >/dev/null 2>&1; then
        echo "  ERROR: Node.js is required but not found. Install it from https://nodejs.org/"
        exit 1
    fi

    local node_major
    node_major="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [[ "$node_major" -lt 18 ]]; then
        echo "  ERROR: Node.js >= 18 required, found $(node -v)"
        exit 1
    fi

    echo "  Node.js $(node -v) ✓"
}

check_cli() {
    local label="$1"
    local cmd="$2"
    if command -v "$cmd" >/dev/null 2>&1; then
        echo "  $label CLI ✓"
    else
        echo "  WARNING: $label CLI not found on PATH."
    fi
}

register_claude_mcp() {
    echo ""
    echo "[3/6] Registering MCP server for Claude..."

    if command -v claude >/dev/null 2>&1; then
        claude mcp remove codex-dialog -s user >/dev/null 2>&1 || true
        claude mcp add -s user codex-dialog -- node "$SERVER_PATH" >/dev/null
        echo "  MCP server registered with Claude CLI ✓"
        return
    fi

    if [[ -f "$CLAUDE_JSON" ]]; then
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
    echo "  MCP server written to ~/.claude.json (CLI fallback) ✓"
}

install_claude_commands() {
    echo ""
    echo "[4/6] Installing Claude commands and hooks..."

    mkdir -p "$CLAUDE_COMMANDS_DIR"

    cp "$SCRIPT_DIR/.claude/commands/codex-review-code.md" "$CLAUDE_COMMANDS_DIR/codex-review-code.md"
    echo "  /codex-review-code ✓"

    cp "$SCRIPT_DIR/.claude/commands/codex-review-plan.md" "$CLAUDE_COMMANDS_DIR/codex-review-plan.md"
    echo "  /codex-review-plan ✓"

    cp "$SCRIPT_DIR/.claude/commands/codex-review-spec.md" "$CLAUDE_COMMANDS_DIR/codex-review-spec.md"
    echo "  /codex-review-spec ✓"

    cp "$SCRIPT_DIR/.claude/commands/codex-audit.md" "$CLAUDE_COMMANDS_DIR/codex-audit.md"
    echo "  /codex-audit ✓"

    mkdir -p "$CLAUDE_HOOKS_DIR"
    cp "$SCRIPT_DIR/src/hooks/mark-needs-investigation.mjs" "$CLAUDE_HOOKS_DIR/"
    cp "$SCRIPT_DIR/src/hooks/clear-investigation.mjs" "$CLAUDE_HOOKS_DIR/"
    cp "$SCRIPT_DIR/src/hooks/enforce-investigation.mjs" "$CLAUDE_HOOKS_DIR/"
    cp "$SCRIPT_DIR/src/hooks/require-lgtm-or-cap.mjs" "$CLAUDE_HOOKS_DIR/"
    rm -f \
        "$CLAUDE_HOOKS_DIR/mark-needs-investigation.sh" \
        "$CLAUDE_HOOKS_DIR/clear-investigation.sh" \
        "$CLAUDE_HOOKS_DIR/enforce-investigation.sh"

    node -e "
        const fs = require('fs');
        const settingsPath = '$CLAUDE_SETTINGS_JSON';
        const hooksDir = '$CLAUDE_HOOKS_DIR';

        let config = {};
        if (fs.existsSync(settingsPath)) {
          try { config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
        }

        if (!config.hooks) config.hooks = {};

        if (!config.hooks.PreToolUse) config.hooks.PreToolUse = [];
        const preHooks = config.hooks.PreToolUse;

        const preEntries = [
          {
            matcher: 'mcp__codex-dialog__send_message',
            hooks: [{ type: 'command', command: 'node ' + hooksDir + '/enforce-investigation.mjs' }]
          },
          {
            matcher: 'mcp__codex-dialog__end_dialog',
            hooks: [{ type: 'command', command: 'node ' + hooksDir + '/require-lgtm-or-cap.mjs' }]
          }
        ];

        for (const entry of preEntries) {
          const idx = preHooks.findIndex(h => h.matcher === entry.matcher);
          if (idx >= 0) preHooks[idx] = entry;
          else preHooks.push(entry);
        }

        if (!config.hooks.PostToolUse) config.hooks.PostToolUse = [];
        const postHooks = config.hooks.PostToolUse;

        for (const matcher of ['mcp__codex-dialog__check_messages', 'mcp__codex-dialog__get_full_history']) {
          const entry = {
            matcher,
            hooks: [{ type: 'command', command: 'node ' + hooksDir + '/mark-needs-investigation.mjs' }]
          };
          const idx = postHooks.findIndex(h => h.matcher === matcher && h.hooks?.[0]?.command?.includes('mark-needs'));
          if (idx >= 0) postHooks[idx] = entry;
          else postHooks.push(entry);
        }

        const clearEntry = {
          matcher: 'Read',
          hooks: [{ type: 'command', command: 'node ' + hooksDir + '/clear-investigation.mjs' }]
        };
        const clearIdx = postHooks.findIndex(h => h.matcher === 'Read' && h.hooks?.[0]?.command?.includes('clear-investigation'));
        if (clearIdx >= 0) postHooks[clearIdx] = clearEntry;
        else postHooks.push(clearEntry);

        for (let i = postHooks.length - 1; i >= 0; i--) {
          if ((postHooks[i].matcher === 'Grep' || postHooks[i].matcher === 'Glob') &&
              postHooks[i].hooks?.[0]?.command?.includes('clear-investigation')) {
            postHooks.splice(i, 1);
          }
        }

        fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
    "

    echo "  Claude hooks installed ✓"
}

register_codex_mcp() {
    echo ""
    echo "[5/6] Registering MCP server for Codex..."

    if command -v codex >/dev/null 2>&1; then
        codex mcp remove codex-dialog >/dev/null 2>&1 || true
        codex mcp add codex-dialog -- node "$SERVER_PATH" >/dev/null
        echo "  MCP server registered with Codex CLI ✓"
        return
    fi

    mkdir -p "$CODEX_DIR"
    node -e "
        const fs = require('fs');
        const configPath = '$CODEX_CONFIG_TOML';
        const section = '[mcp_servers.codex-dialog]\\ncommand = \"node\"\\nargs = [\"$SERVER_PATH\"]\\n';

        let content = '';
        if (fs.existsSync(configPath)) {
          content = fs.readFileSync(configPath, 'utf-8');
          content = content.replace(/\\n?\\[mcp_servers\\.codex-dialog\\]\\n(?:.*\\n)*?(?=\\n\\[|$)/g, '\\n');
          content = content.trimEnd() + '\\n';
        }

        fs.writeFileSync(configPath, content + section);
    "
    echo "  Codex CLI not found; wrote MCP server fallback to ~/.codex/config.toml ✓"
}

install_codex_skills() {
    echo ""
    echo "[6/6] Installing Codex skills..."

    mkdir -p "$CODEX_SKILLS_DIR"

    for skill in claude-review-code claude-review-plan claude-review-spec claude-audit; do
        rm -rf "$CODEX_SKILLS_DIR/$skill"
        cp -R "$SCRIPT_DIR/codex-skills/$skill" "$CODEX_SKILLS_DIR/$skill"
        echo "  /$skill ✓"
    done
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " claude-codex-dialog installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Mode: $(mode_label)"
echo ""

echo "[1/6] Checking prerequisites..."
check_node
check_cli "Claude" "claude"
check_cli "Codex" "codex"

echo ""
echo "[2/6] Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
echo "  Dependencies installed ✓"

if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
    register_claude_mcp
    install_claude_commands
fi

if [[ "$INSTALL_CODEX" -eq 1 ]]; then
    register_codex_mcp
    install_codex_skills
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Installation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " MCP server: $SERVER_PATH"
if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
    echo " Claude:     $CLAUDE_COMMANDS_DIR/codex-{review-code,review-plan,review-spec,audit}.md"
    echo " Hooks:      $CLAUDE_HOOKS_DIR/"
fi
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
    echo " Codex:      $CODEX_SKILLS_DIR/{claude-review-code,claude-review-plan,claude-review-spec,claude-audit}"
fi
echo ""
if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
    echo " Restart Claude Code to pick up updated MCP configuration and commands."
fi
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
    echo " Restart Codex to pick up updated MCP configuration and skills."
fi
echo ""
echo " Usage:"
if [[ "$INSTALL_CLAUDE" -eq 1 ]]; then
    echo "   /codex-review-code          Review uncommitted code changes with Codex"
    echo "   /codex-review-plan          Review an implementation plan with Codex"
    echo "   /codex-review-spec          Review a product/feature spec with Codex"
    echo "   /codex-audit src/           Audit files with Codex"
fi
if [[ "$INSTALL_CODEX" -eq 1 ]]; then
    echo "   /claude-review-code         Review uncommitted code changes with Claude"
    echo "   /claude-review-plan         Review an implementation plan with Claude"
    echo "   /claude-review-spec         Review a product/feature spec with Claude"
    echo "   /claude-audit src/          Audit files with Claude"
fi
echo ""
