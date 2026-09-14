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
import { commandCodeHandler } from "../providers/command-code";
import { workbuddyHandler } from "../providers/workbuddy";
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
  config: {
    chains?: string[][];
    fallbacks: Record<string, string>;
    cooldownMs?: number;
    maxConsecutive?: number;
    autoRestore?: boolean;
  },
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

  results.push(await runTest("openai-codex resolves the conservative reset from shared usage fetch", async () => {
    const originalFetch = globalThis.fetch;
    const before = Date.now();
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          rate_limit: {
            primary_window: { used_percent: 100, reset_at: Math.floor((before + 10 * 60_000) / 1000) },
            secondary_window: { used_percent: 100, reset_at: Math.floor((before + 2 * 60 * 60_000) / 1000) },
          },
        }),
      } as Response;
    }) as typeof fetch;
    try {
      const resetsAt = await openaiCodexHandler.resolveResetsAt?.(
        { reason: "usage_limit", scope: "cross-provider" },
        { getProviderAuth: async () => ({ auth: { apiKey: "test-access-token" } }) },
      );
      expect(requestedUrl === "https://chatgpt.com/backend-api/wham/usage", `unexpected quota URL: ${requestedUrl}`);
      expect(resetsAt !== undefined, "shared Codex usage fetch did not produce a reset estimate");
      expect(resetsAt! >= before + 119 * 60_000, "selected reset was earlier than the exhausted weekly window");
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  results.push(await runTest("opencode-go GoUsageLimitError is detected", () => {
    const before = Date.now();
    const verdict = opencodeGoHandler.inspect(
      assistantFailure(
        "opencode-go",
        "deepseek-v4-flash",
        '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 22hr 52min."}',
      ),
    );
    expect(verdict, "opencode-go GoUsageLimitError was not detected");
    expect(verdict.reason === "usage_limit", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
    expect(typeof verdict.resetsAt === "number", "resetsAt was not populated");
    expect(verdict.resetsAt! >= before + (22 * 60 + 51) * 60_000, "resetsAt is too early");
    expect(verdict.resetsAt! <= Date.now() + (22 * 60 + 53) * 60_000, "resetsAt is too late");
  }));

  results.push(await runTest("opencode-go resolves reset only for a subscription usage limit", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return {
        ok: true,
        json: async () => ({
          usage: { weekly: { percent: 100, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() } },
        }),
      } as Response;
    }) as typeof fetch;
    try {
      const resolver = { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) };
      const reset = await opencodeGoHandler.resolveResetsAt?.(
        { reason: "usage_limit", scope: "cross-provider" }, resolver,
      );
      expect(typeof reset === "number", "Go usage endpoint did not produce a reset estimate");
      const outageReset = await opencodeGoHandler.resolveResetsAt?.(
        { reason: "endpoint_unavailable", scope: "cross-provider" }, resolver,
      );
      expect(outageReset === undefined, "endpoint outage must not be assigned a quota reset");
      expect(fetches === 1, `endpoint outage unexpectedly queried quota (${fetches} requests)`);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  results.push(await runTest("command-code USAGE_EXCEEDED is a cross-provider spend limit", () => {
    const verdict = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "deepseek/deepseek-v4.1-flash",
        '400: {"message":"Usage limit reached","type":"invalid_request_error","code":"USAGE_EXCEEDED"}',
      ),
    );
    expect(verdict, "command-code USAGE_EXCEEDED was not detected");
    expect(verdict.reason === "spend_limit", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
  }));

  results.push(await runTest("command-code org spend cap is detected with resetsAt", () => {
    const before = Date.now();
    const verdict = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "glm-5",
        "You've reached the $10.00/mo spending limit your organization set for GLM-5. It resets in 3 days.",
      ),
    );
    expect(verdict, "command-code org spend cap was not detected");
    expect(verdict.reason === "spend_limit", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
    expect(typeof verdict.resetsAt === "number", "org spend cap resetsAt was not populated");
    const expected = before + 3 * 24 * 60 * 60_000;
    expect(Math.abs(verdict.resetsAt! - expected) <= 60_000, "org spend cap resetsAt is not ~3 days");
  }));

  results.push(await runTest("command-code rolling window limit is detected with resetsAt", () => {
    const before = Date.now();
    const verdict = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "xiaomi/mimo-v2.5",
        '429: {"message":"You\'ve reached your 5-hour usage limit. Resets in 2h 41m (3:00 PM).","type":"rate_limit_error","code":"RATE_LIMITED","rateLimit":{"window":"fiveHour","reset":1789388669}}',
      ),
    );
    expect(verdict, "command-code rolling window limit was not detected");
    expect(verdict.reason === "usage_limit", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
    expect(typeof verdict.resetsAt === "number", "resetsAt was not populated");
    // "2h 41m (3:00 PM)" 的括号复述不得被重复累加。
    const expected = before + (2 * 60 + 41) * 60_000;
    expect(Math.abs(verdict.resetsAt! - expected) <= 60_000, "resetsAt double-counted the parenthesised restatement");
  }));

  results.push(await runTest("command-code plain-text window limit variants are detected", () => {
    const samples = [
      "You've reached your weekly limit. Resets in 3 days.",
      "You have exceeded your weekly usage limit",
      "5-hour limit reached. Try again later.",
      // 泛化文案自身不够明确,需配合官方限流门禁(官方 CLI 同此语义)。
      '429: {"code":"RATE_LIMITED","message":"Usage limit for your plan has been reached"}',
      '429: {"code":"RATE_LIMITED","message":"Usage limit has been reached"}',
    ];
    for (const sample of samples) {
      const verdict = commandCodeHandler.inspect(assistantFailure("command-code", "m", sample));
      expect(verdict, `plain-text window limit was not detected: ${sample}`);
      expect(verdict.reason === "usage_limit", `unexpected reason for ${sample}: ${verdict.reason}`);
      expect(verdict.scope === "cross-provider", `unexpected scope for ${sample}: ${verdict.scope}`);
    }
  }));

  results.push(await runTest("command-code premium credits and insufficient credits are quota exhausted", () => {
    const premium = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "claude-opus-5",
        '400: {"message":"Premium credits exhausted","type":"invalid_request_error","code":"PREMIUM_CREDITS_EXHAUSTED"}',
      ),
    );
    const insufficient = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "claude-opus-5",
        '400: {"message":"You have insufficient credits to make this request. Please purchase more credits to continue using Command Code here: https://command-code.ai/billing","type":"invalid_request_error","code":"USAGE_EXCEEDED"}',
      ),
    );
    expect(premium, "PREMIUM_CREDITS_EXHAUSTED was not detected");
    expect(premium.reason === "quota_exhausted", `unexpected reason: ${premium.reason}`);
    expect(premium.scope === "cross-provider", `unexpected scope: ${premium.scope}`);
    expect(insufficient, "insufficient credits was not detected");
    expect(insufficient.reason === "quota_exhausted", `unexpected reason: ${insufficient.reason}`);
    expect(insufficient.scope === "cross-provider", `unexpected scope: ${insufficient.scope}`);
  }));

  results.push(await runTest("command-code model not in plan is model-scoped (any)", () => {
    const samples = [
      '400: {"message":"MODEL_NOT_IN_PLAN: claude-opus-5","type":"invalid_request_error"}',
      '400: {"message":"claude-opus-5 is not included in your current plan"}',
    ];
    for (const sample of samples) {
      const verdict = commandCodeHandler.inspect(assistantFailure("command-code", "claude-opus-5", sample));
      expect(verdict, `MODEL_NOT_IN_PLAN was not detected: ${sample}`);
      expect(verdict.reason === "model_not_in_plan", `unexpected reason: ${verdict.reason}`);
      // 只影响这一个模型,同 provider 的其他模型仍然可用。
      expect(verdict.scope === "any", `unexpected scope: ${verdict.scope}`);
    }
  }));

  results.push(await runTest("command-code transient and configuration errors do not match", () => {
    const samples = [
      '429: {"message":"Rate limit exceeded. Please wait a moment and try again.","type":"rate_limit_error","code":"rate_limit_error"}',
      '429: {"message":"Too many requests","type":"rate_limit_error"}',
      '429: Too many requests',
      '401: {"message":"Missing or invalid auth","type":"authentication_error"}',
      '403: {"message":"You are on the Go plan, the only plan without API access.","type":"permission_error","code":"upgrade_required"}',
      '400: {"message":"Model \\"foo\\" is not supported on this endpoint.","type":"invalid_request_error","code":"unsupported_model"}',
      '422: {"message":"no zero-data-retention upstream","code":"cmd_zdr_no_providers"}',
      '500: {"message":"Internal server error","type":"server_error"}',
      '502: {"message":"Upstream request failed: Endpoint is unavailable.","type":"api_error"}',
      // 只有 "Resets in …" 而没有额度文案:不得单独成为终态。
      "Resets in 30s",
      "Resets in 5 minutes",
      "Resets at 2026-09-14T07:00:00Z",
      // 自然语言里的 window 不是窗口证据。
      '429: {"message":"upstream said: connection window closed","type":"server_error","code":"RATE_LIMITED"}',
      // 其他 provider 的额度信号必须保持隔离。
      '429: {"code":"insufficient_quota","message":"You exceeded your current quota"}',
      '429: {"message":"insufficient balance"}',
      '{"type":"CreditsError","message":"Insufficient balance"}',
      '400: {"code":"Free allocated quota exceeded"}',
      '400: {"code":"out of budget"}',
    ];
    for (const sample of samples) {
      const verdict = commandCodeHandler.inspect(assistantFailure("command-code", "some-model", sample));
      expect(verdict === null, `should not match: ${sample}`);
    }
  }));

  results.push(await runTest("command-code only parses the error body, never the appended metadata", () => {
    // pi 的 formatProviderError 会把 error.error.metadata.raw 追加在换行之后。
    // 判定必须只看第一个括号配平的 JSON 对象,否则元数据/嵌套字段里的
    // 同名 token 会把非终态错误升级为整 provider 级 ban。
    const samples = [
      '400: {"message":"not supported on this endpoint"}\n{"code":"USAGE_EXCEEDED","type":"invalid_request_error"}',
      '500: {"message":"Internal server error"}\n{"code":"RATE_LIMITED","rateLimit":{"window":"fiveHour"}}',
      '401: {"message":"Missing or invalid API key"}\n{"code":"RATE_LIMITED","rateLimit":{"window":"weekly"}}',
      '400: {"message":"not supported","extra":{"code":"USAGE_EXCEEDED"},"code":"unsupported_model"}',
      '400: {"message":"not supported","extra":{"code":"RATE_LIMITED","rateLimit":{"window":"weekly"}},"code":"unsupported_model"}',
      '429: {"message":"Rate limit exceeded. Please wait a moment and try again.","type":"rate_limit_error","error":{"code":"USAGE_EXCEEDED"}}',
    ];
    for (const sample of samples) {
      const verdict = commandCodeHandler.inspect(assistantFailure("command-code", "some-model", sample));
      expect(verdict === null, `metadata/nested token was escalated to a terminal verdict: ${sample}`);
    }
  }));

  results.push(await runTest("command-code terminal code wins over a sibling non-terminal type", () => {
    // 终态 code 不得被同层/嵌套的非终态 type 覆盖,否则真终态会被漏判。
    const samples = [
      '400: {"message":"body {\\"code\\":\\"unsupported_model\\"}","code":"USAGE_EXCEEDED","type":"invalid_request_error"}',
      '400: {"message":"Usage limit reached","extra":{"type":"server_error"},"code":"USAGE_EXCEEDED"}',
      '429: {"error":{"type":"api_error","message":"upstream failed"},"type":"rate_limit_error","rateLimit":{"window":"fiveHour"},"code":"RATE_LIMITED"}',
      '400: {"error":{"type":"api_error"},"type":"invalid_request_error","code":"USAGE_EXCEEDED","message":"Usage limit reached"}',
    ];
    for (const sample of samples) {
      const verdict = commandCodeHandler.inspect(assistantFailure("command-code", "some-model", sample));
      expect(verdict, `terminal code was masked by a non-terminal type: ${sample}`);
      expect(
        verdict.reason === "spend_limit" || verdict.reason === "usage_limit",
        `unexpected reason for ${sample}: ${verdict.reason}`,
      );
      expect(verdict.scope === "cross-provider", `unexpected scope for ${sample}: ${verdict.scope}`);
    }
    // code 与 type 同层冲突时以 code 为准(与字段顺序无关)。
    const conflicted = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "some-model",
        '500: {"type":"server_error","message":"boom","code":"RATE_LIMITED","rateLimit":{"window":"fiveHour"}}',
      ),
    );
    expect(conflicted, "RATE_LIMITED code was masked by a sibling server_error type");
    expect(conflicted.reason === "usage_limit", `unexpected reason: ${conflicted.reason}`);
  }));

  results.push(await runTest("command-code drops a reset time that is already in the past", () => {
    const verdict = commandCodeHandler.inspect(
      assistantFailure(
        "command-code",
        "m",
        '429: {"code":"RATE_LIMITED","message":"Resets at 2020-01-01T00:00:00Z"}',
      ),
    );
    expect(verdict, "window limit was not detected");
    expect(verdict.resetsAt === undefined, `a past reset time leaked into the ledger: ${verdict.resetsAt}`);
  }));

  results.push(await runTest("command-code non-terminal code/type wins over nested terminal tokens", () => {
    // pi 会把 error.error.metadata.raw 追加进 errorMessage,嵌套字段里的
    // USAGE_EXCEEDED / window 不得把非终态错误升级为整 provider 级 ban。
    const samples = [
      '400: {"code":"unsupported_model","message":"not supported","extra":{"code":"USAGE_EXCEEDED"}}',
      '400: {"code":"unsupported_model","message":"nope","docLink":"https://x/USAGE_EXCEEDED"}',
      '500: {"message":"Internal server error","type":"server_error","rateLimit":{"window":"fiveHour","reset":1789388669}}',
      '502: {"type":"api_error","message":"Endpoint is unavailable","rateLimit":{"window":"weekly"}}',
      '401: {"type":"authentication_error","message":"Missing or invalid auth","rateLimit":{"window":"weekly"}}',
      '403: {"code":"upgrade_required","message":"Go plan has no API access","rateLimit":{"window":"weekly"}}',
      '400: {"code":"unsupported_model","message":"not supported","rateLimit":{"window":"daily"}}',
      '422: {"code":"cmd_zdr_no_providers","message":"no zdr upstream","rateLimit":{"window":"weekly"}}',
      '500: {"message":"boom","type":"server_error","window":"weekly","help":"https://x/docs/429"}',
      // 校验类文案不得当成额度终态。
      '400: {"message":"Invalid field: usage limit for your plan must be a string","type":"invalid_request_error"}',
    ];
    for (const sample of samples) {
      const verdict = commandCodeHandler.inspect(assistantFailure("command-code", "some-model", sample));
      expect(verdict === null, `non-terminal error was escalated to a terminal verdict: ${sample}`);
    }
  }));

  results.push(await runTest("command-code ignores other providers and non-error messages", () => {
    const otherProvider = commandCodeHandler.inspect(
      assistantFailure("opencode", "gpt-5.6-sol", "USAGE_EXCEEDED"),
    );
    const wrongStopReason = commandCodeHandler.inspect({
      role: "assistant",
      stopReason: "stop",
      provider: "command-code",
      model: "m",
      errorMessage: "USAGE_EXCEEDED",
    });
    const emptyMessage = commandCodeHandler.inspect(
      assistantFailure("command-code", "m", ""),
    );
    expect(otherProvider === null, "another provider was incorrectly detected");
    expect(wrongStopReason === null, "a non-error message was incorrectly detected");
    expect(emptyMessage === null, "an empty error message was incorrectly detected");
  }));

  results.push(await runTest("command-code resolveResetsAt only queries for a window usage limit", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    const resetAt = Date.now() + 60 * 60_000;
    globalThis.fetch = (async (url: string | URL) => {
      fetches += 1;
      const target = String(url);
      if (target.includes("/alpha/whoami")) {
        return { ok: true, json: async () => ({ user: { id: "u" }, org: null }) } as Response;
      }
      if (target.includes("/alpha/billing/credits")) {
        return {
          ok: true,
          json: async () => ({
            credits: { monthlyCredits: 0 },
            windowLimits: {
              limited: true,
              fiveHour: { used: 14, cap: 14, exceeded: true, resetAt },
              weekly: { used: 1, cap: 35, exceeded: false, resetAt: Date.now() + 7 * 24 * 60 * 60_000 },
            },
          }),
        } as Response;
      }
      if (target.includes("/alpha/billing/subscriptions")) {
        return { ok: true, json: async () => ({ success: true, data: { planId: "indivi" } }) } as Response;
      }
      return { ok: false, json: async () => undefined } as Response;
    }) as typeof fetch;
    try {
      const resolver = { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) };
      // 非 usage_limit 的 reason 一律不查额度:必须先断言,避免污染后续 usage_limit
      // 的首次真实 fetch(usage-stats 有 90s 模块级缓存)。
      const reasons = ["quota_exhausted", "spend_limit", "model_not_in_plan"];
      for (const reason of reasons) {
        const skipped = await commandCodeHandler.resolveResetsAt?.(
          { reason, scope: reason === "model_not_in_plan" ? "any" : "cross-provider" }, resolver,
        );
        expect(skipped === undefined, `${reason} must not be assigned a reset estimate`);
      }
      expect(fetches === 0, `non-window reasons unexpectedly queried quota (${fetches} requests)`);

      const before = Date.now();
      const reset = await commandCodeHandler.resolveResetsAt?.(
        { reason: "usage_limit", scope: "cross-provider" }, resolver,
      );
      expect(typeof reset === "number", "usage endpoint did not produce a reset estimate");
      expect(Math.abs(reset! - (before + 60 * 60_000)) <= 5 * 60_000, "reset estimate is not the exhausted window");
      expect(fetches > 0, "usage_limit did not query the quota endpoint");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    expect(harness.state.original === null, "autoRestore=false must discard the old restore target on a new task");
    expect(harness.state.resetsAt === undefined, "autoRestore=false must discard the old reset estimate on a new task");
  }));

  results.push(await runTest("autoRestore preserves the original snapshot until its deadline, then restores", async () => {
    const source = { provider: "opencode", id: "gpt-5.6-sol" };
    const fallback = { provider: "rightcode-codex", id: "gpt-5.6-sol" };
    const harness = engineHarness(
      { fallbacks: { "opencode/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" }, autoRestore: true },
      [source, fallback],
      source,
    );
    await harness.emit(creditsFailure(source.provider, source.id));
    harness.state.resetsAt = Date.now() + 60_000;
    expect(harness.state.original?.provider === source.provider, "initial restore target was not retained");

    await harness.emitAgentStart();
    expect(harness.state.chain.length === 2, "steering continuation unexpectedly reset the failback chain");
    await harness.emitAgentStart();
    expect(harness.state.chain.length === 0, "new task did not clear the completed failback chain");
    expect(harness.state.original?.provider === source.provider, "autoRestore lost the original model before its deadline");
    expect(harness.pi.setModelCalls.length === 1, "autoRestore ran before the original deadline");

    harness.state.resetsAt = Date.now() - 1;
    (harness.ctx as { model: { provider: string; id: string } }).model = fallback;
    await harness.emitAgentStart();
    expect(harness.pi.setModelCalls.length === 2, "autoRestore did not switch back after the deadline");
    expect((harness.pi.setModelCalls[1] as { provider: string }).provider === source.provider, "autoRestore selected the wrong model");
    expect(harness.state.original === null && harness.state.resetsAt === undefined, "successful autoRestore did not clear its snapshot");
  }));

  results.push(await runTest("autoRestore keeps the first model deadline across a fallback chain", async () => {
    const source = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const middle = { provider: "opencode-go", id: "deepseek-v4-flash" };
    const target = { provider: "rightcode-codex", id: "gpt-5.6-sol" };
    const harness = engineHarness(
      {
        chains: [["openai-codex/gpt-5.6-sol", "opencode-go/deepseek-v4-flash", "rightcode-codex/gpt-5.6-sol"]],
        fallbacks: {},
        autoRestore: true,
      },
      [source, middle, target],
      source,
    );
    await harness.emit(assistantFailure(
      source.provider,
      source.id,
      "You have hit your ChatGPT usage limit. Try again in ~34 min.",
    ));
    const originalDeadline = harness.state.resetsAt;
    expect(originalDeadline !== undefined, "first model did not establish a restore deadline");
    (harness.ctx as { model: { provider: string; id: string } }).model = middle;
    await harness.emitAgentStart(); // Consume the steering continuation.
    await harness.emit(assistantFailure(
      middle.provider,
      middle.id,
      '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 1min."}',
    ));
    expect(harness.state.original?.provider === source.provider, "second fallback replaced the original restore target");
    expect(harness.state.resetsAt === originalDeadline, "second fallback overwrote the original restore deadline");
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

  results.push(await runTest("workbuddy balance-exhausted codes are cross-provider terminals", () => {
    // 这些 code 来自腾讯官方 CodeBuddy CLI 的业务错误码枚举。
    const codes = ["14001", "14002", "14012", "14013", "14014", "14018", "14019", "6003", "6004"];
    for (const code of codes) {
      const verdict = workbuddyHandler.inspect(
        assistantFailure(
          "workbuddy",
          "deepseek-v4.1-flash",
          `400: {"message":"UsageLimitExceeded","type":"invalid_request_error","code":"${code}"}`,
        ),
      );
      expect(verdict, `workbuddy code ${code} was not detected`);
      expect(verdict.reason === "quota_exhausted", `unexpected reason for ${code}: ${verdict.reason}`);
      expect(verdict.scope === "cross-provider", `unexpected scope for ${code}: ${verdict.scope}`);
    }
  }));

  results.push(await runTest("workbuddy non-terminal codes never trigger a failback", () => {
    // 瞬时限流/鉴权/未开通/模型错误/上下文超长/会话数/联网搜索额度。
    const codes = [
      "14003", "6005", "6006", "6007", "6008",
      "14015", "14016", "14017", "11140", "11142", "11141", "11115", "10105", "15001",
    ];
    for (const code of codes) {
      const verdict = workbuddyHandler.inspect(
        assistantFailure(
          "workbuddy",
          "deepseek-v4.1-flash",
          `429: {"message":"RateLimitError","type":"invalid_request_error","code":"${code}"}`,
        ),
      );
      expect(verdict === null, `workbuddy code ${code} should not trigger a failback`);
    }
  }));

  results.push(await runTest("workbuddy unknown code is left alone", () => {
    // 未知 code 不做猜测,避免误 ban 整个 provider。
    const verdict = workbuddyHandler.inspect(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        '400: {"message":"something new","type":"invalid_request_error","code":"99999"}',
      ),
    );
    expect(verdict === null, "an unknown workbuddy code must not be guessed as terminal");
  }));

  results.push(await runTest("workbuddy 429 fallback requires quota wording", () => {
    const quota = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "m", "429: usage limit reached"),
    );
    expect(quota, "429 with quota wording was not detected");
    expect(quota.reason === "quota_exhausted", `unexpected reason: ${quota.reason}`);
    expect(quota.scope === "cross-provider", `unexpected scope: ${quota.scope}`);

    // 没有业务码也没有额度文案的 429 属瞬时限流,交给 pi 退避重试。
    const transient = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "m", "429: Too many requests"),
    );
    expect(transient === null, "a bare 429 must stay transient");
  }));

  results.push(await runTest("workbuddy ignores other providers and non-error messages", () => {
    const otherProvider = workbuddyHandler.inspect(
      assistantFailure("command-code", "m", '400: {"code":"14001"}'),
    );
    const wrongStopReason = workbuddyHandler.inspect({
      role: "assistant",
      stopReason: "stop",
      provider: "workbuddy",
      model: "m",
      errorMessage: '400: {"code":"14001"}',
    });
    // 未经过 workbuddy 扩展信封补全时,errorMessage 会退化成这句:不能误判。
    const noBody = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "m", "400 status code (no body)"),
    );
    expect(otherProvider === null, "another provider was incorrectly detected");
    expect(wrongStopReason === null, "a non-error message was incorrectly detected");
    expect(noBody === null, "a body-less error must not be guessed as terminal");
  }));

  results.push(await runTest("engine fails back from workbuddy to the next chain node", async () => {
    const harness = engineHarness(
      {
        chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next", "deepseek/deepseek-flash"]],
        fallbacks: {},
      },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
        { provider: "deepseek", id: "deepseek-flash" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );

    await harness.emit(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        '400: {"message":"UsageLimitExceeded","type":"invalid_request_error","code":"14001"}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected 1 switch, got ${called.length}`);
    expect(called[0].provider === "modelscope", `wrong fallback target: ${called[0].provider}`);
    expect(harness.pi.userMessages.length === 1, "workbuddy failback did not send steering");
  }));

  results.push(await runTest("registry contains all six providers", () => {
    const providers = supportedProviders();
    expect(providers.length === 6, `expected 6 providers, got ${providers.length}`);
    for (const provider of [
      "openai-codex",
      "opencode",
      "opencode-go",
      "modelscope",
      "command-code",
      "workbuddy",
    ]) {
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

  results.push(await runTest("engine fails back from command-code to the next chain node", async () => {
    const harness = engineHarness(
      {
        chains: [["openai-codex/gpt-5.6-luna", "command-code/xiaomi/mimo-v2.5", "deepseek/deepseek-flash"]],
        fallbacks: {},
      },
      [
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "command-code", id: "xiaomi/mimo-v2.5" },
        { provider: "deepseek", id: "deepseek-flash" },
      ],
      { provider: "openai-codex", id: "gpt-5.6-luna" },
    );

    await harness.emit(assistantFailure("openai-codex", "gpt-5.6-luna", "usage_limit_reached"));
    await harness.emit(
      assistantFailure(
        "command-code",
        "xiaomi/mimo-v2.5",
        "You've reached your 5-hour usage limit. Resets in 2h 41m (3:00 PM).",
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 2, `expected 2 switches, got ${called.length}`);
    expect(called[0].provider === "command-code", "first hop should be command-code");
    expect(called[1].provider === "deepseek", "second hop should be deepseek");
    expect(harness.pi.userMessages.length === 2, "expected 2 steering messages");
  }));

  results.push(await runTest("engine keeps the same provider when command-code reports model_not_in_plan", async () => {
    // scope "any":同 provider 的其他模型仍然可用,不能因单个模型不在计划内
    // 就跳到别的 provider(甚至直接断供)。
    const harness = engineHarness(
      {
        chains: [
          [
            "command-code/claude-opus-5",
            "command-code/deepseek/deepseek-v4.1-flash",
            "deepseek/deepseek-flash",
          ],
        ],
        fallbacks: {},
      },
      [
        { provider: "command-code", id: "claude-opus-5" },
        { provider: "command-code", id: "deepseek/deepseek-v4.1-flash" },
        { provider: "deepseek", id: "deepseek-flash" },
      ],
      { provider: "command-code", id: "claude-opus-5" },
    );

    await harness.emit(
      assistantFailure(
        "command-code",
        "claude-opus-5",
        '400: {"message":"MODEL_NOT_IN_PLAN: claude-opus-5","type":"invalid_request_error"}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected 1 switch, got ${called.length}`);
    expect(called[0].provider === "command-code", "model_not_in_plan must stay on command-code");
    expect(
      called[0].id === "deepseek/deepseek-v4.1-flash",
      `model_not_in_plan skipped the same-provider model: ${called[0].id}`,
    );
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
