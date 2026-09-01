/**
 * failback 引擎:与 provider 无关的编排层。
 *
 * 终态后标记精确模型为 ban；子进程启动与后续链解析都会跳过该模型。
 * ban 由外部 BanStore 持久化，供 agent-team 每次新建的 Pi 进程读取。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getProviderHandler } from "../providers/registry";
import type { BanStore } from "./ban-store";
import type { FailbackConfig } from "./config";
import { DEFAULT_MAX_CONSECUTIVE, resolveFallback, splitModelKey } from "./config";

export interface EngineState {
  consecutive: number;
  lastFallbackAt: number;
  /** 本次 failback 链的原始模型(首次切换前的模型),用于 restore */
  original: { provider: string; model: string } | null;
  /** 最近一次终态记录的配额恢复时刻 */
  resetsAt: number | undefined;
  /** 当前 failback 链已达到的模型 key(含 original 与每个 target),用于环检测 */
  chain: string[];
  /** restore 命令显式恢复时,暂时允许选择已 ban 的原模型 */
  restoreInProgress: boolean;
}

interface AssistantFailureLike {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  provider?: unknown;
  model?: unknown;
}

function extractFailure(message: unknown): AssistantFailureLike | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as AssistantFailureLike;
  if (m.role !== "assistant" || m.stopReason !== "error") return null;
  return m;
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * 取链上第一个可用目标：跳过已经 ban 的模型；来源终态要求 cross-provider 时，
 * 也跳过同 provider 节点（不扩大 ban 范围，只保护这次路由语义）。
 */
function resolveAvailableTarget(
  config: FailbackConfig,
  bans: BanStore,
  sourceProvider: string,
  sourceModel: string,
  scope?: "cross-provider" | "any",
): { target: string; provider: string; model: string } | null {
  const sourceScope = scope ?? bans.get(modelKey(sourceProvider, sourceModel))?.scope;
  const target = resolveFallback(config, sourceProvider, sourceModel, (candidate) => {
    if (bans.isBlocked(candidate)) return true;
    const parts = splitModelKey(candidate);
    return sourceScope === "cross-provider" && parts?.provider === sourceProvider;
  });
  if (!target) return null;
  const parts = splitModelKey(target);
  return parts ? { target, ...parts } : null;
}

async function setTargetModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: { target: string; provider: string; model: string },
): Promise<boolean> {
  const targetModelObj = ctx.modelRegistry.find(target.provider, target.model);
  if (!targetModelObj) {
    ctx.ui.notify(
      `[model-failback] fallback 模型不在 registry: ${target.target}(检查 models.json)`,
      "error",
    );
    return false;
  }
  try {
    const ok = await pi.setModel(targetModelObj);
    if (!ok) ctx.ui.notify(`[model-failback] 切换到 ${target.target} 失败(无可用鉴权?)`, "error");
    return ok;
  } catch {
    ctx.ui.notify(`[model-failback] 切换到 ${target.target} 失败(无可用鉴权?)`, "error");
    return false;
  }
}

