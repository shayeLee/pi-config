import { getOpenCodeGoQuota } from "../../usage-stats";
import type { ProviderFailbackHandler } from "./types";
import { createOpencodeCreditsHandler } from "./opencode";

type AssistantLike = {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
};

const creditsHandler = createOpencodeCreditsHandler("opencode-go");

function isEndpointUnavailable(text: string): boolean {
  // Console Go currently wraps this upstream outage as:
  // `503: {"type":"server_error","message":"... Endpoint is unavailable."}`.
  return /\b503\b/i.test(text) && /endpoint\s+(?:is\s+)?unavailable/i.test(text);
}

function parseUsageLimitReset(text: string): number | undefined {
  // Go returns messages such as "Weekly usage limit reached. Resets in 22hr 52min.".
  const match = text.match(/resets?\s+in\s+([^\n.}"\]]+)/i);
  if (!match) return undefined;
  let durationMs = 0;
  for (const part of match[1].matchAll(/(\d+)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m)\b/gi)) {
    const value = Number(part[1]);
    if (!Number.isFinite(value)) continue;
    durationMs += /^(hours?|hrs?|hr|h)$/i.test(part[2]) ? value * 60 * 60_000 : value * 60_000;
  }
  return durationMs > 0 ? Date.now() + durationMs : undefined;
}

function isGoUsageLimit(text: string): boolean {
  return /\bGoUsageLimitError\b/i.test(text) && /usage\s+limit\s+reached/i.test(text);
}

async function resolveGoResetsAt(
  verdict: Parameters<NonNullable<ProviderFailbackHandler["resolveResetsAt"]>>[0],
  resolver: Parameters<NonNullable<ProviderFailbackHandler["resolveResetsAt"]>>[1],
  signal?: AbortSignal,
): Promise<number | undefined> {
  // 503 端点故障没有额度恢复语义，不能借账户窗口制造错误的恢复承诺。
  if (verdict.reason !== "usage_limit") return undefined;
  const quota = await getOpenCodeGoQuota(resolver, signal);
  const resets = quota?.windows
    .filter((window) => window.percent >= 100 && window.resetsAt && window.resetsAt.getTime() > Date.now())
    .map((window) => window.resetsAt!.getTime()) ?? [];
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

export const opencodeGoHandler: ProviderFailbackHandler = {
  providerId: "opencode-go",
  resolveResetsAt: resolveGoResetsAt,

  inspect(message: unknown) {
    const creditsVerdict = creditsHandler.inspect(message);
    if (creditsVerdict) return creditsVerdict;

    if (typeof message !== "object" || message === null) return null;
    const msg = message as AssistantLike;
    if (msg.role !== "assistant" || msg.stopReason !== "error" || msg.provider !== "opencode-go") {
      return null;
    }

    const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!text || /\bModelError\b/i.test(text)) return null;

    if (isGoUsageLimit(text)) {
      return {
        reason: "usage_limit",
        scope: "cross-provider",
        resetsAt: parseUsageLimitReset(text),
        note: "OpenCode Go 订阅额度用尽(GoUsageLimitError)",
      };
    }

    if (!isEndpointUnavailable(text)) return null;
    return {
      reason: "endpoint_unavailable",
      scope: "cross-provider",
      note: "OpenCode Go 端点不可用(503)",
    };
  },
};
