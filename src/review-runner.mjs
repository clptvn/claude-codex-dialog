#!/usr/bin/env node
/**
 * Review Runner - Background process that manages codex code review invocations
 *
 * Similar to dialog-runner.mjs but specialized for code review:
 * - Auto-starts: Codex generates an initial review from the diff without waiting for Claude
 * - Longer timeouts to account for both sides investigating code
 * - Review-specific prompts with diff context and structured feedback categories
 *
 * Usage: node review-runner.mjs <session-dir> <project-path> [codex-command]
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { readConversation, appendMessage, sleep } from "./shared.mjs";

const sessionDir = process.argv[2];
const projectPath = process.argv[3] || process.cwd();
const codexCommand = process.argv[4] || "codex";

if (!sessionDir) {
  process.exit(1);
}

const CONVERSATION_PATH = path.join(sessionDir, "conversation.jsonl");
const DIFF_PATH = path.join(sessionDir, "diff.patch");
const META_PATH = path.join(sessionDir, "review_meta.json");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "codex_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const MAX_TURNS = 30;
const POLL_INTERVAL_MS = 5000;
const CODEX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per invocation
const MAX_IDLE_MS = 30 * 60 * 1000; // 30 min idle timeout
const MAX_CONVERSATION_MESSAGES = 20;
const MAX_DIFF_CHARS = 50000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

// ── Review prompt builder ───────────────────────────────────────────────────

function buildReviewPrompt(diff, meta, messages) {
  let conversationMessages = messages;
  if (messages.length > MAX_CONVERSATION_MESSAGES) {
    const first = messages.slice(0, 2);
    const recent = messages.slice(-(MAX_CONVERSATION_MESSAGES - 2));
    conversationMessages = [
      ...first,
      {
        id: -1,
        from: "system",
        content: `[... ${messages.length - MAX_CONVERSATION_MESSAGES} earlier messages omitted ...]`,
        timestamp: "",
      },
      ...recent,
    ];
  }

  // Truncate diff if huge
  let diffContent = diff;
  let diffTruncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diffContent = diff.slice(0, MAX_DIFF_CHARS);
    diffTruncated = true;
  }

  let prompt = `You are a thorough code reviewer examining changes on branch "${meta.branch}" compared to "${meta.base_branch}".

## Review Focus
${meta.review_focus || "General code review — correctness, edge cases, error handling, naming, test coverage."}

## Changed Files
${meta.diff_stat || "(no stat available)"}

## The Diff
\`\`\`diff
${diffContent}
\`\`\`
${diffTruncated ? `\n**Note:** The diff was truncated (${diff.length} chars total, showing first ${MAX_DIFF_CHARS}). Read the full files in the project directory to see all changes.\n` : ""}

## Project Directory
${projectPath}

You can read any files in this directory to understand context beyond the diff.

`;

  if (conversationMessages.length > 0) {
    prompt += `## Conversation So Far\n`;
    for (const msg of conversationMessages) {
      if (msg.id === -1) {
        prompt += `\n${msg.content}\n`;
        continue;
      }
      const speaker = msg.from === "claude" ? "Claude" : "Codex (you)";
      prompt += `\n### ${speaker} [message #${msg.id}]:\n${msg.content}\n`;
    }
    prompt += `\n`;
  }

  const isInitialReview = conversationMessages.length === 0;

  if (isInitialReview) {
    prompt += `## Your Task — Initial Review
- Examine each changed file carefully. Read the FULL file (not just the diff) to understand context.
- For each significant finding, cite the file and line number.
- Categorize findings: [CRITICAL] for bugs/security issues, [SUGGESTION] for improvements, [QUESTION] for things needing clarification, [PRAISE] for good patterns worth noting.
- Be specific. "This might have issues" is not useful. "Line 42 of foo.ts: the null check is missing for the case where X is undefined because Y" is useful.
${meta.review_focus ? `- Prioritize your review around: ${meta.review_focus}` : ""}
- At the end, give an overall assessment: approve, request changes, or needs discussion.

Respond with ONLY your review. Do NOT wrap it in any JSON or metadata.`;
  } else {
    prompt += `## Your Task — Follow-up
- Address Claude's responses to your review comments.
- If Claude fixed something, verify the fix looks correct by reading the current file.
- If Claude disagreed with a finding, either accept their reasoning or explain why you still think there's an issue.
- If new issues came up in discussion, address those too.
- When all significant issues are resolved, say "LGTM" with a brief summary of what was reviewed and resolved.

Respond with ONLY your message. Do NOT wrap it in any JSON or metadata.`;
  }

  return prompt;
}

// ── Codex invocation ─────────────────────────────────────────────────────────

async function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    const promptPath = path.join(sessionDir, "current_prompt.md");
    fs.writeFileSync(promptPath, prompt);

    const shortPrompt = `Read the code review prompt file at ${promptPath} and follow its instructions. Respond with your review.`;

    log(`Invoking ${codexCommand} for review (prompt: ${prompt.length} chars)`);

    const codex = spawn(codexCommand, ["exec", "--full-auto", shortPrompt], {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log("Codex review invocation timed out, killing process");
      try {
        codex.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          codex.kill("SIGKILL");
        } catch {}
      }, 10000);
    }, CODEX_TIMEOUT_MS);

    codex.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    codex.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    codex.on("close", (code) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(promptPath);
      } catch {}

      if (timedOut) {
        reject(new Error("Codex timed out after 10 minutes"));
        return;
      }

      const response = stdout.trim();
      if (response) {
        resolve(response);
      } else {
        reject(
          new Error(
            `Codex exited with code ${code}, no stdout. stderr: ${stderr.slice(0, 500)}`
          )
        );
      }
    });

    codex.on("error", (err) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(promptPath);
      } catch {}
      reject(err);
    });
  });
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const diff = fs.readFileSync(DIFF_PATH, "utf-8");
  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));

  let lastProcessedId = 0;
  let codexTurns = 0;
  let lastActivityTime = Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  log("=== Review runner started ===");
  log(`Project: ${projectPath}`);
  log(`Branch: ${meta.branch} vs ${meta.base_branch}`);
  log(`Codex command: ${codexCommand}`);
  log(`Review focus: ${meta.review_focus || "general"}`);
  log(`Max turns: ${MAX_TURNS}, Codex timeout: ${CODEX_TIMEOUT_MS / 1000}s, Idle timeout: ${MAX_IDLE_MS / 1000}s`);

  // ── Auto-start: generate initial review without waiting for Claude ──
  log("Generating initial review from diff...");
  fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
  try {
    fs.unlinkSync(ERROR_PATH);
  } catch {}

  try {
    const prompt = buildReviewPrompt(diff, meta, []);
    const response = await runCodex(prompt);

    if (response) {
      appendMessage(sessionDir, "codex", response);
      codexTurns++;
      lastActivityTime = Date.now();
      log(`Initial review complete (${response.length} chars). Waiting for Claude...`);
    } else {
      throw new Error("Empty response from codex on initial review");
    }
  } catch (err) {
    consecutiveErrors++;
    log(`Error on initial review: ${err.message}`);
    fs.writeFileSync(ERROR_PATH, err.message);
    appendMessage(
      sessionDir,
      "codex",
      `[SYSTEM] Failed to generate initial review: ${err.message}. Claude can still send messages to retry.`
    );
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  // ── Poll loop: wait for Claude responses ──
  while (codexTurns < MAX_TURNS) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected, shutting down gracefully");
      break;
    }

    const messages = readConversation(sessionDir);

    const newClaudeMessages = messages.filter(
      (m) => m.id > lastProcessedId && m.from === "claude"
    );

    if (newClaudeMessages.length > 0) {
      lastActivityTime = Date.now();
      lastProcessedId = messages[messages.length - 1].id;

      log(
        `New Claude message(s) detected (latest id: ${lastProcessedId}). Starting review turn ${codexTurns + 1}...`
      );

      fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
      try {
        fs.unlinkSync(ERROR_PATH);
      } catch {}

      try {
        const prompt = buildReviewPrompt(diff, meta, messages);
        const response = await runCodex(prompt);

        if (response) {
          appendMessage(sessionDir, "codex", response);
          codexTurns++;
          consecutiveErrors = 0;
          log(
            `Review turn ${codexTurns} complete (${response.length} chars). Waiting for Claude...`
          );
        } else {
          throw new Error("Empty response from codex");
        }
      } catch (err) {
        consecutiveErrors++;
        log(`Error on review turn: ${err.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
        fs.writeFileSync(ERROR_PATH, `${err.message}\n\nConsecutive errors: ${consecutiveErrors}`);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("Too many consecutive errors, shutting down");
          appendMessage(
            sessionDir,
            "codex",
            `[SYSTEM] Review runner encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors and is shutting down. Last error: ${err.message}`
          );
          break;
        }
      }

      try {
        fs.unlinkSync(PROCESSING_PATH);
      } catch {}
    } else {
      const idleMs = Date.now() - lastActivityTime;
      if (idleMs > MAX_IDLE_MS) {
        log(`Idle timeout reached (${(idleMs / 1000).toFixed(0)}s). Shutting down.`);
        appendMessage(
          sessionDir,
          "codex",
          "[SYSTEM] Review runner shut down due to inactivity. Start a new review to continue."
        );
        break;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (codexTurns >= MAX_TURNS) {
    log(`Max turns (${MAX_TURNS}) reached`);
    appendMessage(
      sessionDir,
      "codex",
      `[SYSTEM] Maximum review turns (${MAX_TURNS}) reached. Summarize findings and start a new review if more discussion is needed.`
    );
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  log("=== Review runner exiting ===");
}

main().catch((err) => {
  log(`Fatal error: ${err.message}\n${err.stack}`);
  try {
    fs.writeFileSync(ERROR_PATH, `Fatal: ${err.message}`);
  } catch {}
  process.exit(1);
});
