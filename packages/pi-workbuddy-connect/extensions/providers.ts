// WorkBuddy provider 实现（国内版 / 国际版共用）。
//
// 两版是同一套客户端框架的两个区域：登录域、端点、桌面凭据文件名、数据目录、
// 内置兜底模型清单不同，其余全部一致。差异收敛进 ProviderSpec，共享逻辑只吃 spec。
// 国际版（workbuddy）与国内版（workbuddy-cn）各自注册一个 provider，账号、积分、
// 模型互不混用。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "X-Pi-WorkBuddy";
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const GENERIC_ELECTRON_ENV = "WORKBUDDY_ELECTRON_BIN";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
type Scope = "free" | "all";
type Visibility = "on" | "off";
type Settings = { scope: Scope; visibility: Visibility };
const LABEL = { on: "显示", off: "隐藏" } as const;

export type ProductModel = {
  id: string;
  name: string;
  credits?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  supportedEfforts?: Effort[];
  canDisableThinking: boolean;
};

export type ProductConfig = {
  source: "cache" | "builtin";
  models: ProductModel[];
  /** 产品配置里 `cli` agent 的模型 roster。空集表示配置没声明，退回「不过滤」。 */
  cliRoster: ReadonlySet<string>;
};

export type ProviderSpec = {
  /** pi provider id，同时也是 widget/status 的 key 与 marker 取值。 */
  id: string;
  /** 登录 UI 与侧栏标题。 */
  displayName: string;
  /** 区域标签，用于侧栏第二行。 */
  regionLabel: string;
  /** 聊天、目录、计费共用的 base（无尾斜杠）。 */
  base: string;
  /** 凭据里的登录域，用于 X-Domain 与插件登录默认值。 */
  domain: string;
  /** 覆盖桌面凭据文件路径的环境变量。 */
  authEnv: string;
  /** 桌面 App 写在共享 auth 目录里的文件名。 */
  desktopFilename: string;
  /** pi 自存凭据的文件名（agentDir 下）。 */
  ownFilename: string;
  /** 设置文件名（agentDir 下）。 */
  settingsFilename: string;
  /** 覆盖产品配置 JSON 路径的环境变量。 */
  productConfigEnv: string;
  /** 产品配置 JSON 的候选路径，按序探测。 */
  productConfigPaths: string[];
  /** 斜杠命令名（不带 /）。 */
  command: string;
  /** 切换侧栏显示的快捷键。 */
  shortcut: string;
  /** macOS 上承载密钥 helper 的 App 名（/Applications/<name>.app）。 */
  electronAppName?: string;
  /** Spotlight 发现该 App 用的 bundle id。 */
  electronBundleId?: string;
  /** 覆盖 Electron 二进制路径的环境变量。 */
  electronEnv: string;
  /** 缓存/产品配置缺失时的内置兜底模型。 */
  builtin: ProductModel[];
  /** 内置兜底时视为免费的模型 id。 */
  builtinFreeIds: readonly string[];
};

function model(
  id: string,
  name: string,
  credits: string,
  contextWindow: number,
  maxTokens: number,
  efforts: Effort[] | undefined,
  canDisableThinking = false,
  supportsImages = true,
): ProductModel {
  return {
    id,
    name,
    credits,
    contextWindow,
    maxTokens,
    supportsImages,
    supportsReasoning: true,
    ...(efforts === undefined ? {} : { supportedEfforts: efforts }),
    canDisableThinking,
  };
}

/** WorkBuddy AI · 国际版。base 与域名都走 www.workbuddy.ai。 */
export const WORKBUDDY_AI: ProviderSpec = {
  id: "workbuddy",
  displayName: "WorkBuddy AI",
  regionLabel: "国际版",
  base: "https://www.workbuddy.ai",
  domain: "www.workbuddy.ai",
  authEnv: "WORKBUDDY_AUTH_FILE",
  desktopFilename: "workbuddy-desktop-ai.info",
  ownFilename: ".workbuddy-auth.json",
  settingsFilename: ".workbuddy-settings.json",
  productConfigEnv: "WORKBUDDYAI_PRODUCT_CONFIG",
  productConfigPaths: [join(homedir(), ".workbuddy-ai", "cache", "acc-product-config-v3.json")],
  command: "workbuddy",
  shortcut: "ctrl+shift+w",
  electronEnv: "WORKBUDDY_AI_ELECTRON_BIN",
  builtin: [
    model("deepseek-v4.1-flash", "Deepseek-V4.1-Flash", "x0.00", 1_000_000, 128_000, ["low", "medium", "high", "xhigh", "max"]),
    model("hy4-preview-f", "Hy4 preview", "x0.00", 1_000_000, 64_000, ["high"]),
    model("hy3", "Hy3", "x0.00", 192_000, 64_000, ["low", "high"]),
  ],
  builtinFreeIds: ["hy3", "deepseek-v4.1-flash", "hy4-preview-f"],
};

/** WorkBuddy · 国内版。base 取产品自身 endpoint，聊天与计费均已实测可用。 */
export const WORKBUDDY_CN: ProviderSpec = {
  id: "workbuddy-cn",
  displayName: "WorkBuddy",
  regionLabel: "国内版",
  base: "https://www.workbuddy.cn",
  domain: "www.workbuddy.cn",
  authEnv: "WORKBUDDY_CN_AUTH_FILE",
  desktopFilename: "workbuddy-desktop.info",
  ownFilename: ".workbuddy-cn-auth.json",
  settingsFilename: ".workbuddy-cn-settings.json",
  productConfigEnv: "WORKBUDDY_PRODUCT_CONFIG",
  productConfigPaths: [join(homedir(), ".workbuddy", "cache", "acc-product-config-v3.json")],
  command: "workbuddy-cn",
  shortcut: "ctrl+shift+u",
  electronAppName: "WorkBuddy",
  electronBundleId: "com.tencent.workbuddy.mac",
  electronEnv: "WORKBUDDY_CN_ELECTRON_BIN",
  builtin: [
    model("fast-model", "快速", "x0.21", 300_000, 48_000, undefined),
    model("balanced-model", "均衡", "x0.65", 300_000, 48_000, undefined),
    model("deep-model", "极致", "x1.20", 300_000, 48_000, undefined),
    model("hy4-preview-f", "Hy4 preview", "x0.00", 1_000_000, 64_000, ["high"]),
    model("hy3", "Hy3", "x0.00", 192_000, 64_000, ["low", "high"]),
    model("hy3-x", "Hy3-X", "x0.05", 192_000, 64_000, ["low", "high"]),
    model("deepseek-v4.1-flash", "Deepseek-V4.1-Flash", "x0.03", 1_000_000, 128_000, undefined),
    model("glm-5.3", "GLM-5.3", "x0.79", 1_000_000, 64_000, ["low", "high", "max"], true),
    model("glm-5.3-flash", "GLM-5.3-Flash", "x0.06", 1_000_000, 131_072, ["low", "high", "max"], true),
    model("glm-5.2", "GLM-5.2", "x0.79", 1_000_000, 64_000, ["high", "xhigh"], true),
    model("glm-5.1", "GLM-5.1", "x0.79", 200_000, 48_000, undefined),
    model("glm-5v-turbo", "GLM-5v-Turbo", "x0.71", 200_000, 64_000, undefined),
    model("minimax-m3", "MiniMax-M3", "x0.25", 512_000, 64_000, undefined),
    model("kimi-k3-1", "Kimi-K3", "x1.62", 1_000_000, 32_000, ["low", "high", "xhigh"], true),
    model("kimi-k2.8-preview", "Kimi-K2.8-Preview", "x0.77", 1_000_000, 64_000, ["low", "high", "max"], true),
    model("kimi-k2.7", "Kimi-K2.7-Code", "x0.57", 256_000, 32_000, undefined),
    model("kimi-k2.6", "Kimi-K2.6", "x0.52", 256_000, 32_000, undefined),
    model("deepseek-v4-pro", "Deepseek-V4-Pro", "x0.51", 1_000_000, 128_000, ["high", "xhigh"], true),
    model("hy4-preview", "Hy4 preview", "x0.29", 1_000_000, 64_000, ["high"]),
  ],
  builtinFreeIds: ["hy3", "hy4-preview-f"],
};

