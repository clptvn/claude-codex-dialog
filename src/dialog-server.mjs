import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import crypto from "crypto";

const DIALOGS_DIR = path.join(process.env.HOME, ".claude", "dialogs");
fs.mkdirSync(DIALOGS_DIR, { recursive: true });

const server = new McpServer({
  name: "codex-dialog",
  version: "1.0.0",
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function readConversation(sessionId) {
  const convPath = path.join(DIALOGS_DIR, sessionId, "conversation.jsonl");
  if (!fs.existsSync(convPath)) return [];
  const lines = fs
    .readFileSync(convPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function appendMessage(sessionId, from, content) {
  const convPath = path.join(DIALOGS_DIR, sessionId, "conversation.jsonl");
  const messages = readConversation(sessionId);
  const id = messages.length + 1;
  const msg = { id, from, content, timestamp: new Date().toISOString() };
  fs.appendFileSync(convPath, JSON.stringify(msg) + "\n");
  return msg;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStatus(sessionId) {
  const statusPath = path.join(DIALOGS_DIR, sessionId, "status.json");
  if (!fs.existsSync(statusPath)) return null;
  return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  "start_dialog",
  "Start a new discussion session with Codex CLI. Spawns a background runner that invokes codex for each turn of the conversation.",
  {
    problem_description: z
      .string()
      .describe("The problem to discuss with Codex"),
    project_path: z
      .string()
      .optional()
      .describe(
        "Path to the project directory for context (codex works in this dir)"
      ),
    codex_command: z
      .string()
      .optional()
      .describe("Command to invoke codex (default: 'codex')"),
  },
  async ({ problem_description, project_path, codex_command }) => {
    const sessionId = `dialog-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = path.join(DIALOGS_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write problem description
    fs.writeFileSync(path.join(sessionDir, "problem.md"), problem_description);

    // Initialize empty conversation
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");

    // Write initial status
    const status = {
      session_id: sessionId,
      started_at: new Date().toISOString(),
      project_path: project_path || process.cwd(),
      codex_command: codex_command || "codex",
      runner_pid: null,
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    // Spawn the dialog runner in background
    const runnerPath = new URL("dialog-runner.mjs", import.meta.url).pathname;
    const runner = spawn(
      "node",
      [runnerPath, sessionDir, project_path || process.cwd(), codex_command || "codex"],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
      }
    );
    runner.unref();

    // Update status with PID
    status.runner_pid = runner.pid;
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id: sessionId,
              runner_pid: runner.pid,
              dialog_dir: sessionDir,
              message:
                "Dialog started. Send your first message with send_message, then poll with check_messages.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "send_message",
  "Send a message to Codex in the ongoing discussion. The background runner will detect it and invoke Codex to respond.",
  {
    session_id: z.string().describe("The dialog session ID"),
    content: z.string().describe("Your message to Codex"),
  },
  async ({ session_id, content }) => {
    const sessionDir = path.join(DIALOGS_DIR, session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }
    const msg = appendMessage(session_id, "claude", content);
    return {
      content: [
        {
          type: "text",
          text: `Message sent (id: ${msg.id}). Codex will be invoked to respond. Poll with check_messages.`,
        },
      ],
    };
  }
);

server.tool(
  "check_messages",
  "Check for new messages from Codex. Returns messages after the given ID, plus status info about whether Codex is still processing.",
  {
    session_id: z.string().describe("The dialog session ID"),
    since_id: z
      .number()
      .optional()
      .describe("Return messages with ID greater than this (default: 0 = all)"),
  },
  async ({ session_id, since_id }) => {
    const sessionDir = path.join(DIALOGS_DIR, session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConversation(session_id);
    const sinceIdNum = since_id || 0;
    const newMessages = messages.filter((m) => m.id > sinceIdNum);

    // Check runner status
    const status = readStatus(session_id);
    const runnerAlive = status?.runner_pid
      ? isProcessAlive(status.runner_pid)
      : false;

    // Check if codex is currently being invoked
    const processingPath = path.join(sessionDir, "codex_processing");
    const codexProcessing = fs.existsSync(processingPath);

    // Check for errors
    const errorPath = path.join(sessionDir, "last_error.txt");
    const lastError = fs.existsSync(errorPath)
      ? fs.readFileSync(errorPath, "utf-8")
      : null;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              new_messages: newMessages,
              total_messages: messages.length,
              latest_id:
                messages.length > 0 ? messages[messages.length - 1].id : 0,
              codex_runner_alive: runnerAlive,
              codex_currently_processing: codexProcessing,
              last_error: lastError,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_full_history",
  "Get the complete conversation history including the original problem description.",
  {
    session_id: z.string().describe("The dialog session ID"),
  },
  async ({ session_id }) => {
    const sessionDir = path.join(DIALOGS_DIR, session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConversation(session_id);
    const problemPath = path.join(sessionDir, "problem.md");
    const problem = fs.existsSync(problemPath)
      ? fs.readFileSync(problemPath, "utf-8")
      : "(no problem description)";

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ problem, messages }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "check_partner_alive",
  "Check if the Codex dialog runner process is still alive and get detailed status.",
  {
    session_id: z.string().describe("The dialog session ID"),
  },
  async ({ session_id }) => {
    const sessionDir = path.join(DIALOGS_DIR, session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const status = readStatus(session_id);
    const alive = status?.runner_pid
      ? isProcessAlive(status.runner_pid)
      : false;

    const processingPath = path.join(sessionDir, "codex_processing");
    const processing = fs.existsSync(processingPath);

    const messages = readConversation(session_id);
    const lastCodexMsg = [...messages].reverse().find((m) => m.from === "codex");
    const lastCodexTime = lastCodexMsg
      ? new Date(lastCodexMsg.timestamp)
      : null;
    const secondsSinceLastCodex = lastCodexTime
      ? (Date.now() - lastCodexTime.getTime()) / 1000
      : null;

    const errorPath = path.join(sessionDir, "last_error.txt");
    const lastError = fs.existsSync(errorPath)
      ? fs.readFileSync(errorPath, "utf-8")
      : null;

    // Read runner log tail
    const logPath = path.join(sessionDir, "runner.log");
    let logTail = null;
    if (fs.existsSync(logPath)) {
      const logLines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      logTail = logLines.slice(-5).join("\n");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              runner_alive: alive,
              runner_pid: status?.runner_pid,
              codex_currently_processing: processing,
              seconds_since_last_codex_message: secondsSinceLastCodex,
              last_error: lastError,
              started_at: status?.started_at,
              recent_log: logTail,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "end_dialog",
  "End the dialog session. Terminates the runner and returns the final conversation.",
  {
    session_id: z.string().describe("The dialog session ID"),
  },
  async ({ session_id }) => {
    const sessionDir = path.join(DIALOGS_DIR, session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    // Signal the runner to stop
    fs.writeFileSync(path.join(sessionDir, "end_signal"), "");

    // Also try to kill the process directly
    const status = readStatus(session_id);
    if (status?.runner_pid && isProcessAlive(status.runner_pid)) {
      try {
        process.kill(status.runner_pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }

    const messages = readConversation(session_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ended: true,
              total_messages: messages.length,
              messages,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_dialogs",
  "List all dialog sessions (active and completed).",
  {},
  async () => {
    if (!fs.existsSync(DIALOGS_DIR)) {
      return { content: [{ type: "text", text: "[]" }] };
    }

    const sessions = fs
      .readdirSync(DIALOGS_DIR)
      .filter((d) => d.startsWith("dialog-"));
    const results = sessions.map((sessionId) => {
      const status = readStatus(sessionId);
      const messages = readConversation(sessionId);
      const alive = status?.runner_pid
        ? isProcessAlive(status.runner_pid)
        : false;
      return {
        session_id: sessionId,
        started_at: status?.started_at,
        message_count: messages.length,
        runner_alive: alive,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
