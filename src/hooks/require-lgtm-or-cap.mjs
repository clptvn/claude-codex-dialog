#!/usr/bin/env node
// PreToolUse hook for mcp__codex-dialog__end_dialog
// Blocks session closure unless Codex has given LGTM or the hard round cap is hit.

import fs from "fs";
import path from "path";

const input = fs.readFileSync("/dev/stdin", "utf-8");
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}

const sessionId = payload.tool_input?.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

const dialogsDir = path.join(process.env.HOME, ".claude", "dialogs");
const sessionDir = path.join(dialogsDir, sessionId);
if (!fs.existsSync(sessionDir)) process.exit(0);

// Read conversation
const convPath = path.join(sessionDir, "conversation.jsonl");
let messages = [];
if (fs.existsSync(convPath)) {
  const lines = fs.readFileSync(convPath, "utf-8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.from === "string") messages.push(obj);
    } catch {}
  }
}

// Check for LGTM from codex — require it at start of line (not preceded by
// negation like "Not LGTM" or "can't say LGTM")
const hasLgtm = messages.some(
  (m) => m.from === "codex" && /(?:^|\n)\s*LGTM\b/i.test(m.content)
);
if (hasLgtm) process.exit(0);

// Check if hard cap reached
let hardCap = 10;
const statusPath = path.join(sessionDir, "status.json");
if (fs.existsSync(statusPath)) {
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    hardCap = status.hard_cap || (status.max_rounds || 5) + 5;
  } catch {}
}
const codexRounds = messages.filter((m) => m.from === "codex").length;
if (codexRounds >= hardCap) process.exit(0);

// Check if runner is dead (allow closing dead sessions)
const runnerPid = (() => {
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    return status.runner_pid;
  } catch {
    return null;
  }
})();
if (runnerPid) {
  try {
    process.kill(runnerPid, 0);
  } catch {
    // Runner is dead — allow closing
    process.exit(0);
  }
}

process.stderr.write(
  `BLOCKED: Cannot end this session yet. Codex has not given LGTM and the hard cap (${hardCap}) has not been reached (${codexRounds} rounds used).

Wait for Codex to verify your fixes and give LGTM before closing the session.
If Codex has remaining concerns, address them first.

To force-close a stuck session, the runner must be dead or the hard cap must be hit.
`
);
process.exit(2);
