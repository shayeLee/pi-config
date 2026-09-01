/**
 * model-failback — 订阅额度终态后的会话内模型 failback(上下文不中断)
 *
 * 首个 provider:openai-codex(ChatGPT 订阅 backend 的 usage limit 终态)。
 * 扩展新 provider:见 providers/ 目录,实现 ProviderFailbackHandler 并注册。
 *
 * 配置(~/.pi/agent/model-failback.json):
 * {
 *   "fallbacks": {
 *     "openai-codex/gpt-5.6-terra": "modelscope/deepseek-ai/DeepSeek-V4-Pro-0813",
 *     "openai-codex/*":            "modelscope/deepseek-ai/DeepSeek-V4-Pro-0813"
 *   },
 *   "cooldownMs": 60000,
 *   "autoRestore": false
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PersistentBanStore } from "./core/ban-store";
import { createEngine } from "./core/engine";
import { loadConfig } from "./core/config";
import { supportedProviders } from "./providers/registry";

export default function modelFailback(pi: ExtensionAPI) {
  let config = loadConfig();
  const bans = new PersistentBanStore();

  // 必须早于 engine 注册:session_start 的 preflight 要读取本次刚更新的 chains。
  pi.on("session_start", () => {
    config = loadConfig();
  });
  const state = createEngine(pi, () => config, bans);

  // 只由主 Pi 在 session_start 执行一次孤儿 ban 文件 GC；worker 不扫描。
  pi.on("session_start", async () => {
    if (process.env.MODEL_FAILBACK_CHILD === "1") return;
    await bans.pruneOrphans(config.banFileTtlMs ?? 7 * 24 * 60 * 60_000);
  });

  pi.registerCommand("failback", {
    description: "model-failback 状态与恢复:status / restore / reset / unban",
    handler: async (args: string, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];
      const current = ctx.model;

      if (sub === "restore") {
        if (!state.original) {
          ctx.ui.notify("[model-failback] 没有待恢复的原模型", "info");
          return;
        }
        const original = ctx.modelRegistry.find(
          state.original.provider,
          state.original.model,
        );
        state.restoreInProgress = true;
        try {
          if (original && (await pi.setModel(original))) {
            ctx.ui.notify(
              `[model-failback] 已恢复 ${state.original.provider}/${state.original.model}`,
              "info",
            );
            state.consecutive = 0;
            state.resetsAt = undefined;
            state.chain = [];
            state.original = null;
          } else {
            ctx.ui.notify("[model-failback] 恢复失败(模型不在 registry 或无鉴权)", "error");
          }
        } finally {
          state.restoreInProgress = false;
        }
        return;
      }

      if (sub === "unban") {
        const key = tokens[1];
        if (!key) {
          ctx.ui.notify("[model-failback] 用法: /failback unban <provider/model>，或 /failback unban all", "error");
          return;
        }
        await bans.clear(key === "all" ? undefined : key);
        ctx.ui.notify(`[model-failback] 已解除 ban: ${key}`, "info");
        return;
      }

      if (sub === "reset") {
        state.consecutive = 0;
        state.lastFallbackAt = 0;
        state.original = null;
        state.resetsAt = undefined;
        state.chain = [];
        await bans.clear();
        ctx.ui.notify("[model-failback] 状态与所有 ban 已重置", "info");
        return;
      }

      // status(默认)
      await bans.refresh();
      const mappings = config.chains?.map((chain) => chain.join(" → "))
        ?? Object.entries(config.fallbacks).map(([k, v]) => `${k} → ${v}`);
      const blocked = bans.list()
        .map(({ key, record }) => `${key}(${record.reason}${record.resetsAt ? `,至${new Date(record.resetsAt).toLocaleTimeString()}` : ""})`)
        .join("; ");
      const lines = [
        `model-failback 支持 providers: ${supportedProviders().join(", ")}`,
        `当前模型: ${current ? `${current.provider}/${current.id}` : "none"}`,
        `fallback 映射: ${mappings.join("; ") || "无"}`,
        `已 ban(跨子进程): ${blocked || "无"}`,
        `连续切换: ${state.consecutive}`,
        `切换链: ${state.chain.join(" → ") || "无"}`,
        `原模型: ${state.original ? `${state.original.provider}/${state.original.model}` : "无"}`,
        `配额恢复估计: ${
          state.resetsAt ? new Date(state.resetsAt).toLocaleString() : "未知"
        }`,
      ].join("\n");
      ctx.ui.notify(lines, "info");
    },
  });
}