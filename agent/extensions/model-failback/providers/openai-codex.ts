/**
 * openai-codex — ChatGPT 订阅 backend 的终态判定
 *
 * 依据(按稳定性分层,命中任意一层即判定终态):
 *  1. pi provider 层的归一化文案(parseErrorResponse friendlyMessage):
 *       "You have hit your ChatGPT usage limit (plus plan). Try again in ~34 min."
 *     该文案由 pi 生成,跨计划/版本最稳定。
 *  2. 订阅 backend 的 error.code 枚举:usage_limit_reached / usage_not_included
 *  3. 订阅计划历史错误词:GoUsageLimitError / FreeUsageLimitError /
 *     Monthly usage limit reached(pi 内建 isTerminalRateLimitError 同款词表)
 *  4. Codex 流式 error 事件原文:"Codex error: The usage limit has been reached"
 *
 * scope = "cross-provider":订阅额度按账户计算,同 provider 下的其他模型
 * 共享同一配额,切换毫无意义,必须跨 provider。
 */

import { getOpenAICodexQuota } from "../../usage-stats";
import type { ProviderFailbackHandler, TerminalVerdict } from "./types";

/** 从 pi 归一文案 "Try again in ~N min." 推算恢复时刻 */
function parseResetsAt(text: string): number | undefined {
  const m = text.match(/try again in ~?(\d+)\s*min/i);
  return m ? Date.now() + Number(m[1]) * 60_000 : undefined;
}

export function isOpenaiCodex(modelProvider: unknown): boolean {
  return typeof modelProvider === "string" && modelProvider === "openai-codex";
}

type AssistantLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
};

function asAssistant(message: unknown): AssistantLike | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as AssistantLike;
  if (m.role !== "assistant") return null;
  if (m.stopReason !== "error") return null;
  return m;
}

/**
 * 只在已耗尽的窗口中取最晚重置时刻：5h 与 weekly 同时用尽时，不能因 5h
 * 先恢复就误判账户可用。额度接口异常、快照尚未达到 100% 时保持未知。
 */
async function resolveCodexResetsAt(
  _verdict: Parameters<NonNullable<ProviderFailbackHandler["resolveResetsAt"]>>[0],
  resolver: Parameters<NonNullable<ProviderFailbackHandler["resolveResetsAt"]>>[1],
  signal?: AbortSignal,
): Promise<number | undefined> {
  const quota = await getOpenAICodexQuota(resolver, signal);
  const resets = quota?.windows
    .filter((window) => window.percent >= 100 && window.resetsAt && window.resetsAt.getTime() > Date.now())
    .map((window) => window.resetsAt!.getTime()) ?? [];
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

export const openaiCodexHandler: ProviderFailbackHandler = {
  providerId: "openai-codex",
  resolveResetsAt: resolveCodexResetsAt,

  inspect(message: unknown): TerminalVerdict | null {
    const msg = asAssistant(message);
    if (!msg || !isOpenaiCodex(msg.provider)) return null;

    const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!text) return null;

    // 层 1:pi 归一文案(最稳)
    if (/you have hit your chatgpt usage limit/i.test(text)) {
      return {
        reason: "usage_limit",
        scope: "cross-provider",
        resetsAt: parseResetsAt(text),
        note: "ChatGPT 订阅额度用尽(pi 归一文案)",
      };
    }
    // 层 2:error.code 枚举
    if (/usage_limit_reached|usage_not_included/i.test(text)) {
      return {
        reason: "usage_limit",
        scope: "cross-provider",
        resetsAt: parseResetsAt(text),
        note: "usage_limit_reached / usage_not_included(error.code)",
      };
    }
    // 层 3:订阅计划历史词
    if (/gousagelimiterror|freeusagelimiterror|monthly usage limit reached/i.test(text)) {
      return {
        reason: "usage_limit",
        scope: "cross-provider",
        resetsAt: parseResetsAt(text),
        note: "订阅计划历史错误词(Go/Free/Monthly usage limit)",
      };
    }
    // 层 4:Codex 流式 error 事件。pi 会抛 "Codex error: <message>"，
    // 上游 code 不一定进入 errorMessage，不能只依赖 usage_limit_reached。
    if (/usage\s+limit\s+has\s+been\s+reached|you'?ve\s+reached\s+your\s+usage\s+limit/i.test(text)) {
      return {
        reason: "usage_limit",
        scope: "cross-provider",
        resetsAt: parseResetsAt(text),
        note: "ChatGPT 订阅额度用尽(Codex 流式 error)",
      };
    }
    return null;
  },
};