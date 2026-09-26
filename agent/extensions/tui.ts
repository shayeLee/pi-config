import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface CacheStats {
	/** Cache hit rate of the most recent assistant message. Undefined when that message has no prompt tokens. */
	latestAssistantPercent: number | undefined;
	cumulativeRead: number;
	cumulativeWrite: number;
	/** Cache hit rate over assistant + branch_summary + compaction usage. Undefined when the denominator is 0. */
	cumulativePercent: number | undefined;
}

interface UsageStats {
	totals: UsageTotals;
	cache: CacheStats;
}

interface FooterField {
	key: string;
	text: string;
}

type ContextColor = "error" | "warning" | "text" | "dim";

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(value: unknown): UsageTotals | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const cost = record.cost && typeof record.cost === "object" ? (record.cost as Record<string, unknown>) : undefined;
	return {
		input: numberOrZero(record.input),
		output: numberOrZero(record.output),
		cacheRead: numberOrZero(record.cacheRead),
		cacheWrite: numberOrZero(record.cacheWrite),
		cost: numberOrZero(cost?.total),
	};
}

function addTotals(target: UsageTotals, usage: UsageTotals): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cost += usage.cost;
}

// Single pass over the active branch. Cache-hit numbers come from assistant messages and from
// branch_summary/compaction entries; toolResult and standalone usage entries still contribute to
// token and cost totals (but never to CH/ΣCH).
function computeUsageStats(entries: readonly SessionEntry[]): UsageStats {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestAssistantPercent: number | undefined;
	let cumulativePrompt = 0;
	let cumulativeRead = 0;
	let cumulativeWrite = 0;

	const addCacheSample = (usage: UsageTotals): void => {
		cumulativePrompt += usage.input + usage.cacheRead + usage.cacheWrite;
		cumulativeRead += usage.cacheRead;
		cumulativeWrite += usage.cacheWrite;
	};

	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message as { role?: string; usage?: unknown } | undefined;
			if (!message || typeof message !== "object") continue;
			const usage = readUsage(message.usage);
			if (!usage) continue;
			if (message.role === "assistant") {
				addTotals(totals, usage);
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				latestAssistantPercent = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
				addCacheSample(usage);
			} else if (message.role === "toolResult") {
				addTotals(totals, usage);
			}
		} else if (entry.type === "usage") {
			const usage = readUsage(entry.usage);
			if (usage) addTotals(totals, usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			const usage = readUsage(entry.usage);
			if (!usage) continue;
			addTotals(totals, usage);
			addCacheSample(usage);
		}
	}

	return {
		totals,
		cache: {
			latestAssistantPercent,
			cumulativeRead,
			cumulativeWrite,
			cumulativePercent: cumulativePrompt > 0 ? (cumulativeRead / cumulativePrompt) * 100 : undefined,
		},
	};
}

function formatUsageFields(stats: UsageStats): FooterField[] {
	const fields: FooterField[] = [];
	const { totals, cache } = stats;
	if (totals.input) fields.push({ key: "in", text: `↑${formatTokens(totals.input)}` });
	if (totals.output) fields.push({ key: "out", text: `↓${formatTokens(totals.output)}` });
	if (totals.cacheRead) fields.push({ key: "read", text: `R${formatTokens(totals.cacheRead)}` });
	if (totals.cacheWrite) fields.push({ key: "write", text: `W${formatTokens(totals.cacheWrite)}` });
	const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	if (total) fields.push({ key: "sum", text: `Σ${formatTokens(total)}` });
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && cache.latestAssistantPercent !== undefined) {
		fields.push({ key: "ch", text: `CH${cache.latestAssistantPercent.toFixed(1)}%` });
	}
	if ((cache.cumulativeRead > 0 || cache.cumulativeWrite > 0) && cache.cumulativePercent !== undefined) {
		fields.push({ key: "sumch", text: `ΣCH${cache.cumulativePercent.toFixed(1)}%` });
	}
	if (totals.cost) fields.push({ key: "cost", text: `$${totals.cost.toFixed(3)}` });
	return fields;
}

function buildContextField(
	usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
	model: { contextWindow?: number } | undefined,
): { text: string; color: ContextColor } {
	if (usage && usage.tokens != null && usage.percent != null) {
		const color: ContextColor = usage.percent > 90 ? "error" : usage.percent > 70 ? "warning" : "text";
		return { text: `${usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`, color };
	}
	const window = usage?.contextWindow ?? model?.contextWindow;
	if (window !== undefined) return { text: `?/${formatTokens(window)}`, color: "dim" };
	return { text: "ctx ?", color: "dim" };
}

function block(theme: any, background: string, foreground: string, text: string): string {
	return theme.bg(background, theme.fg(foreground, ` ${text} `));
}

// Deterministic degradation ladder for the stats/model line. Left fields are dropped least
// valuable first (Σ and R/W, then the xp marker, cost and the token arrows) while the right side
// loses the provider prefix and then the thinking level. CH/ΣCH/context survive the longest.
const LEFT_DROP_STAGES: readonly (readonly string[])[] = [
	[],
	[],
	["sum"],
	["sum", "read", "write"],
	["sum", "read", "write"],
	["sum", "read", "write", "xp"],
	["sum", "read", "write", "xp", "cost"],
	["sum", "read", "write", "xp", "cost", "in", "out"],
];
const RIGHT_STAGE: readonly number[] = [0, 1, 1, 1, 2, 2, 2, 2];
const MIN_LEFT_BUDGET = 6;

