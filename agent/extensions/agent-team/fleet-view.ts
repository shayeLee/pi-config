import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1000l";

export function parseMouseWheel(data: string): -1 | 1 | undefined {
	const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1], 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction === 0) return -1;
		if (direction === 1) return 1;
		return undefined;
	}

	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction === 0) return -1;
		if (direction === 1) return 1;
	}
	return undefined;
}

export type FleetRunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface FleetUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface FleetRun {
	id: string;
	mode: "single" | "parallel" | "chain";
	agent: string;
	task: string;
	messages: Message[];
	usage: FleetUsage;
	model?: string;
	status: FleetRunStatus;
	startedAt: number;
	endedAt?: number;
	stop: () => boolean;
}

export type RestoredFleetRun = Omit<FleetRun, "id" | "stop" | "status"> & {
	status: Exclude<FleetRunStatus, "running">;
};

type FleetListener = () => void;

export class FleetStore {
	private runs: FleetRun[] = [];
	private listeners = new Set<FleetListener>();
	private nextId = 1;

	add(run: Omit<FleetRun, "id" | "status" | "startedAt">): FleetRun {
		const entry: FleetRun = {
			...run,
			id: String(this.nextId++),
			status: "running",
			startedAt: Date.now(),
		};
		this.runs.push(entry);
		this.prune();
		this.notify();
		return entry;
	}

	restore(runs: RestoredFleetRun[]): void {
		const activeRuns = this.runs.filter((run) => run.status === "running");
		const restoredRuns: FleetRun[] = runs.slice(-32).map((run) => ({
			...run,
			id: String(this.nextId++),
			stop: () => false,
		}));
		this.runs = [...restoredRuns, ...activeRuns];
		this.prune();
		this.notify();
	}

	touch(): void {
		this.notify();
	}

	finish(run: FleetRun, status: Exclude<FleetRunStatus, "running">): void {
		if (run.status !== "running") return;
		run.status = status;
		run.endedAt = Date.now();
		this.notify();
	}

	stop(id: string): boolean {
		const run = this.runs.find((item) => item.id === id);
		if (!run || run.status !== "running") return false;
		return run.stop();
	}

	list(): readonly FleetRun[] {
		return this.runs;
	}

	clear(): void {
		this.runs = [];
		this.notify();
	}

