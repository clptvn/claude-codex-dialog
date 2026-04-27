#!/usr/bin/env bash
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
CLAUDE_JSON="$HOME/.claude.json"
CLAUDE_COMMANDS_DIR="$CLAUDE_DIR/commands"
CLAUDE_HOOKS_DIR="$CLAUDE_DIR/hooks/codex-dialog"
CLAUDE_SETTINGS_JSON="$CLAUDE_DIR/settings.json"
CODEX_DIR="$HOME/.codex"
CODEX_SKILLS_DIR="$CODEX_DIR/skills"
CODEX_CONFIG_TOML="$CODEX_DIR/config.toml"

REMOVE_CLAUDE=1
REMOVE_CODEX=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --claude)
            REMOVE_CLAUDE=1
            REMOVE_CODEX=0
            ;;
        --codex)
            REMOVE_CLAUDE=0
            REMOVE_CODEX=1
            ;;
        --both)
            REMOVE_CLAUDE=1
            REMOVE_CODEX=1
            ;;
        *)
            echo "ERROR: Unknown option: $1"
            echo "Usage: ./uninstall.sh [--claude|--codex|--both]"
            exit 1
            ;;
    esac
    shift
done

remove_claude_mcp() {
    if command -v claude >/dev/null 2>&1; then
        claude mcp remove codex-dialog -s user >/dev/null 2>&1 || true
        echo "  Removed Claude MCP registration ✓"
        return
    fi

    if [[ -f "$CLAUDE_JSON" ]] && grep -q '"codex-dialog"' "$CLAUDE_JSON" 2>/dev/null; then
        node -e "
            const fs = require('fs');
            const config = JSON.parse(fs.readFileSync('$CLAUDE_JSON', 'utf-8'));
            if (config.mcpServers && config.mcpServers['codex-dialog']) {
              delete config.mcpServers['codex-dialog'];
              if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
            }
            fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(config, null, 2) + '\n');
        "
        echo "  Removed ~/.claude.json MCP registration ✓"
    fi
}

remove_claude_hooks() {
    if [[ -d "$CLAUDE_HOOKS_DIR" ]]; then
        rm -rf "$CLAUDE_HOOKS_DIR"
        echo "  Removed Claude hook files ✓"
    fi

    node -e "
        const fs = require('fs');
        const settingsPath = '$CLAUDE_SETTINGS_JSON';
        if (!fs.existsSync(settingsPath)) process.exit(0);

        let config;
        try { config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { process.exit(0); }
        if (!config.hooks) process.exit(0);

        const matchers = new Set([
          'mcp__codex-dialog__send_message',
          'mcp__codex-dialog__end_dialog',
          'mcp__codex-dialog__check_messages',
          'mcp__codex-dialog__get_full_history',
        ]);

        for (const key of ['PreToolUse', 'PostToolUse']) {
          if (!Array.isArray(config.hooks[key])) continue;
          config.hooks[key] = config.hooks[key].filter(entry => {
            if (matchers.has(entry.matcher)) return false;
            if (entry.matcher === 'Read' && entry.hooks?.[0]?.command?.includes('clear-investigation')) return false;
            return true;
          });
          if (config.hooks[key].length === 0) delete config.hooks[key];
        }

        if (Object.keys(config.hooks).length === 0) delete config.hooks;
        fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
    "
    echo "  Removed Claude hook settings ✓"
}

remove_codex_mcp() {
    if command -v codex >/dev/null 2>&1; then
        codex mcp remove codex-dialog >/dev/null 2>&1 || true
        echo "  Removed Codex MCP registration ✓"
        return
    fi

    if [[ -f "$CODEX_CONFIG_TOML" ]]; then
        node -e "
            const fs = require('fs');
            const configPath = '$CODEX_CONFIG_TOML';
            let content = fs.readFileSync(configPath, 'utf-8');
            content = content.replace(/\\n?\\[mcp_servers\\.codex-dialog\\]\\n(?:.*\\n)*?(?=\\n\\[|$)/g, '\\n').trimEnd();
            fs.writeFileSync(configPath, content ? content + '\\n' : '');
        "
        echo "  Codex CLI not found; removed ~/.codex/config.toml MCP fallback ✓"
    else
        echo "  WARNING: Codex CLI not found. Skipped Codex MCP removal."
    fi
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " claude-codex-dialog uninstaller"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ "$REMOVE_CLAUDE" -eq 1 ]]; then
    if [[ -f "$CLAUDE_COMMANDS_DIR/codex-review-code.md" ]]; then
        rm "$CLAUDE_COMMANDS_DIR/codex-review-code.md"
        echo "  Removed /codex-review-code ✓"
    fi
    if [[ -f "$CLAUDE_COMMANDS_DIR/codex-review-plan.md" ]]; then
        rm "$CLAUDE_COMMANDS_DIR/codex-review-plan.md"
        echo "  Removed /codex-review-plan ✓"
    fi
    if [[ -f "$CLAUDE_COMMANDS_DIR/codex-review-spec.md" ]]; then
        rm "$CLAUDE_COMMANDS_DIR/codex-review-spec.md"
        echo "  Removed /codex-review-spec ✓"
    fi
    if [[ -f "$CLAUDE_COMMANDS_DIR/codex-audit.md" ]]; then
        rm "$CLAUDE_COMMANDS_DIR/codex-audit.md"
        echo "  Removed /codex-audit ✓"
    fi

    remove_claude_hooks
    remove_claude_mcp
fi

if [[ "$REMOVE_CODEX" -eq 1 ]]; then
    for skill in claude-review-code claude-review-plan claude-review-spec claude-audit claude-ui-implementer; do
        if [[ -d "$CODEX_SKILLS_DIR/$skill" ]]; then
            rm -rf "$CODEX_SKILLS_DIR/$skill"
            echo "  Removed /$skill ✓"
        fi
    done

    remove_codex_mcp
fi

echo ""
if [[ "$REMOVE_CLAUDE" -eq 1 ]]; then
    echo " Restart Claude Code to apply the removal."
fi
if [[ "$REMOVE_CODEX" -eq 1 ]]; then
    echo " Restart Codex to apply the removal."
fi
echo ""
