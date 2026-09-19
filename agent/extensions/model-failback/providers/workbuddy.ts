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
 *   quota / quota_balance_exhausted  ← 14001 14002 14012 14013 14014 14018
 *   quota / quota_request_limit      ← 14003,以及 6005-6008(本 handler 直接切备用链)
 *   quota / quota_token_limit        ← 6000-6004(CraftRate 的 TPS/TPM/TPH/TPD token 配额)
 *   quota / quota_active_session     ← 10105
 *   quota / quota_web_search         ← 15001
 *   quota / quota_not_activated      ← 14016 14017
 *   auth  / auth_expired             ← 14015
 *   auth  / auth_forbidden           ← 11140 11142
 *   model_service / model_behavior   ← 11141
 *   429 兜底                          → quota_balance_exhausted
 *
 * 6003(CraftRateTPHLimit)/6004(CraftRateTPDLimit)虽然与 6005-6008 同属 CraftRate 限流族,
 * 但官方归类是 `quota_token_limit`(按 TPS/TPM/TPH/TPD 计)。关键在于它们是**按模型**
 * 限定的免费档额度窗口,而不是账户级余额:
 *  - 官方 `isCraftDailyQuotaBusinessCode` 集合为 `{6004, 6008}`,即这两个码是**日粒度**
 *    窗口,且它在 `isRequestLevelRetryableError` 里被**显式排除在重试之外** ——
 *    官方自己也认为日粒度窗口不该交给退避重试,而应换模型继续。
 *    注意 `isTransientRateLimitBusinessCode` 覆盖的是 6000-6003 / 6005-6007 +
 *    14003,**不含** 6004/6008(日配额被单独摘出来);
 *  - 官方 `ModelRateLimitCap` 配置给出 freeId/paidId 双档(实测 WorkBuddy 国际版为
 *    freeId=deepseek-v4.1-flash 记 x0.00 credits、paidId=deepseek-v4.1-flash-sg 记 x0.03 credits,
 *    且 allowPaidSwitch=true);
 *  - 真实错误文案自己就给出了官方逃生路径:
 *
 *      429 {"message":"usage exceeds frequency limit, but don't worry, your usage will reset at
 *      2026-09-19 09:43:30 UTC+8, alternatively, you can switch to the other models to continue
 *      using it.","code":"6004"}
 *
 * 所以这两码必须按**限流窗口**处理(scope 用 "any",允许逐跳链里的付费档),
 * 而不是像 14001 那样按账户级终态把整个 provider 跳过;文案里的 `reset at … UTC+8`
 * 直接解析成 resetsAt,到期由 autoRestore 切回免费档。
 * 6000-6002(秒/分钟级 token 窗口)不在此列:它们不在 `isCraftDailyQuotaBusinessCode`
 * 里,官方仍当可重试错误处理,保持交给 pi 退避重试。
 *
 * 注意:文案里的 UTC 偏移是该码**唯一**的精确恢复时间来源,所以 `resetsAt` 严格依赖
 * `parseCraftResetAt` —— 它宁可返回 undefined 也不猜时区。解析不到时退回
 * `workbuddyRateLimitCooldownMs`,那只是**冷却期估计**,不是真实窗口恢复时刻,
 * 因此它可能偏短(6003 是小时窗口、6004 是日窗口)。`autoRestore` 会在该时刻
 * 提前切回源模型;若窗口其实仍开着,只是一次额外试探,不会造成停机。
 *
 * 本 handler 覆盖两类需要换模型的终态:
 *  1. **账户额度耗尽** —— 余额耗尽、用户/企业额度耗尽、token 预算耗尽,
 *     以及无 code 时带额度语义的 429 兜底。账户级,`scope: "cross-provider"`
 *     (同 provider 换模型无效);
 *  2. **模型级限流窗口** —— 14003 / 6003-6008 与无 code 的裸 429。这类错误 pi 会
 *     退避重试(默认 3 次,1s/2s/4s),但 WorkBuddy 单请求就要数分钟,7 秒总退避
 *     远小于限流窗口,重试耗尽后 pi 只会把错误交还用户、任务中断。因此按配置
 *     **直接切备用链**(`scope: "any"`,逐跳按用户配的链走 —— 限流窗口按模型
 *     计算,同 provider 的另一档位/部署有独立配额,例如 CraftRate 的 free/paid
 *     双档):带 resetsAt 到期自动解 ban,模型重新可用。6003/6004 优先用错误
 *     文案里的官方重置时刻,解析不到才退回 `workbuddyRateLimitCooldownMs`
 *     (默认 60s)。把该值配成 <=0 即关闭此逃逸,回到"全部交给 pi 重试"的旧行为。
 *     注意这是**免费档额度窗口**,不是账户余额:文案「usage exceeds frequency limit」
 *     与官方 `ModelRateLimitCap.freeId/paidId` 双档都表明该模型限额用尽后
 *     切付费档/其它模型正是厂商设计路径,不得据此劝用户充值或跳过整个 provider。
 *
 * **不触发**的情形:
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
 *
 * 关于 WAF 拦截页的例外:腾讯云 WAF 会直接返回 403 的 HTML 拦截页
 * (`403 <!DOCTYPE html>…<title>WAF Block Page</title>…waf-intl.qq.com…`)。它接不住
 * 上面两条既有路径:`readStatus` 只认 `"403:"` 冒号形式,而真实文本是 `403 <!DOCTYPE`
 * (openai SDK 的 `APIError.makeMessage` 形如 `${status} ${msg}`);
 * `extractFirstJsonObject` 也因 HTML 里内联 `<script>` 的 `{` 解析失败而返回 undefined。
 * 更关键的是 **pi 的 `RETRYABLE_PROVIDER_ERROR_PATTERN` 不含 403**,一次 403 就直接终止
 * 该 run,不可能产生第二次 `message_end` —— 因此 5xx 那套"连续 N 次才逃逸"的 streak
 * 语义对 WAF 完全无效,必须**默认首次即逃逸**(`DEFAULT_WAF_BLOCK_STREAK = 1`)。
 * WAF 是 IP/请求特征级封禁,换同 provider 的其他模型无效,故 `scope: "cross-provider"`;
 * 冷却期用固定的 `WAF_BLOCK_COOLDOWN_MS`(10 分钟),不做成配置项。
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

/**
 * 账户/计划额度耗尽 —— 换同 provider 模型无效,只能跨 provider。
 * 只放官方 `quota_balance_exhausted` 一族:余额/企业额度/用户额度耗尽。
 * **不放 CraftRate 的 6003/6004** —— 那是按模型计的 token 窗口,
 * 换个模型(含同 provider 付费档)就能继续,见上方文件头说明。
 *
 * 注意:官方当前制品里**不存在 14019**(`UsageLimitNoTokenBudget` 的 rg 计数为 0,
 * `UsageLimit*` 枚举只有 14001/14012/14013/14014/14015/14016/14017/14018),
 * 保留它只为兼容早期版本/文档里出现过的 code,不影响现行判定。
 */
const BALANCE_EXHAUSTED_CODES = new Set([
  "14001", // UsageLimitExceeded
  "14002", // ConversationChatTooMany(官方 lookupBizCode 归为 quota_balance_exhausted)
  "14012", // UsageLimitExceededEnterprise
  "14013", // UsageLimitExceededTencent
  "14014", // UsageLimitEnterpriseExhausted
  "14018", // UsageLimitUserExhausted
  "14019", // UsageLimitNoTokenBudget(当前制品已无此码,legacy 兼容)
]);

/**
 * 瞬时限流:直接切备用链(见文件头说明),带冷却期,到期自动解 ban。
 * 由 `workbuddyRateLimitCooldownMs` 控制;<=0 关闭逃逸。
 */
const RATE_LIMIT_CODES = new Set([
  "14003", // RateLimitError
  "6005", "6006", "6007", "6008", // CraftRate RPS/RPM/RPH/RPD
]);

/**
 * CraftRate 的 **日粒度 token 配额窗口** (6004=TPD) 与其它长期窗口。
 *
 * 官方 `isCraftDailyQuotaBusinessCode` 把 6004 与 6008(RPD) 一并列出,并把它们
 * 排除在短退避重试之外 —— 这两个是**日**窗口,60 秒冷却远不足以覆盖,
 * 因此必须优先采用文案里的官方重置时刻。
 */
export const CRAFT_DAILY_QUOTA_CODES: ReadonlySet<string> = new Set(["6004", "6008"]);

/** 官方日窗口的重置时刻上界:超过这个幅度说明解析出了错误的时间,宁可未知。 */
export const CRAFT_DAILY_RESET_MAX_MS = 3 * 24 * 60 * 60_000;

/**
 * CraftRate 的 token 配额窗口(6003=TPH / 6004=TPD):per-model 的免费档窗口,
 * 厂商给出的逃生路径就是切到其它模型(付费档/其它 provider),
 * 因此按限流处理,但优先用错误文案里的官方重置时刻。
 */
const CRAFT_TOKEN_WINDOW_CODES = new Map([
  ["6003", "每小时 token 限额"], // CraftRateTPHLimit
  ["6004", "每日 token 限额"], // CraftRateTPDLimit
]);

/**
 * 解析 CraftRate 配额文案里的官方重置时刻,形如
 * `your usage will reset at 2026-09-19 09:43:30 UTC+8` → epoch ms。
 *
 * 解析纪律(任何一条不满足即返回 undefined,由冷却期兜底):
 *  - **必须带 UTC/GMT 标记**:`UTC+8` / `UTC+08:00` / `GMT+0800` / 裸 `UTC`(按 UTC+0
 *    解释)。完全没有时区标记时无法确定 epoch,猜本地时区会给出错误的
 *    `autoRestore` 时刻,所以直接拒绝;
 *  - **各字段必须真实存在**:月/日/时/分/秒有范围校验,并进行 round-trip 比对,
 *    避免 `2026-02-31`、`25:70`、`UTC+99` 被 `Date.UTC` 悄悄规范化成另一个时刻;
 *  - **必须是未来时刻**;
 *  - **必须是单个、无冲突的时间**:同时出现多个不同时刻时拒绝解析。
 *
 * 只接受 UTC/GMT 偏移,不接受 `CST`/`IST` 这类有歧义的缩写。
 */
export function parseCraftResetAt(text: string, now = Date.now()): number | undefined {
  const pattern =
    /resets?\s+at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?::?(\d{2}))?)?/gi;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return undefined;

  const resolved = new Set<number>();
  for (const match of matches) {
    const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute] = match;
    const parts = [year, month, day, hour, minute, second, offsetHour, offsetMinute]
      .map((part) => (part === undefined ? undefined : Number(part)));
    const [y, mo, d, h, mi, s, oh, om] = parts;
    // 范围校验:拦下会被 Date.UTC 归一化的非法日历/时钟值。
    if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31) return undefined;
    if (h! > 23 || mi! > 59 || (s ?? 0) > 59) return undefined;
    if (oh !== undefined && (oh > 14 || (om ?? 0) > 59)) return undefined;

    const localMs = Date.UTC(y!, mo! - 1, d!, h!, mi!, s ?? 0);
    if (!Number.isFinite(localMs)) return undefined;
    // round-trip:非法日期(如 2 月 31 日)会被 Date.UTC 规范化,必须拒绝。
    const probe = new Date(localMs);
    if (
      probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo! - 1 ||
      probe.getUTCDate() !== d || probe.getUTCHours() !== h ||
      probe.getUTCMinutes() !== mi || probe.getUTCSeconds() !== (s ?? 0)
    ) return undefined;

    // 无偏移按 UTC 解释(官方文案里裸 UTC 即 UTC+0);带偏移才做平移。
    const offsetMinutes = oh === undefined ? 0 : (oh * 60 + (om ?? 0)) * (sign === "-" ? -1 : 1);
    const resetsAt = localMs - offsetMinutes * 60_000;
    if (resetsAt > now) resolved.add(resetsAt);
  }

  // 多个互相冲突的恢复时刻无法判定哪个生效:拒绝解析,交给冷却期。
  return resolved.size === 1 ? [...resolved][0] : undefined;
}

