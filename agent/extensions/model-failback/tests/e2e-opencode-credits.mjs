// WARNING: this test makes real provider calls. Run only when the opencode account has no balance.
// It also requires working credentials for opencode and rightcode-codex.

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function runPi(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function assistantText(message) {
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

const tempDir = await mkdtemp(join(tmpdir(), "model-failback-e2e-"));
const agentDir = tempDir;
const sourceAgentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~/, process.env.HOME ?? "")
  ?? join(process.env.HOME ?? "", ".pi", "agent");
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

try {
  // Keep the real credentials/catalog while giving this run an isolated failback config.
  await cp(join(sourceAgentDir, "auth.json"), join(agentDir, "auth.json"));
  await cp(join(sourceAgentDir, "models.json"), join(agentDir, "models.json"));
  await cp(join(sourceAgentDir, "models-store.json"), join(agentDir, "models-store.json"));
  await writeFile(
    join(agentDir, "model-failback.json"),
    JSON.stringify({
      fallbacks: {
        "opencode/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol",
      },
      cooldownMs: 0,
      autoRestore: false,
    }, null, 2) + "\n",
    "utf8",
  );

  const child = await runPi(
    [
      "--no-extensions",
      "-e", extensionPath,
      "--mode", "json",
      "-p",
      "--no-session",
      "--model", "opencode/gpt-5.6-sol",
      "Task: Reply with exactly: failback-ok",
    ],
    {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
    },
  );

  const messages = child.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === "message_end" && event.message?.role === "assistant"
          ? [event.message]
          : [];
      } catch {
        return [];
      }
    });

  const creditsIndex = messages.findIndex((message) =>
    message.provider === "opencode" &&
    message.stopReason === "error" &&
    typeof message.errorMessage === "string" &&
    /CreditsError/i.test(message.errorMessage),
  );
  const successIndex = messages.findIndex((message, index) =>
    index > creditsIndex &&
    message.provider === "rightcode-codex" &&
    message.model === "gpt-5.6-sol" &&
    message.stopReason === "stop" &&
    assistantText(message) === "failback-ok",
  );

  if (child.code !== 0 || child.signal) {
    throw new Error(`pi exited unsuccessfully (${child.code ?? child.signal})\n${child.stderr}`);
  }
  if (creditsIndex < 0) throw new Error("did not receive opencode CreditsError assistant message");
  if (successIndex < 0) throw new Error("did not receive rightcode-codex/gpt-5.6-sol assistant message failback-ok");

  console.log("E2E PASS: opencode CreditsError → rightcode-codex/gpt-5.6-sol failback-ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
