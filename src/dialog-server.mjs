import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn, execSync, execFileSync } from "child_process";
import crypto from "crypto";
import {
  DIALOGS_DIR,
  getAgentDisplayName,
  getSessionHostAgent,
  getSessionPartnerAgent,
  normalizeAgent,
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
  if (!/^(dialog|review)-\d+-[0-9a-f]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
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

function resolvePartnerCommandValue(
  partnerAgent,
  partnerCommand,
  codexCommand,
  claudeCommand
) {
  if (partnerCommand) return partnerCommand;
  if (partnerAgent === "claude") return claudeCommand || "claude";
  return codexCommand || "codex";
}

function getProcessingPath(sessionDir) {
  const partnerPath = path.join(sessionDir, "partner_processing");
  if (fs.existsSync(partnerPath)) return partnerPath;
  return path.join(sessionDir, "codex_processing");
}

function writeFileAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content);
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function computeBudget(status, messages) {
  const maxRounds = status?.max_rounds ?? 5;
  const hardCap = status?.hard_cap ?? maxRounds + 5;
  const partnerAgent = getSessionPartnerAgent(status);
  // Only real partner turns count toward the budget. System notices (idle
  // shutdown, hard-cap reached, error shutdown, etc.) use from: "system"
  // and must not inflate rounds_used past hard_cap.
  const roundsUsed = messages.filter((m) => m.from === partnerAgent).length;
  const roundsRemaining = Math.max(0, maxRounds - roundsUsed);
  const hardRoundsRemaining = Math.max(0, hardCap - roundsUsed);
  return {
    max_rounds: maxRounds,
    hard_cap: hardCap,
    rounds_used: roundsUsed,
    rounds_remaining: roundsRemaining,
    hard_rounds_remaining: hardRoundsRemaining,
    past_soft_cap: roundsUsed > maxRounds,
  };
}

function extractReferencedFiles(messages, projectPath, partnerAgent = "codex") {
  const raw = new Set();
  for (const msg of messages) {
    if (msg.from !== partnerAgent) continue;
    const content = msg.content;
    // Primary: structured REFERENCED_FILES line (machine-readable, the partner fills this in)
    const refMatch = content.match(/^REFERENCED_FILES:\s*(.+)$/m);
    if (refMatch) {
      for (const entry of refMatch[1].split(/,\s*/)) {
        const p = entry.trim().replace(/:\d+(?::\d+)?$/, "");
        if (p) raw.add(p);
      }
    }
    // Fallback: markdown links [text](/path/to/file) or [text](/path/to/file:line)
    for (const m of content.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
      let p = m[2].replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
      if (p.includes("/") && !p.startsWith("http")) raw.add(p);
    }
    // Fallback: backtick paths — with or without directory separators.
    // Permissive match; filesystem validation filters false positives.
    for (const m of content.matchAll(/`([^`\s]+\.[a-zA-Z]{1,5}(?::\d+)?)`/g)) {
      let p = m[1].replace(/:\d+(?::\d+)?$/, "");
      raw.add(p);
    }
  }
  // Resolve against project root and validate existence
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(projectPath || process.cwd());
  } catch {
    resolvedRoot = path.resolve(projectPath || process.cwd());
  }
  const validated = new Set();
  for (const p of raw) {
    let resolved = path.isAbsolute(p)
      ? p.replace(/#.*$/, "")
      : path.resolve(resolvedRoot, p);
    try {
      resolved = fs.realpathSync(resolved);
      if (!fs.statSync(resolved).isFile()) continue;
    } catch {
      continue; // doesn't exist or not a file — skip
    }
    const rel = path.relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    validated.add(resolved);
  }
  return [...validated];
}

// ── Dialog Tools ────────────────────────────────────────────────────────────

server.tool(
  "start_dialog",
  "Start a new discussion session with a partner CLI. By default the host is Claude and the partner is Codex, but the session can be inverted so Codex hosts and Claude is the partner. Enforces a soft round budget (default 5) with a hard cap 5 rounds past that.",
  {
    problem_description: z
      .string()
      .describe("The problem to discuss with the partner agent"),
    project_path: z
      .string()
      .optional()
      .describe("Path to the project directory for context"),
    host_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent is orchestrating the session (default: 'claude')"),
    partner_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent should respond in the background runner (default: 'codex')"),
    partner_command: z
      .string()
      .optional()
      .describe("Command to invoke the partner CLI. Overrides the agent-specific defaults."),
    codex_command: z
      .string()
      .optional()
      .describe("Deprecated alias for partner_command when partner_agent='codex'"),
    claude_command: z
      .string()
      .optional()
      .describe("Alias for partner_command when partner_agent='claude'"),
    max_rounds: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Soft round budget (default: 5). The partner is asked to deliver all feedback within this many rounds. Hard cap = max_rounds + 5. Do not override unless the user explicitly requested a different budget."
      ),
    reasoning_effort: z
      .string()
      .optional()
      .describe(
        "Optional partner-specific reasoning effort level. For Codex this is typically low|medium|high|xhigh; for Claude low|medium|high|xhigh|max."
      ),
    model: z
      .string()
      .optional()
      .describe("Optional partner model override. Omit to use the partner CLI default."),
  },
  async ({
    problem_description,
    project_path,
    host_agent,
    partner_agent,
    partner_command,
    codex_command,
    claude_command,
    max_rounds,
    reasoning_effort,
    model,
  }) => {
    const hostAgent = normalizeAgent(host_agent, "claude");
    const partnerAgent = normalizeAgent(partner_agent, "codex");
    if (hostAgent === partnerAgent) {
      return {
        content: [
          {
            type: "text",
            text: "Error: host_agent and partner_agent must be different",
          },
        ],
      };
    }
    const sessionId = `dialog-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = resolveSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const softCap = max_rounds || 5;
    const hardCap = softCap + 5;
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);

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
      host_agent: hostAgent,
      partner_agent: partnerAgent,
      partner_command: partnerCommand,
      ...(partnerAgent === "codex" ? { codex_command: partnerCommand } : {}),
      max_rounds: softCap,
      hard_cap: hardCap,
      reasoning_effort: reasoning_effort || null,
      model: model || null,
      runner_pid: null,
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    // Spawn the dialog runner in background
    const runnerPath = new URL("dialog-runner.mjs", import.meta.url).pathname;
    const runnerArgs = [
      runnerPath,
      sessionDir,
      project_path || process.cwd(),
      partnerCommand,
      String(softCap),
      reasoning_effort || "",
      model || "",
      hostAgent,
      partnerAgent,
    ];
    const runner = spawn(
      "node",
      runnerArgs,
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
      }
    );
    runner.on("error", () => {});
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
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_command: partnerCommand,
              max_rounds: softCap,
              hard_cap: hardCap,
              reasoning_effort: reasoning_effort || "partner default",
              model: model || "default",
              message:
                `Dialog started with a soft budget of ${softCap} rounds (hard cap ${hardCap}), model: ${model || "default"}, reasoning effort: ${reasoning_effort || "partner default"}. Send your first message with send_message, then wait for ${partnerDisplay}.`,
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
  "Start a code review session where the configured partner agent reviews changes in the background. By default the host is Claude and the reviewer is Codex, but the flow can be inverted so Codex hosts and Claude reviews.",
  {
    project_path: z
      .string()
      .describe("Path to the git project directory"),
    diff_target: z
      .string()
      .optional()
      .describe(
        "What to diff. 'uncommitted' (default) = all working tree + staged changes vs HEAD. 'staged' = only staged changes vs HEAD. 'branch' = compare branch vs base_branch. 'commit:<sha>' = review a specific commit."
      ),
    branch: z
      .string()
      .optional()
      .describe("Branch to review (only used when diff_target='branch', default: current branch)"),
    base_branch: z
      .string()
      .optional()
      .describe("Base branch to compare against (only used when diff_target='branch', default: 'main')"),
    review_focus: z
      .string()
      .optional()
      .describe(
        "Optional focus area for the review, e.g. 'security', 'performance', 'correctness'"
      ),
    host_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent is orchestrating the review (default: 'claude')"),
    partner_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent should review in the background (default: 'codex')"),
    partner_command: z
      .string()
      .optional()
      .describe("Command to invoke the reviewing partner CLI."),
    codex_command: z
      .string()
      .optional()
      .describe("Deprecated alias for partner_command when partner_agent='codex'"),
    claude_command: z
      .string()
      .optional()
      .describe("Alias for partner_command when partner_agent='claude'"),
    max_rounds: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Soft round budget (default: 5). The reviewer is asked to deliver all feedback within this many rounds. Hard cap = max_rounds + 5. Do not override unless the user explicitly requested a different budget."
      ),
    reasoning_effort: z
      .string()
      .optional()
      .describe(
        "Optional partner-specific reasoning effort override."
      ),
    model: z
      .string()
      .optional()
      .describe("Optional partner model override."),
  },
  async ({
    project_path,
    diff_target,
    branch,
    base_branch,
    review_focus,
    host_agent,
    partner_agent,
    partner_command,
    codex_command,
    claude_command,
    max_rounds,
    reasoning_effort,
    model,
  }) => {
    const hostAgent = normalizeAgent(host_agent, "claude");
    const partnerAgent = normalizeAgent(partner_agent, "codex");
    if (hostAgent === partnerAgent) {
      return {
        content: [
          {
            type: "text",
            text: "Error: host_agent and partner_agent must be different",
          },
        ],
      };
    }
    const target = diff_target || "uncommitted";
    if (!["staged", "uncommitted", "branch"].includes(target) && !target.startsWith("commit:")) {
      return {
        content: [{ type: "text", text: `Error: Unknown diff_target "${target}". Use: staged, uncommitted, branch, or commit:<sha>` }],
      };
    }
    const softCap = max_rounds || 5;
    const hardCap = softCap + 5;
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);
    const execOpts = { cwd: project_path, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };

    // Resolve current branch and HEAD SHA for metadata
    let currentBranch, headSha;
    try {
      headSha = execSync("git rev-parse HEAD", {
        cwd: project_path,
        timeout: 10000,
      }).toString().trim();
    } catch {}
    try {
      currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
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

    let diff, diffStat, diffLabel;

    try {
      if (target === "staged") {
        // Only staged changes
        diff = execSync("git diff --cached", execOpts).toString();
        diffStat = execSync("git diff --cached --stat", { ...execOpts, timeout: 10000 }).toString();
        diffLabel = "staged changes vs HEAD";
      } else if (target === "uncommitted") {
        // All working tree changes (staged + unstaged) vs HEAD
        diff = execSync("git diff HEAD", execOpts).toString();
        diffStat = execSync("git diff HEAD --stat", { ...execOpts, timeout: 10000 }).toString();
        diffLabel = "uncommitted changes vs HEAD";

        // If no diff against HEAD (maybe no commits yet), try plain diff
        if (!diff.trim()) {
          diff = execSync("git diff", execOpts).toString();
          diffStat = execSync("git diff --stat", { ...execOpts, timeout: 10000 }).toString();
          diffLabel = "unstaged changes";
        }
      } else if (target.startsWith("commit:")) {
        const sha = target.slice("commit:".length);
        if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
          throw new Error(`Invalid commit SHA: ${sha}`);
        }
        diff = execFileSync("git", ["show", sha, "--format="], execOpts).toString();
        diffStat = execFileSync("git", ["show", sha, "--stat", "--format="], { ...execOpts, timeout: 10000 }).toString();
        diffLabel = `commit ${sha}`;
      } else {
        // Branch mode
        const baseBranch = base_branch || "main";
        const headBranch = branch || currentBranch;

        try {
          diff = execFileSync("git", ["diff", `${baseBranch}...${headBranch}`], execOpts).toString();
          diffStat = execFileSync("git", ["diff", "--stat", `${baseBranch}...${headBranch}`], { ...execOpts, timeout: 10000 }).toString();
        } catch {
          // Fall back to two-dot diff
          diff = execFileSync("git", ["diff", `${baseBranch}..${headBranch}`], execOpts).toString();
          diffStat = execFileSync("git", ["diff", "--stat", `${baseBranch}..${headBranch}`], { ...execOpts, timeout: 10000 }).toString();
        }
        diffLabel = `${headBranch} vs ${baseBranch}`;
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error generating diff (${target}):\n${err.message}`,
          },
        ],
      };
    }

    if (!diff.trim()) {
      return {
        content: [
          {
            type: "text",
            text: `No changes found (${diffLabel}). Nothing to review.`,
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

    const headBranchForMeta = target === "branch" ? (branch || currentBranch) : currentBranch;
    const baseBranchForMeta = target === "branch" ? (base_branch || "main") : "HEAD";
    const meta = {
      branch: headBranchForMeta,
      base_branch: baseBranchForMeta,
      diff_target: target,
      diff_label: diffLabel,
      diff_stat: diffStat.trim(),
      review_focus: review_focus || null,
      files_changed: diffStat
        .trim()
        .split("\n")
        .slice(0, -1)
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
      host_agent: hostAgent,
      partner_agent: partnerAgent,
      partner_command: partnerCommand,
      ...(partnerAgent === "codex" ? { codex_command: partnerCommand } : {}),
      diff_target: target,
      diff_label: diffLabel,
      branch: headBranchForMeta,
      base_branch: baseBranchForMeta,
      head_sha: headSha || null,
      review_focus: review_focus || null,
      max_rounds: softCap,
      hard_cap: hardCap,
      reasoning_effort: reasoning_effort || null,
      model: model || null,
      runner_pid: null,
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    // Spawn the review runner
    const runnerPath = new URL("review-runner.mjs", import.meta.url).pathname;
    const reviewRunnerArgs = [
      runnerPath,
      sessionDir,
      project_path,
      partnerCommand,
      String(softCap),
      reasoning_effort || "",
      model || "",
      hostAgent,
      partnerAgent,
    ];
    const runner = spawn(
      "node",
      reviewRunnerArgs,
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
      }
    );
    runner.on("error", () => {});
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
              diff_target: target,
              diff_label: diffLabel,
              files_changed: meta.files_changed.length,
              diff_size: diff.length,
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_command: partnerCommand,
              max_rounds: softCap,
              hard_cap: hardCap,
              reasoning_effort: reasoning_effort || "partner default",
              model: model || "default",
              message:
                `Code review started with a soft budget of ${softCap} rounds (hard cap ${hardCap}), model: ${model || "default"}, reasoning effort: ${reasoning_effort || "partner default"}. ${partnerDisplay} is generating an initial review.`,
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
    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);

    const metaPath = path.join(sessionDir, "review_meta.json");
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
    }

    // Parse structured findings from codex messages. Keep in sync with the
    // taxonomy advertised in runner prompts and skill docs.
    const FINDING_CATEGORIES = [
      "CRITICAL",
      "CORRECTNESS",
      "ARCHITECTURE",
      "SECURITY",
      "ROBUSTNESS",
      "SUGGESTION",
      "QUESTION",
      "PRAISE",
      "NIT",
    ];
    const findings = Object.fromEntries(
      FINDING_CATEGORIES.map((c) => [c.toLowerCase(), []])
    );
    for (const msg of messages) {
      if (msg.from !== partnerAgent) continue;
      const lines = msg.content.split("\n");
      for (const line of lines) {
        for (const cat of FINDING_CATEGORIES) {
          if (line.includes(`[${cat}]`)) {
            findings[cat.toLowerCase()].push(line.trim());
          }
        }
      }
    }

    const hasLgtm = messages.some(
      (m) => m.from === partnerAgent && /(?:^|\n)\s*LGTM\b/i.test(m.content)
    );

    const budget = computeBudget(status, messages);

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
              budget,
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
  "Send a message to the configured partner session. The background runner will detect it and invoke the partner CLI to respond.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
    content: z.string().describe("Your message to the partner agent"),
  },
  async ({ session_id, content }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }
    const status = readStat(session_id);
    const hostAgent = getSessionHostAgent(status);
    const partnerAgent = getSessionPartnerAgent(status);
    const partnerDisplay = getAgentDisplayName(partnerAgent);

    // Auto-refresh diff BEFORE appending message so it's ready when the runner
    // sees the new message and immediately starts building the prompt.
    if (status?.type === "review" && status.diff_target && !status.diff_target.startsWith("commit:")) {
      try {
        const refreshOpts = { cwd: status.project_path, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };
        const baseline = status.head_sha || "HEAD";
        let refreshedDiff;
        if (status.diff_target === "staged") {
          let filesChanged = [];
          try {
            const meta = JSON.parse(
              fs.readFileSync(path.join(sessionDir, "review_meta.json"), "utf-8")
            );
            filesChanged = Array.isArray(meta?.files_changed) ? meta.files_changed : [];
          } catch {}

          try {
            refreshedDiff = filesChanged.length > 0
              ? execFileSync("git", ["diff", baseline, "--", ...filesChanged], refreshOpts).toString()
              : execFileSync("git", ["diff", baseline], refreshOpts).toString();
          } catch {
            refreshedDiff = execFileSync("git", ["diff", "HEAD"], refreshOpts).toString();
          }
        } else if (status.diff_target === "branch") {
          const base = status.base_branch || "main";
          const head = status.branch;
          try {
            refreshedDiff = execFileSync("git", ["diff", `${base}...${head}`], refreshOpts).toString();
          } catch {
            refreshedDiff = execFileSync("git", ["diff", `${base}..${head}`], refreshOpts).toString();
          }
        } else {
          // uncommitted: diff against the original HEAD SHA to keep baseline stable
          try {
            refreshedDiff = execFileSync("git", ["diff", baseline], refreshOpts).toString();
          } catch {
            refreshedDiff = execFileSync("git", ["diff"], refreshOpts).toString();
          }
        }
        writeFileAtomic(path.join(sessionDir, "diff_refreshed.patch"), refreshedDiff);
      } catch {
        // On failure, remove stale refreshed diff so runner falls back to original
        try { fs.unlinkSync(path.join(sessionDir, "diff_refreshed.patch")); } catch {}
      }
    }

    const msg = appendMsg(session_id, hostAgent, content);
    const budget = computeBudget(status, readConv(session_id));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sent: true,
              message_id: msg.id,
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              budget,
              message: `Message sent (id: ${msg.id}). ${partnerDisplay} will be invoked to respond.`,
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
  "check_messages",
  "Check for new messages from the configured partner agent. Returns messages after the given ID, plus runner status.",
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
    const hostAgent = getSessionHostAgent(status);
    const partnerAgent = getSessionPartnerAgent(status);
    const runnerAlive = status?.runner_pid
      ? isProcessAlive(status.runner_pid)
      : false;

    const processingPath = getProcessingPath(sessionDir);
    const partnerProcessing = fs.existsSync(processingPath);

    // Check for errors
    const errorPath = path.join(sessionDir, "last_error.txt");
    const lastError = fs.existsSync(errorPath)
      ? fs.readFileSync(errorPath, "utf-8")
      : null;

    const budget = computeBudget(status, messages);
    const projectPath = status?.project_path || process.cwd();
    const referencedFiles = extractReferencedFiles(
      newMessages,
      projectPath,
      partnerAgent
    );

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
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_runner_alive: runnerAlive,
              partner_currently_processing: partnerProcessing,
              ...(partnerAgent === "codex"
                ? {
                    codex_runner_alive: runnerAlive,
                    codex_currently_processing: partnerProcessing,
                  }
                : {}),
              last_error: lastError,
              budget,
              referenced_files: referencedFiles,
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
    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);
    const projectPath = status?.project_path || process.cwd();
    const referencedFiles = extractReferencedFiles(
      messages,
      projectPath,
      partnerAgent
    );

    // Return problem for dialogs, meta for reviews
    const problemPath = path.join(sessionDir, "problem.md");
    const metaPath = path.join(sessionDir, "review_meta.json");
    const problem = fs.existsSync(problemPath)
      ? fs.readFileSync(problemPath, "utf-8")
      : null;
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ problem, review_meta: meta, messages, referenced_files: referencedFiles }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "check_partner_alive",
  "Check if the partner runner process is still alive and get detailed status.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);
    const alive = status?.runner_pid
      ? isProcessAlive(status.runner_pid)
      : false;

    const processingPath = getProcessingPath(sessionDir);
    const processing = fs.existsSync(processingPath);

    const messages = readConv(session_id);
    const lastPartnerMsg = [...messages]
      .reverse()
      .find((m) => m.from === partnerAgent);
    const lastPartnerTime = lastPartnerMsg
      ? new Date(lastPartnerMsg.timestamp)
      : null;
    const secondsSinceLastPartner = lastPartnerTime
      ? (Date.now() - lastPartnerTime.getTime()) / 1000
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

    const budget = computeBudget(status, messages);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_type: status?.type || "unknown",
              host_agent: getSessionHostAgent(status),
              partner_agent: partnerAgent,
              runner_alive: alive,
              runner_pid: status?.runner_pid,
              partner_currently_processing: processing,
              seconds_since_last_partner_message: secondsSinceLastPartner,
              ...(partnerAgent === "codex"
                ? {
                    codex_currently_processing: processing,
                    seconds_since_last_codex_message: secondsSinceLastPartner,
                  }
                : {}),
              last_error: lastError,
              started_at: status?.started_at,
              recent_log: logTail,
              budget,
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
    const results = [];
    for (const sessionId of sessions) {
      try {
        const status = readStat(sessionId);
        const messages = readConv(sessionId);
        const alive = status?.runner_pid
          ? isProcessAlive(status.runner_pid)
          : false;
        const budget = computeBudget(status, messages);
        results.push({
          session_id: sessionId,
          type: sessionId.startsWith("review-") ? "review" : "dialog",
          started_at: status?.started_at,
          host_agent: getSessionHostAgent(status),
          partner_agent: getSessionPartnerAgent(status),
          message_count: messages.length,
          runner_alive: alive,
          budget,
          ...(status?.branch ? { branch: status.branch, base_branch: status.base_branch } : {}),
        });
      } catch {
        results.push({ session_id: sessionId, error: "failed to read session" });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
