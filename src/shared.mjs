import fs from "fs";
import path from "path";

export const DIALOGS_DIR = path.join(process.env.HOME, ".claude", "dialogs");
fs.mkdirSync(DIALOGS_DIR, { recursive: true });
export const KNOWN_AGENTS = ["claude", "codex"];

export function normalizeAgent(agent, fallback = "codex") {
  return KNOWN_AGENTS.includes(agent) ? agent : fallback;
}

export function getSessionHostAgent(status) {
  return normalizeAgent(status?.host_agent, "claude");
}

export function getSessionPartnerAgent(status) {
  return normalizeAgent(status?.partner_agent, "codex");
}

export function getAgentDisplayName(agent) {
  return normalizeAgent(agent, "codex") === "claude" ? "Claude" : "Codex";
}

function resolveConvPath(sessionDir) {
  return sessionDir.includes("conversation.jsonl")
    ? sessionDir
    : path.join(sessionDir, "conversation.jsonl");
}

function isValidMessage(obj) {
  return obj && typeof obj.id === "number" && Number.isSafeInteger(obj.id) && obj.id > 0 && typeof obj.from === "string" && typeof obj.content === "string";
}

export function readConversation(sessionDir) {
  const convPath = resolveConvPath(sessionDir);
  if (!fs.existsSync(convPath)) return [];
  const lines = fs
    .readFileSync(convPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (isValidMessage(obj)) messages.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

function withConvLock(convPath, fn) {
  const lockPath = convPath + ".lock";
  const STALE_MS = 30000;
  for (let i = 0; i < 200; i++) {
    try {
      fs.mkdirSync(lockPath);
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(lockPath); } catch {}
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Check for stale lock (older than 30s = likely crashed holder)
      if (i > 0 && i % 50 === 0) {
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > STALE_MS) {
            try { fs.rmdirSync(lockPath); } catch {}
            continue;
          }
        } catch {}
      }
      const deadline = Date.now() + 10;
      while (Date.now() < deadline) {}
    }
  }
  throw new Error("Failed to acquire conversation lock after retries");
}

export function appendMessage(sessionDir, from, content) {
  const convPath = resolveConvPath(sessionDir);
  return withConvLock(convPath, () => {
    const messages = readConversation(sessionDir);
    const maxId = messages.reduce((max, m) => {
      const n = m?.id;
      return typeof n === "number" && Number.isSafeInteger(n) && n > max ? n : max;
    }, 0);
    const id = maxId + 1;
    const msg = { id, from, content, timestamp: new Date().toISOString() };
    fs.appendFileSync(convPath, JSON.stringify(msg) + "\n");
    return msg;
  });
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readStatus(sessionDir) {
  const statusPath = sessionDir.includes("status.json")
    ? sessionDir
    : path.join(sessionDir, "status.json");
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
