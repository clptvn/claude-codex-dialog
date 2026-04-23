import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { getAgentDisplayName, normalizeAgent } from "./shared.mjs";

const VALID_CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const VALID_CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function buildInvocation({
  partnerAgent,
  partnerCommand,
  promptPath,
  projectPath,
  model,
  reasoningEffort,
  responseInstruction,
}) {
  const normalizedAgent = normalizeAgent(partnerAgent, "codex");
  const instruction =
    responseInstruction || "Respond with your analysis.";
  const shortPrompt = `Read the prompt file at ${promptPath} and follow its instructions. ${instruction}`;

  if (normalizedAgent === "claude") {
    const args = [
      "-p",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Read,Grep,Glob,Bash,LSP",
      "--add-dir",
      projectPath,
    ];
    if (model) {
      args.push("--model", model);
    }
    if (reasoningEffort && VALID_CLAUDE_EFFORTS.has(reasoningEffort)) {
      args.push("--effort", reasoningEffort);
    }
    // --add-dir is variadic, so terminate option parsing before the prompt.
    args.push("--");
    args.push(shortPrompt);
    return { command: partnerCommand, args };
  }

  const args = ["exec", "--full-auto"];
  if (model) {
    args.push("--model", model);
  }
  if (reasoningEffort && VALID_CODEX_EFFORTS.has(reasoningEffort)) {
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  args.push(shortPrompt);
  return { command: partnerCommand, args };
}

export async function runPartnerCommand({
  partnerAgent,
  partnerCommand,
  prompt,
  projectPath,
  model,
  reasoningEffort,
  timeoutMs,
  log,
  tempPrefix,
  responseInstruction,
}) {
  const normalizedAgent = normalizeAgent(partnerAgent, "codex");
  const partnerDisplay = getAgentDisplayName(normalizedAgent);

  return new Promise((resolve, reject) => {
    const promptPath = path.join(
      os.tmpdir(),
      `${tempPrefix || normalizedAgent}-prompt-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.md`
    );
    fs.writeFileSync(promptPath, prompt);

    const { command, args } = buildInvocation({
      partnerAgent: normalizedAgent,
      partnerCommand,
      promptPath,
      projectPath,
      model,
      reasoningEffort,
      responseInstruction,
    });

    log(
      `Invoking ${partnerDisplay} via "${command}" (prompt: ${prompt.length} chars)`
    );

    const child = spawn(command, args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log(`${partnerDisplay} invocation timed out, killing process`);
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 10000);
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(promptPath);
      } catch {}

      if (timedOut) {
        reject(new Error(`${partnerDisplay} timed out after ${timeoutMs}ms`));
        return;
      }

      const response = stdout.trim();
      if (response) {
        resolve(response);
        return;
      }

      reject(
        new Error(
          `${partnerDisplay} exited with code ${code}, no stdout. stderr: ${stderr
            .trim()
            .slice(0, 500)}`
        )
      );
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      try {
        fs.unlinkSync(promptPath);
      } catch {}
      reject(err);
    });
  });
}
