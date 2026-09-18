/**
 * failback 引擎:与 provider 无关的编排层。
 *
 * 终态后标记精确模型为 ban；子进程启动与后续链解析都会跳过该模型。
 * ban 由外部 BanStore 持久化，供 agent-team 每次新建的 Pi 进程读取。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProviderRegistry } from "../providers/registry";
import {
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_TRANSIENT_OUTAGE_STREAK,
  DEFAULT_WAF_BLOCK_STREAK,
} from "../providers/workbuddy";
import type { BanStore } from "./ban-store";
import type { FailbackConfig } from "./config";
import { DEFAULT_MAX_CONSECUTIVE, resolveFallback, splitModelKey } from "./config";

/**
 * thinking-breaker 的升级请求契约。
 *
 * 刻意在两侧各声明一份结构（而不是 import）：两个扩展各自独立加载，互相 import
 * 会让其中一个无法单独启用。字段名由回归测试固定，漂移会立刻失败。
 */
export const THINKING_BREAKER_ESCALATE_EVENT = "thinking-breaker:escalate";

/** 复读 ban 的冷却期：到期自动解除，给模型一次重新证明自己的机会。 */
export const BEHAVIOR_BAN_COOLDOWN_MS = 30 * 60_000;
export const BEHAVIOR_BAN_REASON = "thinking_loop";

interface ThinkingBreakerEscalateRequest {
  readonly version: 1;
  readonly sessionId: string;
  readonly key: string;
  readonly reason: string;
  readonly note: string;
  readonly evidence:
    | {
        readonly kind?: "period";
        readonly period: number;
        readonly repeats: number;
        readonly chars: number;
        readonly strikes: number;
      }
    | {
        readonly kind: "collapse";
        readonly distinct: number;
        readonly lineCount: number;
        readonly repeatRatio: number;
        readonly chars: number;
        readonly strikes: number;
      };
  readonly accept: (reply: ThinkingBreakerEscalateReply) => void;
}

interface ThinkingBreakerEscalateReply {
  readonly ok: boolean;
  readonly switchedTo?: string;
  readonly message?: string;
}

export interface FailbackLifecycleEvent {
  readonly version: 1;
  readonly phase: "start" | "end";
  readonly attemptId: string;
  readonly sessionId: string | null;
  readonly outcome?: "switched" | "no-target" | "failed" | "cancelled";
  /** Present on terminal events after a target has been selected. */
  readonly from?: string;
  readonly to?: string;
  readonly reason?: string;
}

export const FAILBACK_LIFECYCLE_EVENT = "model-failback:lifecycle";
const FAILBACK_HOST_TRANSPORT_EVENT = "model-failback:host-transport";

