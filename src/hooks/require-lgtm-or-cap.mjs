#!/usr/bin/env node
// PreToolUse hook for mcp__codex-dialog__end_dialog
// Blocks session closure unless the partner has given LGTM or the hard round cap is hit.

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

let partnerAgent = "codex";
let partnerDisplay = "Codex";
let hardCap = 10;
let runnerPid = null;
let allowsApproveVerdict = false;

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

// Check for LGTM from the partner — require it at start of line (not preceded by
// negation like "Not LGTM" or "can't say LGTM")
const statusPath = path.join(sessionDir, "status.json");
if (fs.existsSync(statusPath)) {
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (status?.partner_agent === "claude" || status?.partner_agent === "codex") {
      partnerAgent = status.partner_agent;
      partnerDisplay = partnerAgent === "claude" ? "Claude" : "Codex";
    }
    hardCap = status?.hard_cap || (status?.max_rounds || 5) + 5;
    runnerPid = status?.runner_pid || null;
  } catch {}
}

const problemPath = path.join(sessionDir, "problem.md");
if (fs.existsSync(problemPath)) {
  try {
    const problem = fs.readFileSync(problemPath, "utf-8");
    allowsApproveVerdict =
      /^Implementation plan review\b/i.test(problem) ||
      /^Feature spec review\b/i.test(problem) ||
      /^##\s*Plan Review Request\b/im.test(problem) ||
      /^##\s*Spec Review Request\b/im.test(problem);
  } catch {}
}

const hasLgtm = messages.some(
  (m) => m.from === partnerAgent && /(?:^|\n)\s*LGTM\b/i.test(m.content)
);
if (hasLgtm) process.exit(0);

const hasApprove = allowsApproveVerdict && messages.some(
  (m) => m.from === partnerAgent && /(?:^|\n)\s*APPROVE\b/i.test(m.content)
);
if (hasApprove) process.exit(0);

const partnerRounds = messages.filter((m) => m.from === partnerAgent).length;
if (partnerRounds >= hardCap) process.exit(0);

// Check if runner is dead (allow closing dead sessions)
if (runnerPid) {
  try {
    process.kill(runnerPid, 0);
  } catch {
    // Runner is dead — allow closing
    process.exit(0);
  }
}

process.stderr.write(
  `BLOCKED: Cannot end this session yet. ${partnerDisplay} has not given ${allowsApproveVerdict ? "LGTM or APPROVE" : "LGTM"} and the hard cap (${hardCap}) has not been reached (${partnerRounds} rounds used).

Wait for ${partnerDisplay} to verify your fixes and give ${allowsApproveVerdict ? "LGTM or APPROVE" : "LGTM"} before closing the session.
If ${partnerDisplay} has remaining concerns, address them first.

To force-close a stuck session, the runner must be dead or the hard cap must be hit.
`
);
process.exit(2);
