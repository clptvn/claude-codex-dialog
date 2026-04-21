#!/bin/bash
# PostToolUse hook for mcp__codex-dialog__check_messages
# Extracts referenced_files from the tool response and writes them to the
# marker file so the enforce hook can require Claude to read each one.

INPUT=$(cat)
MARKER="/tmp/codex-dialog-required-reads"

# Only act if codex returned findings (not just LGTM)
if ! echo "$INPUT" | grep -qE '\[(CRITICAL|CORRECTNESS|ARCHITECTURE|SECURITY|ROBUSTNESS|SUGGESTION|QUESTION)\]'; then
    exit 0
fi

# Extract referenced_files from the JSON. The tool_response.text is a JSON
# string with \n escapes. Unescape, collapse to one line, then pull paths.
echo "$INPUT" | \
    sed 's/\\n/ /g; s/\\"/"/g' | \
    grep -oE '"referenced_files"\s*:\s*\[[^]]*\]' | \
    grep -oE '"(/[^"]+)"' | \
    tr -d '"' | \
    sort -u > "$MARKER"

# If we didn't extract any paths, fall back to the simple flag behavior
if [ ! -s "$MARKER" ]; then
    echo "__any__" > "$MARKER"
fi

exit 0
