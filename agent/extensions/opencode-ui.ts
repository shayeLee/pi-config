import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
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

					for (const entry of ctx.sessionManager.getEntries() as any[]) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const usage = (entry.message as AssistantMessage).usage;
							totals.input += usage.input;
							totals.output += usage.output;
							totals.cacheRead += usage.cacheRead;
							totals.cacheWrite += usage.cacheWrite;
							totals.cost += usage.cost.total;
							const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
							latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							const usage = entry.message.usage;
							totals.input += usage.input ?? 0;
							totals.output += usage.output ?? 0;
							totals.cacheRead += usage.cacheRead ?? 0;
							totals.cacheWrite += usage.cacheWrite ?? 0;
							totals.cost += usage.cost?.total ?? 0;
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							const usage = entry.usage;
							totals.input += usage.input ?? 0;
							totals.output += usage.output ?? 0;
							totals.cacheRead += usage.cacheRead ?? 0;
							totals.cacheWrite += usage.cacheWrite ?? 0;
							totals.cost += usage.cost?.total ?? 0;
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
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined)
						stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
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
