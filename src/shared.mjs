import fs from "fs";
import path from "path";

export const DIALOGS_DIR = path.join(process.env.HOME, ".claude", "dialogs");
fs.mkdirSync(DIALOGS_DIR, { recursive: true });

export function readConversation(sessionDir) {
  const convPath = sessionDir.includes("conversation.jsonl")
    ? sessionDir
    : path.join(sessionDir, "conversation.jsonl");
  if (!fs.existsSync(convPath)) return [];
  const lines = fs
    .readFileSync(convPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

export function appendMessage(sessionDir, from, content) {
  const convPath = sessionDir.includes("conversation.jsonl")
    ? sessionDir
    : path.join(sessionDir, "conversation.jsonl");
  const messages = readConversation(sessionDir);
  const id = messages.length + 1;
  const msg = { id, from, content, timestamp: new Date().toISOString() };
  fs.appendFileSync(convPath, JSON.stringify(msg) + "\n");
  return msg;
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
  return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
