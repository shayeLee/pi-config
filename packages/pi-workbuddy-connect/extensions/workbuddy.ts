// WorkBuddy provider 入口：注册两个区域变体。
//
// - `workbuddy`    → WorkBuddy AI（国际版，www.workbuddy.ai）
// - `workbuddy-cn` → WorkBuddy（国内版，www.workbuddy.cn）
//
// 两版各自的账号、积分、模型清单与设置互不混用；差异全部收敛在
// `providers.ts` 的 ProviderSpec 里，本文件只负责把两个 spec 交给同一个实现。
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PROVIDERS,
  WORKBUDDY_AI,
  WORKBUDDY_CN,
  buildAuthenticatedContextAad,
  buildPiModels,
  classifyDesktopAuthDocument,
  creditsAreFree,
  credFromPluginToken,
  freeModelIds,
  loadSettings,
  openAuthField,
  parseCredits,
  parseProductConfig,
  parseWorkBuddyAuth,
  prepareChatPayload,
  registerWorkBuddyProvider,
  sealAuthFieldForTest,
  selfCheckRefs,
  statusText,
  toOpenAIErrorEnvelope,
  widgetLines,
} from "./providers.ts";

export {
  WORKBUDDY_AI,
  WORKBUDDY_CN,
  buildAuthenticatedContextAad,
  buildPiModels,
  classifyDesktopAuthDocument,
  creditsAreFree,
  credFromPluginToken,
  freeModelIds,
  loadSettings,
  openAuthField,
  parseCredits,
  parseProductConfig,
  parseWorkBuddyAuth,
  prepareChatPayload,
  sealAuthFieldForTest,
  statusText,
  toOpenAIErrorEnvelope,
  widgetLines,
};

/** 一个 payload 的 model 是否属于任一 WorkBuddy 变体（两个 provider 共享 hook）。 */
export function isWorkBuddyModel(modelId: unknown, ids: ReadonlySet<string>): boolean {
  return typeof modelId === "string" && ids.has(modelId);
}

export default async function (pi: ExtensionAPI) {
  for (const spec of PROVIDERS) {
    await registerWorkBuddyProvider(pi, spec);
  }
}

