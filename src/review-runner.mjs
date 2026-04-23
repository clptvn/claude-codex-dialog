#!/usr/bin/env node
/**
 * Review Runner - Background process that manages partner code review invocations
 *
 * Similar to dialog-runner.mjs but specialized for code review:
 * - Auto-starts: the partner generates an initial review from the diff
 * - Longer timeouts to account for both sides investigating code
 * - Review-specific prompts with diff context and structured feedback categories
 */

import fs from "fs";
import path from "path";
import {
  appendMessage,
  getAgentDisplayName,
  normalizeAgent,
  readConversation,
  sleep,
} from "./shared.mjs";
import { runPartnerCommand } from "./partner-invocation.mjs";

const sessionDir = process.argv[2];
const projectPath = process.argv[3] || process.cwd();
const partnerCommand = process.argv[4] || "codex";
const SOFT_CAP = parseInt(process.argv[5], 10) || 5;
const HARD_CAP = SOFT_CAP + 5;
const REASONING_EFFORT = process.argv[6] || null;
const PARTNER_MODEL = process.argv[7] || null;
const HOST_AGENT = normalizeAgent(process.argv[8], "claude");
const PARTNER_AGENT = normalizeAgent(process.argv[9], "codex");

if (!sessionDir || HOST_AGENT === PARTNER_AGENT) {
  process.exit(1);
}

const HOST_DISPLAY = getAgentDisplayName(HOST_AGENT);
const PARTNER_DISPLAY = getAgentDisplayName(PARTNER_AGENT);
const DIFF_PATH = path.join(sessionDir, "diff.patch");
const REFRESHED_DIFF_PATH = path.join(sessionDir, "diff_refreshed.patch");
const META_PATH = path.join(sessionDir, "review_meta.json");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "partner_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const MAX_TURNS = HARD_CAP;
const POLL_INTERVAL_MS = 5000;
const PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_IDLE_MS = 30 * 60 * 1000;
const MAX_CONVERSATION_MESSAGES = 20;
const MAX_DIFF_CHARS = 50000;

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

function buildRoundBudgetBlock(partnerTurns, softCap, hardCap) {
  const currentRound = partnerTurns + 1;
  const remaining = Math.max(0, softCap - currentRound);
  const pastSoft = currentRound > softCap;

  let block = `## Round Budget

This review has a soft budget of ${softCap} rounds. You are writing round ${currentRound} of ${softCap}. Rounds remaining after this one: ${remaining}.
`;

  if (pastSoft) {
    block += `
**OVERTIME:** You are past the soft budget (round ${currentRound}, soft cap ${softCap}, hard cap ${hardCap}). Continue only if the remaining issues genuinely require more back-and-forth. Otherwise wrap up with a final summary this round and approve if appropriate.
`;
  }

  block += `
How to use the budget well:

1. **Dump every finding in this message.** Do not hold findings back for "next round." If your investigation surfaced ten issues, include all ten here. Future rounds are for verifying fixes and genuine follow-ups — not for releasing material you already had. Drip-feeding burns rounds and risks the review ending before you raise important findings.

2. **Consolidate and order by severity.** Group related findings. Lead with CRITICAL, then CORRECTNESS / ARCHITECTURE / SECURITY / ROBUSTNESS, then SUGGESTION, then a single short "Nits" section at the end — or omit nits entirely.

3. **Signal over noise.** A finding earns a slot only if a reasonable senior engineer would change a decision based on it. Skip style, naming, and cosmetic preferences unless they impact correctness or understanding. If nothing serious survives investigation after you've genuinely looked, say so plainly — a short honest review is better than padding the list with manufactured concerns.

4. **Thoroughness, not speed.** The budget is not a countdown clock. Take the time to investigate each finding properly before you write. The goal is that when you DO write, your message is COMPLETE. Brevity of conversation, not brevity of message.
`;

  return block;
}

