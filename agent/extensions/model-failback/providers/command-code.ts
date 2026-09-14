/**
 * command-code — Command Code 聚合网关(Provider API, OpenAI-compatible)。
 *
 * 额度由三部分组成:账户 credits(充值/月度额度)、订阅的 5h/weekly 滚动窗口,
 * 以及组织级月度 spend cap。本 handler 只覆盖这些**账户/计划级终态**:
 *
 *  - 滚动窗口限额 → "usage_limit";
 *  - 账户/组织消费限额(顶层 code "USAGE_EXCEEDED"、组织 spend cap 文案)→ "spend_limit";
 *  - 余额与计划(insufficient credits、PREMIUM_CREDITS_EXHAUSTED)→ "quota_exhausted";
 *  - 该模型不在计划内(MODEL_NOT_IN_PLAN)→ "model_not_in_plan",scope "any"。
 *
 * 前三类都是账户级终态,scope 为 "cross-provider";`MODEL_NOT_IN_PLAN` 只针对
 * 单个模型,换同 provider 的其他模型仍有效,因此 scope 为 "any"(见 types.ts)。
 *
 * **不触发**的情形(交给 pi 退避重试或用户处理):
 * 无窗口证据的瞬时限流、5xx 上游故障、401 鉴权、403 upgrade_required、
 * unsupported_model、cmd_zdr_no_providers。
 *
 * ## 两道解析纪律(缺一就会误判)
 *
 * 1. **只解析错误正文,不解析 pi 追加的元数据。** pi 的 formatProviderError
 *    产出 `${status}: ${JSON.stringify(body)}`,并会把 `error.error.metadata.raw`
 *    追加在换行之后。因此这里只取**第一个括号配平的 JSON 对象**,所有字段
 *    (code / type / rateLimit) 都从该对象读取,绝不做跨文档的正则子串匹配——
 *    否则元数据里的同名 token 会把非终态错误升级为整 provider 级 ban。
 *
 * 2. **终态 code 优先于非终态 type。** 官方 CLI 只在
 *    `code === "RATE_LIMITED"` 或 `status === 429` 时才把 window 字段当作额度
 *    终态;缺失这道门禁时,上游透传的 5xx/401/403 只要带上 rateLimit 元数据
 *    就会被误判。反之,当顶层已有终态 code 时也不能被同层的非终态 type 覆盖,
 *    否则真终态会被漏判。
 */

import { getCommandCodeQuota } from "../../usage-stats";
import type { ProviderFailbackHandler } from "./types";

type AssistantLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
};

type ErrorBody = {
  code?: unknown;
  type?: unknown;
  message?: unknown;
  rateLimit?: unknown;
  window?: unknown;
};

function asAssistant(message: unknown): AssistantLike | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as AssistantLike;
  if (m.role !== "assistant" || m.stopReason !== "error") return null;
  return m;
}

/** pi 的 formatProviderError 前缀形如 "429: {...}";只在文本开头取状态码。 */
function readStatus(text: string): number | undefined {
  const match = text.match(/^\s*(\d{3}):/);
  return match ? Number(match[1]) : undefined;
}

/**
 * 取第一个**括号配平**的 JSON 对象(正确跳过字符串里的花括号与转义),
 * 从而只覆盖错误正文本身,排除换行之后追加的 metadata.raw。
 */
