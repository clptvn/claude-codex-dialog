import fs from "fs";
import os from "os";
import path from "path";

// claude-codex-dialog platform helpers. Keep this file dependency-light because
// Claude hook scripts import it from the user-level hooks directory.
export function isWindows() {
  return process.platform === "win32";
}

export function homeDir() {
  return os.homedir();
}

export function dialogsDir() {
  return path.join(homeDir(), ".claude", "dialogs");
}

export function dialogSessionDir(sessionId) {
  return path.join(dialogsDir(), sessionId);
}

export function readStdin() {
  return fs.readFileSync(0, "utf-8");
}