export const PROVIDERS: readonly ProviderSpec[] = [WORKBUDDY_AI, WORKBUDDY_CN];

export function thinkingLevelMap(efforts: readonly string[], canDisable = false) {
  return {
    off: canDisable ? "off" : null,
    minimal: null,
    low: efforts.includes("low") ? "low" : null,
    medium: efforts.includes("medium") ? "medium" : null,
    high: efforts.includes("high") ? "high" : null,
    xhigh: efforts.includes("xhigh") ? "xhigh" : null,
    max: efforts.includes("max") ? "max" : null,
  } as const;
}

const HIGH_ONLY = thinkingLevelMap(["high"]);
const LOW_HIGH = thinkingLevelMap(["low", "high"]);

type Cred = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
};

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 声明价为 0 即为免费。未标价的模型（`undefined` 或空串，如自动路由的 `default-model`）
 *  同样计入免费：没有任何证据表明它收费，而排除它会把 Auto 从免费清单里悄悄抹掉。
 *  上游两种写法都存在（`"x0.00"` 与 `"x0.34 credits"`），故先剥掉单位后缀再比对。 */
export function creditsAreFree(credits: string | undefined): boolean {
  if (credits === undefined) return true;
  const price = credits.trim().replace(/\s*credits?\.?$/iu, "").trim();
  if (price === "") return true;
  return /^x?0(?:\.0+)?$/u.test(price);
}

function parseEffort(value: unknown): Effort | undefined {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value)
    ? value as Effort
    : undefined;
}

function parseProductModel(value: unknown): ProductModel | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (id === "") return undefined;
  const reasoning = asRecord(row.reasoning);
  const rawEfforts = reasoning?.supportedEfforts;
  let supportedEfforts: Effort[] | undefined;
  if (Array.isArray(rawEfforts)) {
    const efforts = rawEfforts.map(parseEffort).filter((e): e is Effort => e !== undefined);
    if (efforts.length > 0) supportedEfforts = efforts;
  }
  return {
    id,
    name: typeof row.name === "string" && row.name !== "" ? row.name : id,
    ...(typeof row.credits === "string" && row.credits.trim() !== "" ? { credits: row.credits.trim() } : {}),
    contextWindow: positiveNumber(row.maxInputTokens) ?? positiveNumber(row.maxAllowedSize) ?? 0,
    maxTokens: positiveNumber(row.maxOutputTokens) ?? 0,
    supportsImages: row.supportsImages === true && row.disabledMultimodal !== true,
    supportsReasoning: row.supportsReasoning === true,
    ...supportedEfforts ? { supportedEfforts } : {},
    canDisableThinking: reasoning?.canDisableThinking === true,
  };
}

/** 产品配置里 `cli` agent 的模型 id 集合。
 *  `/v3/config` 与产品配置都把「CLI 能用的模型」单独列在 `agents[name=cli].models` 里；
 *  配置顶层 `models` 还包含补全、本地自定义等一堆 CLI 用不了的条目（CN 尤其多：
 *  `codewise-completions`、`custom-local:*`、`hunyuan-*` 等）。不过滤就会把它们
 *  摆进选择器，选中后必然失败。 */
export function parseCliRoster(document: Record<string, unknown>): ReadonlySet<string> {
  const agents = document.agents;
  if (!Array.isArray(agents)) return new Set();
  for (const item of agents) {
    const agent = asRecord(item);
    if (agent?.name !== "cli") continue;
    const ids = agent.models;
    if (!Array.isArray(ids)) continue;
    return new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""));
  }
  return new Set();
}

export function parseProductConfig(text: string): ProductConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document || !Array.isArray(document.models)) return undefined;
  const models = document.models.map(parseProductModel).filter((m): m is ProductModel => m !== undefined);
  if (models.length === 0) return undefined;
  return { source: "cache", models, cliRoster: parseCliRoster(document) };
}

export function productConfigPath(spec: ProviderSpec): string {
  const override = process.env[spec.productConfigEnv]?.trim();
  if (override) return override;
  for (const path of spec.productConfigPaths) {
    if (existsSync(path)) return path;
  }
  return spec.productConfigPaths[0] ?? "";
}

export function loadProductConfig(spec: ProviderSpec): ProductConfig {
  try {
    const parsed = parseProductConfig(readFileSync(productConfigPath(spec), "utf8"));
    if (parsed) return parsed;
  } catch { /* missing/unreadable cache → builtin */ }
  return { source: "builtin", models: spec.builtin, cliRoster: new Set(spec.builtin.map((model) => model.id)) };
}

/** 配置里的模型先按 CLI roster 收窄；roster 为空（配置没声明）时才退回全集。 */
function rosterModels(config: ProductConfig): ProductModel[] {
  if (config.cliRoster.size === 0) return config.models;
  const onRoster = config.models.filter((model) => config.cliRoster.has(model.id));
  return onRoster.length > 0 ? onRoster : config.models;
}

export function freeModelIds(config: ProductConfig, spec: ProviderSpec): readonly string[] {
  if (config.source === "builtin") return spec.builtinFreeIds;
  const free = rosterModels(config).filter((m) => creditsAreFree(m.credits)).map((m) => m.id);
  return free.length > 0 ? free : spec.builtinFreeIds;
}

