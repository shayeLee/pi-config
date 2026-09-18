/**
 * 配置加载:~/..../agent/model-failback.json
 *
 * 结构与社区 pi-model-fallback 兼容("provider/model" → "provider/model"),
 * 支持通配:"provider/★" 兜住该 provider 全部模型;"★/★" 全局兜底(★ 即星号,
 * 块注释内避免出现注释结束符)。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface FailbackConfig {
  /** 链式映射:["A","B","C"](A 终态 → B,B 终态 → C),首节点可为 "provider/星号" */
  chains?: string[][];
  /** 旧平面映射 "provider/model" → "provider/model",向后兼容;chains 优先 */
  fallbacks: Record<string, string>;
  /** 向后兼容保留,不再参与切换拦截(由环检测 + maxConsecutive 接管)。 */
  cooldownMs?: number;
  /** 单次 failback 链允许的最大连续切换次数(用于多层链式)。默认 3。 */
  maxConsecutive?: number;
  /** 死 session ban 文件的惰性清理阈值(ms)。默认 7 天；<=0 关闭。 */
  banFileTtlMs?: number;
  /** 配额恢复后自动切回原模型(agent_start 时机检查)。默认 false。 */
  autoRestore?: boolean;
  /**
   * workbuddy:同一模型在 2 分钟内连续几次上游网关故障(502/504 页)后允许
   * 一次跨 provider 逃逸。默认 3;<=0 关闭逃逸(全部交给 pi 重试)。
   */
  workbuddyTransientOutageStreak?: number;
  /**
   * workbuddy:命中瞬时限流(14003 / 6005-6008 / 无 code 的 429)时直接切备用链,
   * 并对该模型设这么久的冷却 ban。默认 60s;<=0 关闭(回到全部交给 pi 重试)。
   */
  workbuddyRateLimitCooldownMs?: number;
  /**
   * workbuddy:连续几次 WAF 拦截页(腾讯云 403 拦截页)后跨 provider 逃逸。
   * 默认 1(首次即逃逸,因为 pi 不重试 403,一次即终止该 run);<=0 关闭。
   */
  workbuddyWafStreak?: number;
}

export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_CONSECUTIVE = 3;
export const DEFAULT_BAN_FILE_TTL_MS = 7 * 24 * 60 * 60_000;

export function loadConfig(path?: string): FailbackConfig {
  const p = path ?? join(getAgentDir(), "model-failback.json");
  if (!existsSync(p)) return { fallbacks: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const chains = Array.isArray(raw.chains)
      ? raw.chains
          .filter((chain: unknown) => Array.isArray(chain))
          .map((chain: unknown[]) =>
            chain.filter((node): node is string => typeof node === "string"),
          )
          .filter((chain: string[]) => chain.length >= 2)
      : undefined;
    return {
      chains,
      fallbacks:
        raw.fallbacks && typeof raw.fallbacks === "object" ? raw.fallbacks : {},
      cooldownMs:
        typeof raw.cooldownMs === "number" && Number.isFinite(raw.cooldownMs)
          ? raw.cooldownMs
          : DEFAULT_COOLDOWN_MS,
      maxConsecutive:
        typeof raw.maxConsecutive === "number" && Number.isFinite(raw.maxConsecutive)
          ? raw.maxConsecutive
          : DEFAULT_MAX_CONSECUTIVE,
      banFileTtlMs:
        typeof raw.banFileTtlMs === "number" && Number.isFinite(raw.banFileTtlMs)
          ? raw.banFileTtlMs
          : DEFAULT_BAN_FILE_TTL_MS,
      autoRestore: raw.autoRestore === true,
      ...(typeof raw.workbuddyTransientOutageStreak === "number" &&
      Number.isFinite(raw.workbuddyTransientOutageStreak)
        ? { workbuddyTransientOutageStreak: raw.workbuddyTransientOutageStreak }
        : {}),
      ...(typeof raw.workbuddyRateLimitCooldownMs === "number" &&
      Number.isFinite(raw.workbuddyRateLimitCooldownMs)
        ? { workbuddyRateLimitCooldownMs: raw.workbuddyRateLimitCooldownMs }
        : {}),
      ...(typeof raw.workbuddyWafStreak === "number" &&
      Number.isFinite(raw.workbuddyWafStreak)
        ? { workbuddyWafStreak: raw.workbuddyWafStreak }
        : {}),
    };
  } catch {
    return { fallbacks: {} };
  }
}

export function splitModelKey(key: string): { provider: string; model: string } | null {
  const idx = key.indexOf("/");
  if (idx <= 0 || idx === key.length - 1) return null;
  return { provider: key.slice(0, idx), model: key.slice(idx + 1) };
}

/** 节点匹配:返回 "exact"(精确)/ "wildcard"(provider/星号 或 星号/星号)/ "none" */
function nodeMatchKind(node: string, provider: string, model: string): "exact" | "wildcard" | "none" {
  if (node === `${provider}/${model}`) return "exact";
  const idx = node.indexOf("/");
  if (idx <= 0) return "none";
  const nodeProvider = node.slice(0, idx);
  const nodeModel = node.slice(idx + 1);
  if (nodeModel === "*" && (nodeProvider === provider || nodeProvider === "*")) return "wildcard";
  return "none";
}

/** 按链解析:当前模型命中非尾节点时,返回首个未被禁用的后续节点。精确优先于通配。 */
function resolveFromChains(
  chains: string[][],
  provider: string,
  model: string,
  isBlocked?: (key: string) => boolean,
): string | undefined {
  for (const kind of ["exact", "wildcard"] as const) {
    for (const chain of chains) {
      for (let i = 0; i < chain.length - 1; i++) {
        if (nodeMatchKind(chain[i], provider, model) !== kind) continue;
        for (let next = i + 1; next < chain.length; next++) {
          if (!isBlocked?.(chain[next])) return chain[next];
        }
      }
    }
  }
  return undefined;
}

/**
 * 解析下一个 fallback 目标:
 *   1. 链式 chains:["A","B","C"] —— A→B→C,可跳过当前 session 已禁节点
 *   2. 旧平面 fallbacks(向后兼容):精确键 → provider/星号 → 星号/星号
 */
export function resolveFallback(
  config: FailbackConfig,
  provider: string,
  model: string,
  isBlocked?: (key: string) => boolean,
): string | undefined {
  if (config.chains && config.chains.length > 0) {
    const next = resolveFromChains(config.chains, provider, model, isBlocked);
    if (next) return next;
  }
  const target =
    config.fallbacks[`${provider}/${model}`] ??
    config.fallbacks[`${provider}/*`] ??
    config.fallbacks["*/*"];
  return target && !isBlocked?.(target) ? target : undefined;
}