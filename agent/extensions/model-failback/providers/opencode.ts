/**
 * opencode — OpenAI-compatible credits/balance exhaustion.
 *
 * Only account-level balance errors trigger a cross-provider failback. Model
 * selection errors and initialization errors (such as a missing API key) do
 * not produce a matching assistant error message and must remain untouched.
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

function isCreditsExhausted(text: string): boolean {
  // ModelError is a model/endpoint problem, not an account balance terminal
  // state. Keep this guard ahead of the broader balance-message matches.
  if (/\bModelError\b/i.test(text)) return false;

  // The observed response is prefixed with `OpenAI API error (401):`, so
  // match the JSON body without requiring the prefix to be present.
  if (/"type"\s*:\s*"CreditsError"/i.test(text)) return true;

  return /insufficient\s+(?:balance|credits)/i.test(text);
}

export function createOpencodeCreditsHandler(providerId: string): ProviderFailbackHandler {
  return {
    providerId,

    inspect(message: unknown): TerminalVerdict | null {
      const msg = asAssistant(message);
      if (!msg || msg.provider !== providerId) return null;

      const text = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
      if (!text || /no\s+api\s+key|missing\s+(?:an?\s+)?api\s+key/i.test(text)) {
        return null;
      }
      if (!isCreditsExhausted(text)) return null;

      return {
      reason: "credits_exhausted",
      scope: "cross-provider",
      note: "OpenCode 账户余额耗尽(CreditsError)",
    };
    },
  };
}

export const opencodeHandler = createOpencodeCreditsHandler("opencode");
