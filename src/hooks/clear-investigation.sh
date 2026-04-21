#!/bin/bash
# PostToolUse hook for Read, Grep, Glob
# Removes the read file from the required-reads marker.
# If all required files have been read, removes the marker entirely.

MARKER="/tmp/codex-dialog-required-reads"
[ -f "$MARKER" ] || exit 0

INPUT=$(cat)

# If marker just has the simple flag, any read clears it
if grep -q "^__any__$" "$MARKER"; then
    rm -f "$MARKER"
    exit 0
fi

# Extract the file path from the tool input
# Read tool: "file_path" field
# Grep/Glob tool: "path" field
FILE_PATH=$(echo "$INPUT" | sed 's/\\"/"/g' | grep -oE '"file_path"\s*:\s*"([^"]+)"' | head -1 | sed 's/.*: *"//; s/"$//')
if [ -z "$FILE_PATH" ]; then
    FILE_PATH=$(echo "$INPUT" | sed 's/\\"/"/g' | grep -oE '"path"\s*:\s*"([^"]+)"' | head -1 | sed 's/.*: *"//; s/"$//')
fi
[ -z "$FILE_PATH" ] && exit 0

# Remove any required-read line that matches (path contains or is contained by the read path)
TEMP=$(mktemp)
while IFS= read -r required; do
    # Match if either path contains the other (handles absolute vs relative)
    if [[ "$FILE_PATH" == *"$required"* ]] || [[ "$required" == *"$FILE_PATH"* ]]; then
        continue  # matched — skip (remove from list)
    fi
    echo "$required"
done < "$MARKER" > "$TEMP"

if [ -s "$TEMP" ]; then
    mv "$TEMP" "$MARKER"
else
    rm -f "$TEMP" "$MARKER"
fi

exit 0
