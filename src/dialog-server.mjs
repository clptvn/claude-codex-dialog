import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import crypto from "crypto";
import {
  DIALOGS_DIR,
  readConversation,
  appendMessage,
  isProcessAlive,
  readStatus,
} from "./shared.mjs";

const server = new McpServer({
  name: "codex-dialog",
  version: "1.0.0",
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveSessionDir(sessionId) {
  return path.join(DIALOGS_DIR, sessionId);
}

function readConv(sessionId) {
  return readConversation(resolveSessionDir(sessionId));
}

function appendMsg(sessionId, from, content) {
  return appendMessage(resolveSessionDir(sessionId), from, content);
}

function readStat(sessionId) {
  return readStatus(resolveSessionDir(sessionId));
}

// ── Dialog Tools ────────────────────────────────────────────────────────────

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
    const sessionDir = resolveSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write problem description
    fs.writeFileSync(path.join(sessionDir, "problem.md"), problem_description);

    // Initialize empty conversation
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");

    // Write initial status
    const status = {
      session_id: sessionId,
      type: "dialog",
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

// ── Code Review Tools ───────────────────────────────────────────────────────

server.tool(
  "start_code_review",
  "Start a code review session where Codex reviews changes and discusses them with Claude. Codex automatically generates an initial review from the diff — poll with check_messages to read it.",
  {
    project_path: z
      .string()
      .describe("Path to the git project directory"),
    branch: z
      .string()
      .optional()
      .describe("Branch to review (default: current branch)"),
    base_branch: z
      .string()
      .optional()
      .describe("Base branch to compare against (default: 'main')"),
    review_focus: z
      .string()
      .optional()
      .describe(
        "Optional focus area for the review, e.g. 'security', 'performance', 'correctness'"
      ),
    codex_command: z
      .string()
      .optional()
      .describe("Command to invoke codex (default: 'codex')"),
  },
  async ({ project_path, branch, base_branch, review_focus, codex_command }) => {
    const baseBranch = base_branch || "main";

    // Resolve the current branch if not specified
    let headBranch = branch;
    if (!headBranch) {
      try {
        headBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: project_path,
          timeout: 10000,
        })
          .toString()
          .trim();
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not determine current branch. Is "${project_path}" a git repository?\n${err.message}`,
            },
          ],
        };
      }
    }

    // Generate the diff
    let diff, diffStat;
    try {
      diff = execSync(`git diff ${baseBranch}...${headBranch}`, {
        cwd: project_path,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      }).toString();

      diffStat = execSync(`git diff --stat ${baseBranch}...${headBranch}`, {
        cwd: project_path,
        timeout: 10000,
      }).toString();
    } catch (err) {
      // Fall back to two-dot diff if three-dot fails (e.g. no common ancestor)
      try {
        diff = execSync(`git diff ${baseBranch}..${headBranch}`, {
          cwd: project_path,
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        }).toString();

        diffStat = execSync(`git diff --stat ${baseBranch}..${headBranch}`, {
          cwd: project_path,
          timeout: 10000,
        }).toString();
      } catch (err2) {
        return {
          content: [
            {
              type: "text",
              text: `Error generating diff between "${baseBranch}" and "${headBranch}":\n${err2.message}`,
            },
          ],
        };
      }
    }

    if (!diff.trim()) {
      return {
        content: [
          {
            type: "text",
            text: `No changes found between "${baseBranch}" and "${headBranch}". Nothing to review.`,
          },
        ],
      };
    }

    // Create session
    const sessionId = `review-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = resolveSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write review artifacts
    fs.writeFileSync(path.join(sessionDir, "diff.patch"), diff);

    const meta = {
      branch: headBranch,
      base_branch: baseBranch,
      diff_stat: diffStat.trim(),
      review_focus: review_focus || null,
      files_changed: diffStat
        .trim()
        .split("\n")
        .slice(0, -1) // remove summary line
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean),
    };
    fs.writeFileSync(
      path.join(sessionDir, "review_meta.json"),
      JSON.stringify(meta, null, 2)
    );

    // Initialize empty conversation (runner will auto-populate the first message)
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");

    // Write status
    const status = {
      session_id: sessionId,
      type: "review",
      started_at: new Date().toISOString(),
      project_path,
      codex_command: codex_command || "codex",
      branch: headBranch,
      base_branch: baseBranch,
      review_focus: review_focus || null,
      runner_pid: null,
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    // Spawn the review runner
    const runnerPath = new URL("review-runner.mjs", import.meta.url).pathname;
    const runner = spawn(
      "node",
      [runnerPath, sessionDir, project_path, codex_command || "codex"],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
      }
    );
    runner.unref();

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
              review_dir: sessionDir,
              branch: headBranch,
              base_branch: baseBranch,
              files_changed: meta.files_changed.length,
              diff_size: diff.length,
              message:
                "Code review started. Codex is generating an initial review — poll with check_messages to read it.",
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
  "get_review_summary",
  "Get the full code review context: diff metadata, original diff stat, and the complete review conversation.",
  {
    session_id: z.string().describe("The review session ID"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConv(session_id);

    // Read review metadata if it exists
    const metaPath = path.join(sessionDir, "review_meta.json");
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
      : null;

    // Parse structured findings from codex messages
    const findings = { critical: [], suggestion: [], question: [], praise: [] };
    for (const msg of messages) {
      if (msg.from !== "codex") continue;
      const lines = msg.content.split("\n");
      for (const line of lines) {
        if (line.includes("[CRITICAL]")) findings.critical.push(line.trim());
        if (line.includes("[SUGGESTION]")) findings.suggestion.push(line.trim());
        if (line.includes("[QUESTION]")) findings.question.push(line.trim());
        if (line.includes("[PRAISE]")) findings.praise.push(line.trim());
      }
    }

    const hasLgtm = messages.some(
      (m) => m.from === "codex" && /\bLGTM\b/i.test(m.content)
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              meta,
              total_messages: messages.length,
              findings,
              approved: hasLgtm,
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

// ── Shared Tools (work with both dialog and review sessions) ────────────────

server.tool(
  "send_message",
  "Send a message to Codex in an ongoing dialog or review session. The background runner will detect it and invoke Codex to respond.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
    content: z.string().describe("Your message to Codex"),
  },
  async ({ session_id, content }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }
    const msg = appendMsg(session_id, "claude", content);
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
    session_id: z.string().describe("The session ID (dialog or review)"),
    since_id: z
      .number()
      .optional()
      .describe("Return messages with ID greater than this (default: 0 = all)"),
  },
  async ({ session_id, since_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConv(session_id);
    const sinceIdNum = since_id || 0;
    const newMessages = messages.filter((m) => m.id > sinceIdNum);

    // Check runner status
    const status = readStat(session_id);
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
  "Get the complete conversation history including the original problem description or review diff.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConv(session_id);

    // Return problem for dialogs, meta for reviews
    const problemPath = path.join(sessionDir, "problem.md");
    const metaPath = path.join(sessionDir, "review_meta.json");
    const problem = fs.existsSync(problemPath)
      ? fs.readFileSync(problemPath, "utf-8")
      : null;
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, "utf-8"))
      : null;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ problem, review_meta: meta, messages }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "check_partner_alive",
  "Check if the Codex runner process is still alive and get detailed status.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const status = readStat(session_id);
    const alive = status?.runner_pid
      ? isProcessAlive(status.runner_pid)
      : false;

    const processingPath = path.join(sessionDir, "codex_processing");
    const processing = fs.existsSync(processingPath);

    const messages = readConv(session_id);
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
              session_type: status?.type || "unknown",
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
  "End a dialog or review session. Terminates the runner and returns the final conversation.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    // Signal the runner to stop
    fs.writeFileSync(path.join(sessionDir, "end_signal"), "");

    // Also try to kill the process directly
    const status = readStat(session_id);
    if (status?.runner_pid && isProcessAlive(status.runner_pid)) {
      try {
        process.kill(status.runner_pid, "SIGTERM");
      } catch {
        /* already dead */
      }
    }

    const messages = readConv(session_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ended: true,
              session_type: status?.type || "unknown",
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
  "list_sessions",
  "List all dialog and review sessions (active and completed).",
  {},
  async () => {
    if (!fs.existsSync(DIALOGS_DIR)) {
      return { content: [{ type: "text", text: "[]" }] };
    }

    const sessions = fs
      .readdirSync(DIALOGS_DIR)
      .filter((d) => d.startsWith("dialog-") || d.startsWith("review-"));
    const results = sessions.map((sessionId) => {
      const status = readStat(sessionId);
      const messages = readConv(sessionId);
      const alive = status?.runner_pid
        ? isProcessAlive(status.runner_pid)
        : false;
      return {
        session_id: sessionId,
        type: sessionId.startsWith("review-") ? "review" : "dialog",
        started_at: status?.started_at,
        message_count: messages.length,
        runner_alive: alive,
        ...(status?.branch ? { branch: status.branch, base_branch: status.base_branch } : {}),
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