export function createEngine(
  pi: ExtensionAPI,
  getConfig: () => FailbackConfig,
  bans: BanStore,
): EngineState {
  const state: EngineState = {
    consecutive: 0,
    lastFallbackAt: 0,
    original: null,
    resetsAt: undefined,
    chain: [],
    restoreInProgress: false,
  };
  let redirectingBlockedSelection = false;

  /** 在 session 启动或用户手动选回已 ban 模型后，事后切到链上可用节点。 */
  const redirectBlockedModel = async (
    ctx: ExtensionContext,
    provider: string,
    model: string,
    trigger: "preflight" | "manual-select",
  ) => {
    const from = modelKey(provider, model);
    const target = resolveAvailableTarget(getConfig(), bans, provider, model);
    if (!target) {
      ctx.ui.notify(
        `[model-failback] ${from} 已 ban,但链上没有未 ban 的 fallback`,
        "error",
      );
      return;
    }
    redirectingBlockedSelection = true;
    try {
      if (await setTargetModel(pi, ctx, target)) {
        pi.appendEntry("model-failback-preflight", { from, to: target.target, trigger, at: Date.now() });
        ctx.ui.notify(`[model-failback] ${from} 已 ban,跳过并使用 ${target.target}`, "warning");
      }
    } finally {
      redirectingBlockedSelection = false;
    }
  };

  // 每个 agent-team child 都先在这里读取共享 ban，避免首个请求再次撞已耗尽模型。
  // 新用户请求开始时结束上一条连续 failback 链；steering continuation 保留链状态。
  let continuationPending = false;
  pi.on("agent_start", async () => {
    if (!continuationPending && (state.chain.length > 0 || state.consecutive > 0)) {
      state.chain = [];
      state.consecutive = 0;
      state.original = null;
      state.resetsAt = undefined;
    }
    continuationPending = false;
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // 主 Pi 使用真实 session id；agent-team 子进程保留父进程注入的 id。
    if (process.env.MODEL_FAILBACK_CHILD !== "1") {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (sessionId) {
        bans.setSessionId(sessionId);
        process.env.MODEL_FAILBACK_SESSION_ID = sessionId;
      }
    }
    await bans.refresh();
    const current = ctx.model;
    if (!current) return;
    if (bans.isBlocked(modelKey(current.provider, current.id))) {
      await redirectBlockedModel(ctx, current.provider, current.id, "preflight");
    }
  });

  // 真正切换/派生 session 前清理旧 session 的 ban；reload 不触发这些 before 事件。
  pi.on("session_before_switch", async () => {
    await bans.endSession();
  });
  pi.on("session_before_fork", async () => {
    await bans.endSession();
  });

  // 只在退出 Pi 时兜底清理。new/resume/fork 已在 before 事件中完成，
  // reload 绝不能依赖 session_shutdown reason 来决定是否保留。
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") await bans.endSession();
  });

  // Pi 没有可取消的 model_select 事件；仅能在用户选择后立即纠正，并用守卫防递归。
  pi.on("model_select", async (event, ctx: ExtensionContext) => {
    if (state.restoreInProgress || redirectingBlockedSelection || event.source === "restore") return;
    await bans.refresh();
    const selected = event.model;
    if (bans.isBlocked(modelKey(selected.provider, selected.id))) {
      await redirectBlockedModel(ctx, selected.provider, selected.id, "manual-select");
    }
  });

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    const fail = extractFailure(event.message);
    if (!fail) return;

    const provider = fail.provider ?? ctx.model?.provider;
    const handler = getProviderHandler(provider);
    if (!handler) return; // 未注册的 provider:保持现状,不外扩行为

    const verdict = handler.inspect(event.message);
    if (!verdict) return;

    const sourceProvider = typeof provider === "string" ? provider : "unknown";
    const currentModel = (fail.model as string) ?? ctx.model?.id;
    if (typeof currentModel !== "string") return;
    const prevKey = modelKey(sourceProvider, currentModel);

    // 先持久化精确模型 ban；即使后续没有可用 fallback，下一个 subagent 也不会再撞它。
    let banRecorded = false;
    try {
      await bans.mark(prevKey, {
        scope: verdict.scope,
        reason: verdict.reason,
        note: verdict.note,
        markedAt: Date.now(),
        resetsAt: verdict.resetsAt,
      });
      banRecorded = true;
      pi.appendEntry("model-failback-ban", {
        key: prevKey,
        reason: verdict.reason,
        scope: verdict.scope,
        resetsAt: verdict.resetsAt,
        at: Date.now(),
      });
    } catch {
      // 持久化失败不能阻断当前会话 failback；仅失去跨 subagent 的预跳过能力。
      ctx.ui.notify(`[model-failback] 无法持久化 ${prevKey} 的 ban,本次仍继续 failback`, "warning");
    }

    const target = resolveAvailableTarget(getConfig(), bans, sourceProvider, currentModel, verdict.scope);
    if (!target) {
      ctx.ui.notify(
        `[model-failback] ${prevKey} 终态,但链上没有未 ban 的 fallback,任务将中断`,
        "error",
      );
      return;
    }

    // ---- 环检测:目标已在当前 failback 链中出现过,拒绝成环切换 ----
    if (state.chain.includes(target.target)) {
      ctx.ui.notify(
        `[model-failback] 检测到切换环: ${target.target} 已在此链失败过,停止 failback,任务将中断`,
        "error",
      );
      return;
    }

    // ---- 连跳上限 ----
    const maxConsecutive = getConfig().maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE;
    if (state.consecutive >= maxConsecutive) {
      ctx.ui.notify(
        `[model-failback] 已达连跳上限(${maxConsecutive}),停止 failback,任务将中断`,
        "error",
      );
      return;
    }

    // ---- 切换 ----
    if (!(await setTargetModel(pi, ctx, target))) return;

    // ---- 台账 ----------------
    if (state.chain.length === 0) state.chain.push(prevKey);
    state.chain.push(target.target);
    state.consecutive += 1;
    state.lastFallbackAt = Date.now();
    state.original ??= { provider: sourceProvider, model: currentModel };
    if (verdict.resetsAt) state.resetsAt = verdict.resetsAt;

    pi.appendEntry("model-failback", {
      from: prevKey,
      to: target.target,
      reason: verdict.reason,
      banRecorded,
      resetsAt: verdict.resetsAt,
      at: Date.now(),
    });

    const failureReason = verdict.note ?? verdict.reason;
    const restoreHint = verdict.resetsAt
      ? `预计 ${new Date(verdict.resetsAt).toLocaleTimeString()} 恢复(/failback status 查看)`
      : "";
    ctx.ui.notify(
      `⚠️ [model-failback] ${prevKey} 终态错误(${failureReason}) → 已切换 ${target.target}。${restoreHint}`,
      "warning",
    );

    continuationPending = true;
    pi.sendUserMessage(
      `[model-failback] 之前的模型(${prevKey})发生终态错误(${failureReason})。` +
        `已切换到备用模型(${target.target}),请继续完成之前的任务,不要重复已完成的步骤。`,
      { deliverAs: "steer" },
    );
  });

  // ---- 自动恢复:autoRestore 打开时,在每次 agent 启动检查配额是否已恢复 ----
  pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
    const config = getConfig();
    if (!config.autoRestore || !state.original || !state.resetsAt) return;
    if (Date.now() < state.resetsAt) return;

    const current = ctx.model;
    if (!current) return;
    const currentKey = modelKey(current.provider, current.id);
    const originalKey = modelKey(state.original.provider, state.original.model);
    if (currentKey === originalKey) {
      state.original = null;
      state.resetsAt = undefined;
      state.consecutive = 0;
      state.chain = [];
      return;
    }
    const originalModelObj = ctx.modelRegistry.find(
      state.original.provider,
      state.original.model,
    );
    if (!originalModelObj) return;
    if (await pi.setModel(originalModelObj)) {
      ctx.ui.notify(`[model-failback] 配额已恢复,切回 ${originalKey}`, "info");
      state.original = null;
      state.resetsAt = undefined;
      state.consecutive = 0;
      state.chain = [];
    }
  });

  return state;
}