if (process.argv.includes("--self-check")) {
  const { HIGH_ONLY, LOW_HIGH } = selfCheckRefs;
  const assert = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(label);
  };
  /** 自检用的「配置缓存缺失」形状，与 loadProductConfig 的 builtin 分支一致。 */
  const builtinConfig = (spec: typeof WORKBUDDY_AI) => ({
    source: "builtin" as const,
    models: spec.builtin,
    cliRoster: new Set(spec.builtin.map((model) => model.id)),
  });

  // ── 凭据解析 ──
  const nested = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: "a", refreshToken: "r", expiresAt: 2000, domain: "www.workbuddy.ai" },
    account: { uid: "u1", nickname: "n" },
  }));
  assert(nested?.uid === "u1" && nested.expiresAtMs === 2_000_000, "parse nested");
  // 国内版桌面文件写的是毫秒 expiresAt，必须原样认。
  const millis = parseWorkBuddyAuth(JSON.stringify({
    auth: { accessToken: "a", refreshToken: "r", expiresAt: 1_794_908_187_523, domain: "www.workbuddy.cn" },
    account: { uid: "u2" },
  }));
  assert(millis?.expiresAtMs === 1_794_908_187_523, "parse millis expiresAt");

  // ── 请求改写 ──
  const payload = prepareChatPayload({
    model: "hy3",
    messages: [{ role: "developer", content: "sys" }, { role: "user", content: "hi" }],
    tool_choice: { type: "function", function: { name: "foo" } },
  });
  assert(payload.stream === true, "stream");
  assert((payload.messages as { role: string }[])[0].role === "system", "system");
  assert(payload.tool_choice === "foo", "tool_choice");
  assert(payload.reasoning_effort === undefined, "no injected effort");
  const kept = prepareChatPayload({ messages: [], reasoning_effort: "max" });
  assert(kept.reasoning_effort === "max", "explicit effort preserved");
  // 国内版原样透传 off；国际版丢弃 off 的行为在上游（不在本 hook），此处只保证不吞。
  const off = prepareChatPayload({ messages: [], reasoning_effort: "off" });
  assert(off.reasoning_effort === "off", "off passthrough");
  assert(LOW_HIGH.low === "low" && HIGH_ONLY.low === null && HIGH_ONLY.high === "high", "effort map");
  assert((selfCheckRefs as unknown) !== undefined, "self check refs");

  // ── 模型归属：hook 不能污染其他 provider ──
  const ours = new Set(["hy3", "deepseek-v4.1-flash"]);
  assert(isWorkBuddyModel("hy3", ours), "scope: own model accepted");
  assert(!isWorkBuddyModel("grok-4.6", ours), "scope: foreign model must be rejected");
  assert(!isWorkBuddyModel(undefined, ours) && !isWorkBuddyModel(42, ours), "scope: non-string rejected");
  assert(selfCheckRefs.EFFORTS.length === 5, "effort vocabulary");
  const prepended = prepareChatPayload({ messages: [{ role: "user", content: "hi" }] });
  assert((prepended.messages as { role: string }[])[0].role === "system", "prepend");
  const looped = prepareChatPayload({
    model: "deepseek-v4.1-flash",
    max_tokens: 128_000,
    messages: [{ role: "assistant", content: "done", reasoning: "OK.\nLet me write.", thinking: "Go." }],
  });
  const assistant = (looped.messages as Record<string, unknown>[])[1];
  assert(assistant.reasoning === undefined && assistant.thinking === undefined, "reasoning replay");
  assert(looped.max_tokens === 128_000, "flash payload passthrough");

  // ── 免费判定 ──
  assert(creditsAreFree("x0.00") && !creditsAreFree("x1.00"), "credits free");
  assert(creditsAreFree("x0.00 credits") && creditsAreFree("x0"), "credits unit free");
  assert(!creditsAreFree("x0.34 credits") && !creditsAreFree("x6.67 credits"), "credits unit paid");
  assert(creditsAreFree(undefined) && creditsAreFree("") && creditsAreFree("  "), "credits unpriced");
  const mixed = parseProductConfig(JSON.stringify({
    models: [
      { id: "default-model", name: "Auto", credits: "", maxInputTokens: 176_000, maxOutputTokens: 24_000, supportsReasoning: true },
      { id: "fast-model", name: "Fast", credits: "x0.34 credits", maxInputTokens: 200_000, maxOutputTokens: 32_000, supportsReasoning: true },
      { id: "hy3", name: "Hy3", credits: "x0.00", maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsReasoning: true },
    ],
  }));
  const mixedFree = freeModelIds(mixed!, WORKBUDDY_AI);
  assert(mixedFree.includes("default-model") && mixedFree.includes("hy3"), "unpriced free");
  assert(!mixedFree.includes("fast-model"), "priced unit excluded");

  // ── CLI roster 收窄：配置顶层 models 里的补全/本地模型不能进选择器 ──
  const withRoster = parseProductConfig(JSON.stringify({
    agents: [{ name: "cli", models: ["hy3", "glm-5.3"] }, { name: "other", models: ["x"] }],
    models: [
      { id: "hy3", name: "Hy3", credits: "x0.00", maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsReasoning: true },
      { id: "glm-5.3", name: "GLM-5.3", credits: "x0.79", maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsReasoning: true },
      { id: "completion-gf", name: "Completion", credits: "x0.00", maxInputTokens: 200_000, maxOutputTokens: 8_000, supportsReasoning: false },
      { id: "custom-local:mimo", name: "Local", credits: "x0.00", maxInputTokens: 900_000, maxOutputTokens: 130_000, supportsReasoning: true },
    ],
  }));
  assert(withRoster?.cliRoster.size === 2, "cli roster parsed");
  const rosterFree = freeModelIds(withRoster!, WORKBUDDY_CN);
  assert(rosterFree.includes("hy3"), "roster free kept");
  assert(!rosterFree.includes("completion-gf") && !rosterFree.includes("custom-local:mimo"), "off-roster free excluded");
  const rosterAll = buildPiModels(withRoster!, "all", WORKBUDDY_CN).map((model) => model.id);
  assert(!rosterAll.includes("completion-gf") && !rosterAll.includes("custom-local:mimo"), "off-roster excluded from all");
  assert(rosterAll.includes("hy3") && rosterAll.includes("glm-5.3"), "on-roster kept");
  // roster 为空（配置没声明 agents）时不过滤。
  assert(parseProductConfig(JSON.stringify({ models: [] })) === undefined, "empty models rejected");
  assert(parseProductConfig(JSON.stringify({ models: [{ id: "a", name: "A", maxInputTokens: 1, maxOutputTokens: 1 }] }))?.cliRoster.size === 0, "absent roster");

  // ── 两个变体的差异必须各就各位 ──
  assert(WORKBUDDY_AI.id === "workbuddy" && WORKBUDDY_CN.id === "workbuddy-cn", "spec ids");
  assert(WORKBUDDY_AI.base === "https://www.workbuddy.ai" && WORKBUDDY_CN.base === "https://www.workbuddy.cn", "spec bases");
  assert(WORKBUDDY_AI.domain === "www.workbuddy.ai" && WORKBUDDY_CN.domain === "www.workbuddy.cn", "spec domains");
  assert(WORKBUDDY_AI.desktopFilename === "workbuddy-desktop-ai.info", "ai desktop file");
  assert(WORKBUDDY_CN.desktopFilename === "workbuddy-desktop.info", "cn desktop file");
  assert(WORKBUDDY_AI.ownFilename !== WORKBUDDY_CN.ownFilename, "own files distinct");
  assert(WORKBUDDY_AI.settingsFilename !== WORKBUDDY_CN.settingsFilename, "settings files distinct");
  assert(WORKBUDDY_AI.productConfigEnv !== WORKBUDDY_CN.productConfigEnv, "product config envs distinct");
  assert(WORKBUDDY_AI.command !== WORKBUDDY_CN.command, "commands distinct");
  assert(WORKBUDDY_AI.shortcut !== WORKBUDDY_CN.shortcut, "shortcuts distinct");
  assert(WORKBUDDY_AI.productConfigPaths[0]?.includes(".workbuddy-ai"), "ai config path");
  assert(WORKBUDDY_CN.productConfigPaths[0]?.includes(".workbuddy") && !WORKBUDDY_CN.productConfigPaths[0]?.includes(".workbuddy-ai"), "cn config path");

  // ── 内置兜底：CN 免费集合与国际版不同 ──
  const cnFree = freeModelIds(builtinConfig(WORKBUDDY_CN), WORKBUDDY_CN);
  assert(cnFree.length === 2 && cnFree.includes("hy3") && cnFree.includes("hy4-preview-f"), "cn builtin free");
  const cnModels = buildPiModels(builtinConfig(WORKBUDDY_CN), "free", WORKBUDDY_CN);
  assert(cnModels.length === 2, "cn builtin free scope size");
  const cnAll = buildPiModels(builtinConfig(WORKBUDDY_CN), "all", WORKBUDDY_CN);
  assert(cnAll.length === WORKBUDDY_CN.builtin.length, "cn builtin all scope size");
  const aiAll = buildPiModels(builtinConfig(WORKBUDDY_AI), "all", WORKBUDDY_AI);
  assert(aiAll.length === 3, "ai builtin size");
  const flash = aiAll.find((model) => model.id === "deepseek-v4.1-flash");
  assert(flash !== undefined, "flash present");
  if (flash !== undefined) {
    assert(flash.thinkingLevelMap.low === "low" && flash.thinkingLevelMap.xhigh === "xhigh", "flash efforts");
    assert(flash.maxTokens === 128_000, "flash maxTokens");
  }
  const implied = parseProductConfig(JSON.stringify({
    models: [{
      id: "implied", name: "Implied", credits: "x0.00",
      maxInputTokens: 1000, maxOutputTokens: 100, supportsReasoning: true,
    }],
  }));
  assert(buildPiModels(implied!, "free", WORKBUDDY_AI)[0].thinkingLevelMap.xhigh === "xhigh", "implied efforts");
  const fromCache = parseProductConfig(JSON.stringify({
    models: [{
      id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00",
      maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    }],
  }));
  const cachedFlash = buildPiModels(fromCache!, "free", WORKBUDDY_AI)[0];
  assert(cachedFlash.thinkingLevelMap.medium === "medium" && cachedFlash.thinkingLevelMap.max === "max", "cache efforts");

  // ── 积分解析 ──
  const credits = parseCredits({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            { PackageName: "Bonus Pack", CycleCapacitySize: 250, CycleCapacityRemain: 249 },
            { PackageName: "Free Plan Subscription", CycleCapacitySize: 100, CycleCapacityRemain: 100 },
          ],
        },
      },
    },
  });
  assert(credits.total === 349 && credits.packs.length === 2, "credits");

  // ── widget / footer ──
  const cred = {
    accessToken: "a", refreshToken: "r",
    expiresAtMs: Date.UTC(2027, 8, 12, 1, 30, 0),
    domain: "www.workbuddy.cn", uid: "u", nickname: "user@example.com",
  };
  const lines = widgetLines(WORKBUDDY_CN, { cred, credits });
  assert(lines.some((line) => line.includes("user@example.com")), "account");
  assert(lines.some((line) => line.includes("合计 349")), "total");
  assert(lines[0].includes("WorkBuddy") && lines[0].includes("国内版"), "cn widget title");
  assert(widgetLines(WORKBUDDY_CN, { cred, credits, visibility: "off" }).length === 0, "widget off");
  assert(widgetLines(WORKBUDDY_CN, { cred, credits, visibility: "on" }).length > 0, "widget on");
  assert(statusText(WORKBUDDY_CN, { cred, credits }) === "国内版 积分 349", "cn status on");
  assert(statusText(WORKBUDDY_AI, { cred, credits }) === "国际版 积分 349", "ai status on");
  assert(statusText(WORKBUDDY_CN, { cred, credits, visibility: "off" }) === undefined, "status off");
  assert(statusText(WORKBUDDY_AI, { cred }) === "国际版 已登录", "status logged in");
  assert(statusText(WORKBUDDY_AI, {}) === "国际版 未登录", "status logged out");

  // ── 插件登录令牌 ──
  const token = `x.${Buffer.from(JSON.stringify({ email: "a@b.c", sub: "u9" })).toString("base64url")}.y`;
  const fromTok = credFromPluginToken(
    WORKBUDDY_CN,
    { refreshToken: "r", expiresIn: 10, enterpriseId: "e1" },
    token,
    1000,
  );
  assert(fromTok.uid === "u9" && fromTok.nickname === "a@b.c" && fromTok.expiresAtMs === 11_000, "plugin token");
  assert(fromTok.enterpriseId === "e1", "enterprise");
  // 令牌没带 domain 时回落到该变体自己的域，而不是国际版。
  assert(fromTok.domain === "www.workbuddy.cn", "cn domain fallback");

  // ── 错误信封 ──
  const quota = toOpenAIErrorEnvelope(400, { code: 14001, msg: "UsageLimitExceeded", requestId: "r" });
  const err = (quota as { error: { message: string; type: string; code: string } }).error;
  assert(err.message === "UsageLimitExceeded" && err.code === "14001", "envelope code");
  assert(err.type === "invalid_request_error", "envelope type");
  const rate = toOpenAIErrorEnvelope(429, { msg: "too many" }) as { error: { type: string } };
  assert(rate.error.type === "rate_limit_error", "envelope 429 type");
  assert(toOpenAIErrorEnvelope(400, { error: { message: "already" } }) === undefined, "envelope no rewrap");
  assert(toOpenAIErrorEnvelope(400, { other: 1 }) === undefined, "envelope no message");
  assert(toOpenAIErrorEnvelope(400, "plain text") === undefined, "envelope non-object");
  const fromMessage = toOpenAIErrorEnvelope(400, { message: "plain" }) as { error: { message: string } };
  assert(fromMessage.error.message === "plain", "envelope message field");

  // ── 加密凭据（WorkBuddy 5.6+ 桌面文件） ──
  // 自封自开的 round-trip，证明 AAD 构造与加解密路径自洽。
  const key = createHash("sha256").update("selftest-secret", "utf8").digest();
  const sealed = sealAuthFieldForTest(key, "the-access-token");
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const classified = classifyDesktopAuthDocument(JSON.stringify({
    auth: { accessToken: sealed, refreshToken: "plain-refresh", expiresAt: 1_794_908_187_523, domain: "www.workbuddy.cn" },
    account: { uid: "u3", nickname: "n3" },
  }));
  assert(classified.format === "encrypted", "classify encrypted");
  if (classified.format === "encrypted") {
    assert(classified.fields.length === 1 && classified.fields[0].field === "accessToken", "wrapped field set");
    assert(classified.fields[0].target === "auth", "wrapped field target");
    const envelope = classified.fields[0].envelope;
    assert(envelope.keyId === keyId, "envelope key id");
    assert(envelope.nonce.length === 12 && envelope.authTag.length === 16, "envelope part sizes");
    assert(openAuthField(key, envelope) === "the-access-token", "open auth field");
    // 换把钥匙必须开不开，而不是给出垃圾明文。
    const wrong = createHash("sha256").update("other-secret", "utf8").digest();
    assert(openAuthField(wrong, envelope) === undefined, "wrong key rejected");
  }
  // 昵称也在同一个信封里（同一把钥匙、同一个方案），必须一并还原。
  const nickClassified = classifyDesktopAuthDocument(JSON.stringify({
    auth: { accessToken: "plain", refreshToken: "plain" },
    account: { uid: "u4", nickname: sealAuthFieldForTest(key, "13800000000") },
  }));
  assert(nickClassified.format === "encrypted", "classify encrypted nickname");
  if (nickClassified.format === "encrypted") {
    assert(nickClassified.fields.length === 1, "nickname wrapped count");
    assert(nickClassified.fields[0].target === "account" && nickClassified.fields[0].field === "nickname", "nickname target");
    assert(openAuthField(key, nickClassified.fields[0].envelope) === "13800000000", "open nickname");
  }
  // 扁平写法（没有 auth/account 容器）也要能识别。
  const flat = classifyDesktopAuthDocument(JSON.stringify({ accessToken: sealAuthFieldForTest(key, "t") }));
  assert(flat.format === "encrypted" && flat.fields[0].target === "auth", "flat document shape");
  // 超长 envelope 不得进入解码。
  assert(
    classifyDesktopAuthDocument(JSON.stringify({
      auth: { accessToken: { $wbEncrypted: 1, envelope: "A".repeat(70_000) } },
    })).format === "unrecognized",
    "oversized envelope rejected",
  );
  assert(classifyDesktopAuthDocument("").format === "absent", "classify absent");
  assert(classifyDesktopAuthDocument("{oops").format === "unrecognized", "classify bad json");
  assert(classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: "plain" } })).format === "plaintext", "classify plaintext");
  assert(
    classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: "!!!" } } })).format === "unrecognized",
    "classify undecodable envelope",
  );
  // suite 不是 1 就不认，避免对未知格式盲开。
  const otherSuite = sealAuthFieldForTest(key, "x", 2);
  assert(
    classifyDesktopAuthDocument(JSON.stringify({ auth: { accessToken: otherSuite } })).format === "unrecognized",
    "classify unknown suite",
  );
  const aad = buildAuthenticatedContextAad(keyId, 1);
  assert(aad.subarray(0, 7).toString("ascii") === "WB-AAD\0", "aad prefix");
  assert(aad.includes(Buffer.from("WBEV1", "utf8")), "aad framing");

  console.log("ok");
}
