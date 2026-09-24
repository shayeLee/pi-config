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
import { workbuddyCnHandler, workbuddyHandler } from "../providers/workbuddy";
import {
  classifyTransientOutage,
  classifyWafBlock,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_TRANSIENT_OUTAGE_STREAK,
  DEFAULT_WAF_BLOCK_STREAK,
  parseCraftResetAt,
  resetWorkbuddyOutages,
  setWorkbuddyRateLimitCooldownMs,
  setWorkbuddyTransientOutageStreak,
  setWorkbuddyWafBlockStreak,
  TRANSIENT_OUTAGE_COOLDOWN_MS,
  WAF_BLOCK_COOLDOWN_MS,
} from "../providers/workbuddy";
import { supportedProviders } from "../providers/registry";

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
  /** 被 MODEL_FAILBACK_TEST_FILTER 过滤掉、未实际执行的用例。 */
  skipped?: boolean;
}

/** 用例名子串过滤（大小写不敏感）；未设置时跑全量。 */
const TEST_FILTER = process.env.MODEL_FAILBACK_TEST_FILTER?.trim() || undefined;

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
  readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
  appendEntryError: Error | undefined;

  /** 与真实 ExtensionAPI.events 同形：同步 emit，订阅方自行桥接异步回复。 */
  readonly events = {
    on: (channel: string, listener: (payload: unknown) => void): void => {
      const current = this.listeners.get(channel) ?? [];
      current.push(listener);
      this.listeners.set(channel, current);
    },
    emit: (channel: string, payload: unknown): void => {
      for (const listener of this.listeners.get(channel) ?? []) listener(payload);
    },
  };

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
    if (this.appendEntryError && type === "model-failback") throw this.appendEntryError;
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

/**
 * 真实 WAF 拦截页的忠实裁剪版(来自真实 session):保留 `403 <!DOCTYPE html>` 前缀
 * (openai SDK 的 `${status} ${msg}` 形状,而不是 `403:`)、WAF 特征串,以及内联
 * `<script> function submitWafFeedback() { … }` —— HTML 里有 `{` 但没有合法 JSON。
 */
const WAF_BLOCK_PAGE =
  '403 <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>WAF Block Page</title>' +
  '<link rel="stylesheet" text="text/css" href="https://domain-config-1256704386.cos.accelerate.myqcloud.com/block-pages/403/main_en.css" />' +
  '</head><script> function submitWafFeedback() { var uuid = document.getElementById("uuid").innerHTML; window.location.href = "https://api.waf-intl.qq.com/waf-attack-feedback/" + uuid; } </script>' +
  '<body><div class="wrapper"><div class="body"><p class="title">Your request has been interrupted</p>' +
  '<p class="desc">The web application firewall has detected a security risk or non-compliance in your visit</p>' +
  '<p class="uuid-wrapper"> Request UUID:<span id="uuid">c93317e20eea317765e94c5abb64cfea-80996126fd197e8e2aa9814fc60a0583</span></p>' +
  '</div></div></body></html>\n';

const GATEWAY_PAGE_502 =
  "502 <html><head><title>502 Bad Gateway</title></head><body>openresty</body></html>";

function waitForTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** 把 epoch ms 渲染成 WorkBuddy 错误文案里的 "… UTC+8" 本地时刻。 */
function formatUtc8(ms: number): string {
  const shifted = new Date(ms + 8 * 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} UTC+8`
  );
}

function engineHarness(
  config: {
    chains?: string[][];
    fallbacks: Record<string, string>;
    cooldownMs?: number;
    maxConsecutive?: number;
    autoRestore?: boolean;
    workbuddyTransientOutageStreak?: number;
    workbuddyRateLimitCooldownMs?: number;
    workbuddyWafStreak?: number;
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
  const beforeAgentStarts = pi.handlers.get("before_agent_start") ?? [];
  expect(messageEnd, "createEngine did not register message_end");
  expect(sessionStart, "createEngine did not register session_start");
  expect(compactFailed, "createEngine did not register session_compact_failed");
  expect(beforeSwitch, "createEngine did not register session_before_switch");
  expect(shutdown, "createEngine did not register session_shutdown");
  expect(beforeAgentStarts.length > 0, "createEngine did not register before_agent_start");

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
    async emitBeforeAgentStart() {
      for (const handler of beforeAgentStarts) await handler({}, ctx);
    },
  };
}

async function runTest(name: string, test: () => void | Promise<void>): Promise<TestResult> {
  if (TEST_FILTER && !name.toLowerCase().includes(TEST_FILTER.toLowerCase())) {
    return { name, passed: true, skipped: true };
  }
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
      // Parent GC is above; an explicitly marked agent-team child must never GC.
      const previousChild = process.env.MODEL_FAILBACK_CHILD;
      process.env.MODEL_FAILBACK_CHILD = "1";
      try {
        expect((await new PersistentBanStore(currentPath).pruneOrphans(DEFAULT_BAN_FILE_TTL_MS)).length === 0,
          "child process unexpectedly pruned parent ban files");
        expect(existsSync(stalePath), "child process removed a stale ban file");
      } finally {
        if (previousChild === undefined) delete process.env.MODEL_FAILBACK_CHILD;
        else process.env.MODEL_FAILBACK_CHILD = previousChild;
      }
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

  results.push(await runTest("engine resets a completed chain only at a new user task boundary", async () => {
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
    // Pi auto-retry starts another low-level agent run without before_agent_start;
    // deliberately do not synthesize it here, because it must not reset this chain.
    expect(harness.state.chain.length === 2, "auto-retry must retain the failback chain");
    // A successful steer uses agent.continue(), so there is no before_agent_start to consume.
    // This is the next real prompt and must reset immediately.
    await harness.emitBeforeAgentStart();
    expect(harness.state.chain.length === 0, "new user task did not reset chain");
    expect(harness.state.consecutive === 0, "new user task did not reset consecutive count");
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

    // The first before_agent_start after steering is already the next real task.
    await harness.emitBeforeAgentStart();
    expect(harness.state.chain.length === 0, "new task did not clear the completed failback chain");
    expect(harness.state.original?.provider === source.provider, "autoRestore lost the original model before its deadline");
    expect(harness.pi.setModelCalls.length === 1, "autoRestore ran before the original deadline");

    harness.state.resetsAt = Date.now() - 1;
    (harness.ctx as { model: { provider: string; id: string } }).model = fallback;
    await harness.emitBeforeAgentStart();
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
    // agent.continue() retains the chain without before_agent_start.
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

  results.push(await runTest("engine clears a cancelled compaction retry so a later manual compact can run", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    // Cancellation can happen after the retry timer was queued without Pi emitting a
    // second aborted session_compact_failed event.
    const cancelled = new AbortController();
    cancelled.abort();
    (harness.ctx as { signal?: AbortSignal }).signal = cancelled.signal;
    await waitForTimers();
    expect(harness.compactCalls.length === 0, "cancelled compaction left its pending retry timer active");
    (harness.ctx as { signal?: AbortSignal }).signal = new AbortController().signal;
    await harness.emitBeforeAgentStart();
    await harness.emitCompactionFailed("Codex error: The usage limit has been reached");
    await waitForTimers();
    expect(harness.compactCalls.length === 1, "manual compaction could not retry after cancellation cleanup");
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
    // 这些 code 来自腾讯官方 CodeBuddy CLI 的业务错误码枚举,且官方归类为
    // quota_balance_exhausted(账户级余额/额度耗尽)。CraftRate 的 6003/6004
    // 不在此列:它们是 per-model 的免费档 token 窗口,见下面的用例。
    const codes = ["14001", "14002", "14012", "14013", "14014", "14018", "14019"];
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

  results.push(await runTest("workbuddy CraftRate token windows are per-model rate limits with an official reset time", () => {
    // 真实事故样本(workbuddy/deepseek-v4.1-flash, stopReason=error 的原样 errorMessage)。
    const realSample =
      '429: {"message":"usage exceeds frequency limit, but don\'t worry, your usage will reset at ' +
      '2026-09-19 09:43:30 UTC+8, alternatively, you can switch to the other models to continue using it.",' +
      '"type":"invalid_request_error","code":"6004"}';

    // 官方文案里的 UTC+8 时刻必须解析成确定的 epoch,而不是猜本地时区。
    expect(
      parseCraftResetAt(realSample, Date.UTC(2026, 7, 1)) === Date.UTC(2026, 8, 19, 1, 43, 30),
      "the UTC+8 reset time must be converted to the exact epoch",
    );
    // 已经过去的时刻视为未知(窗口已恢复),交给冷却期兜底。
    expect(
      parseCraftResetAt(realSample, Date.UTC(2026, 8, 19, 1, 43, 31)) === undefined,
      "an expired reset time must not be reported",
    );
    // 不带 UTC 偏移时无法确定 epoch:宁可未知,也不拿本地时区猜。
    expect(
      parseCraftResetAt('reset at 2026-09-19 09:43:30', Date.UTC(2026, 7, 1)) === undefined,
      "a reset time without an explicit UTC offset must stay unknown",
    );

    // 宽松但显式的偏移写法要能识别(官方目前只见 UTC+8,但不应当因为写法微变就丢恢复时间)。
    const epoch = Date.UTC(2026, 8, 19, 1, 43, 30);
    const before = Date.UTC(2026, 7, 1);
    for (const sample of [
      "reset at 2026-09-19 09:43:30 UTC+8",
      "your usage will reset at 2026-09-19 09:43:30 UTC+08:00",
      "resets at 2026-09-19 09:43:30 GMT+0800",
      "reset at 2026-09-19 01:43:30 UTC",
      "reset at 2026-09-19T09:43:30 UTC+08",
    ]) {
      expect(
        parseCraftResetAt(sample, before) === epoch,
        `explicit UTC offset must be honored: ${sample}`,
      );
    }

    // 非法或自相矛盾的时刻一律拒绝,绝不返回被 Date.UTC 规范化出来的“附近”时刻。
    for (const sample of [
      "reset at 2026-02-31 09:43:30 UTC+8",
      "reset at 2026-09-19 25:70:00 UTC+8",
      "reset at 2026-09-19 09:43:30 UTC+99",
      "reset at 2026-09-19 09:43:30 UTC+08:99",
      "reset at 2026-09-19 09:43:30 CST",
      "reset at 2026-09-19 09:43:30 UTC+8 and reset at 2026-09-20 09:43:30 UTC+8",
    ]) {
      expect(
        parseCraftResetAt(sample, before) === undefined,
        `must not parse an invalid or conflicting stamp: ${sample}`,
      );
    }

    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    const resetAt = Math.floor((Date.now() + 2 * 3_600_000) / 1_000) * 1_000;
    for (const code of ["6003", "6004"]) {
      const verdict = workbuddyHandler.inspect(
        assistantFailure(
          "workbuddy",
          "deepseek-v4.1-flash",
          `429: {"message":"usage exceeds frequency limit, but don't worry, your usage will reset at ` +
            `${formatUtc8(resetAt)}, alternatively, you can switch to the other models to continue using it.",` +
            `"type":"invalid_request_error","code":"${code}"}`,
        ),
      );
      expect(verdict, `workbuddy code ${code} was not detected`);
      // 按模型计的免费档窗口,不是账户余额:同 provider 的付费档/其它部署有独立配额。
      expect(verdict.reason === "rate_limited", `unexpected reason for ${code}: ${verdict.reason}`);
      expect(verdict.scope === "any", `code ${code} must allow the same-provider paid line`);
      expect(
        verdict.resetsAt === resetAt,
        `code ${code} must use the official reset time, got ${verdict.resetsAt}`,
      );
      expect(
        !/账户额度耗尽/.test(verdict.note ?? ""),
        `code ${code} must not tell the user the account is out of quota: ${verdict.note}`,
      );
    }

    // 文案里没有重置时刻时退回配置的冷却期,仍然带到期自动解 ban 的 resetsAt。
    const withoutReset = workbuddyHandler.inspect(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        '429: {"message":"usage exceeds frequency limit","type":"invalid_request_error","code":"6004"}',
      ),
    );
    expect(withoutReset, "a 6004 without a reset time must still switch the chain");
    expect(
      typeof withoutReset!.resetsAt === "number" &&
        withoutReset!.resetsAt! <= Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1_000,
      "a 6004 without a reset time must fall back to the configured cooldown",
    );

    // 6008(RPD)与 6004(TPD)同为官方日配额,固定 60s 冷却对日窗口明显偏短,
    // 因此同样必须优先采用文案里的官方重置时刻。
    const dailyReset = Math.floor((Date.now() + 4 * 3_600_000) / 1_000) * 1_000;
    const rpd = workbuddyHandler.inspect(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        `429: {"message":"usage exceeds frequency limit, your usage will reset at ${formatUtc8(dailyReset)}",` +
          '"type":"invalid_request_error","code":"6008"}',
      ),
    );
    expect(rpd, "workbuddy code 6008 was not detected");
    expect(rpd.reason === "rate_limited", `unexpected reason for 6008: ${rpd.reason}`);
    expect(rpd.scope === "any", `unexpected scope for 6008: ${rpd.scope}`);
    expect(
      rpd.resetsAt === dailyReset,
      `6008 must use the official daily reset time, got ${rpd.resetsAt}`,
    );

    // 日窗口不可能在数天后才恢复:超出上界说明解析出了错误时间,退回冷却期而不是给出假承诺。
    const absurd = workbuddyHandler.inspect(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        `429: {"message":"usage exceeds frequency limit, your usage will reset at ${formatUtc8(Date.now() + 30 * 24 * 3_600_000)}",` +
          '"type":"invalid_request_error","code":"6004"}',
      ),
    );
    expect(absurd, "a 6004 with an out-of-range stamp must still switch the chain");
    expect(
      absurd!.resetsAt! <= Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1_000,
      "an out-of-range daily reset must fall back to the cooldown instead of a bogus deadline",
    );

    // 与其它瞬时限流一致:冷却配成 <=0 即关闭该逃逸(回到交给 pi 退避重试)。
    setWorkbuddyRateLimitCooldownMs(0);
    expect(
      workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", realSample)) === null,
      "a disabled escape must keep 6003/6004 on pi retry",
    );
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  }));

  results.push(await runTest("workbuddy-cn shares the workbuddy terminal classification", () => {
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    resetWorkbuddyOutages();
    const quotaMessage = '400: {"message":"UsageLimitExceeded","type":"invalid_request_error","code":"14001"}';
    const quota = workbuddyCnHandler.inspect(assistantFailure("workbuddy-cn", "hy3", quotaMessage));
    expect(quota?.reason === "quota_exhausted", `unexpected quota verdict: ${quota?.reason}`);
    expect(quota?.scope === "cross-provider", `unexpected quota scope: ${quota?.scope}`);

    const resetAt = Math.floor((Date.now() + 2 * 3_600_000) / 1_000) * 1_000;
    const rateLimit = workbuddyCnHandler.inspect(assistantFailure(
      "workbuddy-cn",
      "hy3",
      `429: {"message":"usage exceeds frequency limit, but don't worry, your usage will reset at ${formatUtc8(resetAt)}, alternatively, you can switch to the other models to continue using it.","type":"invalid_request_error","code":"6004"}`,
    ));
    expect(rateLimit?.reason === "rate_limited", `unexpected rate-limit verdict: ${rateLimit?.reason}`);
    expect(rateLimit?.scope === "any", `unexpected rate-limit scope: ${rateLimit?.scope}`);
    expect(typeof rateLimit?.resetsAt === "number", "rate-limit resetsAt was not populated");
    expect(rateLimit?.note?.includes("国内版"), `note did not identify domestic deployment: ${rateLimit?.note}`);

    const waf = workbuddyCnHandler.inspect(assistantFailure("workbuddy-cn", "hy3", WAF_BLOCK_PAGE));
    expect(waf?.reason === "waf_blocked", `unexpected WAF verdict: ${waf?.reason}`);
    expect(waf?.scope === "cross-provider", `unexpected WAF scope: ${waf?.scope}`);
    expect(workbuddyCnHandler.inspect(assistantFailure("workbuddy", "hy3", quotaMessage)) === null,
      "domestic handler must ignore international provider messages");
    expect(workbuddyHandler.inspect(assistantFailure("workbuddy-cn", "hy3", quotaMessage)) === null,
      "international handler must ignore domestic provider messages");
    resetWorkbuddyOutages();
  }));

  results.push(await runTest("workbuddy rate-limit codes switch the chain with a cooldown", () => {
    // 瞬时限流:pi 的退避(1s/2s/4s)远短于 WorkBuddy 的限流窗口,重试耗尽后任务会中断,
    // 因此按配置直接切备用链,并带一个到期自动解 ban 的冷却期。
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    const codes = ["14003", "6005", "6006", "6007", "6008"];
    for (const code of codes) {
      const verdict = workbuddyHandler.inspect(
        assistantFailure(
          "workbuddy",
          "deepseek-v4.1-flash",
          `429: {"message":"RateLimitError","type":"invalid_request_error","code":"${code}"}`,
        ),
      );
      expect(verdict, `workbuddy code ${code} was not detected`);
      expect(verdict.reason === "rate_limited", `unexpected reason for ${code}: ${verdict.reason}`);
      // 限流用 "any":按用户配的链逐跳尝试(同 provider 的另一部署也可能有独立配额)。
      expect(verdict.scope === "any", `unexpected scope for ${code}: ${verdict.scope}`);
      expect(typeof verdict.resetsAt === "number", `code ${code} must carry a cooldown`);
      expect(
        verdict.resetsAt! > Date.now() &&
          verdict.resetsAt! <= Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1_000,
        `code ${code} cooldown must be bounded`,
      );
    }

    // 冷却配成 <=0 完全关闭该逃逸,回到"全部交给 pi 重试"的旧行为。
    setWorkbuddyRateLimitCooldownMs(0);
    for (const code of codes) {
      expect(
        workbuddyHandler.inspect(
          assistantFailure(
            "workbuddy",
            "deepseek-v4.1-flash",
            `429: {"message":"RateLimitError","type":"invalid_request_error","code":"${code}"}`,
          ),
        ) === null,
        `code ${code} must stay transient when the escape is disabled`,
      );
    }
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  }));

  results.push(await runTest("workbuddy non-terminal codes never trigger a failback", () => {
    // 鉴权/未开通/模型错误/上下文超长/会话数/联网搜索额度 —— 换模型都无效。
    const codes = [
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

    // 没有业务码也没有额度文案的 429 属瞬时限流:同样直接切备用链,带冷却期。
    const transient = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "m", "429: Too many requests"),
    );
    expect(transient, "a bare 429 must switch the chain");
    expect(transient.reason === "rate_limited", `unexpected reason: ${transient.reason}`);
    expect(transient.scope === "any", `unexpected scope: ${transient.scope}`);
    expect(typeof transient.resetsAt === "number", "a bare 429 must carry a cooldown");

    // 冷却配成 <=0 时回到交给 pi 退避重试的旧行为。
    setWorkbuddyRateLimitCooldownMs(0);
    expect(
      workbuddyHandler.inspect(assistantFailure("workbuddy", "m", "429: Too many requests")) === null,
      "a bare 429 must stay transient when the escape is disabled",
    );
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
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

  results.push(await runTest("workbuddy gateway outages are transient until a bounded escape", () => {
    // 真实样本:apisix/openresty 的 502/504 HTML 页,无业务码、无 JSON 体。
    const gatewayPage =
      '504 <html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n<hr><center>openresty</center>\r\n<p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a>.</em></p></body>\r\n</html>\r\n';
    expect(
      classifyTransientOutage(gatewayPage) === "gateway",
      "a 502/504 gateway page must classify as a gateway outage",
    );
    expect(
      classifyTransientOutage("500 <html>\n <head><title>500 Internal Server Error</title></head>\n <body>\n <center><h1>500 Internal Server Error</h1></center>\n <hr><center>openresty</center>\n <p><em>Powered by <a href=\"https://apisix.apache.org/\">APISIX</a>.</em></p></body>\n </html>") === "gateway",
      "a 500 openresty/APISIX page must classify as a gateway outage",
    );
    expect(
      classifyTransientOutage("503 <html><head><title>503 Service Temporarily Unavailable</title></head><body>openresty</body></html>") === "gateway",
      "a 503 openresty page must classify as a gateway outage",
    );
    expect(
      classifyTransientOutage("502 <!DOCTYPE html>\n<html lang=\"en\">\n<head>") === "gateway",
      "a 502 DOCTYPE page must classify as a gateway outage",
    );
    expect(
      classifyTransientOutage("Provider finish_reason: error") === "provider_error",
      "a provider finish_reason error must classify as an upstream failure",
    );
    // 有结构化错误体的一律走 code 判定,免得把上游透传的 JSON 当成网关页。
    expect(
      classifyTransientOutage('502: {"code":14001,"msg":"UsageLimitExceeded"}') === undefined,
      "a JSON error body must never be classified as a gateway page",
    );
    expect(
      classifyTransientOutage("500 Internal Server Error") === undefined,
      "a bare status line without an HTML body is not a gateway page",
    );

    // 单次故障仍是瞬时错误:交给 pi 退避重试。
    setWorkbuddyTransientOutageStreak(DEFAULT_TRANSIENT_OUTAGE_STREAK);
    resetWorkbuddyOutages();
    const once = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage),
    );
    expect(once === null, "a single gateway failure must stay transient");

    // 连续到阈值才允许一次跨 provider 逃逸,并带冷却期让 ban 自动过期。
    for (let i = 2; i < DEFAULT_TRANSIENT_OUTAGE_STREAK; i++) {
      expect(
        workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage)) === null,
        `gateway failure ${i} must stay transient`,
      );
    }
    const escaped = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage),
    );
    expect(escaped, "the configured streak must allow one escape");
    expect(escaped.reason === "endpoint_unavailable", `unexpected reason: ${escaped.reason}`);
    expect(escaped.scope === "cross-provider", `unexpected scope: ${escaped.scope}`);
    expect(typeof escaped.resetsAt === "number", "an escape must carry a cooldown");
    expect(
      escaped.resetsAt! > Date.now() &&
        escaped.resetsAt! <= Date.now() + TRANSIENT_OUTAGE_COOLDOWN_MS + 1_000,
      "the escape cooldown must be bounded",
    );

    // 逃逸后计数复位,下一个单次故障又回到瞬时错误。
    expect(
      workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage)) === null,
      "the streak must reset after an escape",
    );

    // 阈值 <=0 完全关闭逃逸。
    setWorkbuddyTransientOutageStreak(0);
    for (let i = 0; i < DEFAULT_TRANSIENT_OUTAGE_STREAK + 2; i++) {
      expect(
        workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage)) === null,
        "a disabled streak must never escape",
      );
    }

    // 混合状态码共享同一个连续计数:真实会话里 500/502/504 是交替出现的。
    setWorkbuddyTransientOutageStreak(DEFAULT_TRANSIENT_OUTAGE_STREAK);
    resetWorkbuddyOutages();
    const mixed = [
      "504 <html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>openresty</center></body></html>",
      "502 <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>openresty</center></body></html>",
      "500 <html><head><title>500 Internal Server Error</title></head><body><center><h1>500 Internal Server Error</h1></center><hr><center>openresty</center></body></html>",
    ];
    for (const page of mixed.slice(0, -1)) {
      expect(
        workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", page)) === null,
        "mixed gateway statuses must share one streak",
      );
    }
    expect(
      workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", mixed[mixed.length - 1])),
      "a mixed 500/502/504 streak must still escape at the threshold",
    );

    // 上游恢复后计数不再累加:两连击后成功请求不该被上一轮计数拖成逃逸。
    resetWorkbuddyOutages();
    workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage));
    expect(
      workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage)) === null,
      "two consecutive gateway failures must stay transient",
    );

    // 计数按模型隔离:另一个模型不会共享同一轮故障计数。
    setWorkbuddyTransientOutageStreak(DEFAULT_TRANSIENT_OUTAGE_STREAK);
    resetWorkbuddyOutages();
    workbuddyHandler.inspect(assistantFailure("workbuddy", "hy3", gatewayPage));
    workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage));
    workbuddyHandler.inspect(assistantFailure("workbuddy", "hy3", gatewayPage));
    expect(
      workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage)) === null,
      "gateway outage streaks must be counted per model",
    );
    resetWorkbuddyOutages();
    setWorkbuddyTransientOutageStreak(DEFAULT_TRANSIENT_OUTAGE_STREAK);
  }));

  results.push(await runTest("engine escapes a sustained workbuddy gateway outage", async () => {
    const config = {
      chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next"]],
      fallbacks: {},
      workbuddyTransientOutageStreak: 2,
    };
    const harness = engineHarness(
      config,
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );
    const gatewayPage = "502 <html><head><title>502 Bad Gateway</title></head><body>openresty</body></html>";

    const otherEngine = engineHarness(
      config,
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );
    await harness.emit(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage));
    await otherEngine.emit(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage));
    // A true prompt on one engine clears only that engine's transient state.
    await harness.emitBeforeAgentStart();
    await otherEngine.emit(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage));
    expect(harness.pi.setModelCalls.length === 0, "one engine's prompt must not advance another engine's streak");
    const called = otherEngine.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected other engine to escape after its own streak, got ${called.length}`);
    expect(called[0].provider === "modelscope", `wrong escape target: ${called[0].provider}`);
    expect(otherEngine.pi.userMessages.length === 1, "the escape did not steer the continuation");
  }));

  results.push(await runTest("engine keeps workbuddy gateway escape disabled for zero and negative thresholds", async () => {
    const gatewayPage = "502 <html><head><title>502 Bad Gateway</title></head><body>openresty</body></html>";
    for (const threshold of [0, -1]) {
      const harness = engineHarness(
        {
          chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next"]],
          fallbacks: {},
          workbuddyTransientOutageStreak: threshold,
        },
        [
          { provider: "workbuddy", id: "deepseek-v4.1-flash" },
          { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
        ],
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
      );
      for (let i = 0; i < DEFAULT_TRANSIENT_OUTAGE_STREAK + 2; i++) {
        await harness.emit(assistantFailure("workbuddy", "deepseek-v4.1-flash", gatewayPage));
      }
      expect(harness.pi.setModelCalls.length === 0, `threshold ${threshold} switched models`);
      expect(!harness.pi.entries.some((entry) => entry.type === "model-failback-ban"), `threshold ${threshold} wrote a ban entry`);
      expect(harness.bans.list().length === 0, `threshold ${threshold} persisted a ban`);
      expect(harness.pi.userMessages.length === 0, `threshold ${threshold} queued a continuation`);
    }
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

  results.push(await runTest("engine switches the chain on a workbuddy 14003 rate limit", async () => {
    // 瞬时限流不再等 pi 退避重试耗尽,而是直接切备用链,并写一个带冷却期的 ban,
    // 到期自动解 ban(而非永久禁用)。
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    const harness = engineHarness(
      {
        chains: [["workbuddy/hy4-preview-f", "modelscope/Qwen/Qwen3.8-Flash-Next", "deepseek/deepseek-flash"]],
        fallbacks: {},
      },
      [
        { provider: "workbuddy", id: "hy4-preview-f" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
        { provider: "deepseek", id: "deepseek-flash" },
      ],
      { provider: "workbuddy", id: "hy4-preview-f" },
    );

    const before = Date.now();
    await harness.emit(
      assistantFailure(
        "workbuddy",
        "hy4-preview-f",
        '429: {"message":"too many requests","type":"invalid_request_error","code":"14003"}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected 1 switch, got ${called.length}`);
    expect(called[0].provider === "modelscope", `wrong fallback target: ${called[0].provider}`);
    expect(harness.pi.userMessages.length === 1, "a rate limit must steer a continuation");

    const ban = harness.bans.get("workbuddy/hy4-preview-f");
    expect(ban, "a rate limit must ban the source model");
    expect(ban!.reason === "rate_limited", `unexpected ban reason: ${ban!.reason}`);
    expect(ban!.scope === "any", `unexpected ban scope: ${ban!.scope}`);
    expect(typeof ban!.resetsAt === "number", "a rate-limit ban must carry a cooldown");
    expect(
      ban!.resetsAt! > before && ban!.resetsAt! <= Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS + 1_000,
      "the rate-limit cooldown must be bounded",
    );
  }));

  results.push(await runTest("engine hops to the same-provider next node on a workbuddy rate limit", async () => {
    // 用户实际配置里存在同 provider 的逐跳链:限流时应当走到下一跳,而不是被
    // cross-provider 守卫拦下。
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    const harness = engineHarness(
      {
        chains: [[
          "workbuddy/deepseek-v4.1-flash",
          "workbuddy/deepseek-v4.1-flash-sg",
          "command-code/deepseek/deepseek-v4.1-flash",
        ]],
        fallbacks: {},
      },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "workbuddy", id: "deepseek-v4.1-flash-sg" },
        { provider: "command-code", id: "deepseek/deepseek-v4.1-flash" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );

    await harness.emit(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        '429: {"message":"too many requests","type":"invalid_request_error","code":"14003"}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected 1 switch, got ${called.length}`);
    expect(
      called[0].provider === "workbuddy" && called[0].id === "deepseek-v4.1-flash-sg",
      `wrong fallback target: ${called[0].provider}/${called[0].id}`,
    );
  }));

  results.push(await runTest("engine hops to the same-provider paid line on a workbuddy 6004 and autoRestores", async () => {
    // 真实事故:免费档 deepseek-v4.1-flash 的 CraftRate 窗口用尽(code 6004)。
    // 官方 ModelRateLimitCap 给 freeId=deepseek-v4.1-flash / paidId=…-sg 双档且
    // allowPaidSwitch=true,因此必须走到链上的付费档,而不是当成账户余额耗尽
    // 把整个 provider 跳过;ban 要带官方重置时刻,autoRestore 才能切回免费档。
    setWorkbuddyRateLimitCooldownMs(DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    const harness = engineHarness(
      {
        chains: [[
          "workbuddy/deepseek-v4.1-flash",
          "workbuddy/deepseek-v4.1-flash-sg",
          "command-code/deepseek/deepseek-v4.1-flash",
        ]],
        fallbacks: {},
        autoRestore: true,
      },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "workbuddy", id: "deepseek-v4.1-flash-sg" },
        { provider: "command-code", id: "deepseek/deepseek-v4.1-flash" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );

    const resetAt = Math.floor((Date.now() + 2 * 3_600_000) / 1_000) * 1_000;
    await harness.emit(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        '429: {"message":"usage exceeds frequency limit, but don\'t worry, your usage will reset at ' +
          `${formatUtc8(resetAt)}, alternatively, you can switch to the other models to continue using it.",` +
          '"type":"invalid_request_error","code":"6004"}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected 1 switch, got ${called.length}`);
    expect(
      called[0].provider === "workbuddy" && called[0].id === "deepseek-v4.1-flash-sg",
      `the free line must hop to its paid line: ${called[0].provider}/${called[0].id}`,
    );

    const ban = harness.bans.get("workbuddy/deepseek-v4.1-flash");
    expect(ban, "a CraftRate token window must ban the exhausted model");
    expect(ban!.reason === "rate_limited", `unexpected ban reason: ${ban!.reason}`);
    expect(ban!.scope === "any", `unexpected ban scope: ${ban!.scope}`);
    expect(ban!.resetsAt === resetAt, `the ban must carry the official reset time, got ${ban!.resetsAt}`);
    expect(
      !/账户额度耗尽/.test(ban!.note ?? ""),
      `the ban note must not claim an account-level quota loss: ${ban!.note}`,
    );
    // autoRestore 依赖这次终态的 resetsAt,不能被丢弃。
    expect(
      harness.state.original?.model === "deepseek-v4.1-flash" && harness.state.resetsAt === resetAt,
      "the restore snapshot must keep the official reset time",
    );

    // 到点后自动切回免费档。
    (harness.ctx as { model: { provider: string; id: string } }).model = {
      provider: "workbuddy",
      id: "deepseek-v4.1-flash-sg",
    };
    harness.state.resetsAt = Date.now() - 1;
    await harness.emitBeforeAgentStart();
    const restored = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(restored.length === 2, `autoRestore did not run, calls=${restored.length}`);
    expect(
      restored[1].provider === "workbuddy" && restored[1].id === "deepseek-v4.1-flash",
      `autoRestore picked the wrong model: ${restored[1].provider}/${restored[1].id}`,
    );
  }));

  results.push(await runTest("engine keeps workbuddy 6004 on pi retry when the escape is disabled", async () => {
    // 与其它瞬时限流一致:冷却期 <=0 关闭逃逸后不得切模型/写 ban。
    const harness = engineHarness(
      {
        chains: [["workbuddy/deepseek-v4.1-flash", "workbuddy/deepseek-v4.1-flash-sg"]],
        fallbacks: {},
        workbuddyRateLimitCooldownMs: 0,
      },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "workbuddy", id: "deepseek-v4.1-flash-sg" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );

    await harness.emit(
      assistantFailure(
        "workbuddy",
        "deepseek-v4.1-flash",
        '429: {"message":"usage exceeds frequency limit","type":"invalid_request_error","code":"6004"}',
      ),
    );

    expect(harness.pi.setModelCalls.length === 0, "a disabled escape must not switch models");
    expect(harness.bans.list().length === 0, "a disabled escape must not ban");
  }));

  results.push(await runTest("engine keeps a workbuddy 14003 on pi retry when the escape is disabled", async () => {
    // 关闭开关走 config(engine 总是注入 getter,模块级默认值不参与)。
    const harness = engineHarness(
      {
        chains: [["workbuddy/hy4-preview-f", "modelscope/Qwen/Qwen3.8-Flash-Next"]],
        fallbacks: {},
        workbuddyRateLimitCooldownMs: 0,
      },
      [
        { provider: "workbuddy", id: "hy4-preview-f" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "hy4-preview-f" },
    );

    await harness.emit(
      assistantFailure(
        "workbuddy",
        "hy4-preview-f",
        '429: {"message":"too many requests","type":"invalid_request_error","code":"14003"}',
      ),
    );

    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 0, "a disabled rate-limit escape must not switch models");
    expect(harness.bans.get("workbuddy/hy4-preview-f") === undefined, "a disabled escape must not ban");
  }));

  results.push(await runTest("engine honors a custom workbuddy rate-limit cooldown", async () => {
    const cooldownMs = 7_000;
    const harness = engineHarness(
      {
        chains: [["workbuddy/hy4-preview-f", "modelscope/Qwen/Qwen3.8-Flash-Next"]],
        fallbacks: {},
        workbuddyRateLimitCooldownMs: cooldownMs,
      },
      [
        { provider: "workbuddy", id: "hy4-preview-f" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "hy4-preview-f" },
    );

    const before = Date.now();
    await harness.emit(
      assistantFailure(
        "workbuddy",
        "hy4-preview-f",
        '429: {"message":"too many requests","type":"invalid_request_error","code":"14003"}',
      ),
    );

    const ban = harness.bans.get("workbuddy/hy4-preview-f");
    expect(ban, "a rate limit must ban the source model");
    expect(
      ban!.resetsAt! > before && ban!.resetsAt! <= Date.now() + cooldownMs + 1_000,
      "the configured cooldown must be honored",
    );
  }));

  results.push(await runTest("workbuddy waf block page escapes immediately", () => {
    // pi 的 RETRYABLE_PROVIDER_ERROR_PATTERN 不含 403:一次 403 就终止该 run,
    // 不可能有第二次 message_end,所以 WAF 必须默认首次即逃逸。
    setWorkbuddyWafBlockStreak(DEFAULT_WAF_BLOCK_STREAK);
    resetWorkbuddyOutages();
    expect(classifyWafBlock(WAF_BLOCK_PAGE), "the real WAF block page must be classified as a WAF block");

    const before = Date.now();
    const verdict = workbuddyHandler.inspect(
      assistantFailure("workbuddy", "deepseek-v4.1-flash", WAF_BLOCK_PAGE),
    );
    expect(verdict, "a WAF block page must escape on the first occurrence");
    expect(verdict.reason === "waf_blocked", `unexpected reason: ${verdict.reason}`);
    expect(verdict.scope === "cross-provider", `unexpected scope: ${verdict.scope}`);
    expect(typeof verdict.resetsAt === "number", "a WAF escape must carry a cooldown");
    expect(
      verdict.resetsAt! > before && verdict.resetsAt! <= before + WAF_BLOCK_COOLDOWN_MS + 1_000,
      "the WAF cooldown must be bounded",
    );

    // 每个特征串单独出现时也能命中。
    const features = [
      '403 <!DOCTYPE html><html><head><title>WAF Block Page</title></head><body>blocked</body></html>',
      '403 <!DOCTYPE html><html><body><script>window.location.href = "https://api.waf-intl.qq.com/waf-attack-feedback/" + uuid;</script></body></html>',
      '403 <!DOCTYPE html><html><body><p class="desc">The web application firewall has detected a security risk</p></body></html>',
    ];
    for (const sample of features) {
      expect(classifyWafBlock(sample), `WAF feature was not detected: ${sample.slice(0, 60)}`);
    }
    resetWorkbuddyOutages();
  }));

  results.push(await runTest("workbuddy waf classification excludes json bodies and unrelated pages", () => {
    // 有结构化错误体的一律走 code 判定,不带 JSON 的普通错误/普通 HTML 页也不得命中。
    const samples = [
      '403: {"message":"UsageLimitLicenseExpired","type":"invalid_request_error","code":"14015"}',
      "403 upgrade_required",
      '401 <!DOCTYPE html><html><head><title>Unauthorized</title></head><body>nginx</body></html>',
      "403 status code (no body)",
      '500 <html><head><title>500 Internal Server Error</title></head><body>openresty</body></html>',
    ];
    for (const sample of samples) {
      expect(!classifyWafBlock(sample), `must not be classified as a WAF page: ${sample}`);
    }

    resetWorkbuddyOutages();
    setWorkbuddyWafBlockStreak(DEFAULT_WAF_BLOCK_STREAK);
    const handlerSamples = [
      '403: {"code":"14015"}',
      "403 upgrade_required",
      "403 status code (no body)",
    ];
    for (const sample of handlerSamples) {
      expect(
        workbuddyHandler.inspect(assistantFailure("workbuddy", "deepseek-v4.1-flash", sample)) === null,
        `handler must stay non-terminal: ${sample}`,
      );
    }

    // 回归确认 5xx 网关页仍走原路径:默认阈值下第一次仍是瞬时错误。
    resetWorkbuddyOutages();
    setWorkbuddyTransientOutageStreak(DEFAULT_TRANSIENT_OUTAGE_STREAK);
    expect(
      workbuddyHandler.inspect(
        assistantFailure("workbuddy", "deepseek-v4.1-flash", GATEWAY_PAGE_502),
      ) === null,
      "a single gateway page must still be transient",
    );
    resetWorkbuddyOutages();
  }));

  results.push(await runTest("workbuddy waf escape can be thresholded or disabled", () => {
    const wafFailure = () => assistantFailure("workbuddy", "deepseek-v4.1-flash", WAF_BLOCK_PAGE);

    setWorkbuddyWafBlockStreak(0);
    resetWorkbuddyOutages();
    for (let i = 0; i < 3; i++) {
      expect(workbuddyHandler.inspect(wafFailure()) === null, "a disabled WAF escape must never escape");
    }

    setWorkbuddyWafBlockStreak(2);
    resetWorkbuddyOutages();
    expect(workbuddyHandler.inspect(wafFailure()) === null, "the first WAF page must stay transient at threshold 2");
    const second = workbuddyHandler.inspect(wafFailure());
    expect(second, "the second WAF page must escape at threshold 2");
    expect(second.reason === "waf_blocked", `unexpected reason: ${second.reason}`);
    expect(workbuddyHandler.inspect(wafFailure()) === null, "the WAF streak must reset after an escape");

    // WAF 计数与 5xx 计数互不干扰:先打一次 5xx 网关页,再打一次 WAF 页,
    // 两者都用默认阈值,WAF 那次必须仍然逃逸。
    setWorkbuddyWafBlockStreak(DEFAULT_WAF_BLOCK_STREAK);
    setWorkbuddyTransientOutageStreak(DEFAULT_TRANSIENT_OUTAGE_STREAK);
    resetWorkbuddyOutages();
    expect(
      workbuddyHandler.inspect(
        assistantFailure("workbuddy", "deepseek-v4.1-flash", GATEWAY_PAGE_502),
      ) === null,
      "a single gateway page must stay transient",
    );
    const escaped = workbuddyHandler.inspect(wafFailure());
    expect(escaped, "a gateway outage must not consume the WAF streak");
    expect(escaped.reason === "waf_blocked", `unexpected reason: ${escaped.reason}`);

    setWorkbuddyWafBlockStreak(DEFAULT_WAF_BLOCK_STREAK);
    resetWorkbuddyOutages();
  }));

  results.push(await runTest("engine switches provider on a workbuddy waf block", async () => {
    const harness = engineHarness(
      {
        chains: [[
          "workbuddy/deepseek-v4.1-flash",
          "workbuddy/deepseek-v4.1-flash-sg",
          "command-code/deepseek/deepseek-v4.1-flash",
        ]],
        fallbacks: {},
      },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "workbuddy", id: "deepseek-v4.1-flash-sg" },
        { provider: "command-code", id: "deepseek/deepseek-v4.1-flash" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );

    const before = Date.now();
    await harness.emit(assistantFailure("workbuddy", "deepseek-v4.1-flash", WAF_BLOCK_PAGE));

    // cross-provider 守卫必须跳过同 provider 的 deepseek-v4.1-flash-sg。
    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected 1 switch, got ${called.length}`);
    expect(
      called[0].provider === "command-code",
      `wrong fallback target: ${called[0].provider}/${called[0].id}`,
    );

    const ban = harness.bans.get("workbuddy/deepseek-v4.1-flash");
    expect(ban, "a WAF block must ban the source model");
    expect(ban!.reason === "waf_blocked", `unexpected ban reason: ${ban!.reason}`);
    expect(ban!.scope === "cross-provider", `unexpected ban scope: ${ban!.scope}`);
    expect(typeof ban!.resetsAt === "number", "a WAF ban must carry a cooldown");
    expect(
      ban!.resetsAt! > before && ban!.resetsAt! <= before + WAF_BLOCK_COOLDOWN_MS + 1_000,
      "the WAF cooldown must be bounded",
    );

    expect(harness.pi.userMessages.length === 1, "a WAF block must steer a continuation");
    expect(
      (harness.pi.userMessages[0].options as { deliverAs: string }).deliverAs === "steer",
      "the continuation must be delivered as steer",
    );
  }));

  results.push(await runTest("engine keeps a workbuddy waf block on pi retry when disabled", async () => {
    const harness = engineHarness(
      {
        chains: [[
          "workbuddy/deepseek-v4.1-flash",
          "workbuddy/deepseek-v4.1-flash-sg",
          "command-code/deepseek/deepseek-v4.1-flash",
        ]],
        fallbacks: {},
        workbuddyWafStreak: 0,
      },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "workbuddy", id: "deepseek-v4.1-flash-sg" },
        { provider: "command-code", id: "deepseek/deepseek-v4.1-flash" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );

    await harness.emit(assistantFailure("workbuddy", "deepseek-v4.1-flash", WAF_BLOCK_PAGE));

    expect(harness.pi.setModelCalls.length === 0, "a disabled WAF escape must not switch models");
    expect(harness.bans.get("workbuddy/deepseek-v4.1-flash") === undefined, "a disabled escape must not ban");
    expect(harness.pi.userMessages.length === 0, "a disabled escape must not queue a continuation");
    expect(
      !harness.pi.entries.some((entry) => entry.type === "model-failback-ban"),
      "a disabled escape must not write a ban entry",
    );
  }));

  results.push(await runTest("registry contains all seven providers", () => {
    const providers = supportedProviders();
    expect(providers.length === 7, `expected 7 providers, got ${providers.length}`);
    for (const provider of [
      "openai-codex",
      "opencode",
      "opencode-go",
      "modelscope",
      "command-code",
      "workbuddy",
      "workbuddy-cn",
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

  results.push(await runTest("engine fails closed when its continuation marker cannot persist", async () => {
    const harness = engineHarness({
      fallbacks: { "openai-codex/gpt-5.6-sol": "rightcode-codex/gpt-5.6-sol" },
    });
    harness.pi.appendEntryError = new Error("disk full");
    await harness.emit(assistantFailure(
      "openai-codex", "gpt-5.6-sol", "You have hit your ChatGPT usage limit.",
    ));
    expect(harness.pi.setModelCalls.length === 1, "model switch must remain durable after marker failure");
    expect(harness.pi.userMessages.length === 0, "marker failure must not queue an unrecognizable continuation");
    expect(harness.notifications.some(({ message }) => message.includes("不会自动续跑")), "marker failure was not reported clearly");
    // A later user task is independent and must not be left behind a pending continuation lock.
    await harness.emitBeforeAgentStart();
    harness.pi.appendEntryError = undefined;
    await harness.emit(assistantFailure(
      "openai-codex", "gpt-5.6-sol", "You have hit your ChatGPT usage limit.",
    ));
    expect(harness.pi.userMessages.length === 1, "next task did not recover after marker failure");
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

  // ---------------------------------------------------------------- 行为升级（复读）
  // thinking-breaker 发现模型反复复读时发 `thinking-breaker:escalate`；本扩展
  // 负责把它变成一次真正的换模型 + 续跑。这一组用例锁住那套契约。
  const emitEscalate = async (
    harness: ReturnType<typeof engineHarness>,
    overrides: Partial<{
      key: string;
      version: number;
      reason: string;
      note: string;
      evidence:
        | { kind?: "period"; period: number; repeats: number; chars: number; strikes: number }
        | {
            kind: "collapse";
            distinct: number;
            lineCount: number;
            repeatRatio: number;
            chars: number;
            strikes: number;
          };
    }> = {},
  ): Promise<{ ok: boolean; switchedTo?: string; message?: string } | undefined> => {
    let reply: { ok: boolean; switchedTo?: string; message?: string } | undefined;
    const request = {
      version: 1,
      sessionId: "test-session",
      key: "workbuddy/deepseek-v4.1-flash",
      reason: "thinking_loop",
      note: "思考尾部连续重复 29 次",
      evidence: { period: 68, repeats: 29, chars: 42_500, strikes: 2 },
      accept(value: { ok: boolean; switchedTo?: string; message?: string }) {
        reply = value;
      },
      ...overrides,
    };
    harness.pi.events.emit("thinking-breaker:escalate", request);
    // 接手方是异步的（要 await 持久化 ban + setModel），让出几个宏任务。
    for (let i = 0; i < 20 && reply === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return reply;
  };

  results.push(await runTest("engine escalates a thinking loop to the next chain node", async () => {
    const harness = engineHarness(
      { chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next"]], fallbacks: {} },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );
    // 行为升级依赖“最近一次事件的上下文”，真实流程里 session_start 已提供。
    await harness.emitSessionStart();
    const reply = await emitEscalate(harness);
    expect(reply?.ok === true, `escalation was refused: ${reply?.message ?? "no reply"}`);
    expect(reply?.switchedTo === "modelscope/Qwen/Qwen3.8-Flash-Next", `wrong target: ${reply?.switchedTo}`);
    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected one setModel call, got ${called.length}`);
    expect(called[0].provider === "modelscope", `wrong provider: ${called[0].provider}`);
    // ban 必须落盘且带冷却期，否则同会话会无限连跳。
    const record = harness.bans.get("workbuddy/deepseek-v4.1-flash");
    expect(record?.reason === "thinking_loop", `wrong ban reason: ${record?.reason}`);
    expect(typeof record?.resetsAt === "number", "behavior ban has no cooldown");
    expect(
      harness.pi.entries.some((entry) => entry.type === "model-failback-ban"),
      "ban entry was not appended",
    );
    // 接手方必须自己发续跑：abort 已经结束了原 agent run。
    expect(harness.pi.userMessages.length === 1, `continuation was not steered (${harness.pi.userMessages.length})`);
    expect(
      String(harness.pi.userMessages[0].content).includes("反复复读"),
      "continuation does not explain the loop",
    );
    expect(
      harness.notifications.some(({ message }) => message.includes("反复复读思考")),
      "escalation notification was not emitted",
    );
  }));

  results.push(await runTest("engine escalates a vocabulary-collapse claim like a period loop", async () => {
    const harness = engineHarness(
      { chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next"]], fallbacks: {} },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );
    await harness.emitSessionStart();
    // 第二种探针（词汇坍缩）只是证据形状不同；换模型/ban/续跑必须与周期探针完全一致。
    const reply = await emitEscalate(harness, {
      evidence: { kind: "collapse", distinct: 3, lineCount: 120, repeatRatio: 0.97, chars: 8_400, strikes: 2 },
    });
    expect(reply?.ok === true, `collapse escalation was refused: ${reply?.message ?? "no reply"}`);
    expect(reply?.switchedTo === "modelscope/Qwen/Qwen3.8-Flash-Next", `wrong target: ${reply?.switchedTo}`);
    const called = harness.pi.setModelCalls as Array<{ provider: string; id: string }>;
    expect(called.length === 1, `expected one setModel call, got ${called.length}`);
    expect(called[0].provider === "modelscope", `wrong provider: ${called[0].provider}`);
    expect(
      harness.state.chain.includes("modelscope/Qwen/Qwen3.8-Flash-Next"),
      "collapse escalation did not extend the failback chain",
    );
    // ban 必须落盘且带冷却期，否则同会话会无限连跳。
    const record = harness.bans.get("workbuddy/deepseek-v4.1-flash");
    expect(record?.reason === "thinking_loop", `wrong ban reason: ${record?.reason}`);
    expect(typeof record?.resetsAt === "number", "behavior ban has no cooldown");
    expect(
      harness.pi.entries.some((entry) => entry.type === "model-failback-ban"),
      "ban entry was not appended",
    );
    // 接手方必须自己发续跑：abort 已经结束了原 agent run。
    expect(harness.pi.userMessages.length === 1, `continuation was not steered (${harness.pi.userMessages.length})`);
    expect(
      String(harness.pi.userMessages[0].content).includes("反复复读"),
      "continuation does not explain the loop",
    );
    expect(
      harness.notifications.some(({ message }) => message.includes("反复复读思考")),
      "escalation notification was not emitted",
    );
  }));

  results.push(await runTest("engine refuses a thinking-loop escalation for a stale model", async () => {
    // 用户已经手动换了模型，thinking-breaker 的请求描述的是旧模型：
    // 不能把新模型 ban 掉，直接让它重试即可。
    const harness = engineHarness(
      { chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next"]], fallbacks: {} },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
    );
    await harness.emitSessionStart();
    const reply = await emitEscalate(harness);
    expect(reply?.ok === false, "stale escalation was accepted");
    expect(harness.pi.setModelCalls.length === 0, "stale escalation switched models");
    expect(harness.bans.list().length === 0, "stale escalation banned the new model");
    expect(harness.pi.userMessages.length === 0, "stale escalation queued a continuation");
  }));

  results.push(await runTest("engine refuses a thinking-loop escalation without a fallback", async () => {
    const harness = engineHarness(
      { fallbacks: {} },
      [{ provider: "workbuddy", id: "deepseek-v4.1-flash" }],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );
    await harness.emitSessionStart();
    const reply = await emitEscalate(harness);
    expect(reply?.ok === false, "escalation without a target was accepted");
    expect(harness.pi.setModelCalls.length === 0, "escalation without a target switched models");
    expect(harness.pi.userMessages.length === 0, "escalation without a target queued a continuation");
    expect(
      harness.notifications.some(({ message }) => message.includes("链上没有未 ban")),
      "missing-target notification was not emitted",
    );
  }));

  results.push(await runTest("engine ignores malformed thinking-loop escalations", async () => {
    const harness = engineHarness(
      { chains: [["workbuddy/deepseek-v4.1-flash", "modelscope/Qwen/Qwen3.8-Flash-Next"]], fallbacks: {} },
      [
        { provider: "workbuddy", id: "deepseek-v4.1-flash" },
        { provider: "modelscope", id: "Qwen/Qwen3.8-Flash-Next" },
      ],
      { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    );
    await harness.emitSessionStart();
    // 版本不符 / 没有 accept 回调的载荷必须被静默丢弃，不得抛异常。
    harness.pi.events.emit("thinking-breaker:escalate", { version: 2, key: "workbuddy/deepseek-v4.1-flash" });
    harness.pi.events.emit("thinking-breaker:escalate", { version: 1, key: "workbuddy/deepseek-v4.1-flash" });
    harness.pi.events.emit("thinking-breaker:escalate", undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.pi.setModelCalls.length === 0, "malformed escalation switched models");
    expect(harness.bans.list().length === 0, "malformed escalation banned a model");
  }));

  return results;
}
export default async function regressionProbe(_pi: ExtensionAPI): Promise<void> {
  const resultPath = process.env.MODEL_FAILBACK_TEST_RESULT;
  if (!resultPath) throw new Error("MODEL_FAILBACK_TEST_RESULT is required");

  let all: TestResult[];
  try {
    all = await runRegressionTests();
  } catch (error) {
    all = [{
      name: "regression probe",
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }

  const matched = all.filter((result) => !result.skipped);
  const results = matched.length > 0
    ? matched
    : [{
        name: "regression probe",
        passed: false,
        detail: `没有用例匹配 MODEL_FAILBACK_TEST_FILTER="${TEST_FILTER}"`,
      }];

  const output = {
    passed: results.every((result) => result.passed),
    filter: TEST_FILTER ?? null,
    total: all.length,
    matched: matched.length,
    results,
  };
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(output, null, 2) + "\n", "utf8");
}
