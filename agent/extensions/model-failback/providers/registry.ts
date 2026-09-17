/**
 * provider → 判定 handler 的分派表。
 * 新增 provider:在 providers/ 下实现同名文件,并在这里注册一行即可。
 */

import type { ProviderFailbackHandler } from "./types";
import { openaiCodexHandler } from "./openai-codex";
import { opencodeHandler } from "./opencode";
import { opencodeGoHandler } from "./opencode-go";
import { modelscopeHandler } from "./modelscope";
import { commandCodeHandler } from "./command-code";
import { createWorkbuddyHandler } from "./workbuddy";

const STATIC_HANDLERS: readonly ProviderFailbackHandler[] = [
  openaiCodexHandler,
  opencodeHandler,
  opencodeGoHandler,
  modelscopeHandler,
  commandCodeHandler,
];

export interface ProviderRegistry {
  get(provider: unknown): ProviderFailbackHandler | undefined;
  resetTransientState(): void;
}

/** Each engine receives its own transient provider state. */
export function createProviderRegistry(
  getWorkbuddyTransientOutageStreak?: () => number,
  getWorkbuddyRateLimitCooldownMs?: () => number,
): ProviderRegistry {
  const handlers = [
    ...STATIC_HANDLERS,
    createWorkbuddyHandler(getWorkbuddyTransientOutageStreak, getWorkbuddyRateLimitCooldownMs),
  ];
  return {
    get(provider) {
      return typeof provider === "string" ? handlers.find((handler) => handler.providerId === provider) : undefined;
    },
    resetTransientState() {
      for (const handler of handlers) handler.resetTransientState?.();
    },
  };
}

export function supportedProviders(): string[] {
  return [...STATIC_HANDLERS.map((handler) => handler.providerId), "workbuddy"];
}