type HostTransport = {
  begin(attemptId: string): boolean;
  cancelled(): boolean;
  enqueue(text: string): Promise<boolean>;
  end(attemptId: string): void;
};

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
  const providers = createProviderRegistry(
    () => {
      const value = getConfig().workbuddyTransientOutageStreak;
      // Config loading omits missing/invalid values; preserve valid <=0 as the handler's
      // explicit disabled setting instead of replacing it with the default threshold.
      return Number.isFinite(value) ? Math.floor(value!) : DEFAULT_TRANSIENT_OUTAGE_STREAK;
    },
    () => {
      const value = getConfig().workbuddyRateLimitCooldownMs;
      // Same contract as above: a valid <=0 disables the escape entirely.
      return Number.isFinite(value) ? Math.floor(value!) : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    },
    () => {
      const value = getConfig().workbuddyWafStreak;
      // Same contract as above: a valid <=0 disables the escape entirely.
      return Number.isFinite(value) ? Math.floor(value!) : DEFAULT_WAF_BLOCK_STREAK;
    },
  );
  let redirectingBlockedSelection = false;
  let extensionActive = true;
  // 行为升级（复读）需要“最近一次收到事件的上下文”，因为 escalate 事件是异步的，
  // 而 events.on() 回调本身拿不到 ctx。每次事件顺手刷新即可，不需要额外订阅。
  let currentContext: ExtensionContext | undefined;
  let compactionRetryActive = false;
  let compactionRetryEpoch = 0;
  let compactionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let lifecycleSequence = 0;
  // Standalone Pi has no host and keeps the legacy continuation path. The server handshake is
  // synchronous and session-local: a hosted extension must not silently fall back to terminal IO.
  let hostTransport: HostTransport | undefined;
  const requestHostTransport = () => {
    pi.events?.emit(FAILBACK_HOST_TRANSPORT_EVENT, {
      version: 1,
      accept(transport: HostTransport) { hostTransport = transport; },
    });
  };
  const cancelled = (ctx: ExtensionContext) => ctx.signal?.aborted === true || hostTransport?.cancelled() === true;
  const emitLifecycle = (event: FailbackLifecycleEvent) => {
    // Optional chaining keeps standalone terminal use and older test doubles compatible.
    pi.events?.emit(FAILBACK_LIFECYCLE_EVENT, event);
  };
  let pendingCompactionFailure:
    | { errorMessage: string; ctx: ExtensionContext; provider: string; model: string; retryCompact: boolean }
    | undefined;

  // 使 timer、进行中的 ctx.compact 回调和缓存失败全部失效。ctx.compact 本身
  // 不可取消；epoch 让旧 session/reload 的回调不再触碰已经失效的 context。
  const cancelCompactionRetry = (expectedEpoch?: number) => {
    // A stale timer/callback must never clear a newer retry's state.
    if (expectedEpoch !== undefined && expectedEpoch !== compactionRetryEpoch) return;
    compactionRetryEpoch += 1;
    if (compactionRetryTimer) clearTimeout(compactionRetryTimer);
    compactionRetryTimer = undefined;
    pendingCompactionFailure = undefined;
    compactionRetryActive = false;
  };

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

  // Pi emits `before_agent_start` only for a real accepted prompt; auto-retry and a
  // `sendUserMessage(..., {deliverAs: "steer"})` continuation use agent.continue() and do
  // not emit it. Therefore it is the task boundary, with no speculative pending flag.
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    currentContext = ctx;
    const autoRestoreEnabled = getConfig().autoRestore === true;
    state.chain = [];
    state.consecutive = 0;
    providers.resetTransientState();
    if (!autoRestoreEnabled) {
      state.original = null;
      state.resetsAt = undefined;
    }

    if (!autoRestoreEnabled || !state.original || !state.resetsAt) return;
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

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    currentContext = ctx;
    // bindExtensions happens after the host bridge is installed; handshake here rather than
    // extension factory time so each session obtains only its own EventBus transport.
    requestHostTransport();
    // 主 Pi 使用真实 session id；agent-team 子进程保留父进程注入的 id。
    if (process.env.MODEL_FAILBACK_CHILD !== "1") {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (sessionId) {
        bans.setSessionId(sessionId);
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
    extensionActive = false;
    cancelCompactionRetry();
    if (event.reason === "quit") await bans.endSession();
  });

  // Pi 没有可取消的 model_select 事件；仅能在用户选择后立即纠正，并用守卫防递归。
  pi.on("model_select", async (event, ctx: ExtensionContext) => {
    if (state.restoreInProgress || redirectingBlockedSelection || event.source === "restore") return;
    currentContext = ctx;
    await bans.refresh();
    const selected = event.model;
    if (bans.isBlocked(modelKey(selected.provider, selected.id))) {
      await redirectBlockedModel(ctx, selected.provider, selected.id, "manual-select");
    }
  });

  const handleTerminalFailure = async (
    message: unknown,
    ctx: ExtensionContext,
    options: { steer: boolean },
  ): Promise<boolean> => {
    const fail = extractFailure(message);
    if (!fail) return false;

    const provider = fail.provider ?? ctx.model?.provider;
    const handler = providers.get(provider);
    if (!handler) return false; // 未注册的 provider:保持现状,不外扩行为

    const verdict = handler.inspect(message);
    if (!verdict) return false;

    const attemptId = `${Date.now()}-${++lifecycleSequence}`;
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
    // A hosted session without an active request is a hard refusal, not a terminal fallback.
    if (hostTransport && !hostTransport.begin(attemptId)) return false;
    emitLifecycle({ version: 1, phase: "start", attemptId, sessionId });
    let lifecycleDetails: Pick<FailbackLifecycleEvent, "from" | "to" | "reason"> | undefined;
    let lifecycleFinished = false;
    const finishLifecycle = (outcome: FailbackLifecycleEvent["outcome"]) => {
      if (lifecycleFinished) return;
      lifecycleFinished = true;
      try {
        emitLifecycle({ version: 1, phase: "end", attemptId, sessionId, outcome, ...lifecycleDetails });
      } finally {
        hostTransport?.end(attemptId);
      }
    };
    try {
    if (cancelled(ctx)) {
      finishLifecycle("cancelled");
      return false;
    }

    // 错误文案通常不带倒计时；只对已确认的终态 best-effort 查询 provider
    // 的额度窗口。查询最多等待共享获取器的 8 秒超时；失败保持未知但仍继续 failback。
    let resetsAt = verdict.resetsAt;
    if (resetsAt === undefined) {
      try {
        resetsAt = await handler.resolveResetsAt?.(verdict, ctx.modelRegistry, ctx.signal);
      } catch {
        // Resolution is best-effort; still close the lifecycle through the normal path.
      }
    }
    if (cancelled(ctx)) {
      finishLifecycle("cancelled");
      return false;
    }

    const sourceProvider = typeof provider === "string" ? provider : "unknown";
    const currentModel = (fail.model as string) ?? ctx.model?.id;
    if (typeof currentModel !== "string") {
      finishLifecycle("failed");
      return false;
    }
    const prevKey = modelKey(sourceProvider, currentModel);

    // 先持久化精确模型 ban；即使后续没有可用 fallback，下一个 subagent 也不会再撞它。
    let banRecorded = false;
    try {
      await bans.mark(prevKey, {
        scope: verdict.scope,
        reason: verdict.reason,
        note: verdict.note,
        markedAt: Date.now(),
        resetsAt,
      });
      banRecorded = true;
      pi.appendEntry("model-failback-ban", {
        key: prevKey,
        reason: verdict.reason,
        scope: verdict.scope,
        resetsAt,
        at: Date.now(),
      });
    } catch {
      // 持久化失败不能阻断当前会话 failback；仅失去跨 subagent 的预跳过能力。
      ctx.ui.notify(`[model-failback] 无法持久化 ${prevKey} 的 ban,本次仍继续 failback`, "warning");
    }
    // `message_end` handlers are async: an abort can happen while ban persistence waits.
    // Never change model or queue a continuation after that boundary.
    if (cancelled(ctx)) {
      finishLifecycle("cancelled");
      return false;
    }

    const target = resolveAvailableTarget(getConfig(), bans, sourceProvider, currentModel, verdict.scope);
    if (!target) {
      ctx.ui.notify(
        `[model-failback] ${prevKey} 终态,但链上没有未 ban 的 fallback,任务将中断`,
        "error",
      );
      finishLifecycle("no-target");
      return false;
    }

    lifecycleDetails = { from: prevKey, to: target.target, reason: verdict.reason };

    // ---- 环检测:目标已在当前 failback 链中出现过,拒绝成环切换 ----
    if (state.chain.includes(target.target)) {
      ctx.ui.notify(
        `[model-failback] 检测到切换环: ${target.target} 已在此链失败过,停止 failback,任务将中断`,
        "error",
      );
      finishLifecycle("no-target");
      return false;
    }

    // ---- 连跳上限 ----
    const maxConsecutive = getConfig().maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE;
    if (state.consecutive >= maxConsecutive) {
      ctx.ui.notify(
        `[model-failback] 已达连跳上限(${maxConsecutive}),停止 failback,任务将中断`,
        "error",
      );
      finishLifecycle("no-target");
      return false;
    }

    // ---- 切换 ----
    if (cancelled(ctx)) {
      finishLifecycle("cancelled");
      return false;
    }
    if (!(await setTargetModel(pi, ctx, target))) {
      finishLifecycle(cancelled(ctx) ? "cancelled" : "failed");
      return false;
    }
    if (cancelled(ctx)) {
      finishLifecycle("cancelled");
      return false;
    }

    // ---- 台账 ----------------
    if (state.chain.length === 0) state.chain.push(prevKey);
    state.chain.push(target.target);
    state.consecutive += 1;
    state.lastFallbackAt = Date.now();
    if (state.original === null) {
      // original/resetsAt 是同一份“最初耗尽模型”的恢复快照。autoRestore
      // 开启时绝不能被 B→C 的备用模型额度时间覆盖，否则会过早切回 A。
      state.original = { provider: sourceProvider, model: currentModel };
      state.resetsAt = resetsAt;
    } else if (getConfig().autoRestore !== true && resetsAt) {
      // 未开启自动恢复时保留既有 status 语义：展示最近一次终态的恢复估计。
      state.resetsAt = resetsAt;
    }

    const failureReason = verdict.note ?? verdict.reason;
    // Persist the exact internal continuation alongside its extension marker. This gives hosts a
    // durable custom-entry association instead of guessing from a user-message prefix.
    const continuation = `[model-failback] 之前的模型(${prevKey})发生终态错误(${failureReason})。` +
      `已切换到备用模型(${target.target}),请继续完成之前的任务,不要重复已完成的步骤。`;
    // The marker is the durable association that makes this internal steering message
    // recognizable to history consumers. If it cannot be written, fail closed: keep the
    // already-persisted Pi model projection, but never queue an unrecognizable continuation.
    try {
      pi.appendEntry("model-failback", {
        from: prevKey,
        to: target.target,
        reason: verdict.reason,
        continuation,
        banRecorded,
        resetsAt,
        at: Date.now(),
      });
    } catch {
      ctx.ui.notify("[model-failback] 无法持久化 failback 标记；已切换模型，但不会自动续跑", "error");
      finishLifecycle("failed");
      return false;
    }

    const restoreHint = resetsAt
      ? `预计 ${new Date(resetsAt).toLocaleTimeString()} 恢复(/failback status 查看)`
      : "";
    ctx.ui.notify(
      `⚠️ [model-failback] ${prevKey} 终态错误(${failureReason}) → 已切换 ${target.target}。${restoreHint}`,
      "warning",
    );

    if (options.steer) {
      if (cancelled(ctx)) {
        finishLifecycle("cancelled");
        return false;
      }
      try {
        // ExtensionAPI.sendUserMessage is void. Hosted mode awaits the public SDK steer API
        // through the bridge so queue_update/abort races are acknowledged before lifecycle end.
        const accepted = hostTransport
          ? await hostTransport.enqueue(continuation)
          : (pi.sendUserMessage(continuation, { deliverAs: "steer" }), true);
        if (!accepted || cancelled(ctx)) {
          finishLifecycle("cancelled");
          return false;
        }
      } catch {
        finishLifecycle(cancelled(ctx) ? "cancelled" : "failed");
        return false;
      }
    }
    finishLifecycle("switched");
    return true;
    } finally {
      // No extension failure (including appendEntry) may leave the host abort lock open.
      finishLifecycle("failed");
    }
  };

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    currentContext = ctx;
    await handleTerminalFailure(event.message, ctx, { steer: true });
  });

  const finishCompactionRetry = (epoch: number, continueFailedChain: boolean) => {
    if (!extensionActive || epoch !== compactionRetryEpoch) return;
    const next = continueFailedChain ? pendingCompactionFailure : undefined;
    pendingCompactionFailure = undefined;
    if (!next) {
      compactionRetryActive = false;
      return;
    }
    // 上一次 compact 已经 onError；下一个宏任务才处理它的终态，
    // 不与 Pi 的失败 catch/finally 或上一次 compact 的回调重入。成功完成时
    // 必须丢弃并发期间重复的源失败，不能错误地产生一次环检测。
    compactionRetryTimer = setTimeout(() => {
      compactionRetryTimer = undefined;
      void retryCompaction(next, epoch);
    }, 0);
  };

  const retryCompaction = async (
    failure: { errorMessage: string; ctx: ExtensionContext; provider: string; model: string; retryCompact: boolean },
    epoch: number,
  ) => {
    if (!extensionActive || epoch !== compactionRetryEpoch) return;
    if (cancelled(failure.ctx)) {
      cancelCompactionRetry(epoch);
      return;
    }
    let switched = false;
    try {
      switched = await handleTerminalFailure(
        {
          role: "assistant",
          stopReason: "error",
          provider: failure.provider,
          model: failure.model,
          errorMessage: failure.errorMessage,
        },
        failure.ctx,
        { steer: false },
      );
    } catch {
      if (extensionActive && epoch === compactionRetryEpoch) {
        failure.ctx.ui.notify("[model-failback] 处理压缩终态失败，未重试压缩", "error");
      }
    }
    if (!extensionActive || epoch !== compactionRetryEpoch) return;
    if (!switched || !failure.retryCompact) {
      finishCompactionRetry(epoch, false);
      return;
    }

    // session_compact_failed 仍在原 compact 的 catch/finally 收尾过程中。
    // 延迟到宏任务边界，避免与共享的 compaction abort controller 重入。
    compactionRetryTimer = setTimeout(() => {
      compactionRetryTimer = undefined;
      if (!extensionActive || epoch !== compactionRetryEpoch) return;
      if (cancelled(failure.ctx)) {
        cancelCompactionRetry(epoch);
        return;
      }
      // threshold/overflow 压缩失败后 Pi 可能已开始下一次 agent 请求；manual
      // /compact 也可能在用户立即发消息后走到这里。绝不 abort 正在进行的请求。
      if (!failure.ctx.isIdle()) {
        failure.ctx.ui.notify("[model-failback] 已有新请求开始，跳过自动重试压缩", "warning");
        finishCompactionRetry(epoch, false);
        return;
      }
      failure.ctx.compact({
        onComplete: () => {
          if (!extensionActive || epoch !== compactionRetryEpoch) return;
          failure.ctx.ui.notify("[model-failback] 已使用备用模型重新压缩上下文", "info");
          finishCompactionRetry(epoch, false);
        },
        onError: (error) => {
          if (!extensionActive || epoch !== compactionRetryEpoch) return;
          failure.ctx.ui.notify(`[model-failback] 备用模型压缩仍失败: ${error.message}`, "error");
          finishCompactionRetry(epoch, true);
        },
      });
    }, 0);
  };

  // A cancelled hosted request must not use compaction as a back door into another provider call.
  pi.on("session_before_compact", (event, ctx: ExtensionContext) => {
    if (cancelled(ctx) || event.signal.aborted) {
      cancelCompactionRetry();
      return { cancel: true };
    }
  });

  pi.on("session_compact_failed", async (event, ctx: ExtensionContext) => {
    if (event.aborted) {
      cancelCompactionRetry();
      return;
    }
    if (!event.errorMessage || !extensionActive) return;
    const current = ctx.model;
    if (!current) return;
    const failure = {
      errorMessage: event.errorMessage,
      ctx,
      provider: current.provider,
      model: current.id,
      // 只有用户显式 /compact 可以安全地在失败收尾后重试；threshold/overflow
      // 会由 Pi 后续的上下文检查处理，不能手动 compact 以免 abort 新请求。
      retryCompact: event.reason === "manual",
    };
    if (compactionRetryActive) {
      // 当前 retry 的 onError 会在 Pi 发出该事件之后执行；先缓存，届时再沿链继续。
      pendingCompactionFailure = failure;
      return;
    }

    compactionRetryActive = true;
    const epoch = ++compactionRetryEpoch;
    await retryCompaction(failure, epoch);
  });

  /**
   * 模型侧行为故障（非 provider 终态）的接管入口。
   *
   * thinking-breaker 发现某模型反复复读后发出 `thinking-breaker:escalate`；
   * 这里负责把它变成一次真正的模型切换。之所以放在 failback 里而不是让
   * thinking-breaker 自己切：ban 持久化、链解析、环检测、连跳上限都属于本
   * 扩展的职责，复制一份必然与 quota 路径分叉。
   *
   * 与终态失败的区别：
   *   - 只标记精确模型（scope 用 "cross-provider"，与额度耗尽同样的路由语义）
   *   - 不依赖 `stopReason === "error"`，因为复读是以 abort 收尾的
   *   - 成功后必须**自己**发续跑指令：abort 已经结束了原 agent run
   *   - 写入 `resetsAt` 冷却期，避免同会话内无限连跳
   */
  const handleBehaviorEscalation = async (
    req: ThinkingBreakerEscalateRequest,
    ctx: ExtensionContext,
  ): Promise<ThinkingBreakerEscalateReply> => {
    if (!extensionActive) return { ok: false, message: "extension 已停用" };
    const current = ctx.model;
    if (!current) return { ok: false, message: "当前没有模型" };

    const currentKey = modelKey(current.provider, current.id);
    // 请求方看到的模型与当前模型不一致（用户已手动切换）：交给新模型重试即可。
    if (currentKey !== req.key) {
      return { ok: false, message: `当前模型已是 ${currentKey}，无需切换` };
    }

    const resetsAt = Date.now() + BEHAVIOR_BAN_COOLDOWN_MS;
    try {
      await bans.mark(currentKey, {
        scope: "cross-provider",
        reason: BEHAVIOR_BAN_REASON,
        note: req.note,
        markedAt: Date.now(),
        resetsAt,
      });
      pi.appendEntry("model-failback-ban", {
        key: currentKey,
        reason: BEHAVIOR_BAN_REASON,
        scope: "cross-provider",
        resetsAt,
        at: Date.now(),
      });
    } catch {
      ctx.ui.notify(`[model-failback] 无法持久化 ${currentKey} 的行为 ban，仍继续切换`, "warning");
    }

    const target = resolveAvailableTarget(getConfig(), bans, current.provider, current.id, "cross-provider");
    if (!target) {
      ctx.ui.notify(
        `[model-failback] ${currentKey} 反复复读，但链上没有未 ban 的 fallback，任务将中断`,
        "error",
      );
      return { ok: false, message: "链上没有可用 fallback" };
    }

    // 环检测与连跳上限：复读升级属于同一类“换模型继续”，必须共享同一套护栏。
    if (state.chain.includes(target.target)) {
      ctx.ui.notify(
        `[model-failback] 复读升级成环：${target.target} 已在此链失败过，停止切换`,
        "error",
      );
      return { ok: false, message: "检测到切换环" };
    }
    const maxConsecutive = getConfig().maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE;
    if (state.consecutive >= maxConsecutive) {
      ctx.ui.notify(
        `[model-failback] 已达连跳上限(${maxConsecutive})，停止复读升级`,
        "error",
      );
      return { ok: false, message: "已达连跳上限" };
    }

    if (!(await setTargetModel(pi, ctx, target))) {
      return { ok: false, message: `切换到 ${target.target} 失败` };
    }

    if (state.chain.length === 0) state.chain.push(currentKey);
    state.chain.push(target.target);
    state.consecutive += 1;
    state.lastFallbackAt = Date.now();
    if (state.original === null) {
      state.original = { provider: current.provider, model: current.id };
    }

    const continuation =
      `[model-failback] 之前的模型(${currentKey})反复复读同一段思考、无法产出结果。` +
      `已切换到备用模型(${target.target})，请继续完成之前的任务，不要重复已完成的步骤。`;
    try {
      pi.appendEntry("model-failback", {
        from: currentKey,
        to: target.target,
        reason: BEHAVIOR_BAN_REASON,
        continuation,
        resetsAt,
        at: Date.now(),
      });
    } catch {
      ctx.ui.notify(
        "[model-failback] 无法持久化复读升级标记；已切换模型，但不会自动续跑",
        "error",
      );
      return { ok: false, message: "无法持久化标记" };
    }

    ctx.ui.notify(
      `🔁 [model-failback] ${currentKey} 反复复读思考 → 已切换 ${target.target}。` +
      `该模型冷却 ${Math.round(BEHAVIOR_BAN_COOLDOWN_MS / 60000)} 分钟`,
      "warning",
    );

    try {
      const accepted = hostTransport
        ? await hostTransport.enqueue(continuation)
        : (pi.sendUserMessage(continuation, { deliverAs: "steer" }), true);
      if (!accepted) return { ok: false, message: "续跑消息未被接受" };
    } catch {
      return { ok: false, message: "续跑消息发送失败" };
    }

    return { ok: true, switchedTo: target.target };
  };

  pi.events?.on(THINKING_BREAKER_ESCALATE_EVENT, (payload: unknown) => {
    const req = payload as ThinkingBreakerEscalateRequest | undefined;
    if (!req || req.version !== 1 || typeof req.accept !== "function") return;
    const ctx = currentContext;
    if (!ctx) {
      req.accept({ ok: false, message: "当前没有可用上下文" });
      return;
    }
    void (async () => {
      try {
        req.accept(await handleBehaviorEscalation(req, ctx));
      } catch (error) {
        req.accept({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  return state;
}
