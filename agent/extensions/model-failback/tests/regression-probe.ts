import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryBanStore, PersistentBanStore } from "../core/ban-store";
import { createEngine } from "../core/engine";
import { DEFAULT_BAN_FILE_TTL_MS, resolveFallback } from "../core/config";
import { openaiCodexHandler } from "../providers/openai-codex";
import { opencodeGoHandler } from "../providers/opencode-go";
import { opencodeHandler } from "../providers/opencode";
import { modelscopeHandler } from "../providers/modelscope";
import { supportedProviders } from "../providers/registry";

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

type Handler = (...args: any[]) => unknown;

function expect(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

function assistantFailure(
  provider: string,
  model: string,
  errorMessage: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    stopReason: "error",
    provider,
    model,
    errorMessage,
  };
}

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly setModelCalls: unknown[] = [];
  readonly entries: Array<{ type: string; data: unknown }> = [];
  readonly userMessages: Array<{ content: unknown; options: unknown }> = [];

  on(event: string, handler: Handler): void {
    const current = this.handlers.get(event) ?? [];
    current.push(handler);
    this.handlers.set(event, current);
  }

  async setModel(model: unknown): Promise<boolean> {
    this.setModelCalls.push(model);
    return true;
  }

  appendEntry(type: string, data: unknown): void {
    this.entries.push({ type, data });
  }

  sendUserMessage(content: unknown, options: unknown): void {
    this.userMessages.push({ content, options });
  }
}

function makeContext(
  models: Array<{ provider: string; id: string }>,
  currentModel: { provider: string; id: string },
  autoCompleteCompact = true,
) {
  const notifications: Array<{ message: string; level: string }> = [];
  const compactCalls: unknown[] = [];
  const ctx = {
    model: currentModel,
    isIdle() {
      return true;
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return models.find((model) => model.provider === provider && model.id === id);
      },
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    compact(options: unknown) {
      compactCalls.push(options);
      if (autoCompleteCompact) (options as { onComplete?: () => void }).onComplete?.();
    },
  };
  return { ctx, notifications, compactCalls };
}

const CHAIN_MODELS = [
  { provider: "opencode", id: "gpt-5.6-sol" },
  { provider: "opencode-go", id: "deepseek-v4-flash" },
  { provider: "rightcode-codex", id: "gpt-5.6-luna" },
];

function creditsFailure(provider: string, model: string): Record<string, unknown> {
  return assistantFailure(provider, model, '{"type":"CreditsError","message":"Insufficient balance"}');
}

function waitForTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function engineHarness(
  config: { chains?: string[][]; fallbacks: Record<string, string>; cooldownMs?: number; maxConsecutive?: number },
  models: Array<{ provider: string; id: string }> = [],
  currentModel: { provider: string; id: string } = { provider: "openai-codex", id: "gpt-5.6-sol" },
  autoCompleteCompact = true,
) {
  const pi = new FakePi();
  const registryModels =
    models.length > 0 ? models : [currentModel, { provider: "rightcode-codex", id: "gpt-5.6-sol" }];
  const { ctx, notifications, compactCalls } = makeContext(registryModels, currentModel, autoCompleteCompact);
  const bans = new MemoryBanStore();
  const state = createEngine(pi as unknown as ExtensionAPI, () => config, bans);
  const messageEnd = pi.handlers.get("message_end")?.[0];
  const sessionStart = pi.handlers.get("session_start")?.[0];
  const compactFailed = pi.handlers.get("session_compact_failed")?.[0];
  const beforeSwitch = pi.handlers.get("session_before_switch")?.[0];
  const shutdown = pi.handlers.get("session_shutdown")?.[0];
  const agentStarts = pi.handlers.get("agent_start") ?? [];
  expect(messageEnd, "createEngine did not register message_end");
  expect(sessionStart, "createEngine did not register session_start");
  expect(compactFailed, "createEngine did not register session_compact_failed");
  expect(beforeSwitch, "createEngine did not register session_before_switch");
  expect(shutdown, "createEngine did not register session_shutdown");
  expect(agentStarts.length > 0, "createEngine did not register agent_start");

  return {
    pi,
    ctx,
    state,
    bans,
    notifications,
    compactCalls,
    async emit(message: Record<string, unknown>) {
      await messageEnd({ message }, ctx);
    },
    async emitSessionStart() {
      await sessionStart({}, ctx);
    },
    async emitCompactionFailed(
      errorMessage: string,
      aborted = false,
      reason: "manual" | "threshold" | "overflow" = "manual",
    ) {
      await compactFailed({ errorMessage, aborted, reason, willRetry: false }, ctx);
    },
    async emitBeforeSwitch() {
      await beforeSwitch({}, ctx);
    },
    async emitShutdown() {
      await shutdown({ reason: "reload" }, ctx);
    },
    async emitAgentStart() {
      for (const handler of agentStarts) await handler({}, ctx);
    },
  };
}

