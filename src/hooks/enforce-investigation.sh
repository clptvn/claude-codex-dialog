#!/bin/bash
# PreToolUse hook for mcp__codex-dialog__send_message
# Blocks the send if Claude hasn't read the files Codex referenced.

MARKER="/tmp/codex-dialog-required-reads"
[ -f "$MARKER" ] || exit 0

# Simple flag mode (no specific files extracted)
if grep -q "^__any__$" "$MARKER"; then
    cat >&2 <<'MSG'
BLOCKED: You have not investigated Codex's claims. Before responding to Codex, you MUST:

1. Read the ACTUAL CODE at every file/line Codex referenced — use Read, Grep, or Glob
2. Verify each claim against the codebase yourself
3. Form your own opinion based on what the code actually does
4. Only then write your response with evidence (file paths, line numbers, what you found)

Do NOT accept or reject findings based on whether they "sound right."
Do NOT paraphrase Codex's claims back as agreement without checking.
Go read the code NOW, then come back and send your message.
MSG
    exit 2
fi

# Specific files mode — list what still needs to be read
REMAINING=$(cat "$MARKER")
COUNT=$(wc -l < "$MARKER" | tr -d ' ')

cat >&2 <<MSG
BLOCKED: You still have $COUNT file(s) referenced by Codex that you haven't read:

$REMAINING

Read each of these files before responding. Codex made claims about this code —
verify those claims yourself before agreeing or disagreeing.
MSG
exit 2
