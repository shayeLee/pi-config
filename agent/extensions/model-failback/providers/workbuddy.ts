/**
 * workbuddy — WorkBuddy AI 国际版(腾讯 CodeBuddy 同一后端)。
 *
 * 这个 handler 依赖 `pi-workbuddy-connect` 扩展在 fetch 层做的**错误信封补全**:
 * WorkBuddy 原生错误是 `{code, msg}`,而 pi 的 openai-completions 路径只保留
 * OpenAI 形状,不改写时 errorMessage 会退化成 `"400 status code (no body)"`,
 * 业务码与文案全部丢失。该扩展把 `{code,msg}` 补成
 * `{error:{message, type, code}}`(code 保留为字符串),因此这里能读到
 * `"400: {\"message\":\"…\",\"code\":\"14001\"}"`。
 *
 * 判定依据腾讯官方 CodeBuddy CLI 的业务错误码枚举(dist-server 中的
 * `UsageLimitExceeded=14001` 等)与它的归类表:
 *
 *   quota / quota_balance_exhausted  ← 14001 14002 14012 14013 14014 14018 14019
 *   quota / quota_request_limit      ← 14003,以及 6005-6008
 *   quota / quota_token_limit        ← 6003 6004
 *   quota / quota_active_session     ← 10105
 *   quota / quota_web_search         ← 15001
 *   quota / quota_not_activated      ← 14016 14017
 *   auth  / auth_expired             ← 14015
 *   auth  / auth_forbidden           ← 11140 11142
 *   model_service / model_behavior   ← 11141
 *   429 兜底                          → quota_balance_exhausted
 *
 * 本 handler 只覆盖**账户/计划额度耗尽**这一终态:余额耗尽、用户/企业额度耗尽、
 * token 预算耗尽,以及无 code 时的 429 兜底。这些是账户级终态,scope 为
 * "cross-provider"(同 provider 换模型无效)。
 *
 * **不触发**的情形:
 *  - 14003 / 6005-6008 等**瞬时限流**(交给 pi 退避重试);
 *  - 14015 / 11140 / 11142 **鉴权**、14016/14017 **未开通**、11141 **模型行为错误**;
 *  - 10105 **会话数超限**、15001 **联网搜索额度** —— 都与模型推理额度无关;
 *  - 11115 **上下文超长**(应触发压缩而非换模型);
 *  - 单次的 **5xx 网关页**(500/502/503/504/524)与 `Provider finish_reason: error`
 *    (上游瞬时故障)。
 *
 * 关于网关故障的例外:WorkBuddy 的推理端点(apisix/openresty 网关)会以纯 HTML
 * 页面返回 502/504,`errorMessage` 里既没有业务码也没有 JSON 体。pi 把它归为
 * 可重试错误(`RETRYABLE_PROVIDER_ERROR_PATTERN` 命中 502/504),但 WorkBuddy
 * 的 Flash 单请求就要数分钟,退避重试只会在数十秒内再次撞上同一个 502/504,
 * 最终把整轮任务交还给用户。因此这里加了**有界逃逸**:同一模型在
 * `TRANSIENT_OUTAGE_WINDOW_MS` 内连续 `workbuddyTransientOutageStreak` 次
 * (默认 3)命中网关故障时,判为 `endpoint_unavailable` 并带一个
 * `TRANSIENT_OUTAGE_COOLDOWN_MS` 冷却期的 `resetsAt`,让 failback 换到链上
 * 其它 provider 继续任务;冷却期过后 ban 自动过期,模型重新可用。
 * 阈值设为 0 即完全关闭该逃逸,回到"全部交给 pi 重试"的旧行为。
 */

import type { ProviderFailbackHandler } from "./types";

type AssistantLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
  model?: unknown;
};

function asAssistant(message: unknown): AssistantLike | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as AssistantLike;
  if (m.role !== "assistant" || m.stopReason !== "error") return null;
  return m;
}

/** pi 的 formatProviderError 前缀形如 "400: {...}";只在文本开头取状态码。 */
function readStatus(text: string): number | undefined {
  const match = text.match(/^\s*(\d{3}):/);
  return match ? Number(match[1]) : undefined;
}

/** 取第一个**括号配平**的 JSON 对象,排除 pi 追加的 metadata.raw。 */
function extractFirstJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** 账户/计划额度耗尽 —— 换同 provider 模型无效,只能跨 provider。 */
const BALANCE_EXHAUSTED_CODES = new Set([
  "14001", // UsageLimitExceeded
  "14002", // ConversationChatTooMany(同一额度的并发表现)
  "14012", // UsageLimitExceededEnterprise
  "14013", // UsageLimitExceededTencent
  "14014", // UsageLimitEnterpriseExhausted
  "14018", // UsageLimitUserExhausted
  "14019", // UsageLimitNoTokenBudget
  "6003", // CraftRateTPHLimit(每小时 token 配额)
  "6004", // CraftRateTPDLimit(每日 token 配额)
]);

