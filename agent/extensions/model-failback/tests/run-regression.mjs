import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const tempDir = await mkdtemp(join(tmpdir(), "model-failback-regression-"));
const resultPath = join(tempDir, "result.json");
const probePath = fileURLToPath(new URL("./regression-probe.ts", import.meta.url));
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

// 可选用例名子串过滤：`node tests/run-regression.mjs ttl` 或 MODEL_FAILBACK_TEST_FILTER=ttl
const filter = process.argv[2]?.trim() || process.env.MODEL_FAILBACK_TEST_FILTER?.trim() || undefined;

try {
  const child = await runPi(
    ["--no-extensions", "-e", extensionPath, "-e", probePath, "--list-models", "opencode-go"],
    {
      ...process.env,
      PI_OFFLINE: "1",
      MODEL_FAILBACK_TEST_RESULT: resultPath,
      ...(filter ? { MODEL_FAILBACK_TEST_FILTER: filter } : {}),
    },
  );

  let result;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    console.error("回归测试未生成有效 JSON 结果:", error instanceof Error ? error.message : String(error));
    if (child.stderr) console.error(child.stderr.trim());
    process.exitCode = 1;
    await rm(tempDir, { recursive: true, force: true });
    process.exit();
  }

  for (const test of result.results ?? []) {
    console.log(`${test.passed ? "PASS" : "FAIL"} ${test.name}${test.detail ? ` — ${test.detail}` : ""}`);
  }
  const skipped = typeof result.total === "number" && typeof result.matched === "number"
    ? result.total - result.matched
    : 0;
  if (filter) console.log(`\n过滤器 "${filter}"：命中 ${result.matched ?? 0} 个用例，跳过 ${skipped} 个`);
  console.log(`\n${result.passed ? "回归测试通过" : "回归测试失败"}`);

  if (child.code !== 0 || child.signal || result.passed !== true) {
    if (child.stderr) console.error(child.stderr.trim());
    process.exitCode = 1;
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
