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

const HANDLERS: readonly ProviderFailbackHandler[] = [
  openaiCodexHandler,
  opencodeHandler,
  opencodeGoHandler,
  modelscopeHandler,
  commandCodeHandler,
];

export function getProviderHandler(provider: unknown): ProviderFailbackHandler | undefined {
  if (typeof provider !== "string") return undefined;
  return HANDLERS.find((h) => h.providerId === provider);
}

export function supportedProviders(): string[] {
  return HANDLERS.map((h) => h.providerId);
}