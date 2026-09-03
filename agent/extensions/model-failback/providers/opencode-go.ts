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

export const opencodeGoHandler: ProviderFailbackHandler = {
  providerId: "opencode-go",

  inspect(message: unknown) {
    const creditsVerdict = creditsHandler.inspect(message);
    if (creditsVerdict) return creditsVerdict;

    if (typeof message !== "object" || message === null) return null;
    const msg = message as AssistantLike;
    if (msg.role !== "assistant" || msg.stopReason !== "error" || msg.provider !== "opencode-go") {
      return null;
    }

    const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
    if (!text || /\bModelError\b/i.test(text) || !isEndpointUnavailable(text)) return null;

    return {
      reason: "endpoint_unavailable",
      scope: "cross-provider",
      note: "OpenCode Go 端点不可用(503)",
    };
  },
};