/** 明确不是账户/限流终态的 code:鉴权/未开通/模型错误/上下文超长。 */
const NON_TERMINAL_CODES = new Set([
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

/**
 * 识别 WorkBuddy 侧的腾讯云 WAF 403 拦截页。
 *
 * **必须没有结构化错误体**:有 JSON 的一律交给 code 判定(与 `classifyTransientOutage`
 * 同一条纪律),免得把上游透传的、带 JSON 的 403 当成 WAF 页。
 * 这里匹配的是 WorkBuddy 侧 WAF 的**专有特征串**,不是"所有 403"的通用规则:
 * 故意不经过 `readStatus`,也不做任何状态码门禁。
 */
export function classifyWafBlock(text: string): boolean {
  if (extractFirstJsonObject(text) !== undefined) return false;
  return (
    /<title>\s*waf\s+block\s+page\s*<\/title>/i.test(text) ||
    /waf-intl\.qq\.com/.test(text) ||
    /web\s+application\s+firewall/i.test(text) ||
    /block-pages\/403/.test(text)
  );
}

/** 连续故障的计数窗口:超出这个间隔视为新的一轮,避免长任务里偶发 5xx 累加成逃逸。 */
export const TRANSIENT_OUTAGE_WINDOW_MS = 120_000;
/** 逃逸后对该模型的冷却期:ban 在此期间生效,到期自动解除,模型重新可用。 */
export const TRANSIENT_OUTAGE_COOLDOWN_MS = 300_000;
export const DEFAULT_TRANSIENT_OUTAGE_STREAK = 3;

/** 限流逃逸后对该模型的冷却期:ban 在此期间生效,到期自动解除,模型重新可用。 */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** WAF 拦截页逃逸后对该模型的冷却期(固定值,不做成配置项)。 */
export const WAF_BLOCK_COOLDOWN_MS = 600_000;

/** 默认首次即逃逸:pi 不重试 403,一次拦截就终止 run,没有第二次机会。 */
export const DEFAULT_WAF_BLOCK_STREAK = 1;

let transientOutageStreak = DEFAULT_TRANSIENT_OUTAGE_STREAK;
let rateLimitCooldownMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS;
let wafBlockStreak = DEFAULT_WAF_BLOCK_STREAK;

/** 由扩展入口按配置注入;<=0 或非有限值表示关闭逃逸。 */
export function setWorkbuddyTransientOutageStreak(value: number): void {
  transientOutageStreak = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 由扩展入口按配置注入;<=0 或非有限值表示关闭 WAF 逃逸。 */
export function setWorkbuddyWafBlockStreak(value: number): void {
  wafBlockStreak = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 由扩展入口按配置注入;<=0 或非有限值表示关闭限流逃逸。 */
export function setWorkbuddyRateLimitCooldownMs(value: number): void {
  rateLimitCooldownMs = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Handler state belongs to one engine/session.  Do not move this map to module scope:
 * hosted Pi engines share the extension module, and one session's new prompt must not
 * erase another session's outage streak.
 */
export function createWorkbuddyHandler(
  getTransientOutageStreak: () => number = () => transientOutageStreak,
  getRateLimitCooldownMs: () => number = () => rateLimitCooldownMs,
  getWafBlockStreak: () => number = () => wafBlockStreak,
): ProviderFailbackHandler {
  const outages = new Map<string, { count: number; lastAt: number }>();
  // WAF 拦截页用**独立**的计数器:它与 5xx 网关故障是不同的上游语义,
  // 共享计数会让一侧的偶发失败把另一侧推到阈值。
  const wafOutages = new Map<string, { count: number; lastAt: number }>();
  const resetWorkbuddyOutages = () => {
    outages.clear();
    wafOutages.clear();
  };
  const noteOutage = (
    map: Map<string, { count: number; lastAt: number }>,
    key: string,
    now: number,
  ): number => {
    const previous = map.get(key);
    const count = previous && now - previous.lastAt <= TRANSIENT_OUTAGE_WINDOW_MS ? previous.count + 1 : 1;
    map.set(key, { count, lastAt: now });
    return count;
  };
  return {
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
      // 鉴权/未开通等非终态 code 优先排除:即使 HTTP 状态是 429 也不该换模型。
      if (NON_TERMINAL_CODES.has(code)) return null;
      if (BALANCE_EXHAUSTED_CODES.has(code)) {
        return {
          reason: "quota_exhausted",
          scope: "cross-provider",
          note: `WorkBuddy 账户额度耗尽(${code})`,
        };
      }
      // 瞬时限流:按配置直接切备用链,不再等 pi 退避重试耗尽。
      // scope 用 "any" —— 限流常是 per-model/endpoint 的,应按用户配的链逐跳尝试
      // (同 provider 的另一部署也可能有独立配额),而不是一律跳过同 provider。
      // 6003/6004/6008 属同一族,但优先用文案里的官方重置时刻(见文件头说明);
      // 6008(RPD)与 6004(TPD)同为官方日配额,固定冷却期对日窗口明显偏短。
      if (RATE_LIMIT_CODES.has(code) || CRAFT_TOKEN_WINDOW_CODES.has(code)) {
        const cooldownMs = getRateLimitCooldownMs();
        if (cooldownMs <= 0) return null;
        const craftWindow = CRAFT_TOKEN_WINDOW_CODES.get(code);
        const official = parseCraftResetAt(text);
        // 日窗口不可能在 3 天后才恢复:超出上界说明解析出了错误的时间,丢弃。
        const bounded = official !== undefined && CRAFT_DAILY_QUOTA_CODES.has(code) &&
            official - Date.now() > CRAFT_DAILY_RESET_MAX_MS
          ? undefined
          : official;
        return {
          reason: "rate_limited",
          scope: "any",
          resetsAt: bounded ?? Date.now() + cooldownMs,
          note: craftWindow !== undefined
            ? `WorkBuddy 模型${craftWindow}已用尽(${code}),仅该模型受限,已切换备用链`
            : `WorkBuddy 瞬时限流(${code}),已切换备用链`,
        };
      }
      // 未知 code 不做猜测:留给人工确认,避免误 ban 整个 provider。
      return null;
    }

    // WAF 403 拦截页:pi 不重试 403,一次即终止 run,所以默认首次就逃逸(见文件头说明)。
    if (classifyWafBlock(text)) {
      const wafBlockStreak = getWafBlockStreak();
      if (wafBlockStreak <= 0) return null;
      const model = typeof msg.model === "string" ? msg.model : "";
      const wafKey = `${msg.provider}/${model}`;
      const count = noteOutage(wafOutages, wafKey, Date.now());
      if (count < wafBlockStreak) return null;
      wafOutages.delete(wafKey);
      return {
        reason: "waf_blocked",
        scope: "cross-provider",
        resetsAt: Date.now() + WAF_BLOCK_COOLDOWN_MS,
        note: "WorkBuddy 被腾讯云 WAF 拦截(403 拦截页),已切换备用链",
      };
    }

    // 上游网关连续故障:单次仍按瞬时错误交给 pi 重试,连续多次才允许一次跨 provider 逃逸。
    const outage = classifyTransientOutage(text);
    if (outage !== undefined) {
      const transientOutageStreak = getTransientOutageStreak();
      if (transientOutageStreak <= 0) return null;
      const model = typeof msg.model === "string" ? msg.model : "";
      const outageKey = `${msg.provider}/${model}`;
      const count = noteOutage(outages, outageKey, Date.now());
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

    // 无 code 时按官方兜底:429 且文案带额度语义 → 余额耗尽(无冷却,等账户恢复)。
    if (status === 429 && /usage\s*limit|quota|balance|exhausted|insufficient\s+credits?/i.test(text)) {
      return {
        reason: "quota_exhausted",
        scope: "cross-provider",
        note: "WorkBuddy 账户额度耗尽(429 兜底)",
      };
    }

    // 无 code 的裸 429:按限流处理,直接切备用链(带冷却期)。
    if (status === 429) {
      const cooldownMs = getRateLimitCooldownMs();
      if (cooldownMs <= 0) return null;
      return {
        reason: "rate_limited",
        scope: "any",
        resetsAt: Date.now() + cooldownMs,
        note: "WorkBuddy 瞬时限流(429)",
      };
    }

    return null;
  },
  };
}

// Backward-compatible standalone handler for direct provider tests. Engines use a fresh
// instance from the registry above.
export const workbuddyHandler = createWorkbuddyHandler();
export function resetWorkbuddyOutages(): void {
  workbuddyHandler.resetTransientState?.();
}