function settingsPath(spec: ProviderSpec): string {
  return join(agentDir(), spec.settingsFilename);
}

export function loadSettings(spec: ProviderSpec): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(spec), "utf8")) as { scope?: unknown; visibility?: unknown };
    return {
      scope: parsed.scope === "all" ? "all" : "free",
      // Legacy "full"/"compact" both mean visible; only "off" hides.
      visibility: parsed.visibility === "off" ? "off" : "on",
    };
  } catch { /* default free and on */ }
  return { scope: "free", visibility: "on" };
}

async function saveSettings(spec: ProviderSpec, settings: Settings): Promise<void> {
  await writeFile(settingsPath(spec), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function buildPiModels(config: ProductConfig, scope: Scope, spec: ProviderSpec) {
  const byId = new Map<string, ProductModel>();
  if (config.source === "cache") {
    for (const model of rosterModels(config)) byId.set(model.id, model);
  }
  for (const model of spec.builtin) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  const free = new Set(freeModelIds(config, spec));
  const rows = [...byId.values()].filter((model) => scope === "all" || free.has(model.id));
  return rows.flatMap((row) => {
    if (row.contextWindow <= 0 || row.maxTokens <= 0) return [];
    const efforts = row.supportsReasoning
      ? (row.supportedEfforts?.length ? row.supportedEfforts : EFFORTS)
      : [];
    const credits = row.credits ?? "免费";
    return [{
      id: row.id,
      name: `${row.name} · ${credits}`,
      reasoning: row.supportsReasoning,
      thinkingLevelMap: thinkingLevelMap(efforts, row.canDisableThinking),
      input: (row.supportsImages ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      cost: ZERO_COST,
      contextWindow: row.contextWindow,
      maxTokens: row.maxTokens,
      compat: COMPAT,
    }];
  });
}

function desktopCandidates(spec: ProviderSpec): string[] {
  const env = process.env[spec.authEnv]?.trim();
  if (env) return [env];
  const home = homedir();
  const rel = ["CodeBuddyExtension", "Data", "Public", "auth", spec.desktopFilename] as const;
  if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...rel)];
  if (process.platform === "win32") {
    return [join(home, "AppData", "Local", ...rel), join(home, "AppData", "Roaming", ...rel)];
  }
  return [join(home, ".config", ...rel)];
}

function ownPath(spec: ProviderSpec): string {
  return join(agentDir(), spec.ownFilename);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expiryToMs(value: number): number {
  if (value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

// ───────────────────────── 桌面凭据的静态加密（WorkBuddy 5.6+） ─────────────────────────
//
// 国内版自 5.6 起把 `auth.accessToken` / `auth.refreshToken`（以及 `account.nickname`）
// 以 `{$wbEncrypted:1, envelope}` 形式落盘：envelope 是 base64 的
// `{suite,keyId,nonce,authTag,ciphertext}`，用 AES-256-GCM 加密。
// 开启所需的材料都在这台机器上：跑一次 App 自带的 Electron（`ELECTRON_RUN_AS_NODE=1`）
// 读它私有的 `workbuddyStorage` 绑定拿到 `atRestSecretKey`，
// `protectorKey = sha256(secret, utf8)`，AAD 构造见 `buildAuthenticatedContextAad`。

type Envelope = { suite: number; keyId: string; nonce: Buffer; authTag: Buffer; ciphertext: Buffer };
/** 一个处于信封里的字段：`target` 指出它属于 `auth` 还是 `account` 容器。 */
type WrappedField = { target: "auth" | "account"; field: string; envelope: Envelope };
type DesktopFormat =
  | { format: "absent" }
  | { format: "plaintext" }
  | { format: "encrypted"; document: Record<string, unknown>; fields: WrappedField[] }
  | { format: "unrecognized" };

/** 凭据文件体积上限。凭据文档是几百字节级，超过就是异常输入，不该进解析与克隆。 */
const MAX_AUTH_FILE_BYTES = 1 << 20;
/** 单个信封 base64 串的长度上限，避免畸形输入驱动巨量解码。 */
const MAX_ENVELOPE_BASE64 = 64 * 1024;
/** 被信封包住的字段：`auth` 的两个令牌，以及 `account` 的昵称（同一把钥匙、同一个方案）。 */
const WRAPPED_FIELDS = [
  { target: "auth", field: "accessToken" },
  { target: "auth", field: "refreshToken" },
  { target: "account", field: "nickname" },
] as const;

function parseBase64(value: unknown, length?: number): Buffer | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) return undefined;
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

function parseWrappedField(target: "auth" | "account", field: string, value: unknown): WrappedField | undefined {
  const wrapped = asRecord(value);
  if (!wrapped || wrapped.$wbEncrypted !== 1 || typeof wrapped.envelope !== "string") return undefined;
  if (wrapped.envelope.length > MAX_ENVELOPE_BASE64) return undefined;
  let inner: unknown;
  try {
    inner = JSON.parse(Buffer.from(wrapped.envelope, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  const parts = asRecord(inner);
  if (!parts) return undefined;
  const nonce = parseBase64(parts.nonce, 12);
  const authTag = parseBase64(parts.authTag, 16);
  const ciphertext = parseBase64(parts.ciphertext);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  // suite 1 是 5.6.x 唯一定义给凭据字段的方案；其他取值一律不认作 encrypted，
  // 免得对着未知格式盲开。
  if (parts.suite !== 1) return undefined;
  if (typeof parts.keyId !== "string" || !/^[0-9a-f]{16}$/u.test(parts.keyId)) return undefined;
  return { target, field, envelope: { suite: 1, keyId: parts.keyId, nonce, authTag, ciphertext } };
}

/** 读出桌面凭据文档的格式。空文件为 absent；能直接解析的为 plaintext；
 *  至少一个字段是可信信封的为 encrypted；其余（JSON 不可解析、信封不可解码）为 unrecognized。 */
export function classifyDesktopAuthDocument(text: string): DesktopFormat {
  if (text.trim() === "") return { format: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { format: "unrecognized" };
  }
  const document = asRecord(parsed);
  if (!document) return { format: "unrecognized" };
  // 没有 auth 容器时整个文档就是 auth（扁平写法）。
  const containers = {
    auth: asRecord(document.auth) ?? document,
    account: asRecord(document.account) ?? document,
  };
  const fields: WrappedField[] = [];
  for (const { target, field } of WRAPPED_FIELDS) {
    const value = containers[target][field];
    if (typeof value === "string" || value === undefined) continue;
    const wrapped = parseWrappedField(target, field, value);
    // 某个字段是「对象但不是可解码信封」：既不是明文也不可用，除非另有字段成功解出。
    if (wrapped === undefined) return { format: "unrecognized" };
    fields.push(wrapped);
  }
  if (fields.length === 0) return { format: "plaintext" };
  return { format: "encrypted", document, fields };
}

/** AAD 逐字节转写自 App 自身的 `buildAuthenticatedContextAad`（对 5.6.2 实测通过）。 */
export function buildAuthenticatedContextAad(keyId: string, suite: number): Buffer {
  const lengthPrefixed = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"), Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 用 protector key 开一个信封；打不开返回 undefined（不抛，调用方给可诊断错误）。 */
export function openAuthField(key: Buffer, envelope: Envelope): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** 用 key 封一个字段，格式与 `openAuthField` 完全对称。自检用。 */
export function sealAuthFieldForTest(key: Buffer, plaintext: string, suite = 1) {
  const keyId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return { "$wbEncrypted": 1 as const, envelope: Buffer.from(JSON.stringify(inner), "utf8").toString("base64") };
}

const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

function executable(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return (statSync(path).mode & 0o111) !== 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/** 该 spec 在 macOS 上 Electron 二进制的默认位置。 */
function defaultElectronPath(spec: ProviderSpec): string | undefined {
  if (process.platform !== "darwin" || spec.electronAppName === undefined) return undefined;
  return executable(`/Applications/${spec.electronAppName}.app/Contents/MacOS/Electron`);
}

/** 用 Spotlight 按 bundle id 找 App，返回其 Electron 二进制。失败即 undefined。 */
async function discoverElectronPath(spec: ProviderSpec): Promise<string | undefined> {
  if (process.platform !== "darwin" || spec.electronBundleId === undefined) return undefined;
  const { execFile } = await import("node:child_process");
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${spec.electronBundleId}'`],
      { timeout: 3000, maxBuffer: 1 << 20, encoding: "utf8" },
      (error, out) => resolve(error ? undefined : out),
    );
  });
  if (stdout === undefined) return undefined;
  for (const line of stdout.split("\n")) {
    const bundle = line.trim();
    if (!bundle.endsWith(".app")) continue;
    const found = executable(join(bundle, "Contents", "MacOS", "Electron"));
    if (found !== undefined) return found;
  }
  return undefined;
}

async function resolveElectronPath(spec: ProviderSpec): Promise<string | undefined> {
  const env = (process.env[spec.electronEnv] ?? process.env[GENERIC_ELECTRON_ENV])?.trim();
  if (env) return executable(env);
  return defaultElectronPath(spec) ?? await discoverElectronPath(spec);
}

type ResolvedKey = { key: Buffer; keyId: string };

/** 每个 spec 一份内存密钥缓存：keyId 变了才重新取。绝不落盘、绝不记日志。 */
const keyCache = new Map<string, ResolvedKey>();
/** 每个 spec 的失败缓存（只存消息，不存密钥）。避免桌面文件一直坏着时反复 spawn Electron。 */
const keyFailure = new Map<string, string>();

async function protectorKeyFor(spec: ProviderSpec, requested: readonly string[]): Promise<ResolvedKey> {
  const cached = keyCache.get(spec.id);
  if (cached !== undefined && requested.includes(cached.keyId)) return cached;
  const failed = keyFailure.get(spec.id);
  if (failed !== undefined) throw new Error(failed);

  const electron = await resolveElectronPath(spec);
  if (electron === undefined) {
    throw new Error(
      `${spec.id}: 桌面凭据是加密的，但没找到 ${spec.displayName} 的 Electron 二进制；`
      + ` 装好桌面 App，或设 ${spec.electronEnv}（或 ${GENERIC_ELECTRON_ENV}）指向它`,
    );
  }
  const { execFile } = await import("node:child_process");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(electron, ["-e", HELPER_SCRIPT], {
      timeout: 15_000,
      maxBuffer: 1 << 20,
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }, (error, stdout) => {
      if (error) {
        // 只带退出码/超时，不带 stdout/stderr（可能含路径或崩溃转储）。
        reject(new Error(
          `${spec.id}: 读取桌面凭据密钥失败（${electron}）：`
          + `${error.killed === true ? "超时或被终止" : `退出码 ${String(error.code ?? "未知")}`}`,
        ));
        return;
      }
      resolve(stdout.trim());
    });
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    keyFailure.set(spec.id, message);
    throw error;
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    parsed = undefined;
  }
  const secret = typeof asRecord(parsed)?.atRestSecretKey === "string"
    ? (asRecord(parsed)!.atRestSecretKey as string)
    : "";
  if (secret === "") {
    const message = `${spec.id}: 桌面 App 未返回可用的 at-rest 密钥（期望 {version:1, atRestSecretKey}）`;
    keyFailure.set(spec.id, message);
    throw new Error(message);
  }
  const key = createHash("sha256").update(secret, "utf8").digest();
  const resolved: ResolvedKey = { key, keyId: createHash("sha256").update(key).digest("hex").slice(0, 16) };
  keyCache.set(spec.id, resolved);
  keyFailure.delete(spec.id);
  return resolved;
}

/** 把加密文档还原成普通解析器能读的文本；失败时给出可诊断错误（只带字段与 keyId，不带内容）。 */
function unwrapDesktopAuthDocument(
  classified: Extract<DesktopFormat, { format: "encrypted" }>,
  spec: ProviderSpec,
): Promise<string> {
  const requested = [...new Set(classified.fields.map((field) => field.envelope.keyId))];
  return protectorKeyFor(spec, requested).then((resolved) => {
    if (!requested.includes(resolved.keyId)) {
      throw new Error(
        `${spec.id}: 当前 at-rest 密钥（id ${resolved.keyId}）与凭据信封（id ${requested.join(" or ")}）不匹配；`
        + " 该凭据由另一份 WorkBuddy 安装封存",
      );
    }
    const rebuilt = structuredClone(classified.document);
    const auth = asRecord(rebuilt.auth) ?? rebuilt;
    const account = asRecord(rebuilt.account) ?? rebuilt;
    const containers = { auth, account };
    for (const field of classified.fields) {
      const plaintext = openAuthField(resolved.key, field.envelope);
      if (plaintext === undefined) {
        throw new Error(
          `${spec.id}: 桌面凭据的 ${field.field} 无法解密（信封 keyId ${field.envelope.keyId}）；`
          + " 打开一次 WorkBuddy App 重新封存登录态",
        );
      }
      containers[field.target][field.field] = plaintext;
    }
    return JSON.stringify(rebuilt);
  });
}

export function parseWorkBuddyAuth(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document) return undefined;
  const nested = asRecord(document.auth) !== undefined;
  const auth = asRecord(document.auth) ?? document;
  const identity = (nested ? asRecord(document.account) ?? {} : document);
  const accessToken = typeof auth.accessToken === "string" ? auth.accessToken : "";
  if (accessToken === "") return undefined;
  const enterpriseId = optionalString(identity.enterpriseId);
  const nickname = optionalString(identity.nickname);
  // 桌面文件写 expiresAt（秒或毫秒），自存副本写 expiresAtMs，两者都认。
  const rawExpiry = typeof auth.expiresAt === "number"
    ? auth.expiresAt
    : typeof auth.expiresAtMs === "number" ? auth.expiresAtMs : 0;
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: expiryToMs(rawExpiry),
    domain: optionalString(auth.domain) ?? "",
    uid: optionalString(identity.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

function parseOwn(text: string): Cred | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  if (!document || document.version !== 1) return undefined;
  const stored = asRecord(document.credential);
  if (!stored) return undefined;
  const accessToken = typeof stored.accessToken === "string" ? stored.accessToken : "";
  if (accessToken === "") return undefined;
  const enterpriseId = optionalString(stored.enterpriseId);
  const nickname = optionalString(stored.nickname);
  return {
    accessToken,
    refreshToken: typeof stored.refreshToken === "string" ? stored.refreshToken : "",
    expiresAtMs: typeof stored.expiresAtMs === "number" ? stored.expiresAtMs : 0,
    domain: optionalString(stored.domain) ?? "",
    uid: optionalString(stored.uid) ?? "",
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_AUTH_FILE_BYTES) {
      throw new Error(`凭据文件超过 ${MAX_AUTH_FILE_BYTES} 字节上限：${path}`);
    }
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readDesktop(spec: ProviderSpec): Promise<Cred | undefined> {
  for (const path of desktopCandidates(spec)) {
    const text = await readText(path);
    if (text === undefined) continue;
    const classified = classifyDesktopAuthDocument(text);
    if (classified.format === "absent") continue;
    if (classified.format === "unrecognized") {
      throw new Error(
        `${spec.id}: 桌面凭据文件 ${path} 存在但无法解读（既不是明文凭据，也不是可解码的加密信封）；`
        + " 请修复或删除该文件",
      );
    }
    if (classified.format === "encrypted") {
      return parseWorkBuddyAuth(await unwrapDesktopAuthDocument(classified, spec));
    }
    return parseWorkBuddyAuth(text);
  }
  return undefined;
}

/** 只读、不抛的凭据快照，供 UI 渲染使用（绝不触发刷新或解密失败重试）。 */
async function peek(spec: ProviderSpec): Promise<Cred | undefined> {
  try {
    return await current(spec);
  } catch {
    return undefined;
  }
}

async function current(spec: ProviderSpec): Promise<Cred | undefined> {
  const own = await readText(ownPath(spec)).then((text) => (text ? parseOwn(text) : undefined));
  // 桌面文件是「当前是谁登录」的权威：只要它存在，读不了就必须报错，
  // 不能被自存副本（可能属于上一个账号）顶掉。
  const desktop = await readDesktop(spec);
  if (!desktop) return own;
  if (!own) return desktop;
  // 身份优先于过期时间：桌面 App 换账号后，自存副本仍属于上一个账号。
  if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop;
  return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
}

async function saveOwn(spec: ProviderSpec, cred: Cred): Promise<void> {
  await writeFile(ownPath(spec), JSON.stringify({ version: 1, credential: cred }), { mode: 0o600 });
}

async function refreshAccess(spec: ProviderSpec, cred: Cred): Promise<Cred> {
  const response = await fetch(`${spec.base}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Origin: spec.base,
      Referer: `${spec.base}/`,
      "User-Agent": CLIENT_UA,
      "X-Refresh-Token": cred.refreshToken,
      "X-Auth-Refresh-Source": "workbuddy",
      ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = (await response.json()) as { code?: number; msg?: string; data?: Record<string, unknown> };
  const data = envelope.data ?? {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (!response.ok || envelope.code !== 0 || accessToken === "") {
    throw new Error(envelope.msg || `${spec.id} token refresh failed; sign in again in ${spec.displayName}`);
  }
  return {
    ...cred,
    accessToken,
    refreshToken: typeof data.refreshToken === "string" && data.refreshToken !== "" ? data.refreshToken : cred.refreshToken,
    expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0
      ? Date.now() + data.expiresIn * 1000
      : cred.expiresAtMs,
    domain: typeof data.domain === "string" && data.domain !== "" ? data.domain : cred.domain,
  };
}

const inflight = new Map<string, Promise<Cred>>();

async function resolveCred(spec: ProviderSpec): Promise<Cred> {
  const cred = await current(spec);
  if (!cred) {
    throw new Error(
      `${spec.id}: 未登录。设置 → 模型 → ${spec.displayName} → Connect 弹出登录页，`
      + `或登录桌面应用 / 设 ${spec.authEnv}`,
    );
  }
  if (cred.expiresAtMs > 0 && Date.now() + REFRESH_MARGIN_MS < cred.expiresAtMs) return cred;
  if (cred.refreshToken === "") {
    if (cred.expiresAtMs > Date.now() + 30_000) return cred;
    throw new Error(`${spec.id}: access token 已过期且没有 refresh token；请在 ${spec.displayName} 桌面应用重新登录`);
  }
  let pending = inflight.get(spec.id);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const next = await refreshAccess(spec, cred);
        await saveOwn(spec, next);
        return next;
      } catch (error) {
        if (cred.expiresAtMs > Date.now() + 30_000) return cred;
        throw error;
      }
    })().finally(() => {
      inflight.delete(spec.id);
    });
    inflight.set(spec.id, pending);
  }
  return pending;
}

function chatHeaders(spec: ProviderSpec, cred: Cred): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: spec.base,
    Referer: `${spec.base}/`,
    "User-Agent": CLIENT_UA,
    Authorization: `Bearer ${cred.accessToken}`,
    ...(cred.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": cred.uid }),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" }),
    ...(cred.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": cred.domain }),
    "X-Product": "SaaS",
  };
}

function stripAssistantReasoning(messages: unknown[]): void {
  for (const item of messages) {
    const msg = asRecord(item);
    if (!msg || msg.role !== "assistant") continue;
    delete msg.reasoning;
    delete msg.thinking;
    delete msg.reasoning_content;
    if (!Array.isArray(msg.content)) continue;
    msg.content = msg.content.filter((part) => {
      if (typeof part !== "object" || part === null) return true;
      const type = (part as { type?: string }).type;
      return type !== "reasoning" && type !== "thinking";
    });
    if (Array.isArray(msg.content) && msg.content.length === 0) msg.content = "";
  }
}

/** 两版的请求改写完全一致，所以共用一个 hook、共用一个实现。 */
export function prepareChatPayload(payload: Record<string, unknown>): Record<string, unknown> {
  payload.stream = true;
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const msg = asRecord(message);
      if (msg?.role === "developer") msg.role = "system";
    }
    if (messages.length > 0 && (messages[0] as { role?: string } | undefined)?.role !== "system") {
      messages.unshift({ role: "system", content: "You are a helpful assistant." });
    }
    stripAssistantReasoning(messages);
  }
  if ("tool_choice" in payload) {
    const choice = payload.tool_choice;
    if (typeof choice === "string") {
      if (choice.trim().toLowerCase() === "none") {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      }
    } else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>;
      const type = typeof wrapped.type === "string" ? wrapped.type.trim().toLowerCase() : "";
      if (type === "none") {
        delete payload.tool_choice;
        delete payload.tools;
        delete payload.functions;
      } else if (type === "auto" || type === "required") {
        payload.tool_choice = type;
      } else if (type === "function") {
        const fn = asRecord(wrapped.function);
        const name = (typeof fn?.name === "string" ? fn.name : typeof wrapped.name === "string" ? wrapped.name : "").trim();
        payload.tool_choice = name || "auto";
      } else {
        delete payload.tool_choice;
      }
    } else {
      delete payload.tool_choice;
    }
  }
  // 绝不注入 reasoning_effort —— 上游在没选档位时收到的是裸请求，
  // 所以「Default」必须保持 Default，而不能悄悄变成 high。
  return payload;
}

function asObject(payload: unknown): Record<string, unknown> | undefined {
  const value = typeof payload === "string"
    ? (() => {
      try {
        return JSON.parse(payload) as unknown;
      } catch {
        return undefined;
      }
    })()
    : payload;
  return asRecord(value);
}

/** marker 的取值是 spec.id，两个 provider 各自只认自己的值。 */
function hasMarker(headers: Record<string, string | null>, id: string): boolean {
  return headers[MARKER] === id || headers[MARKER.toLowerCase()] === id;
}

/**
 * WorkBuddy 的错误体是 `{code, msg}`，但 pi 的 openai-completions 路径只保留
 * OpenAI 形状 `{error:{message,...}}`：`normalizeProviderError` 取 `error.error`，
 * 非对象时退化成 `error.message`，最终 `errorMessage` 只剩
 * `"400 status code (no body)"`，业务码与文案全部丢失。
 *
 * 因此这里在 fetch 层把 `{code,msg}` 补成 `{error:{message,type,code}}`，其中
 * `code` 原样保留为**字符串**（pi 只把 `error.error.code` 透传进 errorMessage 的
 * JSON 里，数字会被丢掉）。不做语义判定：是否属于额度终态交给 model-failback。
 */
export function toOpenAIErrorEnvelope(status: number, body: unknown): Record<string, unknown> | undefined {
  const record = asRecord(body);
  if (!record) return undefined;
  if (asRecord(record.error)) return undefined;
  const message = typeof record.msg === "string" && record.msg !== ""
    ? record.msg
    : typeof record.message === "string" && record.message !== "" ? record.message : undefined;
  if (message === undefined) return undefined;
  const code = record.code === undefined || record.code === null ? undefined : String(record.code);
  const type = code === undefined
    ? (status === 429 ? "rate_limit_error" : "invalid_request_error")
    : "invalid_request_error";
  return { error: { message, type, ...(code === undefined ? {} : { code }) } };
}

let errorEnvelopeInstalled = false;

/** 在 `globalThis.fetch` 上装一层，只改 WorkBuddy 自己的失败响应，幂等。 */
export function installErrorEnvelopeRewrite(bases: readonly string[]): void {
  if (errorEnvelopeInstalled) return;
  errorEnvelopeInstalled = true;
  const prefixes = bases.map((base) => `${base}/v2/`);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    if (response.ok) return response;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!prefixes.some((prefix) => url.startsWith(prefix))) return response;
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const rewritten = toOpenAIErrorEnvelope(response.status, parsed);
    if (rewritten === undefined) {
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(rewritten), { status: response.status, statusText: response.statusText, headers });
  }) as typeof fetch;
}

type Pack = { name: string; remain: number; size: number };

function unwrap(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

export function parseCredits(envelope: unknown): { total: number; packs: Pack[] } {
  const inner = unwrap(unwrap(unwrap(unwrap(envelope).data).Response).Data);
  const raw = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  const packs: Pack[] = [];
  let total = 0;
  for (const item of raw) {
    const account = unwrap(item);
    const num = (key: string): number => typeof account[key] === "number" ? account[key] as number : 0;
    const size = num("CycleCapacitySize");
    const cycleRemain = num("CycleCapacityRemain");
    const cycleUsed = num("CycleCapacityUsed");
    let remain = size > 0 || cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : num("CapacityRemain");
    if (remain < 0) remain = 0;
    total += remain;
    packs.push({
      name: typeof account.PackageName === "string" ? account.PackageName : "(unnamed)",
      remain,
      size: size > 0 ? size : num("CapacitySize"),
    });
  }
  return { total, packs };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtExpiry(ms: number): string {
  if (ms <= 0) return "未知";
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function bar(remain: number, size: number, width = 28): string {
  if (size <= 0) return "";
  const n = Math.round(Math.min(1, Math.max(0, remain / size)) * width);
  return `${"█".repeat(n)}${"░".repeat(width - n)}`;
}

export function widgetLines(spec: ProviderSpec, input: {
  cred?: Cred;
  credits?: { total: number; packs: Pack[] };
  error?: string;
  scope?: Scope;
  visibility?: Visibility;
  models?: { name: string }[];
}): string[] {
  const visibility = input.visibility ?? "on";
  if (visibility === "off") return [];
  const scope = input.scope ?? "free";
  const lines = [`${spec.displayName} · ${spec.regionLabel} · ${scope === "all" ? "全部模型" : "仅免费模型"}`];
  if (!input.cred) {
    lines.push(`未登录。设置 → 模型 → ${spec.displayName} → Connect，或 /login ${spec.id}`);
    if (input.error) lines.push(input.error);
    lines.push(`设置  /${spec.command}`);
    return lines;
  }
  lines.push(`账号  已登录  ${input.cred.nickname || input.cred.uid}`);
  lines.push(`令牌  ${fmtExpiry(input.cred.expiresAtMs)} 过期（自动续期）`);
  if (input.credits) {
    lines.push(`积分  合计 ${input.credits.total}`);
    for (const pack of input.credits.packs) {
      const right = pack.size > 0 ? `${pack.remain} / ${pack.size}` : String(pack.remain);
      lines.push(`  ${pack.name}  剩余 ${right}`);
      const drawn = bar(pack.remain, pack.size);
      if (drawn) lines.push(`  ${drawn}`);
    }
  } else if (input.error) {
    lines.push(`积分  ${input.error}`);
  }
  const names = (input.models ?? []).map((model) => model.name).join("  |  ") || "（无模型）";
  lines.push(`模型  ${names}`);
  lines.push(`设置  /${spec.command}`);
  return lines;
}

export function statusText(spec: ProviderSpec, input: {
  cred?: Cred;
  credits?: { total: number };
  visibility?: Visibility;
}): string | undefined {
  if ((input.visibility ?? "on") === "off") return undefined;
  const tag = spec.regionLabel;
  if (input.credits) return `${tag} 积分 ${input.credits.total}`;
  return input.cred ? `${tag} 已登录` : `${tag} 未登录`;
}

async function fetchCredits(spec: ProviderSpec, cred: Cred): Promise<{ total: number; packs: Pack[] }> {
  const now = new Date();
  const response = await fetch(`${spec.base}/v2/billing/meter/get-user-resource`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: spec.base,
      Referer: `${spec.base}/`,
      "User-Agent": CLIENT_UA,
      Authorization: `Bearer ${cred.accessToken}`,
      ...(cred.uid === "" ? {} : { "X-User-Id": cred.uid }),
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmtStamp(now),
      PackageEndTimeRangeEnd: fmtStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope: unknown = await response.json();
  const msg = unwrap(envelope).msg;
  if (!response.ok || unwrap(envelope).code !== 0) {
    throw new Error(typeof msg === "string" && msg !== "" ? msg : `credits ${response.status}`);
  }
  return parseCredits(envelope);
}

type Ui = {
  setWidget(key: string, content: string[] | undefined): void;
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

type Extra = { scope: Scope; visibility: Visibility; models: { name: string }[] };

async function paint(spec: ProviderSpec, ui: Ui, notify = false, extra: Extra): Promise<void> {
  let cred: Cred | undefined;
  let credits: { total: number; packs: Pack[] } | undefined;
  let error: string | undefined;
  try {
    cred = await resolveCred(spec);
    credits = await fetchCredits(spec, cred);
  } catch (caught) {
    cred = await peek(spec);
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const lines = widgetLines(spec, { cred, credits, error, ...extra });
  ui.setWidget(spec.id, lines.length > 0 ? lines : undefined);
  ui.setStatus(spec.id, statusText(spec, { cred, credits, visibility: extra.visibility }));
  if (notify) {
    ui.notify(
      error ? `${spec.displayName}：${error}` : `${spec.displayName} 已刷新 · 积分 ${credits?.total ?? "?"}`,
      error ? "warning" : "info",
    );
  }
}

const PLUGIN_AUTH_HEADERS = (spec: ProviderSpec) => ({
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: spec.base,
  Referer: `${spec.base}/`,
  "User-Agent": CLIENT_UA,
  "X-Requested-With": "XMLHttpRequest",
  "X-Product": "SaaS",
  "X-No-Authorization": "true",
  "X-No-User-Id": "1",
  "X-No-Enterprise-Id": "1",
  "X-No-Department-Info": "1",
});

export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const padded = part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return asRecord(JSON.parse(Buffer.from(padded, "base64").toString("utf8"))) ?? {};
  } catch {
    return {};
  }
}

export function credFromPluginToken(
  spec: ProviderSpec,
  data: Record<string, unknown>,
  accessToken: string,
  now = Date.now(),
): Cred {
  const jwt = jwtPayload(accessToken);
  const uid = optionalString(data.uid)
    ?? optionalString(jwt.uid)
    ?? optionalString(jwt.sub)
    ?? optionalString(jwt.email)
    ?? "";
  const enterpriseId = optionalString(data.enterpriseId) ?? optionalString(data.enterprise_id);
  const nickname = optionalString(data.nickname) ?? optionalString(jwt.email) ?? optionalString(jwt.name);
  return {
    accessToken,
    refreshToken: optionalString(data.refreshToken) ?? "",
    expiresAtMs: typeof data.expiresIn === "number" && data.expiresIn > 0 ? now + data.expiresIn * 1000 : 0,
    domain: optionalString(data.domain) ?? spec.domain,
    uid,
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(nickname ? { nickname } : {}),
  };
}

async function startPluginLogin(spec: ProviderSpec): Promise<{ state: string; authUrl: string }> {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const response = await fetch(`${spec.base}/v2/plugin/auth/state?platform=CLI&nonce=${nonce}`, {
    method: "POST",
    headers: PLUGIN_AUTH_HEADERS(spec),
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = unwrap(await response.json());
  const data = unwrap(envelope.data);
  const state = typeof data.state === "string" ? data.state : "";
  const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
  if (!response.ok || envelope.code !== 0 || state === "" || authUrl === "") {
    throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : `${spec.id} login start failed`);
  }
  return { state, authUrl };
}

async function pollPluginToken(spec: ProviderSpec, state: string): Promise<Cred> {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${spec.base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: PLUGIN_AUTH_HEADERS(spec),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = unwrap(await response.json());
    if (envelope.code === 11217) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const data = unwrap(envelope.data);
    const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
    if (!response.ok || envelope.code !== 0 || accessToken === "") {
      throw new Error(typeof envelope.msg === "string" && envelope.msg !== "" ? envelope.msg : `${spec.id} login failed`);
    }
    return credFromPluginToken(spec, data, accessToken);
  }
  throw new Error(`${spec.id} login timed out`);
}

async function loginWorkBuddy(spec: ProviderSpec, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  callbacks.onProgress?.(`正在打开 ${spec.displayName} 登录页…`);
  const { state, authUrl } = await startPluginLogin(spec);
  callbacks.onAuth({ url: authUrl });
  callbacks.onProgress?.("请在弹出的页面完成登录，完成后会自动继续");
  const cred = await pollPluginToken(spec, state);
  await saveOwn(spec, cred);
  return { access: cred.accessToken, refresh: cred.refreshToken, expires: cred.expiresAtMs };
}

async function refreshWorkBuddyOAuth(spec: ProviderSpec, credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const prev = await current(spec).catch(() => undefined);
  const next = await refreshAccess(spec, {
    accessToken: credentials.access,
    refreshToken: credentials.refresh,
    expiresAtMs: credentials.expires ?? 0,
    domain: prev?.domain ?? spec.domain,
    uid: prev?.uid ?? "",
    ...(prev?.enterpriseId ? { enterpriseId: prev.enterpriseId } : {}),
    ...(prev?.nickname ? { nickname: prev.nickname } : {}),
  });
  await saveOwn(spec, next);
  return { access: next.accessToken, refresh: next.refreshToken, expires: next.expiresAtMs };
}

// ─────────────────────────── 共享 hook（只装一次） ───────────────────────────

/** spec.id → 当前注册的模型 id 集合。 */
const modelIndex = new Map<string, ReadonlySet<string>>();
let sharedHooksInstalled = false;

/** 该请求是否属于某个 WorkBuddy 变体。
 *
 *  pi 的 `before_provider_request` 事件本身不带 provider，但**处理器拿得到 `ctx`**，
 *  而 `ctx.model.provider` 就是本次请求的 provider id（实测在压缩、重试、多轮场景下
 *  均与 payload.model 一致）。这比只看模型 id 可靠得多：
 *  pi 自带目录里有 44 条与 WorkBuddy 撞名的 id（`deepseek-v4-pro`、`glm-5.3`、`hy3`…），
 *  只看 id 会误改别的 provider 的请求。
 *
 *  仍保留一层 id 一致性校验作为纵深防御：若将来某个请求的 `ctx.model` 不再等于
 *  本次 payload 的模型（pi 内部路由变化），宁可不改写，也不去动一个说不准是谁的请求。 */
function ownsPayload(payload: Record<string, unknown>, ctx: { model?: { provider?: unknown; id?: unknown } } | undefined): boolean {
  const providerId = ctx?.model?.provider;
  if (typeof providerId !== "string" || !modelIndex.has(providerId)) return false;
  // 模型 id 必须属于该 provider，且与 payload 一致。
  if (typeof payload.model !== "string") return false;
  if (ctx?.model?.id !== payload.model) return false;
  return modelIndex.get(providerId)!.has(payload.model);
}

function installSharedHooks(pi: ExtensionAPI): void {
  if (sharedHooksInstalled) return;
  sharedHooksInstalled = true;
  installErrorEnvelopeRewrite(PROVIDERS.map((spec) => spec.base));

  pi.on("before_provider_request", (event, ctx) => {
    const payload = asObject(event.payload);
    if (!payload) return;
    if (!ownsPayload(payload, ctx)) return;
    return prepareChatPayload(payload);
  });
}

/** 注册一个 provider 的 header hook；marker 取值就是 spec.id。 */
function installHeaderHook(pi: ExtensionAPI, spec: ProviderSpec): void {
  pi.on("before_provider_headers", async (event) => {
    if (!hasMarker(event.headers, spec.id)) return;
    const cred = await resolveCred(spec);
    event.headers[MARKER] = null;
    event.headers[MARKER.toLowerCase()] = null;
    for (const [key, value] of Object.entries(chatHeaders(spec, cred))) event.headers[key] = value;
  });
}

export async function registerWorkBuddyProvider(pi: ExtensionAPI, spec: ProviderSpec): Promise<void> {
  installSharedHooks(pi);
  installHeaderHook(pi, spec);

  let settings = loadSettings(spec);
  let models = buildPiModels(loadProductConfig(spec), settings.scope, spec);
  let ids: ReadonlySet<string> = new Set(models.map((model) => model.id));
  modelIndex.set(spec.id, ids);
  const extra = (): Extra => ({ scope: settings.scope, visibility: settings.visibility, models });
  const oauth = {
    name: spec.displayName,
    login: (callbacks: OAuthLoginCallbacks) => loginWorkBuddy(spec, callbacks),
    refreshToken: (credentials: OAuthCredentials) => refreshWorkBuddyOAuth(spec, credentials),
    getApiKey: (credentials: OAuthCredentials) => credentials.access,
  };

  function apply(next?: Scope) {
    if (next) settings = { ...settings, scope: next };
    models = buildPiModels(loadProductConfig(spec), settings.scope, spec);
    ids = new Set(models.map((model) => model.id));
    modelIndex.set(spec.id, ids);
    pi.registerProvider(spec.id, {
      name: spec.displayName,
      baseUrl: `${spec.base}/v2`,
      api: "openai-completions",
      headers: { [MARKER]: spec.id },
      oauth,
      models,
      async refreshModels() {
        settings = loadSettings(spec);
        models = buildPiModels(loadProductConfig(spec), settings.scope, spec);
        ids = new Set(models.map((model) => model.id));
        modelIndex.set(spec.id, ids);
        return models;
      },
    });
  }

  apply();

  pi.on("session_start", async (_event, ctx) => {
    await paint(spec, ctx.ui, false, extra());
  });

  pi.registerShortcut(spec.shortcut as never, {
    description: `切换 ${spec.displayName} 侧栏显示（显示/隐藏）`,
    handler: async (ctx) => {
      const next: Visibility = settings.visibility === "on" ? "off" : "on";
      settings = { ...settings, visibility: next };
      await saveSettings(spec, settings);
      await paint(spec, ctx.ui, false, extra());
      ctx.ui.notify(`${spec.displayName} 侧栏：${LABEL[next]}`, "info");
    },
  });

  pi.registerCommand(spec.command, {
    description: `${spec.displayName} 设置：刷新积分、免费/全部模型、断开登录`,
    handler: async (args, ctx) => {
      const cmd = String(args ?? "").trim().toLowerCase();
      if (cmd === "free" || cmd === "all") {
        settings = { ...settings, scope: cmd };
        await saveSettings(spec, settings);
        apply();
        await paint(spec, ctx.ui, true, extra());
        return;
      }
      if (cmd === "on" || cmd === "off") {
        settings = { ...settings, visibility: cmd };
        await saveSettings(spec, settings);
        await paint(spec, ctx.ui, true, extra());
        return;
      }
      if (cmd === "logout" || cmd === "disconnect") {
        await unlink(ownPath(spec)).catch(() => undefined);
        await paint(spec, ctx.ui, true, extra());
        return;
      }
      const pick = await ctx.ui.select(`${spec.displayName} 设置`, [
        "刷新积分与账号",
        settings.scope === "free" ? "列出全部模型（含付费）" : "只列出免费模型",
        "断开登录",
        `侧栏显示：${LABEL[settings.visibility]}`,
      ]);
      if (pick === undefined) return;
      if (pick.startsWith("列出全部")) {
        settings = { ...settings, scope: "all" };
        await saveSettings(spec, settings);
        apply();
      } else if (pick.startsWith("只列出")) {
        settings = { ...settings, scope: "free" };
        await saveSettings(spec, settings);
        apply();
      } else if (pick === "断开登录") {
        await unlink(ownPath(spec)).catch(() => undefined);
      } else if (pick.startsWith("侧栏显示：")) {
        const next: Visibility = settings.visibility === "on" ? "off" : "on";
        settings = { ...settings, visibility: next };
        await saveSettings(spec, settings);
      }
      await paint(spec, ctx.ui, true, extra());
    },
  });
}

/** 自检用的共享断言入口，避免把测试常量再导出一遍。 */
export const selfCheckRefs = { HIGH_ONLY, LOW_HIGH, EFFORTS };