function buildReviewPrompt(originalDiff, refreshedDiff, meta, messages, partnerTurns) {
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

  const activeDiff = refreshedDiff ?? originalDiff;
  let diffContent = activeDiff;
  let diffTruncated = false;
  if (activeDiff.length > MAX_DIFF_CHARS) {
    diffContent = activeDiff.slice(0, MAX_DIFF_CHARS);
    diffTruncated = true;
  }

  let diffSection;
  if (refreshedDiff != null) {
    diffSection = `## Updated Changes (after fixes)

The original diff was included in your initial review (round 1 above). The reviewer has made fixes since then. Below is the current state of all changes. Compare against the original to verify fixes were applied correctly and check for any new issues introduced by the fixes.

\`\`\`diff
${diffContent}
\`\`\`
${diffTruncated ? `\n**Note:** The updated diff was truncated (${activeDiff.length} chars total, showing first ${MAX_DIFF_CHARS}). Read the full files in the project directory to see all changes.\n` : ""}`;
  } else {
    diffSection = `## The Diff
\`\`\`diff
${diffContent}
\`\`\`
${diffTruncated ? `\n**Note:** The diff was truncated (${activeDiff.length} chars total, showing first ${MAX_DIFF_CHARS}). Read the full files in the project directory to see all changes.\n` : ""}`;
  }

  let prompt = `You are a thorough code reviewer examining ${meta.diff_label || `changes on branch "${meta.branch}" compared to "${meta.base_branch}"`}.

${buildRoundBudgetBlock(partnerTurns, SOFT_CAP, HARD_CAP)}

## Review Focus
${meta.review_focus || "General code review — correctness, edge cases, error handling, naming, test coverage."}

## Changed Files
${meta.diff_stat || "(no stat available)"}

${diffSection}

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
      const speaker =
        msg.from === HOST_AGENT
          ? HOST_DISPLAY
          : msg.from === "system"
            ? "System"
            : `${PARTNER_DISPLAY} (you)`;
      prompt += `\n### ${speaker} [message #${msg.id}]:\n${msg.content}\n`;
    }
    prompt += `\n`;
  }

  const isInitialReview = partnerTurns === 0;

  const refFilesBlock = `
## File References (IMPORTANT)
At the very end of your response, on its own line, list every source file you referenced or made claims about using exactly this format:
REFERENCED_FILES: path/to/file1.ext, path/to/file2.ext
Use paths relative to the project root (${projectPath}). This line is machine-parsed to ensure your discussion partner verifies your claims by reading the actual code. If you made no file-specific claims, omit this line entirely.`;

  if (isInitialReview) {
    prompt += `## Your Task — Initial Review
- Examine each changed file carefully. Read the full file (not just the diff) to understand context.
- For each significant finding, cite the file and line number.
- Be specific. "This might have issues" is not useful. "Line 42 of foo.ts: the null check is missing for the case where X is undefined because Y" is useful.
${meta.review_focus ? `- Prioritize your review around: ${meta.review_focus}` : ""}
- Categorize each finding (definitions matter — do not inflate categories):
  - **[CRITICAL]** — bugs, security issues, data loss risk, correctness failures. Must address.
  - **[CORRECTNESS]** — logic errors, edge cases, race conditions, incorrect error handling.
  - **[ARCHITECTURE]** — design problems, coupling issues, broken abstractions.
  - **[SECURITY]** — input validation, auth, secrets, unsafe patterns.
  - **[ROBUSTNESS]** — error paths, resource cleanup, partial failure handling.
  - **[SUGGESTION]** — concrete improvement with demonstrable benefit. Not a stylistic preference. If you cannot explain why a senior engineer would adopt it, omit it.
  - **[QUESTION]** — needs clarification before you can conclude. Used sparingly.
  - **[PRAISE]** — optional; call out a pattern genuinely worth keeping, kept to one or two lines. Only when honest — forced praise is worthless.
  - **[NIT]** — cosmetic/stylistic. Group into one short trailing "Nits" section or omit entirely.
- Deliver the complete review in this message. Do not hold findings back for later rounds.
- At the end, give an overall assessment: approve, request changes, or needs discussion.
${refFilesBlock}

Respond with ONLY your review (plus the REFERENCED_FILES line). Do NOT wrap it in any JSON or metadata.`;
  } else {
    prompt += `## Your Task — Follow-up
- Address ${HOST_DISPLAY}'s responses to your review comments.
- If ${HOST_DISPLAY} fixed something, verify the fix looks correct by reading the current file.
- If ${HOST_DISPLAY} disagreed with a finding, either accept the reasoning or explain why you still think there is an issue.
- If new issues came up in discussion, address those too — but only if they meet the same severity bar as the initial review.
- Deliver complete follow-up in this message. Do not split follow-up findings across additional rounds.
- When all significant issues are resolved, say "LGTM" with a brief summary of what was reviewed and resolved.
${refFilesBlock}

Respond with ONLY your message (plus the REFERENCED_FILES line). Do NOT wrap it in any JSON or metadata.`;
  }

  return prompt;
}

