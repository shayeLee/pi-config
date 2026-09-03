import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

interface FooterUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readFooterUsage(value: unknown): FooterUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Record<string, unknown>;
	const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : undefined;
	return {
		input: numberOrZero(usage.input),
		output: numberOrZero(usage.output),
		cacheRead: numberOrZero(usage.cacheRead),
		cacheWrite: numberOrZero(usage.cacheWrite),
		cost: numberOrZero(cost?.total),
	};
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const fromHome = relative(resolvedHome, resolvedCwd);
	const insideHome =
		fromHome === "" ||
		(fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
	return insideHome ? (fromHome === "" ? "~" : `~${sep}${fromHome}`) : cwd;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function block(theme: any, background: string, foreground: string, text: string): string {
	return theme.bg(background, theme.fg(foreground, ` ${text} `));
}

export default function (pi: ExtensionAPI) {
	let activeTui: { requestRender(): void } | undefined;
	const CHARS_PER_TOKEN = 4;
	const TPS_THROTTLE_MS = 250;
	const MIN_TPS_WINDOW_MS = 250;
	const MAX_DISPLAY_TPS = 1000;
	let firstDeltaAt: number | undefined;
	let deltaChars = 0;
	let lastTpsRefreshAt = 0;
	let tpsTimer: ReturnType<typeof setTimeout> | undefined;
	let tpsText = "0 tok/s";

	function resetTpsMeasurement() {
		firstDeltaAt = undefined;
		deltaChars = 0;
		lastTpsRefreshAt = performance.now();
		if (tpsTimer !== undefined) {
			clearTimeout(tpsTimer);
			tpsTimer = undefined;
		}
	}

	function calculateTps(tokens: number, startedAt: number, now = performance.now()): number | undefined {
		const elapsed = now - startedAt;
		if (elapsed < 0) return undefined;
		const effectiveElapsed = Math.max(elapsed, MIN_TPS_WINDOW_MS);
		return Math.min(MAX_DISPLAY_TPS, Math.round(tokens / (effectiveElapsed / 1000)));
	}

	function estimateTps(): number | undefined {
		if (firstDeltaAt === undefined) return undefined;
		return calculateTps(deltaChars / CHARS_PER_TOKEN, firstDeltaAt);
	}

	function scheduleTpsRefresh() {
		if (tpsTimer !== undefined) return;
		const now = performance.now();
		const delay = Math.max(0, TPS_THROTTLE_MS - (now - lastTpsRefreshAt));
		tpsTimer = setTimeout(() => {
			tpsTimer = undefined;
			lastTpsRefreshAt = performance.now();
			const tps = estimateTps();
			if (tps !== undefined && tps > 0) {
				tpsText = `~${tps} tok/s`;
				activeTui?.requestRender();
			}
		}, delay);
	}

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		resetTpsMeasurement();
		tpsText = "0 tok/s";
		activeTui?.requestRender();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const eventType = event.assistantMessageEvent;
		if (eventType.type !== "text_delta" && eventType.type !== "thinking_delta" && eventType.type !== "toolcall_delta") return;

		const length = (eventType as { delta: string }).delta.length;
		if (length <= 0) return;
		if (firstDeltaAt === undefined) firstDeltaAt = performance.now();
		deltaChars += length;
		scheduleTpsRefresh();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		if (tpsTimer !== undefined) {
			clearTimeout(tpsTimer);
			tpsTimer = undefined;
		}

		const outputTokens = event.message.usage?.output ?? 0;
		if (firstDeltaAt === undefined || outputTokens <= 0) {
			tpsText = "0 tok/s";
			resetTpsMeasurement();
			activeTui?.requestRender();
			return;
		}

		const tps = calculateTps(outputTokens, firstDeltaAt);
		tpsText = tps === undefined ? "0 tok/s" : `${tps} tok/s`;
		resetTpsMeasurement();
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", () => resetTpsMeasurement());

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribe();
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const model = ctx.model;
					let pwd = formatCwd(ctx.sessionManager.getCwd());
					const branch = footerData.getGitBranch();
					if (branch) pwd += ` (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd += ` • ${sessionName}`;

					const totals = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
					};
					let latestCacheHitRate: number | undefined;
					let cachePromptTokens = 0;
					let cacheReadTokens = 0;
					let cacheWriteTokens = 0;

					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message") {
							const message = entry.message;
							if (!message || typeof message !== "object") continue;
							const usage = readFooterUsage("usage" in message ? message.usage : undefined);
							if (!usage) continue;

							if (message.role === "assistant") {
								totals.input += usage.input;
								totals.output += usage.output;
								totals.cacheRead += usage.cacheRead;
								totals.cacheWrite += usage.cacheWrite;
								totals.cost += usage.cost;
								const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
								latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
								cachePromptTokens += promptTokens;
								cacheReadTokens += usage.cacheRead;
								cacheWriteTokens += usage.cacheWrite;
							} else if (message.role === "toolResult") {
								totals.input += usage.input;
								totals.output += usage.output;
								totals.cacheRead += usage.cacheRead;
								totals.cacheWrite += usage.cacheWrite;
								totals.cost += usage.cost;
							}
						} else if (entry.type === "branch_summary" || entry.type === "compaction") {
							const usage = readFooterUsage(entry.usage);
							if (!usage) continue;
							totals.input += usage.input;
							totals.output += usage.output;
							totals.cacheRead += usage.cacheRead;
							totals.cacheWrite += usage.cacheWrite;
							totals.cost += usage.cost;
							cachePromptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
							cacheReadTokens += usage.cacheRead;
							cacheWriteTokens += usage.cacheWrite;
						}
					}

					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? model?.contextWindow ?? 0;
					const contextDisplay =
						context?.percent == null ? `?/${formatTokens(contextWindow)}` : `${context.percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
					const contextColor =
						context?.percent != null && context.percent > 90
							? "error"
							: context?.percent != null && context.percent > 70
								? "warning"
								: "text";

					const stats: string[] = [];
					if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
					const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
					if (totalTokens) stats.push(`Σ${formatTokens(totalTokens)}`);
					const cumulativeCacheHitRate = cachePromptTokens > 0 ? (cacheReadTokens / cachePromptTokens) * 100 : undefined;
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined)
						stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					if ((cacheReadTokens > 0 || cacheWriteTokens > 0) && cumulativeCacheHitRate !== undefined)
						stats.push(`ΣCH${cumulativeCacheHitRate.toFixed(1)}%`);
					if (totals.cost || model?.provider === "kimi-coding")
						stats.push(`$${totals.cost.toFixed(3)}${model?.provider === "kimi-coding" ? " (sub)" : ""}`);
					stats.push(theme.fg(contextColor, contextDisplay));
					if (process.env.PI_EXPERIMENTAL === "1")
						stats.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);

					const statsText = theme.fg("dim", stats.join(" "));
					const thinking = model?.reasoning
						? ctx.thinkingLevel && ctx.thinkingLevel !== "off"
							? ` • ${ctx.thinkingLevel}`
							: " • thinking off"
						: "";
					let modelText = model?.id || "no-model";
					if (footerData.getAvailableProviderCount() > 1 && model) modelText = `(${model.provider}) ${modelText}`;
					modelText += thinking;
					modelText += ` • ${tpsText}`;

					const modelBlock = block(theme, "selectedBg", "accent", modelText);
					const statsWidth = visibleWidth(statsText);
					const availableForModel = width - statsWidth - 2;
					let statsLine: string;
					if (availableForModel > 0) {
						const right = truncateToWidth(modelBlock, availableForModel, "");
						statsLine = statsText + " ".repeat(Math.max(0, width - statsWidth - visibleWidth(right))) + right;
					} else {
						statsLine = truncateToWidth(statsText, width, "");
					}

					const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), statsLine];
					const statuses = [...footerData.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatus(text))
						.filter(Boolean);
					if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
					return lines;
				},
			};
		});
	});

	pi.on("model_select", () => activeTui?.requestRender());
	pi.on("thinking_level_select", () => activeTui?.requestRender());
	pi.on("turn_end", () => activeTui?.requestRender());
}