function extractFirstJsonObject(text: string): ErrorBody | undefined {
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
          return typeof parsed === "object" && parsed !== null ? (parsed as ErrorBody) : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const WINDOW_LABELS = new Set(["fiveHour", "weekly", "daily"]);

/** 从错误正文的 rateLimit.window(或 window)读取窗口枚举。 */
function readWindowLabel(body: ErrorBody | undefined): string | undefined {
  if (!body) return undefined;
  const rateLimit = body.rateLimit;
  if (typeof rateLimit === "object" && rateLimit !== null) {
    const label = (rateLimit as { window?: unknown }).window;
    if (typeof label === "string" && WINDOW_LABELS.has(label)) return label;
  }
  return typeof body.window === "string" && WINDOW_LABELS.has(body.window) ? body.window : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 官方 CLI 的窗口门禁:`status === 429` 或顶层 `code === "RATE_LIMITED"`。 */
function hasRateLimitGate(status: number | undefined, body: ErrorBody | undefined): boolean {
  const code = readString(body?.code);
  const type = readString(body?.type);
  return status === 429 || code === "RATE_LIMITED" || type === "rate_limit_error";
}

function hasResetCountdown(text: string): boolean {
  return (
    /resets? in \d+\s*(?:d|day|h|hr|hour|m|min)/i.test(text) ||
    /resets? at \d{4}-\d{2}-\d{2}T/i.test(text)
  );
}

/**
 * 窗口限额判定。分三层,置信度递减:
 *  1. 官方具名窗口文案("You've reached your 5-hour/weekly/daily … limit"、
 *     "5-hour limit reached")—— 自身足够明确,不需额外证据;
 *  2. 错误正文里的 `rateLimit.window` / `window` —— 必须有限流门禁;
 *  3. 泛化文案("usage limit for your plan")或仅 `Resets at <ISO>` —— 需要
 *     门禁,或明确倒计时(避免把校验类文案 "…must be a string" 当成额度终态)。
 */
function isWindowUsageLimit(
  prose: string,
  status: number | undefined,
  body: ErrorBody | undefined,
): boolean {
  const explicitWindowPhrase =
    /(?:5-hour|five-hour|weekly|daily)\s+(?:usage\s+)?limit\s+(?:has\s+been\s+)?(?:reached|exceeded)/i.test(prose) ||
    /you'?ve reached (?:your )?(?:5-hour|five-hour|weekly|daily)\s+(?:usage\s+)?limit/i.test(prose) ||
    /you have exceeded your (?:5-hour|five-hour|weekly|daily)\s+usage\s+limit/i.test(prose);
  if (explicitWindowPhrase) return true;

  if (readWindowLabel(body)) return hasRateLimitGate(status, body);

  const planWindowPhrase =
    /usage limit for your plan/i.test(prose) ||
    /usage limit has been reached/i.test(prose) ||
    /plan usage limit/i.test(prose);
  if (planWindowPhrase) return hasRateLimitGate(status, body) || hasResetCountdown(prose);

  return /resets? at \d{4}-\d{2}-\d{2}T/i.test(prose) && hasRateLimitGate(status, body);
}

function isModelNotInPlan(code: string | undefined, prose: string): boolean {
  return (
    code === "MODEL_NOT_IN_PLAN" ||
    /MODEL_NOT_IN_PLAN/i.test(prose) ||
    /model not in plan/i.test(prose) ||
    /not (?:included|available) in your (?:current )?plan/i.test(prose)
  );
}

function isCreditsExhausted(code: string | undefined, prose: string): boolean {
  return (
    code === "PREMIUM_CREDITS_EXHAUSTED" ||
    /premium credits (?:exhausted|have been exhausted)/i.test(prose) ||
    /insufficient credits/i.test(prose)
  );
}

function isSpendLimit(code: string | undefined, prose: string): boolean {
  return (
    code === "USAGE_EXCEEDED" ||
    /spending limit your organization set/i.test(prose) ||
    /organization'?s monthly spending limit/i.test(prose) ||
    /you'?ve reached (?:your )?monthly (?:usage|spending) limit/i.test(prose)
  );
}

/**
 * best-effort 解析恢复时间:优先绝对时刻 "Resets at 2026-09-14T07:00:00Z",
 * 否则累加 "Resets in 2h 41m" / "Resets in 3 days" 中的天/时/分。
 * 括号内的复述会被截断,同一单位只计一次(避免 "3 days (72 hours)" 变成 6 天);
 * 已经过去的时刻视为未知,不写入台账。
 */
function parseResetsAt(text: string): number | undefined {
  const at = text.match(/resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  let resolved: number | undefined;
  if (at) {
    const parsed = Date.parse(at[1]);
    if (Number.isFinite(parsed)) resolved = parsed;
  }
  if (resolved === undefined) {
    const clause = text.match(/resets? in ([^\n.}"\]]+)/i);
    if (clause) {
      const duration = clause[1].split("(")[0];
      let durationMs = 0;
      const seen = new Set<string>();
      for (const part of duration.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/gi)) {
        const unit = part[2].toLowerCase();
        const kind = unit.startsWith("d") ? "day" : unit.startsWith("h") ? "hour" : "minute";
        if (seen.has(kind)) continue;
        seen.add(kind);
        const value = Number(part[1]);
        if (!Number.isFinite(value)) continue;
        durationMs +=
          kind === "day" ? value * 24 * 60 * 60_000
            : kind === "hour" ? value * 60 * 60_000
              : value * 60_000;
      }
      if (durationMs > 0) resolved = Date.now() + durationMs;
    }
  }
  return resolved !== undefined && resolved > Date.now() ? resolved : undefined;
}

/**
 * 只在已确认的**滚动窗口**终态上查询额度接口。消费限额/余额/模型类错误没有
 * "窗口重置"语义,绝不填恢复时间(与 opencode-go 对齐)。查询失败一律 undefined。
 */
async function resolveCommandCodeResetsAt(
  verdict: Parameters<NonNullable<ProviderFailbackHandler["resolveResetsAt"]>>[0],
  resolver: Parameters<NonNullable<ProviderFailbackHandler["resolveResetsAt"]>>[1],
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (verdict.reason !== "usage_limit") return undefined;
  try {
    const quota = await getCommandCodeQuota(resolver, signal);
    const resets = quota?.windows
      .filter((window) => window.percent >= 100 && window.resetsAt && window.resetsAt.getTime() > Date.now())
      .map((window) => window.resetsAt!.getTime()) ?? [];
    return resets.length > 0 ? Math.max(...resets) : undefined;
  } catch {
    return undefined;
  }
}

export const commandCodeHandler: ProviderFailbackHandler = {
  providerId: "command-code",
  resolveResetsAt: resolveCommandCodeResetsAt,

  inspect(message: unknown) {
    const msg = asAssistant(message);
    if (!msg || msg.provider !== "command-code") return null;

    const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!text) return null;

    const body = extractFirstJsonObject(text);
    const status = readStatus(text);
    const code = readString(body?.code);
    // 判定文案优先取错误正文的 message:换行之后追加的元数据不得参与判定。
    const prose = readString(body?.message) ?? text;

    // 顺序即优先级,且**终态 code 先于非终态 type**(字段顺序无关)。
    // MODEL_NOT_IN_PLAN 只针对单个模型,scope 必须是 "any",否则会跳过同
    // provider 其他仍然可用的模型(如 mimo 不在计划内却跳过了 deepseek)。
    if (isModelNotInPlan(code, prose)) {
      return {
        reason: "model_not_in_plan",
        scope: "any",
        note: "Command Code 该模型不在当前计划内",
      };
    }

    // 余额类要先于消费限额:同一响应可能同时带 USAGE_EXCEEDED code,
    // 但 "insufficient credits" 的语义是账户余额耗尽。
    if (isCreditsExhausted(code, prose)) {
      return {
        reason: "quota_exhausted",
        scope: "cross-provider",
        note: "Command Code 账户额度耗尽",
      };
    }

    if (isWindowUsageLimit(prose, status, body)) {
      return {
        reason: "usage_limit",
        scope: "cross-provider",
        resetsAt: parseResetsAt(prose),
        note: "Command Code 订阅窗口额度用尽",
      };
    }

    // 消费限额与滚动窗口不是同一恢复语义:恢复时间只从文案里取,不查窗口。
    if (isSpendLimit(code, prose)) {
      return {
        reason: "spend_limit",
        scope: "cross-provider",
        resetsAt: parseResetsAt(prose),
        note: "Command Code 账户/组织消费限额用尽",
      };
    }

    // 其余(401/403 upgrade_required/unsupported_model/cmd_zdr_no_providers/
    // 5xx 上游故障/无窗口证据的瞬时限流)交给 pi 退避重试或用户处理。
    return null;
  },
};