async function main() {
  const originalDiff = fs.readFileSync(DIFF_PATH, "utf-8");
  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));

  let lastProcessedId = 0;
  let partnerTurns = 0;
  let lastActivityTime = Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  log("=== Review runner started ===");
  log(`Project: ${projectPath}`);
  log(`Branch: ${meta.branch} vs ${meta.base_branch}`);
  log(`Host agent: ${HOST_DISPLAY}`);
  log(`Partner agent: ${PARTNER_DISPLAY}`);
  log(`Partner command: ${partnerCommand}`);
  log(`Review focus: ${meta.review_focus || "general"}`);
  log(`Soft cap: ${SOFT_CAP} rounds, hard cap: ${HARD_CAP} rounds, Partner timeout: ${PARTNER_TIMEOUT_MS / 1000}s, Idle timeout: ${MAX_IDLE_MS / 1000}s`);
  log(`Model: ${PARTNER_MODEL || "default"}`);
  log(`Reasoning effort: ${REASONING_EFFORT || "partner default"}`);

  log(`Generating initial review from diff with ${PARTNER_DISPLAY}...`);
  fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
  try {
    fs.unlinkSync(ERROR_PATH);
  } catch {}

  try {
    const prompt = buildReviewPrompt(originalDiff, null, meta, [], 0);
    const response = await runPartnerCommand({
      partnerAgent: PARTNER_AGENT,
      partnerCommand,
      prompt,
      projectPath,
      model: PARTNER_MODEL,
      reasoningEffort: REASONING_EFFORT,
      timeoutMs: PARTNER_TIMEOUT_MS,
      log,
      tempPrefix: `${PARTNER_AGENT}-review`,
      responseInstruction: "Respond with your review.",
    });

    appendMessage(sessionDir, PARTNER_AGENT, response);
    partnerTurns++;
    lastActivityTime = Date.now();
    log(
      `Initial review complete (${response.length} chars). Waiting for ${HOST_DISPLAY}...`
    );
  } catch (err) {
    consecutiveErrors++;
    log(`Error on initial review: ${err.message}`);
    fs.writeFileSync(ERROR_PATH, err.message);
    appendMessage(
      sessionDir,
      "system",
      `Failed to generate initial review: ${err.message}. ${HOST_DISPLAY} can still send messages to retry.`
    );
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  while (partnerTurns < MAX_TURNS) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected, shutting down gracefully");
      break;
    }

    const messages = readConversation(sessionDir);
    let refreshedDiff = null;
    if (fs.existsSync(REFRESHED_DIFF_PATH)) {
      try {
        refreshedDiff = fs.readFileSync(REFRESHED_DIFF_PATH, "utf-8");
      } catch {}
    }

    const newHostMessages = messages.filter(
      (m) => m.id > lastProcessedId && m.from === HOST_AGENT
    );

    if (newHostMessages.length > 0) {
      lastActivityTime = Date.now();
      lastProcessedId = messages.reduce(
        (max, m) =>
          typeof m.id === "number" && Number.isSafeInteger(m.id) && m.id > max
            ? m.id
            : max,
        0
      );

      log(
        `New ${HOST_DISPLAY} message(s) detected (latest id: ${lastProcessedId}). Starting review turn ${partnerTurns + 1}...`
      );

      fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
      try {
        fs.unlinkSync(ERROR_PATH);
      } catch {}

      try {
        const prompt = buildReviewPrompt(
          originalDiff,
          refreshedDiff,
          meta,
          messages,
          partnerTurns
        );
        const response = await runPartnerCommand({
          partnerAgent: PARTNER_AGENT,
          partnerCommand,
          prompt,
          projectPath,
          model: PARTNER_MODEL,
          reasoningEffort: REASONING_EFFORT,
          timeoutMs: PARTNER_TIMEOUT_MS,
          log,
          tempPrefix: `${PARTNER_AGENT}-review`,
          responseInstruction: "Respond with your review.",
        });

        appendMessage(sessionDir, PARTNER_AGENT, response);
        partnerTurns++;
        consecutiveErrors = 0;
        log(
          `Review turn ${partnerTurns} complete (${response.length} chars). Waiting for ${HOST_DISPLAY}...`
        );
      } catch (err) {
        consecutiveErrors++;
        log(
          `Error on review turn: ${err.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`
        );
        fs.writeFileSync(
          ERROR_PATH,
          `${err.message}\n\nConsecutive errors: ${consecutiveErrors}`
        );

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("Too many consecutive errors, shutting down");
          appendMessage(
            sessionDir,
            "system",
            `Review runner encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors and is shutting down. Last error: ${err.message}`
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
          "system",
          "Review runner shut down due to inactivity. Start a new review to continue."
        );
        break;
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (partnerTurns >= MAX_TURNS) {
    log(`Hard cap (${HARD_CAP}) reached`);
    appendMessage(
      sessionDir,
      "system",
      `Hard round cap (${HARD_CAP}) reached — soft budget was ${SOFT_CAP}. No further ${PARTNER_DISPLAY} turns will be invoked in this session. Summarize remaining findings and start a new review if more discussion is needed.`
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
