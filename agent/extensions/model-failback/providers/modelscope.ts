/**
 * modelscope — ModelScope(魔搭)推理 API,底层为阿里云百炼(Model Studio)的
 * OpenAI-compatible completions 端点。
 *
 * 只覆盖"账户/计划额度耗尽"这类终态。瞬时限流(Throttling.RateQuota、
 * BurstRate、Concurrency)与鉴权错误(InvalidApiKey)不作为 failback 触发。
 *
 * 实测错误形状:
 *   429: {"code":"insufficient_quota","message":"You exceeded your current
 *        quota, please check your plan and billing details...","type":"insufficient_quota"}
 *   429: {"message":"insufficient balance","request_id":"..."}
 */

import type { ProviderFailbackHandler, TerminalVerdict } from "./types";

type AssistantLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
};

function asAssistant(message: unknown): AssistantLike | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as AssistantLike;
  if (m.role !== "assistant" || m.stopReason !== "error") return null;
  return m;
}

function isQuotaExhausted(text: string): boolean {
  return (
    /insufficient_quota/i.test(text) ||
    /you exceeded your current quota/i.test(text) ||
    /free\s+allocated\s+quota/i.test(text) ||
    /insufficient\s+balance/i.test(text) ||
    /out\s+of\s+budget/i.test(text)
  );
}

export const modelscopeHandler: ProviderFailbackHandler = {
  providerId: "modelscope",

  inspect(message: unknown): TerminalVerdict | null {
    const msg = asAssistant(message);
    if (!msg || msg.provider !== "modelscope") return null;

    const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!text) return null;
    // 鉴权错是配置问题,换 provider 也救不了(但这些文本不命中上面词表,
    // 此分支仅为显式排除,避免未来词表放宽时误触发想清语义)。
    if (/invalid\s*api[_\s]?key|incorrect api key/i.test(text)) return null;
    if (!isQuotaExhausted(text)) return null;

    return { reason: "quota_exhausted", scope: "cross-provider", note: "ModelScope/百炼额度耗尽" };
  },
};