	subscribe(listener: FleetListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private prune(): void {
		if (this.runs.length <= 32) return;
		const completed = this.runs.filter((run) => run.status !== "running");
		while (this.runs.length > 32 && completed.length > 0) {
			const oldest = completed.shift();
			if (!oldest) break;
			this.runs = this.runs.filter((run) => run !== oldest);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(startedAt: number, endedAt?: number): string {
	const seconds = Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function getStatusIcon(run: FleetRun, theme: Theme): string {
	switch (run.status) {
		case "running":
			return theme.fg("warning", "●");
		case "completed":
			return theme.fg("success", "✓");
		case "stopped":
			return theme.fg("warning", "■");
		case "interrupted":
			return theme.fg("warning", "◇");
		case "failed":
			return theme.fg("error", "✗");
	}
}

function getUsageText(run: FleetRun): string {
	const parts: string[] = [];
	if (run.usage.input) parts.push(`↑${formatTokens(run.usage.input)}`);
	if (run.usage.output) parts.push(`↓${formatTokens(run.usage.output)}`);
	if (run.usage.cost) parts.push(`$${run.usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export class FleetWidget {
	private unsubscribe: () => void;
	private ticker: ReturnType<typeof setInterval>;

	constructor(
		private store: FleetStore,
		private tui: TUI,
		private theme: Theme,
	) {
		this.unsubscribe = store.subscribe(() => tui.requestRender());
		this.ticker = setInterval(() => {
			const now = Date.now();
			if (
				this.store
					.list()
					.some((run) => run.status === "running" || (run.endedAt !== undefined && now - run.endedAt <= 16_000))
			) {
				this.tui.requestRender();
			}
		}, 1000);
		this.ticker.unref?.();
	}

	render(width: number): string[] {
		const now = Date.now();
		const visibleRuns = this.store
			.list()
			.filter((run) => run.status === "running" || now - (run.endedAt ?? now) < 15_000)
			.slice(-6);
		if (visibleRuns.length === 0) return [];

		const running = visibleRuns.filter((run) => run.status === "running").length;
		const lines = [
			truncateToWidth(
				`${this.theme.fg("borderMuted", "── ")}${this.theme.fg("toolTitle", this.theme.bold("Fleet"))}${this.theme.fg("dim", `  ${running} running · Ctrl+Alt+F`)}`,
				width,
			),
		];
		for (const run of visibleRuns) {
			const usage = getUsageText(run);
			const meta = `${run.model ? `${run.model} · ` : ""}${formatDuration(run.startedAt, run.endedAt)}${usage ? ` · ${usage}` : ""}`;
			const prefix = `${getStatusIcon(run, this.theme)} ${this.theme.fg("accent", `#${run.id}`)} ${this.theme.fg("toolTitle", run.agent)} `;
			const suffix = this.theme.fg("dim", `  ${meta}`);
			const available = Math.max(8, width - visibleWidth(prefix) - visibleWidth(suffix));
			const task = this.theme.fg("muted", truncateToWidth(singleLine(run.task), available, "…"));
			lines.push(truncateToWidth(`${prefix}${task}${suffix}`, width));
		}
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.ticker);
		this.unsubscribe();
	}
}

function toolResultText(message: Extract<Message, { role: "toolResult" }>): string {
	const text = message.content.map((part) => (part.type === "text" ? part.text : `[${part.type} output]`)).join("\n");
	if (text.length <= 50_000) return text;
	return `${text.slice(0, 50_000)}\n\n[tool result truncated in FleetView]`;
}

function formatToolArguments(args: unknown): string {
	try {
		const text = JSON.stringify(args);
		if (!text) return "";
		return text.length > 500 ? `${text.slice(0, 500)}…` : text;
	} catch {
		return "";
	}
}

function buildConversation(run: FleetRun, width: number, theme: Theme): string[] {
	const container = new Container();
	const markdownTheme = getMarkdownTheme();
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(new Markdown(run.task, 1, 0, markdownTheme));

	for (const message of run.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim()) {
					container.addChild(new Text(theme.fg("accent", "Assistant"), 0, 1));
					container.addChild(new Markdown(part.text, 1, 0, markdownTheme));
				} else if (part.type === "toolCall") {
					const args = formatToolArguments(part.arguments);
					container.addChild(
						new Text(
							theme.fg("warning", "▶ ") + theme.fg("toolTitle", part.name) + (args ? theme.fg("dim", ` ${args}`) : ""),
							1,
							0,
						),
					);
				}
			}
		} else if (message.role === "toolResult") {
			const icon = message.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			container.addChild(new Text(`${icon} ${theme.fg("toolTitle", `${message.toolName} result`)}`, 1, 0));
			container.addChild(new Text(theme.fg("toolOutput", toolResultText(message)), 2, 0));
		}
	}

	return container.render(Math.max(10, width));
}

class FleetOverlay {
	private selectedId?: string;
	private view: "list" | "conversation" = "list";
	private offsetFromBottom = 0;
	private confirmStopId?: string;
	private unsubscribe: () => void;
	private ticker: ReturnType<typeof setInterval>;
	private mouseTrackingEnabled = false;

	constructor(
		private store: FleetStore,
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private openWebUi: (runId: string) => Promise<void>,
		private reportError: (message: string) => void,
	) {
		this.selectedId = this.sortedRuns()[0]?.id;
		this.unsubscribe = store.subscribe(() => tui.requestRender());
		this.ticker = setInterval(() => tui.requestRender(), 1000);
		this.ticker.unref?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.view === "conversation") {
				this.view = "list";
				this.offsetFromBottom = 0;
				this.confirmStopId = undefined;
				this.disableMouseTracking();
			} else {
				this.done();
			}
			this.tui.requestRender();
			return;
		}

		const runs = this.sortedRuns();
		const selectedIndex = Math.max(
			0,
			runs.findIndex((run) => run.id === this.selectedId),
		);
		const wheel = parseMouseWheel(data);
		if (wheel !== undefined && this.view === "conversation") {
			if (wheel < 0) {
				this.offsetFromBottom += 2;
			} else {
				this.offsetFromBottom = Math.max(0, this.offsetFromBottom - 2);
			}
			this.tui.requestRender();
			return;
		}
		if (this.view === "list") {
			if (matchesKey(data, "up") || matchesKey(data, "ctrl+p") || data === "k") {
				this.selectedId = runs[Math.max(0, selectedIndex - 1)]?.id;
				this.confirmStopId = undefined;
			} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n") || data === "j") {
				this.selectedId = runs[Math.min(runs.length - 1, selectedIndex + 1)]?.id;
				this.confirmStopId = undefined;
			} else if (matchesKey(data, "return") && this.selectedId) {
				void this.openWebUi(this.selectedId)
					.then(() => this.done())
					.catch((error: unknown) => this.reportError(`Could not open Fleet web UI: ${error instanceof Error ? error.message : String(error)}`));
			} else if (data === "i" && this.selectedId) {
				this.view = "conversation";
				this.offsetFromBottom = 0;
				this.enableMouseTracking();
			} else if (data === "x") {
				this.requestStop();
			}
		} else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p") || data === "k") {
			this.offsetFromBottom += 1;
		} else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n") || data === "j") {
			this.offsetFromBottom = Math.max(0, this.offsetFromBottom - 1);
		} else if (matchesKey(data, "pageUp")) {
			this.offsetFromBottom += 10;
		} else if (matchesKey(data, "pageDown")) {
			this.offsetFromBottom = Math.max(0, this.offsetFromBottom - 10);
		} else if (matchesKey(data, "home")) {
			this.offsetFromBottom = Number.MAX_SAFE_INTEGER;
		} else if (matchesKey(data, "end")) {
			this.offsetFromBottom = 0;
		} else if (data === "x") {
			this.requestStop();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 2);
		const body = this.view === "list" ? this.renderList(innerWidth) : this.renderConversation(innerWidth);
		return this.box(body, innerWidth);
	}

	invalidate(): void {}

	dispose(): void {
		this.disableMouseTracking();
		clearInterval(this.ticker);
		this.unsubscribe();
	}

	private disableMouseTracking(): void {
		if (!this.mouseTrackingEnabled) return;
		this.tui.terminal.write(DISABLE_MOUSE_TRACKING);
		this.mouseTrackingEnabled = false;
	}

	private enableMouseTracking(): void {
		if (this.mouseTrackingEnabled) return;
		this.tui.terminal.write(ENABLE_MOUSE_TRACKING);
		this.mouseTrackingEnabled = true;
	}

	private sortedRuns(): FleetRun[] {
		return [...this.store.list()].sort((a, b) => {
			if (a.status === "running" && b.status !== "running") return -1;
			if (a.status !== "running" && b.status === "running") return 1;
			return b.startedAt - a.startedAt || Number(b.id) - Number(a.id);
		});
	}

	private requestStop(): void {
		if (!this.selectedId) return;
		const run = this.store.list().find((item) => item.id === this.selectedId);
		if (!run || run.status !== "running") return;
		if (this.confirmStopId === run.id) {
			this.store.stop(run.id);
			this.confirmStopId = undefined;
		} else {
			this.confirmStopId = run.id;
		}
	}

	private renderList(width: number): string[] {
		const runs = this.sortedRuns();
		const maxVisible = Math.max(1, Math.floor((this.tui.terminal.rows * 0.75 - 6) / 2));
		const selectedIndex = Math.max(
			0,
			runs.findIndex((run) => run.id === this.selectedId),
		);
		const start = Math.min(
			Math.max(0, selectedIndex - Math.floor(maxVisible / 2)),
			Math.max(0, runs.length - maxVisible),
		);
		const visibleRuns = runs.slice(start, start + maxVisible);
		const range = runs.length > maxVisible ? this.theme.fg("dim", `  ${start + 1}-${start + visibleRuns.length} of ${runs.length}`) : "";
		const lines = [this.theme.fg("accent", this.theme.bold("Subagent Fleet")) + range, ""];
		if (runs.length === 0) {
			lines.push(this.theme.fg("dim", "No subagents have run in this session."));
		} else {
			for (const run of visibleRuns) {
				const selected = run.id === this.selectedId;
				const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
				const usage = getUsageText(run);
				const meta = `${run.status}${run.model ? ` · ${run.model}` : ""} · ${formatDuration(run.startedAt, run.endedAt)}${usage ? ` · ${usage}` : ""}`;
				const label = `${getStatusIcon(run, this.theme)} #${run.id} ${run.agent}  ${singleLine(run.task)}`;
				const line = `${prefix}${selected ? this.theme.bg("selectedBg", this.theme.fg("text", label)) : label}`;
				lines.push(truncateToWidth(line, width, "…"));
				lines.push(truncateToWidth(`    ${this.theme.fg("dim", meta)}`, width));
			}
		}
		lines.push("");
		if (this.confirmStopId) {
			lines.push(this.theme.fg("warning", `Press x again to stop #${this.confirmStopId}`));
		} else {
			lines.push(this.theme.fg("dim", "↑↓/jk/Ctrl+P,N select · Enter web UI · i inspect here · x stop · Esc close"));
		}
		return lines;
	}

	private renderConversation(width: number): string[] {
		const run = this.store.list().find((item) => item.id === this.selectedId);
		if (!run) {
			this.view = "list";
			return this.renderList(width);
		}

		const height = Math.max(8, Math.floor(this.tui.terminal.rows * 0.75) - 5);
		const transcript = buildConversation(run, width, this.theme);
		const maxOffset = Math.max(0, transcript.length - height);
		const offset = Math.min(this.offsetFromBottom, maxOffset);
		this.offsetFromBottom = offset;
		const start = Math.max(0, transcript.length - height - offset);
		const visible = transcript.slice(start, start + height);
		const usage = getUsageText(run);
		const meta = `${run.status}${run.model ? ` · ${run.model}` : ""} · ${formatDuration(run.startedAt, run.endedAt)}${usage ? ` · ${usage}` : ""}`;
		const header = `${getStatusIcon(run, this.theme)} ${this.theme.fg("accent", `#${run.id}`)} ${this.theme.fg("toolTitle", this.theme.bold(run.agent))} ${this.theme.fg("dim", meta)}`;
		const lines = [truncateToWidth(header, width), this.theme.fg("borderMuted", "─".repeat(width)), ...visible];
		lines.push(this.theme.fg("borderMuted", "─".repeat(width)));
		if (this.confirmStopId) {
			lines.push(this.theme.fg("warning", `Press x again to stop #${this.confirmStopId}`));
		} else {
			lines.push(this.theme.fg("dim", "↑↓/jk/Ctrl+P,N/trackpad scroll · Home/End jump · PgUp/PgDn · x stop · Esc back"));
		}
		return lines;
	}

	private box(lines: string[], innerWidth: number): string[] {
		const pad = (text: string) => {
			const clipped = truncateToWidth(text, innerWidth, "");
			return clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		};
		return [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			...lines.map((line) => `${this.theme.fg("border", "│")}${pad(line)}${this.theme.fg("border", "│")}`),
			this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		];
	}
}

export async function showFleetOverlay(
	ctx: ExtensionContext,
	store: FleetStore,
	openWebUi: (runId: string) => Promise<void>,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Subagent Fleet requires TUI mode", "error");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
		new FleetOverlay(store, tui, theme, done, openWebUi, (message) => ctx.ui.notify(message, "error")),
	{
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "85%",
			minWidth: 60,
			maxHeight: "85%",
			margin: 1,
		},
	});
}
