#!/usr/bin/env node
/**
 * Dialog Runner - Background process that manages codex invocations
 *
 * Polls for new Claude messages. When one appears, invokes codex with the
 * full conversation history and writes the response back to the shared
 * conversation file. Handles timeouts, crashes, and graceful shutdown.
 *
 * Usage: node dialog-runner.mjs <session-dir> <project-path> [codex-command]
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { readConversation, appendMessage, sleep } from "./shared.mjs";

const sessionDir = process.argv[2];
const projectPath = process.argv[3] || process.cwd();
const codexCommand = process.argv[4] || "codex";
const SOFT_CAP = parseInt(process.argv[5], 10) || 5;
const HARD_CAP = SOFT_CAP + 5;
const REASONING_EFFORT = process.argv[6] || null;
const CODEX_MODEL = process.argv[7] || null;
const VALID_EFFORTS = ["low", "medium", "high", "xhigh"];

if (!sessionDir) {
  process.exit(1);
}

const PROBLEM_PATH = path.join(sessionDir, "problem.md");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "codex_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const MAX_TURNS = HARD_CAP;
const POLL_INTERVAL_MS = 3000;
const CODEX_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes per invocation
const MAX_IDLE_MS = 15 * 60 * 1000; // 15 min with no new claude msgs = exit
const MAX_CONVERSATION_MESSAGES = 30; // truncate older messages in prompt

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

// ── Codex prompt builder ─────────────────────────────────────────────────────

function buildRoundBudgetBlock(codexTurns, softCap, hardCap) {
  const currentRound = codexTurns + 1;
  const remaining = Math.max(0, softCap - currentRound);
  const pastSoft = currentRound > softCap;

  let block = `## Round Budget

This session has a soft budget of ${softCap} rounds. You are writing round ${currentRound} of ${softCap}. Rounds remaining after this one: ${remaining}.
`;

  if (pastSoft) {
    block += `
**OVERTIME:** You are past the soft budget (round ${currentRound}, soft cap ${softCap}, hard cap ${hardCap}). Continue only if the remaining issues genuinely require more back-and-forth. Otherwise wrap up with a final summary this round.
`;
  }

  block += `
How to use the budget well:

1. **Include everything you have in this message.** Do not hold findings, concerns, or suggestions back for "next round." If your investigation surfaced ten items, include all ten here. Future rounds are for verifying fixes and genuine follow-ups — not for releasing material you already had. Drip-feeding burns rounds and risks the conversation ending before you raise important points.

2. **Consolidate and order by severity.** Group related items. Lead with the highest-severity categories first. Stylistic or cosmetic points, if any, belong in a single short "Nits" section at the end — or are omitted entirely.

3. **Signal over noise.** An item earns a slot only if a reasonable senior engineer would change a decision based on it. Skip style, naming, and cosmetic preferences unless they impact correctness or understanding. If nothing serious survives investigation, say so plainly — a short honest response is better than padding the list.

4. **Thoroughness, not speed.** The budget is not a countdown clock. Take the time to investigate each item properly before you write. The goal is that when you DO write, your message is COMPLETE. Brevity of conversation, not brevity of message.
`;

  return block;
}

function buildCodexPrompt(problem, messages, codexTurns) {
  // Keep conversation manageable - truncate old messages but keep first + recent
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

  let prompt = `You are participating in a technical discussion with Claude Code (Anthropic's AI coding assistant) about a challenging problem. You are "Codex" in this conversation.

Your goal is to collaboratively solve the problem by bringing your own independent analysis, ideas, and critical thinking. You and Claude are working TOGETHER - you should build on each other's ideas while also challenging weak reasoning.

${buildRoundBudgetBlock(codexTurns, SOFT_CAP, HARD_CAP)}

## Problem Description
${problem}

## Project Directory
${projectPath}

You can read any files in this directory to understand the code.

`;

  if (conversationMessages.length > 0) {
    prompt += `## Conversation So Far\n`;
    for (const msg of conversationMessages) {
      if (msg.id === -1) {
        prompt += `\n${msg.content}\n`;
        continue;
      }
      const speaker =
        msg.from === "claude"
          ? "Claude"
          : msg.from === "system"
            ? "System"
            : "Codex (you)";
      prompt += `\n### ${speaker} [message #${msg.id}]:\n${msg.content}\n`;
    }
    prompt += `\n`;
  }

  prompt += `## Your Task
- Read the conversation above carefully and provide your next response.
- Think deeply about the problem. Explore relevant code files before responding.
- If Claude made a suggestion, evaluate it critically - point out flaws or improvements.
- If you have a new idea, explain your reasoning step by step.
- Propose concrete solutions: specific files, functions, line numbers, code changes.
- If you agree with Claude's analysis, say so but ADD something new - a refinement, edge case, or next step.
- Be direct and technical. No filler.
- Respect the round budget above: deliver complete feedback this message; do not save material for later rounds.

## File References (IMPORTANT)
At the very end of your response, on its own line, list every source file you referenced or made claims about using exactly this format:
REFERENCED_FILES: path/to/file1.ext, path/to/file2.ext
Use paths relative to the project root (${projectPath}). This line is machine-parsed to ensure your discussion partner verifies your claims by reading the actual code. If you made no file-specific claims, omit this line entirely.

Respond with ONLY your message (plus the REFERENCED_FILES line). Do NOT wrap it in any JSON or metadata.`;

  return prompt;
}

// ── Codex invocation ─────────────────────────────────────────────────────────

async function runCodex(prompt) {
  return new Promise((resolve, reject) => {
    // Write prompt to /tmp so codex can read it (sessionDir is outside codex's sandbox)
    const promptPath = path.join(os.tmpdir(), `codex-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(promptPath, prompt);

    // Tell codex to read the prompt file - keeps CLI arg short
    const shortPrompt = `Read the discussion prompt file at ${promptPath} and follow its instructions. Respond with your analysis.`;

    log(`Invoking ${codexCommand} (prompt: ${prompt.length} chars)`);

    const args = ["exec", "--full-auto"];
    if (CODEX_MODEL) {
      args.push("--model", CODEX_MODEL);
    }
    if (REASONING_EFFORT && VALID_EFFORTS.includes(REASONING_EFFORT)) {
      args.push("-c", `model_reasoning_effort=${REASONING_EFFORT}`);
    }
    args.push(shortPrompt);

    const codex = spawn(codexCommand, args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log("Codex invocation timed out, killing process");
      try {
        codex.kill("SIGTERM");
      } catch {}
      // Force kill after 10s if still alive
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
        reject(new Error("Codex timed out after 15 minutes"));
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
  const problem = fs.readFileSync(PROBLEM_PATH, "utf-8");

  let lastProcessedId = 0;
  let codexTurns = 0;
  let lastClaudeMessageTime = Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  log("=== Dialog runner started ===");
  log(`Project: ${projectPath}`);
  log(`Codex command: ${codexCommand}`);
  log(`Soft cap: ${SOFT_CAP} rounds, hard cap: ${HARD_CAP} rounds`);
  log(`Model: ${CODEX_MODEL || "default"}`);
  log(`Reasoning effort: ${REASONING_EFFORT || "codex default"}`);
  log(`Max idle: ${MAX_IDLE_MS / 1000}s`);

  while (codexTurns < MAX_TURNS) {
    // Check for end signal
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected, shutting down gracefully");
      break;
    }

    // Read current conversation
    const messages = readConversation(sessionDir);

    // Find new messages from Claude that we haven't processed
    const newClaudeMessages = messages.filter(
      (m) => m.id > lastProcessedId && m.from === "claude"
    );

    if (newClaudeMessages.length > 0) {
      // Update tracking
      lastClaudeMessageTime = Date.now();
      lastProcessedId = messages[messages.length - 1].id;

      log(
        `New Claude message(s) detected (latest id: ${lastProcessedId}). Starting codex turn ${codexTurns + 1}...`
      );

      // Mark as processing
      fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
      // Clear any previous error
      try {
        fs.unlinkSync(ERROR_PATH);
      } catch {}

      try {
        const prompt = buildCodexPrompt(problem, messages, codexTurns);
        const response = await runCodex(prompt);

        if (response) {
          appendMessage(sessionDir, "codex", response);
          codexTurns++;
          consecutiveErrors = 0;
          log(
            `Codex turn ${codexTurns} complete (${response.length} chars). Waiting for Claude...`
          );
        } else {
          throw new Error("Empty response from codex");
        }
      } catch (err) {
        consecutiveErrors++;
        log(`Error on codex turn: ${err.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
        fs.writeFileSync(ERROR_PATH, `${err.message}\n\nConsecutive errors: ${consecutiveErrors}`);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("Too many consecutive errors, shutting down");
          appendMessage(
            sessionDir,
            "system",
            `Dialog runner encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors and is shutting down. Last error: ${err.message}`
          );
          break;
        }
      }

      // Remove processing flag
      try {
        fs.unlinkSync(PROCESSING_PATH);
      } catch {}
    } else {
      // No new messages - check idle timeout
      const idleMs = Date.now() - lastClaudeMessageTime;
      if (idleMs > MAX_IDLE_MS) {
        log(`Idle timeout reached (${(idleMs / 1000).toFixed(0)}s). Shutting down.`);
        appendMessage(
          sessionDir,
          "system",
          "Dialog runner shut down due to inactivity. Start a new dialog to continue the discussion."
        );
        break;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (codexTurns >= MAX_TURNS) {
    log(`Hard cap (${HARD_CAP}) reached`);
    appendMessage(
      sessionDir,
      "system",
      `Hard round cap (${HARD_CAP}) reached — soft budget was ${SOFT_CAP}. No further Codex turns will be invoked in this session. Summarize remaining findings and start a new dialog if more discussion is needed.`
    );
  }

  // Cleanup processing flag
  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  log("=== Dialog runner exiting ===");
}

main().catch((err) => {
  log(`Fatal error: ${err.message}\n${err.stack}`);
  try {
    fs.writeFileSync(ERROR_PATH, `Fatal: ${err.message}`);
  } catch {}
  process.exit(1);
});