/** 明确不是账户额度终态的 code:鉴权/未开通/瞬时限流/模型错误/上下文超长。 */
const NON_TERMINAL_CODES = new Set([
  "14003", // RateLimitError(瞬时,交给 pi 退避重试)
  "6005", "6006", "6007", "6008", // CraftRate RPS/RPM/RPH/RPD(瞬时)
  "14015", // UsageLimitLicenseExpired(鉴权)
  "14016", "14017", // UsageLimitEnterpriseNotActivated / UserNotActivated
  "11140", "11142", // auth_forbidden
  "11141", // model_behavior_error
  "11115", // ContextTooLong(应触发压缩)
  "10105", // ConversationLimitExceeded(会话数,与模型额度无关)
  "15001", // WebSearchRateLimit(联网搜索,与模型额度无关)
]);

function readCode(body: Record<string, unknown> | undefined): string | undefined {
  const raw = body?.code;
  if (typeof raw === "string" && raw !== "") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** 上游网关/上游推理故障 —— 瞬时,不是账户终态。 */
type TransientOutage = "gateway" | "provider_error";

const GATEWAY_STATUS_PATTERN = /\b(?:500|502|503|504|524)\b/;
const GATEWAY_PAGE_PATTERN =
  /<html|<!doctype\s+html|<head>|<body>|bad\s+gateway|gateway\s+time-?out|openresty|apisix/i;
const PROVIDER_FINISH_REASON_ERROR = /provider\s+finish_reason:\s*error/i;

/**
 * 识别瞬时上游故障。**必须没有结构化错误体**:有 JSON 的响应一律交给 code 判定,
 * 免得把上游透传的 JSON(哪怕带 500/502 字段)当成网关页。
 */
export function classifyTransientOutage(text: string): TransientOutage | undefined {
  if (extractFirstJsonObject(text) !== undefined) return undefined;
  if (PROVIDER_FINISH_REASON_ERROR.test(text)) return "provider_error";
  if (GATEWAY_STATUS_PATTERN.test(text) && GATEWAY_PAGE_PATTERN.test(text)) return "gateway";
  return undefined;
}

/** 连续故障的计数窗口:超出这个间隔视为新的一轮,避免长任务里偶发 5xx 累加成逃逸。 */
export const TRANSIENT_OUTAGE_WINDOW_MS = 120_000;
/** 逃逸后对该模型的冷却期:ban 在此期间生效,到期自动解除,模型重新可用。 */
export const TRANSIENT_OUTAGE_COOLDOWN_MS = 300_000;
export const DEFAULT_TRANSIENT_OUTAGE_STREAK = 3;

let transientOutageStreak = DEFAULT_TRANSIENT_OUTAGE_STREAK;

/** 由扩展入口按配置注入;<=0 或非有限值表示关闭逃逸。 */
export function setWorkbuddyTransientOutageStreak(value: number): void {
  transientOutageStreak = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const outages = new Map<string, { count: number; lastAt: number }>();

/** 新任务开始时清空计数;测试也用它复位。 */
export function resetWorkbuddyOutages(): void {
  outages.clear();
}

function noteOutage(key: string, now: number): number {
  const previous = outages.get(key);
  const count =
    previous && now - previous.lastAt <= TRANSIENT_OUTAGE_WINDOW_MS ? previous.count + 1 : 1;
  outages.set(key, { count, lastAt: now });
  return count;
}

export const workbuddyHandler: ProviderFailbackHandler = {
  providerId: "workbuddy",
  resetTransientState: resetWorkbuddyOutages,

  inspect(message: unknown) {
    const msg = asAssistant(message);
    if (!msg || msg.provider !== "workbuddy") return null;

    const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!text) return null;

    const body = extractFirstJsonObject(text);
    const code = readCode(body);
    const status = readStatus(text);

    if (code !== undefined) {
      // 非终态 code 优先排除:即使 HTTP 状态是 429,限流/鉴权也不该换模型。
      if (NON_TERMINAL_CODES.has(code)) return null;
      if (BALANCE_EXHAUSTED_CODES.has(code)) {
        return {
          reason: "quota_exhausted",
          scope: "cross-provider",
          note: `WorkBuddy 账户额度耗尽(${code})`,
        };
      }
      // 未知 code 不做猜测:留给人工确认,避免误 ban 整个 provider。
      return null;
    }

    // 上游网关连续故障:单次仍按瞬时错误交给 pi 重试,连续多次才允许一次跨 provider 逃逸。
    const outage = classifyTransientOutage(text);
    if (outage !== undefined) {
      if (transientOutageStreak <= 0) return null;
      const model = typeof msg.model === "string" ? msg.model : "";
      const outageKey = `${msg.provider}/${model}`;
      const count = noteOutage(outageKey, Date.now());
      if (count < transientOutageStreak) return null;
      outages.delete(outageKey);
      return {
        reason: "endpoint_unavailable",
        scope: "cross-provider",
        resetsAt: Date.now() + TRANSIENT_OUTAGE_COOLDOWN_MS,
        note:
          `WorkBuddy 上游连续故障(${outage === "gateway" ? "5xx 网关页" : "Provider finish_reason: error"}),` +
          `已重试 ${count} 次`,
      };
    }

    // 无 code 时按官方兜底:429 视为余额耗尽。但没有业务码佐证,要求
    // 文案里出现额度语义,避免把上游透传的瞬时限流当成终态。
    if (status === 429 && /usage\s*limit|quota|balance|exhausted|insufficient\s+credits?/i.test(text)) {
      return {
        reason: "quota_exhausted",
        scope: "cross-provider",
        note: "WorkBuddy 账户额度耗尽(429 兜底)",
      };
    }

    return null;
  },
};