function fitTwoSided(left: string, right: string, width: number): string | undefined {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + rightWidth + 1 > width) return undefined;
	return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

function composeLine(
	width: number,
	fields: readonly FooterField[],
	rightVariants: readonly string[],
	modelLabel: string,
	tpsSuffix: string,
	styleModel: (text: string) => string,
	ellipsis: string,
): string {
	if (width <= 0) return "";

	for (let stage = 0; stage < LEFT_DROP_STAGES.length; stage++) {
		const dropped = new Set(LEFT_DROP_STAGES[stage]);
		const left = fields
			.filter((field) => !dropped.has(field.key))
			.map((field) => field.text)
			.join(" ");
		const fitted = fitTwoSided(left, rightVariants[RIGHT_STAGE[stage]], width);
		if (fitted !== undefined) return fitted;
	}

	// Nothing fits: keep the model id and TPS, truncate everything else with an explicit ellipsis.
	const compactDropped = new Set(LEFT_DROP_STAGES[LEFT_DROP_STAGES.length - 1]);
	const leftCompact = fields
		.filter((field) => !compactDropped.has(field.key))
		.map((field) => field.text)
		.join(" ");
	const tpsWidth = visibleWidth(tpsSuffix);
	let right: string;
	if (width - 2 >= tpsWidth) {
		right = styleModel(truncateToWidth(modelLabel, width - 2 - tpsWidth, ellipsis) + tpsSuffix);
	} else {
		right = truncateToWidth(styleModel(modelLabel + tpsSuffix), width, ellipsis);
	}
	const rightWidth = visibleWidth(right);
	const leftBudget = width - rightWidth - 1;
	if (leftBudget < MIN_LEFT_BUDGET) return right;
	const left = truncateToWidth(leftCompact, leftBudget, ellipsis);
	return left + " ".repeat(Math.max(0, width - visibleWidth(left) - rightWidth)) + right;
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
	// Context usage and cumulative usage stats are expensive to compute, so they are cached here
	// and only refreshed once per final settlement (agent_settled). Render never walks the branch.
	// Undefined means "not computed yet"; the cache is cleared on session/tree/compact/model changes.
	let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	let usageStats: UsageStats | undefined;
	// Session name is read once per session (getSessionName walks all entries); session_info_changed
	// updates it directly so render never triggers a full history scan.
	let sessionName: string | undefined;

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

	pi.on("session_info_changed", (event) => {
		sessionName = event.name;
		activeTui?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		contextUsage = undefined;
		usageStats = undefined;
		sessionName = undefined;
		if (ctx.mode !== "tui") return;
		sessionName = ctx.sessionManager.getSessionName();

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
					if (sessionName) pwd += ` • ${sessionName}`;

					const thinking = model?.reasoning
						? ctx.thinkingLevel && ctx.thinkingLevel !== "off"
							? ` • ${ctx.thinkingLevel}`
							: " • thinking off"
						: "";
					const modelLabel = model?.id || "no-model";
					const providerPrefix = footerData.getAvailableProviderCount() > 1 && model ? `(${model.provider}) ` : "";
					const tpsSuffix = ` • ${tpsText}`;

					const styleModel = (text: string) => block(theme, "selectedBg", "accent", text);
					const rightVariants = [
						styleModel(`${providerPrefix}${modelLabel}${thinking}${tpsSuffix}`),
						styleModel(`${modelLabel}${thinking}${tpsSuffix}`),
						styleModel(`${modelLabel}${tpsSuffix}`),
					];

					const context = buildContextField(contextUsage, model);
					const fields: FooterField[] = [];
					if (usageStats) {
						for (const field of formatUsageFields(usageStats)) {
							fields.push({ key: field.key, text: theme.fg("dim", field.text) });
						}
					}
					fields.push({ key: "ctx", text: theme.fg(context.color, context.text) });
					if (process.env.PI_EXPERIMENTAL === "1") {
						fields.push({
							key: "xp",
							text: `${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`,
						});
					}

					const line = composeLine(
						width,
						fields,
						rightVariants,
						modelLabel,
						tpsSuffix,
						styleModel,
						theme.fg("dim", "..."),
					);

					const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")), line];
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

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		usageStats = computeUsageStats(ctx.sessionManager.getBranch());
		const usage = ctx.getContextUsage();
		contextUsage = usage
			? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
			: undefined;
		activeTui?.requestRender();
	});

	// Cache invalidation only clears state and re-renders; it never calls getBranch/getContextUsage.
	const invalidateAll = () => {
		usageStats = undefined;
		contextUsage = undefined;
		activeTui?.requestRender();
	};

	pi.on("session_tree", invalidateAll);
	pi.on("session_compact", invalidateAll);
	pi.on("model_select", () => {
		contextUsage = undefined;
		activeTui?.requestRender();
	});
	pi.on("thinking_level_select", () => activeTui?.requestRender());
	pi.on("turn_end", () => activeTui?.requestRender());
}