async function runTest(name: string, test: () => void | Promise<void>): Promise<TestResult> {
  try {
    await test();
    return { name, passed: true };
  } catch (error) {
    return {
      name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runRegressionTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  results.push(await runTest("openai-codex usage limit is cross-provider and has resetsAt", () => {
    const before = Date.now();
    const verdict = openaiCodexHandler.inspect(
      assistantFailure(
        "openai-codex",
        "gpt-5.6-sol",
        "You have hit your ChatGPT usage limit (plus plan). Try again in ~34 min.",
      ),
    );
    expect(verdict, "usage limit was not detected");
    expect(verdict.reason === "usage_limit", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
    expect(typeof verdict.resetsAt === "number", "resetsAt was not populated");
    expect(verdict.resetsAt! >= before + 33 * 60_000, "resetsAt is too early");
    expect(verdict.resetsAt! <= Date.now() + 35 * 60_000, "resetsAt is too late");
  }));

  results.push(await runTest("openai-codex stream usage limit is detected", () => {
    const verdict = openaiCodexHandler.inspect(
      assistantFailure("openai-codex", "gpt-5.6-terra", "Codex error: The usage limit has been reached"),
    );
    expect(verdict, "Codex stream usage-limit error was not detected");
    expect(verdict.reason === "usage_limit", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("opencode CreditsError is detected", () => {
    const verdict = opencodeHandler.inspect(
      assistantFailure(
        "opencode",
        "gpt-5.6-sol",
        'OpenAI API error (401): {"type":"CreditsError","message":"Insufficient balance"}',
      ),
    );
    expect(verdict, "opencode CreditsError was not detected");
    expect(verdict.reason === "credits_exhausted", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("opencode-go CreditsError is detected", () => {
    const verdict = opencodeGoHandler.inspect(
      assistantFailure(
        "opencode-go",
        "gpt-5.6-sol",
        '{"type":"CreditsError","message":"Insufficient credits"}',
      ),
    );
    expect(verdict, "opencode-go CreditsError was not detected");
    expect(verdict.reason === "credits_exhausted", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("opencode-go 503 endpoint unavailable is detected", () => {
    const verdict = opencodeGoHandler.inspect(
      assistantFailure(
        "opencode-go",
        "deepseek-v4-flash",
        'Error: 503: {"type":"server_error","message":"Error from provider (Console Go): Upstream request failed: Endpoint is unavailable."}',
      ),
    );
    expect(verdict, "opencode-go 503 endpoint error was not detected");
    expect(verdict.reason === "endpoint_unavailable", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("opencode endpoint 503 remains non-terminal", () => {
    const verdict = opencodeHandler.inspect(
      assistantFailure(
        "opencode",
        "gpt-5.6-sol",
        '503: {"type":"server_error","message":"Endpoint is unavailable"}',
      ),
    );
    expect(verdict === null, "opencode endpoint error should remain non-terminal");
  }));

  results.push(await runTest("opencode-go ModelError remains non-terminal", () => {
    const verdict = opencodeGoHandler.inspect(
      assistantFailure(
        "opencode-go",
        "gpt-5.6-sol",
        'ModelError: 503: {"type":"server_error","message":"Endpoint is unavailable"}',
      ),
    );
    expect(verdict === null, "opencode-go ModelError should remain non-terminal");
  }));

  results.push(await runTest("ModelError does not match CreditsError", () => {
    const verdict = opencodeHandler.inspect(
      assistantFailure(
        "opencode",
        "gpt-5.6-sol",
        'ModelError: {"type":"CreditsError","message":"Insufficient balance"}',
      ),
    );
    expect(verdict === null, "ModelError was incorrectly detected");
  }));

  results.push(await runTest("different provider does not match", () => {
    const verdict = opencodeHandler.inspect(
      assistantFailure(
        "opencode-go",
        "gpt-5.6-sol",
        '{"type":"CreditsError","message":"Insufficient balance"}',
      ),
    );
    expect(verdict === null, "a different provider was incorrectly detected");
  }));

  results.push(await runTest("unrelated error does not match", () => {
    const verdict = opencodeHandler.inspect(
      assistantFailure("opencode", "gpt-5.6-sol", "timeout while contacting the model"),
    );
    expect(verdict === null, "an unrelated error was incorrectly detected");
  }));

  results.push(await runTest("modelscope insufficient_quota is detected", () => {
    const verdict = modelscopeHandler.inspect(
      assistantFailure(
        "modelscope",
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        '429: {"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}',
      ),
    );
    expect(verdict, "modelscope quota exhaustion was not detected");
    expect(verdict.reason === "quota_exhausted", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("modelscope insufficient balance is detected", () => {
    const verdict = modelscopeHandler.inspect(
      assistantFailure(
        "modelscope",
        "Qwen/Qwen3.8-Flash-Next",
        '429: {"message":"insufficient balance","request_id":"b28841ac-1751-4d0b-83ad-f73965c570ac"}',
      ),
    );
    expect(verdict, "modelscope insufficient balance was not detected");
    expect(verdict.reason === "quota_exhausted", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("modelscope transient/auth errors do not match", () => {
    const auth = modelscopeHandler.inspect(
      assistantFailure("modelscope", "x", "401: InvalidApiKey"),
    );
    const rate = modelscopeHandler.inspect(
      assistantFailure("modelscope", "x", "429: Throttling.RateQuota, requests rate limit exceeded"),
    );
    expect(auth === null, "modelscope auth error should not match");
    expect(rate === null, "modelscope rate limit should not match");
  }));

  results.push(await runTest("resolveFallback resolves a chain A->B->C", () => {
    const config = {
      chains: [["opencode/*", "opencode-go/deepseek-v4-flash", "rightcode-codex/gpt-5.6-luna"]],
      fallbacks: {},
    };
    expect(
      resolveFallback(config, "opencode", "gpt-5.6-sol") === "opencode-go/deepseek-v4-flash",
      "first hop not resolved",
    );
    expect(
      resolveFallback(config, "opencode-go", "deepseek-v4-flash") === "rightcode-codex/gpt-5.6-luna",
      "second hop not resolved from middle node",
    );
    expect(
      resolveFallback(config, "rightcode-codex", "gpt-5.6-luna") === undefined,
      "tail node must resolve to undefined",
    );
  }));

  results.push(await runTest("resolveFallback keeps legacy fallbacks map", () => {
    const config = { fallbacks: { "opencode/*": "opencode-go/x" } };
    expect(
      resolveFallback(config, "opencode", "gpt-5.6-sol") === "opencode-go/x",
      "legacy fallbacks map not honored",
    );
  }));

  results.push(await runTest("resolveFallback prefers exact over wildcard", () => {
    const config = {
      chains: [
        ["opencode/*", "opencode-go/deepseek-v4-flash"],
        ["opencode/gpt-5.6-luna", "opencode/mimo-v2.5"],
      ],
      fallbacks: {},
    };
    expect(
      resolveFallback(config, "opencode", "gpt-5.6-luna") === "opencode/mimo-v2.5",
      "exact chain must win over an earlier wildcard",
    );
    expect(
      resolveFallback(config, "opencode", "gpt-5.6-sol") === "opencode-go/deepseek-v4-flash",
      "wildcard must still resolve models without an exact chain",
    );
  }));

  results.push(await runTest("persistent model ban survives a fresh process store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-failback-ban-"));
    const path = join(dir, "bans.json");
    try {
      const first = new PersistentBanStore(path);
      await first.mark("opencode/gpt-5.6-sol", {
        scope: "cross-provider",
        reason: "credits_exhausted",
        markedAt: Date.now(),
      });
      const fresh = new PersistentBanStore(path);
      await fresh.refresh();
      expect(fresh.isBlocked("opencode/gpt-5.6-sol"), "ban was not visible to fresh store");
      expect(!fresh.isBlocked("opencode/gpt-5.6-terra"), "ban must not affect another model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await runTest("persistent ban TTL prunes only expired orphan files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-failback-ban-"));
    const currentPath = join(dir, "model-failback-bans-current.json");
    const stalePath = join(dir, "model-failback-bans-stale.json");
    const freshPath = join(dir, "model-failback-bans-fresh.json");
    try {
      const store = new PersistentBanStore(currentPath);
      await store.mark("opencode/gpt-5.6-sol", {
        scope: "cross-provider",
        reason: "credits_exhausted",
        markedAt: Date.now(),
      });
      writeFileSync(stalePath, "{}\n", "utf8");
      writeFileSync(freshPath, "{}\n", "utf8");
      const old = new Date(Date.now() - DEFAULT_BAN_FILE_TTL_MS * 2);
      utimesSync(currentPath, old, old);
      utimesSync(stalePath, old, old);
      const removed = await store.pruneOrphans(DEFAULT_BAN_FILE_TTL_MS);
      expect(!removed.includes("model-failback-bans-current.json"), "current session ban was pruned");
      expect(removed.includes("model-failback-bans-stale.json"), "stale orphan ban was not pruned");
      expect(!removed.includes("model-failback-bans-fresh.json"), "fresh ban was pruned");
      expect(store.isBlocked("opencode/gpt-5.6-sol"), "current ban became unreadable after prune");
      writeFileSync(stalePath, "{}\n", "utf8");
      utimesSync(stalePath, old, old);
      expect((await store.pruneOrphans(0)).length === 0, "TTL=0 should disable pruning");
      expect(existsSync(stalePath), "TTL-disabled prune removed stale file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await runTest("persistent concurrent ban writes do not lose entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "model-failback-ban-"));
    const path = join(dir, "bans.json");
    try {
      const first = new PersistentBanStore(path);
      const second = new PersistentBanStore(path);
      await Promise.all([
        first.mark("opencode/gpt-5.6-sol", {
          scope: "cross-provider",
          reason: "credits_exhausted",
          markedAt: Date.now(),
        }),
        second.mark("modelscope/Qwen/Qwen3.8-Flash-Next", {
          scope: "cross-provider",
          reason: "quota_exhausted",
          markedAt: Date.now(),
        }),
      ]);
      const fresh = new PersistentBanStore(path);
      await fresh.refresh();
      expect(fresh.isBlocked("opencode/gpt-5.6-sol"), "first concurrent ban was lost");
      expect(fresh.isBlocked("modelscope/Qwen/Qwen3.8-Flash-Next"), "second concurrent ban was lost");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  results.push(await runTest("engine resets a completed chain before a new agent run", async () => {
    const harness = engineHarness(
      {
        fallbacks: {
          "opencode/gpt-5.6-sol": "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-flash": "rightcode-codex/gpt-5.6-luna",
        },
      },
      CHAIN_MODELS,
      { provider: "opencode", id: "gpt-5.6-sol" },
    );
    await harness.emit(creditsFailure("opencode", "gpt-5.6-sol"));
    expect(harness.state.chain.length === 2, "first failback chain was not recorded");
    await harness.emitAgentStart();
    expect(harness.state.chain.length === 2, "steering continuation unexpectedly reset chain");
    await harness.emitAgentStart();
    expect(harness.state.chain.length === 0, "new agent run did not reset chain");
    expect(harness.state.consecutive === 0, "new agent run did not reset consecutive count");
  }));

  results.push(await runTest("engine retries compaction after terminal model failback", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await harness.emitCompactionFailed("Summarization failed: Codex error: The usage limit has been reached");
    await waitForTimers();
    expect(harness.pi.setModelCalls.length === 1, "compaction failure did not switch model");
    expect((harness.pi.setModelCalls[0] as { provider: string }).provider === "rightcode-codex", "wrong compaction fallback target");
    expect(harness.compactCalls.length === 1, "compaction was not retried");
  }));

  results.push(await runTest("engine ignores aborted compaction failures", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached", true);
    expect(harness.pi.setModelCalls.length === 0, "aborted compaction triggered failback");
    expect(harness.compactCalls.length === 0, "aborted compaction was retried");
  }));

  results.push(await runTest("engine serializes concurrent compaction failures", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await Promise.all([
      harness.emitCompactionFailed("Codex error: The usage limit has been reached"),
      harness.emitCompactionFailed("Codex error: The usage limit has been reached"),
    ]);
    await waitForTimers();
    expect(harness.pi.setModelCalls.length === 1, "concurrent failures switched model more than once");
    expect(harness.compactCalls.length === 1, "concurrent failures started multiple compactions");
    expect(
      !harness.notifications.some((notification) => notification.message.includes("检测到切换环")),
      "duplicate source failure produced a false cycle notification",
    );
    expect(
      harness.pi.entries.filter((entry) => entry.type === "model-failback").length === 1,
      "duplicate source failure wrote another failback ledger entry",
    );
  }));

  results.push(await runTest("engine continues a failed compaction chain after retry completion", async () => {
    const source = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const middle = { provider: "opencode", id: "gpt-5.6-sol" };
    const target = { provider: "rightcode-codex", id: "gpt-5.6-sol" };
    const harness = engineHarness(
      {
        chains: [["openai-codex/gpt-5.6-sol", "opencode/gpt-5.6-sol", "rightcode-codex/gpt-5.6-sol"]],
        fallbacks: {},
      },
      [source, middle, target],
      source,
      false,
    );
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    await waitForTimers();
    expect(harness.compactCalls.length === 1, "first fallback compaction did not start");
    (harness.ctx as { model: { provider: string; id: string } }).model = middle;
    await harness.emitCompactionFailed('{"type":"CreditsError","message":"Insufficient balance"}');
    ((harness.compactCalls[0] as { onError: (error: Error) => void }).onError)(new Error("CreditsError"));
    await waitForTimers();
    await waitForTimers();
    expect(harness.pi.setModelCalls.length === 2, "failed fallback compact did not advance chain");
    expect(
      (harness.pi.setModelCalls[1] as { provider: string }).provider === "rightcode-codex",
      "wrong second compaction fallback target",
    );
    expect(harness.compactCalls.length === 2, "second fallback compaction did not start");
  }));

  results.push(await runTest("engine keeps retry when a session switch is cancelled", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    // session_before_switch 可以被后续扩展取消，before 本身不能使当前 retry 失效。
    await harness.emitBeforeSwitch();
    await waitForTimers();
    expect(harness.compactCalls.length === 1, "cancelled switch discarded current session retry");
  }));

  results.push(await runTest("engine does not manually retry threshold compaction", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached", false, "threshold");
    await waitForTimers();
    expect(harness.pi.setModelCalls.length === 1, "threshold failure did not fail back");
    expect(harness.compactCalls.length === 0, "threshold failure manually aborted a possible new request");
  }));

  results.push(await runTest("engine does not abort a new request for manual retry", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    (harness.ctx as { isIdle: () => boolean }).isIdle = () => false;
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    await waitForTimers();
    expect(harness.compactCalls.length === 0, "manual retry aborted a newly started request");
  }));

  results.push(await runTest("engine cancels a pending compaction timer on shutdown", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    await harness.emitShutdown();
    await waitForTimers();
    expect(harness.compactCalls.length === 0, "shutdown did not cancel pending compaction timer");
  }));

  results.push(await runTest("engine ignores old compaction callback after shutdown", async () => {
    const harness = engineHarness(
      { fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" } },
      [],
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      false,
    );
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    await waitForTimers();
    const options = harness.compactCalls[0] as { onComplete: () => void };
    await harness.emitShutdown();
    options.onComplete();
    expect(
      !harness.notifications.some((notification) => notification.message.includes("已使用备用模型重新压缩")),
      "old session compaction callback used stale context",
    );
  }));

  results.push(await runTest("registry contains all four providers", () => {
    const providers = supportedProviders();
    expect(providers.length === 4, `expected 4 providers, got ${providers.length}`);
    for (const provider of ["openai-codex", "opencode", "opencode-go", "modelscope"]) {
      expect(providers.includes(provider), `missing provider ${provider}`);
    }
  }));

  results.push(await runTest("engine sets model, appends entry, and steers", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
      cooldownMs: 60_000,
    });
    const failure = assistantFailure(
      "openai-codex",
      "gpt-5.6-sol",
      "You have hit your ChatGPT usage limit. Try again in ~34 min.",
    );
    await harness.emit(failure);

    expect(harness.pi.setModelCalls.length === 1, "setModel was not called once");
    expect(harness.pi.setModelCalls[0] === harness.ctx.modelRegistry.find("rightcode-codex", "gpt-5.6-sol"), "wrong fallback model");
    const ledger = harness.pi.entries.find((entry) => entry.type === "model-failback");
    expect(ledger, "model-failback ledger entry was not written");
    expect(harness.pi.entries.some((entry) => entry.type === "model-failback-ban"), "ban entry was not written");
    expect(harness.pi.userMessages.length === 1, "steering message was not sent");
    expect((harness.pi.userMessages[0].options as { deliverAs: string }).deliverAs === "steer", "message was not delivered as steer");
    expect(
      String(harness.pi.userMessages[0].content).includes("rightcode-codex/gpt-5.6-sol"),
      "steering message does not name the fallback model",
    );
    expect(harness.state.resetsAt !== undefined, "engine did not retain resetsAt");
  }));

  results.push(await runTest("engine advances through a two-hop chain", async () => {
    const harness = engineHarness(
      {
        fallbacks: {
          "opencode/gpt-5.6-sol": "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-flash": "rightcode-codex/gpt-5.6-luna",
        },
      },
      CHAIN_MODELS,
      { provider: "opencode", id: "gpt-5.6-sol" },
    );

    await harness.emit(creditsFailure("opencode", "gpt-5.6-sol"));
    await harness.emit(creditsFailure("opencode-go", "deepseek-v4-flash"));

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 2, `expected 2 switches, got ${called.length}`);
    expect(called[0].provider === "opencode-go", "first hop should be opencode-go");
    expect(called[1].provider === "rightcode-codex", "second hop should be rightcode-codex");
    expect(harness.pi.userMessages.length === 2, "expected 2 steering messages");
    expect(harness.state.chain.length === 3, `expected chain length 3, got ${harness.state.chain.length}`);
  }));

  results.push(await runTest("engine fails back after opencode-go 503", async () => {
    const harness = engineHarness(
      {
        fallbacks: { "opencode-go/deepseek-v4-flash": "rightcode-codex/gpt-5.6-luna" },
      },
      CHAIN_MODELS,
      { provider: "opencode-go", id: "deepseek-v4-flash" },
    );
    await harness.emit(
      assistantFailure(
        "opencode-go",
        "deepseek-v4-flash",
        'Error: 503: {"type":"server_error","message":"Error from provider (Console Go): Upstream request failed: Endpoint is unavailable."}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, "503 failure did not trigger failback");
    expect(called[0].provider === "rightcode-codex", "503 failure selected wrong fallback");
    expect(harness.pi.entries.some((entry) => entry.type === "model-failback-ban"), "503 failure was not banned");
    expect(harness.pi.userMessages.length === 1, "503 failure did not send steering");
  }));

  results.push(await runTest("engine skips a previously banned chain node", async () => {
    const harness = engineHarness(
      {
        chains: [["opencode/gpt-5.6-sol", "opencode-go/deepseek-v4-flash", "rightcode-codex/gpt-5.6-luna"]],
        fallbacks: {},
      },
      CHAIN_MODELS,
      { provider: "opencode", id: "gpt-5.6-sol" },
    );
    await harness.bans.mark("opencode-go/deepseek-v4-flash", {
      scope: "cross-provider",
      reason: "credits_exhausted",
      markedAt: Date.now(),
    });
    await harness.emit(creditsFailure("opencode", "gpt-5.6-sol"));

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, "expected one direct switch past banned node");
    expect(called[0].provider === "rightcode-codex", "banned intermediate node was not skipped");
  }));

  results.push(await runTest("engine preflight skips banned initial subagent model", async () => {
    const harness = engineHarness(
      {
        chains: [["opencode/gpt-5.6-sol", "opencode-go/deepseek-v4-flash", "rightcode-codex/gpt-5.6-luna"]],
        fallbacks: {},
      },
      CHAIN_MODELS,
      { provider: "opencode", id: "gpt-5.6-sol" },
    );
    await harness.bans.mark("opencode/gpt-5.6-sol", {
      scope: "cross-provider",
      reason: "credits_exhausted",
      markedAt: Date.now(),
    });
    await harness.emitSessionStart();

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, "banned initial model was not redirected before request");
    expect(called[0].provider === "opencode-go", "preflight selected wrong fallback");
  }));

  results.push(await runTest("engine avoids a failback cycle through bans", async () => {
    const harness = engineHarness(
      {
        fallbacks: {
          "opencode/gpt-5.6-sol": "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-flash": "opencode/gpt-5.6-sol",
        },
      },
      CHAIN_MODELS,
      { provider: "opencode", id: "gpt-5.6-sol" },
    );

    await harness.emit(creditsFailure("opencode", "gpt-5.6-sol"));
    await harness.emit(creditsFailure("opencode-go", "deepseek-v4-flash"));

    expect(harness.pi.setModelCalls.length === 1, "cycle-forming switch should be rejected");
    expect(
      harness.notifications.some(({ message }) => message.includes("没有未 ban")),
      "banned-cycle notification was not emitted",
    );
  }));

  results.push(await runTest("engine enforces maxConsecutive", async () => {
    const harness = engineHarness(
      {
        fallbacks: {
          "opencode/gpt-5.6-sol": "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-flash": "rightcode-codex/gpt-5.6-luna",
        },
        maxConsecutive: 1,
      },
      CHAIN_MODELS,
      { provider: "opencode", id: "gpt-5.6-sol" },
    );

    await harness.emit(creditsFailure("opencode", "gpt-5.6-sol"));
    await harness.emit(creditsFailure("opencode-go", "deepseek-v4-flash"));

    expect(harness.pi.setModelCalls.length === 1, "maxConsecutive=1 should block the second switch");
    expect(
      harness.notifications.some(({ message }) => message.includes("连跳上限")),
      "maxConsecutive notification was not emitted",
    );
  }));

  results.push(await runTest("engine cross-provider guard rejects same-provider target", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "openai-codex/gpt-5.6-terra" },
      cooldownMs: 60_000,
    });
    await harness.emit(assistantFailure("openai-codex", "gpt-5.6-sol", "usage_limit_reached"));
    expect(harness.pi.setModelCalls.length === 0, "same-provider fallback was selected");
    expect(harness.pi.entries.some((entry) => entry.type === "model-failback-ban"), "source model was not banned");
    expect(!harness.pi.entries.some((entry) => entry.type === "model-failback"), "same-provider fallback was recorded");
    expect(harness.pi.userMessages.length === 0, "same-provider fallback sent steering");
    expect(
      harness.notifications.some(({ message }) => message.includes("没有未 ban")),
      "cross-provider route guard notification was not emitted",
    );
  }));

  return results;
}

export default async function regressionProbe(_pi: ExtensionAPI): Promise<void> {
  const resultPath = process.env.MODEL_FAILBACK_TEST_RESULT;
  if (!resultPath) throw new Error("MODEL_FAILBACK_TEST_RESULT is required");

  let results: TestResult[];
  try {
    results = await runRegressionTests();
  } catch (error) {
    results = [{
      name: "regression probe",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }

  const output = {
    passed: results.every((result) => result.passed),
    results,
  };
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(output, null, 2) + "\n", "utf8");
}
