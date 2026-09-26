/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports two modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *
 * Both modes return a runId per subagent and are supervised through
 * subagent_wait / subagent_status / subagent_logs / subagent_steer / subagent_stop.
 * Sequencing is the caller's job: call subagent again with the previous result.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, StringEnum, type Message, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ModelRegistry,
	type SessionEntry,
	SettingsManager,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, type Component, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { BackgroundRunRegistry, type BackgroundRunRecord, type BackgroundRunStatus } from "./background-runs.ts";
import { FleetStore, RevisionCache, liveRowRevisionKey, type FleetRun, type FleetRunStatus, type FleetStreamingDelta, type FleetTouchKind, type RestoredFleetRun } from "./fleet-store.ts";
import { FleetWidget, showFleetOverlay } from "./fleet-view.ts";
import { FleetWebServer } from "./fleet-web.ts";

const MAX_PARALLEL_TASKS = 8;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_FLEET_TOOL_UPDATE_BYTES = 48 * 1024;
const MAX_FLEET_TRANSIENT_BYTES = 256 * 1024;
const MAX_FLEET_STREAMING_BYTES = 32 * 1024;
const MAX_FLEET_STREAMING_PARTS = 64;
const MAX_FLEET_STREAMING_DELTAS_BYTES = 64 * 1024;
const MAX_FLEET_STREAMING_DELTA_COUNT = 256;
const MAX_FLEET_TOOL_UPDATES = 64;
const STREAMING_DELTA_METADATA_BYTES = 64;
const FLEET_TRUNCATION_MARKER = "\n\n[Fleet live output truncated]";
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

/**
 * Renders a subagent tool row in the opencode style: subtle background + left rail.
 *
 * The shell wraps a component whose output is expensive to format: every line
 * goes through ANSI/CJK-aware `truncateToWidth` and `visibleWidth`, and a settled
 * tool row can hold dozens of lines. A transcript repaints on a timer, so a
 * static row re-formats all of its lines on every frame even though nothing
 * changed — the dominant cost in a render profile.
 *
 * `inner.render()` is therefore still called on every `render()` (a live child
 * can change without calling `invalidate()`), but the expensive per-line work is
 * skipped when the child's lines, the width and the styling are all unchanged. A
 * per-line cache built from the previous frame's lines keeps a one-line change to
 * re-formatting that one line. The caches hold only the current frame, so they
 * cannot grow with the length of the transcript.
 */
export class OpencodeToolShell implements Component {
	// Last frame's input snapshot and output, returned verbatim on a no-op frame.
	private cachedWidth = -1;
	private cachedStyle = "";
	private cachedInput: string[] = [];
	private cachedOutput: string[] = [];

	// Formatting result per input line for the frame just rendered. Bounded by the
	// number of lines in one frame, never by the number of frames.
	private lineCache = new Map<string, string>();
	private lineCacheKey = "";

	constructor(
		private readonly inner: Component,
		private readonly background: (text: string) => string,
		private readonly rail: (text: string) => string,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const contentWidth = Math.max(1, width - 2);
		// Always render the child: it may hold live state (a running run's status)
		// that changed since the last frame without an invalidate().
		const input = this.inner.render(contentWidth);
		// Styling arrives as opaque closures. Sampling them detects a theme or state
		// change even when the same component instance is reused.
		const style = `${this.background("\u0000")}\u0001${this.rail("\u0000")}`;

		if (width === this.cachedWidth && style === this.cachedStyle && sameLines(input, this.cachedInput)) {
			return this.cachedOutput;
		}

		const lineCacheKey = `${width}\u0001${contentWidth}\u0001${style}`;
		if (lineCacheKey !== this.lineCacheKey) {
			// Width or styling changed: every cached line was formatted for the old
			// geometry/style and must not be reused.
			this.lineCache.clear();
			this.lineCacheKey = lineCacheKey;
		}

		const previousLines = this.lineCache;
		const nextLines = new Map<string, string>();
		const output: string[] = new Array(input.length);
		for (let i = 0; i < input.length; i++) {
			const line = input[i];
			let rendered = previousLines.get(line);
			if (rendered === undefined) rendered = this.formatLine(line, contentWidth, width);
			nextLines.set(line, rendered);
			output[i] = rendered;
		}

		this.lineCache = nextLines;
		this.cachedWidth = width;
		this.cachedStyle = style;
		// Snapshot the child's lines: it may mutate and return the same array, so a
		// reference comparison would miss an in-place change.
		this.cachedInput = input.slice();
		this.cachedOutput = output;
		return output;
	}

	private formatLine(line: string, contentWidth: number, width: number): string {
		const clipped = truncateToWidth(line, contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return truncateToWidth(this.background(`${this.rail("│")} ${clipped}${padding}`), width, "");
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedStyle = "";
		this.cachedInput = [];
		this.cachedOutput = [];
		this.lineCache.clear();
		this.lineCacheKey = "";
		this.inner.invalidate();
	}
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function capFleetText(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: value.length > 0 };
	if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false };
	const marker = Buffer.byteLength(FLEET_TRUNCATION_MARKER) <= maxBytes ? FLEET_TRUNCATION_MARKER : "";
	const limit = maxBytes - Buffer.byteLength(marker);
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle)) <= limit) low = middle;
		else high = middle - 1;
	}
	return { text: value.slice(0, low) + marker, truncated: true };
}

function fleetToolUpdateBytes(update: { content: Array<{ type: string; text?: string }>; actualDiff?: string }): number {
	return update.content.reduce((total, part) => total + (part.text ? Buffer.byteLength(part.text) : 0), 0) + (update.actualDiff ? Buffer.byteLength(update.actualDiff) : 0);
}

function fleetToolContent(value: unknown, maxBytes: number): { content: Array<{ type: string; text?: string }>; truncated: boolean } {
	if (!Array.isArray(value)) return { content: [], truncated: false };
	let remaining = maxBytes;
	let truncated = false;
	const content: Array<{ type: string; text?: string }> = [];
	for (let index = 0; index < value.length; index++) {
		const part = value[index];
		if (content.length >= 64) {
			truncated = true;
			break;
		}
		if (part?.type !== "text") {
			content.push({ type: typeof part?.type === "string" ? part.type : "unknown" });
			continue;
		}
		const capped = capFleetText(typeof part.text === "string" ? part.text : "", remaining);
		content.push({ type: "text", text: capped.text });
		truncated ||= capped.truncated;
		remaining -= Buffer.byteLength(capped.text);
		if (remaining <= 0) {
			truncated ||= index < value.length - 1;
			break;
		}
	}
	return { content, truncated };
}

function fleetToolOutputText(content: Array<{ type: string; text?: string }> | undefined): string {
	return (content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

function isToolId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

function isToolName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function fleetActualEditDiff(result: unknown, maxBytes: number): { text?: string; truncated: boolean } {
	if (!isRecord(result) || !isRecord(result.details)) return { truncated: false };
	const candidate = typeof result.details.diff === "string" ? result.details.diff : typeof result.details.patch === "string" ? result.details.patch : undefined;
	if (candidate === undefined) return { truncated: false };
	const capped = capFleetText(candidate, maxBytes);
	return { text: capped.text, truncated: capped.truncated };
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinkingLevel?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	if (thinkingLevel) parts.push(`thinking:${thinkingLevel}`);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	expanded = false,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const formatValue = (value: unknown): string => {
		if (typeof value === "string") return value;
		if (value === undefined) return "...";
		if (value === null) return "null";
		if (Array.isArray(value)) return value.map(formatValue).join(", ");
		if (typeof value === "object") {
			return Object.entries(value)
				.map(([key, item]) => `${key}: ${formatValue(item)}`)
				.join(", ");
		}
		return String(value);
	};
	const formatField = (label: string, value: unknown, indent = "  ") => {
		const lines = formatValue(value).split("\n");
		let text = `\n${themeFg("dim", `${indent}${label}: `)}${themeFg("toolOutput", lines[0] || "")}`;
		for (const line of lines.slice(1)) {
			text += `\n${themeFg("dim", `${indent}  `)}${themeFg("toolOutput", line)}`;
		}
		return text;
	};
	const formatExpanded = (header: string, fields: Array<[string, unknown]>) =>
		header + fields.map(([label, value]) => formatField(label, value)).join("");

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			if (expanded) {
				const fields: Array<[string, unknown]> = [];
				if (args.timeout !== undefined) fields.push(["timeout", `${args.timeout}s`]);
				return formatExpanded(themeFg("muted", "$ ") + themeFg("toolOutput", command), fields);
			}
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (expanded) {
				const fields: Array<[string, unknown]> = [];
				if (offset !== undefined) fields.push(["offset", offset]);
				if (limit !== undefined) fields.push(["limit", limit]);
				return formatExpanded(themeFg("muted", "read ") + themeFg("accent", filePath), fields);
			}
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			if (expanded)
				return formatExpanded(
					themeFg("muted", "write ") + themeFg("accent", filePath),
					[["content", content]],
				);
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const header = themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
			if (!expanded) return header;

			let edits: unknown[] = Array.isArray(args.edits) ? args.edits : [];
			if (typeof args.edits === "string") {
				try {
					const parsed = JSON.parse(args.edits);
					if (Array.isArray(parsed)) edits = parsed;
				} catch {
					/* Keep invalid input empty, matching the tool's validation failure. */
				}
			}
			if (typeof args.oldText === "string" && typeof args.newText === "string") {
				edits = [...edits, { oldText: args.oldText, newText: args.newText }];
			}
			let text = formatExpanded(header, [["edits", `${edits.length} block${edits.length === 1 ? "" : "s"}`]]);
			for (let i = 0; i < edits.length; i++) {
				const edit = edits[i] as Record<string, unknown>;
				text += `\n${themeFg("dim", `  edit ${i + 1}:`)}`;
				if (edit.oldText !== undefined) text += formatField("oldText", edit.oldText, "    ");
				if (edit.newText !== undefined) text += formatField("newText", edit.newText, "    ");
			}
			return text;
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			if (expanded) {
				const fields: Array<[string, unknown]> = [];
				if (args.limit !== undefined) fields.push(["limit", args.limit]);
				return formatExpanded(themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath)), fields);
			}
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			const header = themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
			if (expanded && args.limit !== undefined) return formatExpanded(header, [["limit", args.limit]]);
			return header;
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			const header =
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`);
			if (expanded) {
				const fields: Array<[string, unknown]> = [];
				for (const name of ["glob", "ignoreCase", "literal", "context", "limit"]) {
					if (args[name] !== undefined) fields.push([name, args[name]]);
				}
				return formatExpanded(header, fields);
			}
			return header;
		}
		default: {
			const fields = Object.entries(args);
			if (expanded) return formatExpanded(themeFg("accent", toolName), fields);
			const argsStr = fields.map(([key, value]) => `${key}: ${formatValue(value)}`).join(", ");
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", argsStr ? ` ${preview}` : "");
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	runId?: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startedAt?: number;
	endedAt?: number;
}

interface SubagentDetails {
	// "chain" is no longer produced; it is retained so sessions recorded before
	// the chain mode was removed can still be restored and rendered.
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	// Run ids of background runs announced by `subagent`. Their live state is read
	// from FleetStore at render time (the store is already the single source of
	// truth for in-flight runs), so the announced row can show live status before
	// any durable result exists.
	liveRunIds?: string[];
}

/**
 * Optional hooks that let a caller run `runSingleAgent` without awaiting it.
 *
 * When supplied, the run is announced to the caller as soon as its subprocess
 * exists (`onSpawned`) so the main agent can query or stop it while it is still
 * running. Omitting the hooks preserves the original fully-awaiting behaviour.
 */
interface RunControlHooks {
	/** Called once the Fleet run and subprocess handle exist. */
	onSpawned?: (handle: {
		runId: string;
		stop: () => boolean;
		live: { messages: Message[] };
		controlSocketPath?: string;
		/**
		 * Cached one-line summary of the run's latest words, refreshed on semantic
		 * events only. Wait progress reads this instead of re-scanning the transcript
		 * on every tick.
		 */
		progressSummary?: () => string;
	}) => void;
	/** Control socket path injected into the child (B-s stage). */
	controlSocketPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function restoredUsage(value: unknown): UsageStats {
	const usage = isRecord(value) ? value : {};
	return {
		input: finiteNumber(usage.input),
		output: finiteNumber(usage.output),
		cacheRead: finiteNumber(usage.cacheRead),
		cacheWrite: finiteNumber(usage.cacheWrite),
		cost: finiteNumber(usage.cost),
		contextTokens: finiteNumber(usage.contextTokens),
		turns: finiteNumber(usage.turns),
	};
}

function restoredMessages(value: unknown): Message[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(message): message is Message =>
			isRecord(message) &&
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			Array.isArray(message.content),
	);
}

function restoredStatus(result: Record<string, unknown>): Exclude<FleetRunStatus, "running"> {
	if (result.stopReason === "stopped") return "stopped";
	if (result.exitCode === -1 || typeof result.exitCode !== "number") return "interrupted";
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") return "failed";
	return "completed";
}

function entryTimestamp(entry: SessionEntry): number {
	const timestamp = Date.parse(entry.timestamp);
	return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function restoredRun(
	result: unknown,
	mode: "single" | "parallel" | "chain",
	fallbackTimestamp: number,
): RestoredFleetRun | undefined {
	if (!isRecord(result) || typeof result.agent !== "string" || typeof result.task !== "string") return undefined;
	const messages = restoredMessages(result.messages);
	const firstMessageTimestamp = messages.length > 0 ? finiteNumber(messages[0].timestamp, fallbackTimestamp) : fallbackTimestamp;
	const startedAt = finiteNumber(result.startedAt, firstMessageTimestamp);
	const endedAt = Math.max(startedAt, finiteNumber(result.endedAt, fallbackTimestamp));
	return {
		mode,
		agent: result.agent,
		task: result.task,
		messages,
		usage: restoredUsage(result.usage),
		model: typeof result.model === "string" ? result.model : undefined,
		thinkingLevel: typeof result.thinkingLevel === "string" ? result.thinkingLevel : undefined,
		status: restoredStatus(result),
		startedAt,
		endedAt,
	};
}

function interruptedRunFromToolCall(
	args: unknown,
	fallbackTimestamp: number,
): RestoredFleetRun {
	const params = isRecord(args) ? args : {};
	let mode: "single" | "parallel" | "chain" = "single";
	let agent = typeof params.agent === "string" ? params.agent : "subagent";
	let task = typeof params.task === "string" ? params.task : "Interrupted subagent call without a final result";
	if (Array.isArray(params.tasks)) {
		mode = "parallel";
		agent = "parallel";
		task = `Interrupted parallel call with ${params.tasks.length} planned task${params.tasks.length === 1 ? "" : "s"}`;
	} else if (Array.isArray(params.chain)) {
		mode = "chain";
		agent = "chain";
		task = `Interrupted chain call with ${params.chain.length} planned step${params.chain.length === 1 ? "" : "s"}`;
	}
	return {
		mode,
		agent,
		task,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		status: "interrupted",
		startedAt: fallbackTimestamp,
		endedAt: fallbackTimestamp,
	};
}

function collectRestoredFleetRuns(entries: readonly SessionEntry[]): RestoredFleetRun[] {
	const restored: RestoredFleetRun[] = [];
	const completedToolCallIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") continue;
		completedToolCallIds.add(entry.message.toolCallId);
		const details = entry.message.details;
		if (!isRecord(details) || !Array.isArray(details.results)) continue;
		const mode = details.mode;
		if (mode !== "single" && mode !== "parallel" && mode !== "chain") continue;
		const fallbackTimestamp = finiteNumber(entry.message.timestamp, entryTimestamp(entry));
		for (const result of details.results) {
			const run = restoredRun(result, mode, fallbackTimestamp);
			if (run) restored.push(run);
		}
	}

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const fallbackTimestamp = finiteNumber(entry.message.timestamp, entryTimestamp(entry));
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.name !== "subagent" || completedToolCallIds.has(part.id)) continue;
			restored.push(interruptedRunFromToolCall(part.arguments, fallbackTimestamp));
		}
	}

	return restored.sort((a, b) => a.startedAt - b.startedAt);
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = msg.content
				.filter((part): part is Extract<(typeof msg.content)[number], { type: "text" }> => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function isStoppedResult(result: SingleResult): boolean {
	return result.stopReason === "stopped";
}

function getResultOutput(result: SingleResult): string {
	if (isStoppedResult(result)) {
		return getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(stopped before output)";
	}
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> }
	| { type: "toolResult"; name: string; text: string; isError: boolean };

function getDisplayItems(messages: Message[], includeToolResults = false): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		} else if (includeToolResults && msg.role === "toolResult") {
			const text = msg.content
				.map((part) => (part.type === "text" ? part.text : `[${part.type} output]`))
				.join("\n");
			items.push({ type: "toolResult", name: msg.toolName, text: text || "(no text output)", isError: msg.isError });
		}
	}
	return items;
}

/** The subagent's most recent assistant prose, clipped, or "" when it has none. */
function latestAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const summary = summarizeMessage(messages[i]);
		if (!summary || summary.startsWith("calling ") || summary.startsWith("finished ")) continue;
		return summary;
	}
	return "";
}

/**
 * One-line description of a single message, used for wait progress.
 *
 * `live.messages` holds whatever the subagent has emitted so far, so reading the
 * last entries shows the caller what the run is doing right now. Assistant text
 * is preferred over tool calls: it is what the subagent is actually saying, which
 * tells the caller more than the name of a tool it happens to be running. Tool
 * calls and results are used as a fallback when the run has not spoken yet.
 * Returns "" for an unrecognised shape so the caller can fall back.
 */
function summarizeMessage(message: unknown): string {
	if (!isRecord(message)) return "";
	const clip = (text: string): string => {
		const single = text.replace(/\s+/g, " ").trim();
		return single.length > 120 ? `${single.slice(0, 120)}…` : single;
	};
	if (message.role === "toolResult" && typeof message.toolName === "string") {
		return `finished ${message.toolName}`;
	}
	if (message.role === "assistant" && Array.isArray(message.content)) {
		// Assistant prose first: it is the subagent's own account of where it is.
		for (const part of message.content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
				const text = clip(part.text);
				if (text) return text;
			}
		}
		for (const part of message.content) {
			if (isRecord(part) && part.type === "toolCall" && typeof part.name === "string") {
				return `calling ${part.name}`;
			}
		}
	}
	return "";
}

/**
 * Projects a live FleetRun onto the SingleResult shape the announcement row
 * reads: agent, live status and live usage.
 *
 * The run's messages ride along untouched. The announcement row renders no tool
 * calls and no prose (see `announceOnly`), so nothing synthetic is fabricated
 * for it — a half-landed tool call must never make the two rows disagree about
 * what the run did.
 */
function fleetRunToSingleResult(run: FleetRun): SingleResult {
	const status = run.status;
	return {
		runId: run.id,
		agent: run.agent,
		agentSource: run.agentSource ?? "unknown",
		task: run.task,
		exitCode: status === "running" ? -1 : status === "completed" ? 0 : 1,
		messages: run.messages,
		stderr: "",
		usage: run.usage,
		model: run.model,
		thinkingLevel: run.thinkingLevel,
		stopReason: status === "running" ? undefined : status === "stopped" ? "stopped" : status,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
	};
}

/**
 * Live results for announced run ids, in announcement order; pruned ids drop out.
 *
 * Only runs started in this session qualify. A restored run reuses the id space,
 * so trusting an id alone would let an old transcript's runId resolve to an
 * unrelated restored run and render the wrong subagent.
 */
function liveFleetResults(runIds: readonly string[], fleetStore: FleetStore): SingleResult[] {
	const byId = new Map(
		fleetStore
			.list()
			.filter((run) => run.live)
			.map((run) => [run.id, run] as const),
	);
	const results: SingleResult[] = [];
	for (const id of runIds) {
		const run = byId.get(id);
		if (run) results.push(fleetRunToSingleResult(run));
	}
	return results;
}

/**
 * A live row that re-reads its run state when the durable state changes.
 *
 * The transcript constructs a tool row once, when the tool returns, and then
 * repaints that same component tree. A `subagent` row read once at construction
 * would therefore freeze at "no output" for the whole run. Re-reading the run
 * state inside `render()` is what keeps the row live; there is no subscription
 * because a Component has no dispose hook to unsubscribe from.
 *
 * Rebuilding the component on every repaint would be wasteful — the TUI repaints
 * far more often than the run's durable state changes. The built component is
 * therefore cached and only rebuilt when the revision of one of the runs this
 * row displays changes (durable events only: message boundaries, tool start/end,
 * run lifecycle) or the width changes. Keying on those runs rather than a global
 * counter means an unrelated run's message never rebuilds an already-finished
 * row. Per-token streaming deltas do not bump a run's revision, so they never
 * invalidate the cache either.
 */
class LiveSubagentRow implements Component {
	private cache = new RevisionCache<Component>();

	constructor(
		private readonly store: FleetStore,
		private readonly runIds: readonly string[],
		private readonly build: () => Component,
	) {}

	render(width: number): string[] {
		const component = this.cache.get(
			`${liveRowRevisionKey(this.store.list(), this.runIds)}:${width}`,
			this.build,
		);
		return component.render(width);
	}

	invalidate(): void {
		// Theme change or an explicit cache clear: rebuild on the next render.
		this.cache.clear();
	}
}

/**
 * Renders a subagent tool result.
 *
 * Shared by `subagent` and `subagent_wait`, which render different things on
 * purpose: `subagent` announces a run and shows only its live status, while
 * `subagent_wait` carries the settled record and shows the tool-call activity
 * and the final output. Rendering the activity in both rows would print the
 * same run twice in the transcript.
 *
 * Returns a component that re-reads the announced runs on every render, so a
 * running `subagent` row keeps its status live. The settled path is static and
 * is built once.
 */
function renderSubagentResult(
	result: AgentToolResult<SubagentDetails | undefined>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	isError: boolean,
	theme: Theme,
	fleetStore: FleetStore,
): Component {
	const rawDetails = result.details as SubagentDetails | undefined;
	const isLive = Boolean(rawDetails && rawDetails.results.length === 0 && rawDetails.liveRunIds?.length);
	if (!isLive) {
		return buildSubagentResultComponent(result, { expanded, isPartial }, isError, theme, fleetStore);
	}
	return new LiveSubagentRow(
		fleetStore,
		(rawDetails?.liveRunIds as string[] | undefined) ?? [],
		() => buildSubagentResultComponent(result, { expanded, isPartial }, isError, theme, fleetStore),
	);
}

function buildSubagentResultComponent(
	result: AgentToolResult<SubagentDetails | undefined>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	isError: boolean,
	theme: Theme,
	fleetStore: FleetStore,
): Component {
	// `subagent` carries no settled results when it announces background runs; its
	// live state lives in FleetStore. Project those runs onto SingleResult so the
	// existing single/parallel rendering below is reused unchanged. Falls back to
	// the plain announcement text when every announced run has been pruned.
	const rawDetails = result.details as SubagentDetails | undefined;
	const liveResults = rawDetails && rawDetails.results.length === 0 && (rawDetails.liveRunIds?.length ?? 0) > 0
		? liveFleetResults(rawDetails.liveRunIds as string[], fleetStore)
		: [];
	const details: SubagentDetails | undefined = rawDetails && liveResults.length > 0
		? { ...rawDetails, results: liveResults }
		: rawDetails;
	// `subagent` announces a run and carries no settled record; `subagent_wait`
	// renders that run's tool calls and prose when the caller collects it. Both
	// rows describing the same run the same way would duplicate one transcript, so
	// the announcement row is status only and leaves the detail to the wait row.
	const announceOnly = liveResults.length > 0;
	const hasRunningResult = details?.results.some((item) => item.exitCode === -1) ?? false;
	const hasFailedResult = details?.results.some((item) => item.exitCode !== -1 && isFailedResult(item)) ?? false;
	const resultBackground = isPartial || hasRunningResult
		? "toolPendingBg"
		: isError || hasFailedResult
			? "toolErrorBg"
			: "toolSuccessBg";
	const shell = (component: Component) =>
		new OpencodeToolShell(
			component,
			(s) => theme.bg(resultBackground, s),
			(s) => theme.fg("muted", s),
		);
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return shell(new Text(text?.type === "text" ? text.text : "(no output)", 0, 0));
	}

	const mdTheme = getMarkdownTheme();

	const getToolCalls = (items: DisplayItem[]) =>
		items.filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall");

	const formatActivitySummary = (items: DisplayItem[]) => {
		const calls = getToolCalls(items);
		const counts = new Map<string, number>();
		for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
		const breakdown = [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(" · ");
		return `${calls.length} call${calls.length === 1 ? "" : "s"}${breakdown ? ` · ${breakdown}` : ""}`;
	};

	const addSectionTitle = (container: Container, title: string, detail?: string) => {
		container.addChild(new Spacer(1));
		let text = theme.fg("muted", "── ");
		text += theme.fg("toolTitle", theme.bold(title));
		if (detail) text += theme.fg("dim", `  ${detail}`);
		container.addChild(new Text(text, 0, 0));
	};

	const addCollapsedActivity = (container: Container, items: DisplayItem[], limit: number) => {
		const calls = getToolCalls(items);
		if (calls.length === 0) return;

		addSectionTitle(container, "Activity", formatActivitySummary(calls));
		const toShow = calls.slice(-limit);
		const skipped = calls.length - toShow.length;
		if (skipped > 0) {
			container.addChild(new Text(theme.fg("dim", `… ${skipped} earlier calls`), 1, 0));
		}
		for (const call of toShow) {
			container.addChild(
				new Text(
					theme.fg("muted", "› ") + formatToolCall(call.name, call.args, theme.fg.bind(theme)),
					1,
					0,
				),
			);
		}
		if (skipped > 0) {
			container.addChild(new Text(theme.fg("muted", "Ctrl+O: inspect every call and result"), 1, 0));
		}
	};

	const addExpandedItems = (container: Container, items: DisplayItem[]) => {
		for (const item of items) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(
						theme.fg("accent", "▶ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme), true),
						1,
						0,
					),
				);
			} else if (item.type === "toolResult") {
				const label = `${item.isError ? "✗" : "✓"} ${item.name} result`;
				container.addChild(new Text(theme.fg(item.isError ? "error" : "success", label), 2, 0));
				container.addChild(new Text(theme.fg("toolOutput", item.text), 3, 0));
			}
		}
	};

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const isRunning = r.exitCode === -1;
		const isStopped = !isRunning && isStoppedResult(r);
		const isError = !isRunning && isFailedResult(r);
		const icon = isRunning
			? theme.fg("warning", "●")
			: isStopped
				? theme.fg("warning", "■")
				: isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isRunning) header += theme.fg("warning", "  running");
		if (isStopped) header += theme.fg("warning", "  stopped");
		else if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		const usageStr = formatUsageStats(r.usage, r.model, r.thinkingLevel);
		if (usageStr) header += theme.fg("dim", `  ${usageStr}`);
		const errorLine = Boolean(isError && !isStopped && r.errorMessage);

		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		if (errorLine) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));

		if (announceOnly) {
			// Status line only: expanding the row adds the task back, never the
			// activity the `subagent_wait` row will report.
			if (expanded) {
				addSectionTitle(container, "Task");
				container.addChild(new Text(theme.fg("dim", r.task), 1, 0));
			}
			return shell(container);
		}

		const displayItems = getDisplayItems(r.messages, expanded);
		const finalOutput = getFinalOutput(r.messages);

		if (expanded) {
			addSectionTitle(container, "Task");
			container.addChild(new Text(theme.fg("dim", r.task), 1, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", isRunning ? "starting…" : "(no output)"), 0, 0));
			} else {
				if (getToolCalls(displayItems).length > 0) {
					addSectionTitle(container, "Activity", formatActivitySummary(displayItems));
				}
				addExpandedItems(container, displayItems);
				if (finalOutput) {
					addSectionTitle(container, isRunning ? "Progress" : "Result");
					container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
				}
			}
			return shell(container);
		}

		if (errorLine) return shell(container);
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", isRunning ? "starting…" : "(no output)"), 1, 0));
			return shell(container);
		}

		addCollapsedActivity(container, displayItems, COLLAPSED_ITEM_COUNT);
		if (getToolCalls(displayItems).length > 0) {
			container.addChild(new Text(theme.fg("muted", "Ctrl+O: inspect every call and result"), 1, 0));
		}
		if (finalOutput) {
			addSectionTitle(container, isRunning ? "Progress" : "Result");
			container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
		}
		return shell(container);
	}

	const aggregateUsage = (results: SingleResult[]) => {
		const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		for (const r of results) {
			total.input += r.usage.input;
			total.output += r.usage.output;
			total.cacheRead += r.usage.cacheRead;
			total.cacheWrite += r.usage.cacheWrite;
			total.cost += r.usage.cost;
			total.turns += r.usage.turns;
		}
		return total;
	};

	if (details.mode === "parallel") {
		const running = details.results.filter((r) => r.exitCode === -1).length;
		const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
		const stoppedCount = details.results.filter(isStoppedResult).length;
		const failCount = details.results.filter(
			(r) => r.exitCode !== -1 && isFailedResult(r) && !isStoppedResult(r),
		).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: stoppedCount > 0
				? theme.fg("warning", "■")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount + stoppedCount}/${details.results.length} done, ${running} running`
			: `${successCount} completed${stoppedCount ? ` · ${stoppedCount} stopped` : ""}${failCount ? ` · ${failCount} failed` : ""}`;

		if (announceOnly) {
			// Same rule as the single branch: the announcement row carries the live
			// per-run status, and `subagent_wait` carries the activity.
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
					0,
					0,
				),
			);
			for (const r of details.results) {
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isStoppedResult(r)
							? theme.fg("warning", "■")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
				container.addChild(new Spacer(1));
				let line = `${theme.fg("muted", "── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				if (r.exitCode === -1) line += theme.fg("warning", "  running");
				container.addChild(new Text(line, 0, 0));
				if (expanded) {
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				}
			}
			return shell(container);
		}

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
					0,
					0,
				),
			);

			for (const r of details.results) {
				const rIcon = isStoppedResult(r)
					? theme.fg("warning", "■")
					: isFailedResult(r)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages, true);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

				if (getToolCalls(displayItems).length > 0) {
					addSectionTitle(container, "Activity", formatActivitySummary(displayItems));
				}
				addExpandedItems(container, displayItems);

				if (finalOutput) {
					addSectionTitle(container, "Result");
					container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
				}

				const taskUsage = formatUsageStats(r.usage, r.model, r.thinkingLevel);
				if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return shell(container);
		}

		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
		);
		for (const r of details.results) {
			const rIcon =
				r.exitCode === -1
					? theme.fg("warning", "⏳")
					: isStoppedResult(r)
						? theme.fg("warning", "■")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages);
			const finalOutput = getFinalOutput(r.messages);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(`${theme.fg("muted", "── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
			);
			addCollapsedActivity(container, displayItems, 5);
			if (finalOutput) {
				addSectionTitle(container, r.exitCode === -1 ? "Progress" : "Result");
				container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
			} else if (getToolCalls(displayItems).length === 0) {
				container.addChild(
					new Text(theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)"), 1, 0),
				);
			}
		}
		if (!isRunning) {
			const usageStr = formatUsageStats(aggregateUsage(details.results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
		}
		container.addChild(new Text(theme.fg("muted", "Ctrl+O: inspect every call and result"), 0, 0));
		return shell(container);
	}

	const text = result.content[0];
	return shell(new Text(text?.type === "text" ? text.text : "(no output)", 0, 0));
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const isPiCliScript = /pi-coding-agent[/\\]dist[/\\]cli\.js$/i.test(currentScript || "");
	if (currentScript && !isBunVirtualScript && isPiCliScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

const VALID_THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Start a subagent as a tracked background run.
 *
 * Shared by single and parallel modes. Resolves once the subprocess exists so
 * the returned runId is immediately usable. The run is deliberately NOT bound to
 * the parent's abort signal: a background run must outlive the tool call that
 * started it, and is stopped through subagent_stop instead.
 */
async function startBackgroundRun(
	backgroundRuns: BackgroundRunRegistry<SingleResult>,
	start: (control: RunControlHooks) => Promise<SingleResult>,
	describe: { agent: string; mode: "single" | "parallel"; task: string; agentScope: AgentScope; projectAgentsDir: string | null },
	onSettled: () => void,
): Promise<BackgroundRunRecord<SingleResult> | undefined> {
	let registered: BackgroundRunRecord<SingleResult> | undefined;
	let resolveSpawned: () => void = () => {};
	const spawned = new Promise<void>((resolve) => {
		resolveSpawned = resolve;
	});

	const promise = start({
		controlSocketPath: createControlSocketPath(),
		onSpawned: (handle) => {
			registered = backgroundRuns.register({
				runId: handle.runId,
				agent: describe.agent,
				mode: describe.mode,
				task: describe.task,
				agentScope: describe.agentScope,
				projectAgentsDir: describe.projectAgentsDir,
				status: "running",
				startedAt: Date.now(),
				stop: handle.stop,
				live: handle.live,
				progressSummary: handle.progressSummary,
				controlSocketPath: handle.controlSocketPath,
			});
			resolveSpawned();
		},
	});

	void promise.then(
		(result) => {
			const status: Exclude<BackgroundRunStatus, "running"> = isStoppedResult(result)
				? "stopped"
				: isFailedResult(result)
					? "failed"
					: "completed";
			if (registered) backgroundRuns.settle(registered.runId, result, status);
			onSettled();
		},
		() => {
			if (registered) backgroundRuns.settle(registered.runId, undefined, "failed");
			onSettled();
		},
	);

	// The subprocess is spawned asynchronously; wait for onSpawned so the
	// returned runId is usable immediately.
	await Promise.race([spawned, new Promise((r) => setTimeout(r, 15000))]);
	return registered;
}

/**
 * Absolute path to the control-channel extension injected into subagents.
 * Resolved relative to this file so the extension keeps working when the
 * agent-team directory is installed elsewhere.
 */
const CONTROL_EXT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "control-ext.js");

/**
 * Create a Unix domain socket path for a subagent control channel.
 *
 * The path must stay short: macOS caps AF_UNIX paths at ~104 bytes, so the
 * socket lives directly in the temp dir rather than inside a per-run subdir.
 * Returns undefined on Windows, where AF_UNIX is not available.
 */
function createControlSocketPath(): string | undefined {
	if (process.platform === "win32") return undefined;
	const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	return path.join(os.tmpdir(), `pi-subagent-ctl-${unique}.sock`);
}

/** Send one steering command to a running subagent's control socket. */
async function sendControlCommand(
	socketPath: string,
	command: { type: "steer" | "followUp"; message: string },
): Promise<{ ok: boolean; error?: string }> {
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (value: { ok: boolean; error?: string }) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let socket: import("node:net").Socket;
		try {
			socket = net.connect(socketPath);
		} catch (error) {
			finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		socket.setTimeout(5000);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify(command)}\n`, () => {
				socket.end();
				finish({ ok: true });
			});
		});
		socket.on("timeout", () => {
			socket.destroy();
			finish({ ok: false, error: "timed out connecting to the subagent control channel" });
		});
		socket.on("error", (error) => finish({ ok: false, error: error.message }));
	});
}

/** Resolve an exact agent model reference, preserving Pi's full-ID-first semantics. */
function resolveAgentModel(modelRef: string, modelRegistry: ModelRegistry): { model: Model<any>; thinkingLevel?: ModelThinkingLevel } | undefined {
	const models = modelRegistry.getAll();
	const findExact = (reference: string): Model<any> | undefined => {
		const normalized = reference.toLowerCase();
		const canonical = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalized);
		if (canonical.length === 1) return canonical[0];
		if (canonical.length > 1) return undefined;
		const bare = models.filter((model) => model.id.toLowerCase() === normalized);
		return bare.length === 1 ? bare[0] : undefined;
	};

	const exact = findExact(modelRef);
	if (exact) return { model: exact };

	const lastColon = modelRef.lastIndexOf(":");
	if (lastColon === -1) return undefined;
	const suffix = modelRef.slice(lastColon + 1);
	if (!VALID_THINKING_LEVELS.has(suffix)) return undefined;
	const base = findExact(modelRef.slice(0, lastColon));
	return base ? { model: base, thinkingLevel: suffix as ModelThinkingLevel } : undefined;
}

/** Mirror Pi's child-session startup resolution for unpinned agents. */
function resolveAgentThinkingLevel(
	agent: AgentConfig,
	modelRegistry: ModelRegistry,
	settings: SettingsManager,
): string | undefined {
	const explicit = VALID_THINKING_LEVELS.has(agent.thinkingLevel as ModelThinkingLevel)
		? (agent.thinkingLevel as ModelThinkingLevel)
		: undefined;
	if (!agent.model) return explicit;
	const resolved = resolveAgentModel(agent.model, modelRegistry);
	if (!resolved) return explicit;
	const requested = explicit ?? resolved.thinkingLevel ?? settings.getModelThinkingLevel(resolved.model.provider, resolved.model.id) ?? settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	return clampThinkingLevel(resolved.model, requested);
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Run one subagent to completion and return its result.
 *
 * Runs are never bound to a parent abort signal: every subagent is an
 * independent background run that outlives the tool call which started it and is
 * stopped explicitly through subagent_stop. Streaming progress reaches the UI
 * through FleetStore, not through a per-call update callback.
 */
async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	mode: "single" | "parallel",
	agentName: string,
	task: string,
	cwd: string | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	fleetStore: FleetStore,
	modelRegistry: ModelRegistry | undefined,
	projectTrusted: boolean | undefined,
	usageRootSessionId: string | undefined,
	failbackParentSessionId: string | undefined,
	control?: RunControlHooks,
): Promise<SingleResult> {
	const configuredAgent = agents.find((a) => a.name === agentName);

	if (!configuredAgent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const agent = modelRegistry
		? {
				...configuredAgent,
				thinkingLevel: resolveAgentThinkingLevel(
					configuredAgent,
					modelRegistry,
					SettingsManager.create(cwd ?? defaultCwd, getAgentDir(), { projectTrusted }),
				),
			}
		: configuredAgent;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// Control channel: only meaningful for runs the caller may steer, and only
	// where AF_UNIX exists. The socket file is created by the child.
	const controlSocketPath = control?.controlSocketPath;

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
	};
	let childProcess: ReturnType<typeof spawn> | null = null;
	let childPid: number | undefined;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
	let terminationStarted = false;
	let stopRequested = false;
	let settled = false;

	const clearForceKillTimerIfGroupGone = () => {
		if (process.platform === "win32" || !childPid || !forceKillTimer) return;
		try {
			process.kill(-childPid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				clearTimeout(forceKillTimer);
				forceKillTimer = undefined;
			}
		}
	};

	const sendTerminationSignal = (signal: NodeJS.Signals): boolean => {
		if (!childPid) return false;
		if (process.platform !== "win32") {
			try {
				// The detached child is the process-group leader. Its descendants remain addressable
				// by this PGID even after the leader itself has exited.
				process.kill(-childPid, signal);
				return true;
			} catch {
				return false; // ESRCH is the expected race when the entire group is already gone.
			}
		}
		try {
			// Best effort only: taskkill /T can miss descendants if the root process has
			// already exited. A reliable Windows tree lifetime requires a Job Object.
			const killer = spawn("taskkill.exe", ["/PID", String(childPid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			killer.on("error", () => childProcess?.kill(signal));
			killer.unref();
			return true;
		} catch {
			return childProcess?.kill(signal) ?? false;
		}
	};

	const terminateProcess = () => {
		if (terminationStarted || !childPid) return;
		terminationStarted = true;
		sendTerminationSignal("SIGTERM");
		forceKillTimer = setTimeout(() => {
			forceKillTimer = undefined;
			sendTerminationSignal("SIGKILL");
		}, 5000);
		clearForceKillTimerIfGroupGone();
	};

	const fleetRun = fleetStore.add({
		mode,
		agent: currentResult.agent,
		agentSource: currentResult.agentSource,
		task: currentResult.task,
		messages: currentResult.messages,
		toolUpdates: {},
		usage: currentResult.usage,
		model: currentResult.model,
		thinkingLevel: currentResult.thinkingLevel,
		stop: () => {
			if (settled || stopRequested) return false;
			stopRequested = true;
			terminateProcess();
			return true;
		},
	});
	currentResult.runId = fleetRun.id;
	currentResult.startedAt = fleetRun.startedAt;

	// Announce the run as soon as the Fleet entry exists. Background callers use
	// this to expose status/stop/logs before the subprocess has finished.
	control?.onSpawned?.({
		runId: fleetRun.id,
		stop: () => fleetStore.stop(fleetRun.id),
		live: { messages: currentResult.messages },
		controlSocketPath: control.controlSocketPath,
		progressSummary: () => progressSummary,
	});

	const clearStreamingDeltas = () => {
		fleetRun.streamingDeltas = [];
	};

	// Wait progress reads the subagent's latest words. Recomputing that by
	// scanning the whole transcript on every tick is wasteful for long runs, so
	// the summary is refreshed only when a semantic event (message_end / tool
	// start / tool end) actually changes the transcript. Deltas do not change
	// `messages`, so they never touch it. The wait tool reads it via
	// `RunControlHooks.progressSummary`.
	let progressSummary = "";
	const refreshProgressSummary = () => {
		const messages = currentResult.messages;
		progressSummary = latestAssistantText(messages) || summarizeMessage(messages[messages.length - 1]);
	};

	const deltaByteSize = (delta: FleetStreamingDelta): number => {
		let size = STREAMING_DELTA_METADATA_BYTES + ("text" in delta ? Buffer.byteLength(delta.text) : 0);
		if ("toolCallId" in delta) size += Buffer.byteLength(delta.toolCallId) + Buffer.byteLength(delta.toolName);
		return size;
	};

	const pushStreamingDelta = (delta: FleetStreamingDelta) => {
		// An oversized toolCallId/toolName is treated as malformed: drop the delta
		// and force a resync instead of truncating, because truncation would break
		// the identity the frontend uses to match blocks against toolUpdates.
		if ("toolCallId" in delta && (delta.toolCallId.length > 128 || delta.toolName.length > 64)) {
			clearStreamingDeltas();
			fleetRun.streamingReset++;
			return;
		}
		const bytes = deltaByteSize(delta);
		if (fleetRun.streamingDeltas.length >= MAX_FLEET_STREAMING_DELTA_COUNT) {
			clearStreamingDeltas();
			fleetRun.streamingReset++;
		}
		let total = 0;
		for (const item of fleetRun.streamingDeltas) total += deltaByteSize(item);
		if (bytes >= MAX_FLEET_STREAMING_DELTAS_BYTES || (fleetRun.streamingDeltas.length > 0 && total + bytes > MAX_FLEET_STREAMING_DELTAS_BYTES)) {
			clearStreamingDeltas();
			fleetRun.streamingReset++;
		}
		if (bytes < MAX_FLEET_STREAMING_DELTAS_BYTES) fleetRun.streamingDeltas.push(delta);
	};

	const updateFleetTool = (
		toolCallId: string,
		toolName: string,
		phase: "streaming" | "completed",
		result: unknown,
		isError = false,
	) => {
		if (!(toolCallId in fleetRun.toolUpdates) && Object.keys(fleetRun.toolUpdates).length >= MAX_FLEET_TOOL_UPDATES) return;
		const usedBytes = Object.entries(fleetRun.toolUpdates)
			.filter(([id]) => id !== toolCallId)
			.reduce((total, [, update]) => total + fleetToolUpdateBytes(update), 0);
		const remaining = Math.max(0, Math.min(MAX_FLEET_TOOL_UPDATE_BYTES, MAX_FLEET_TRANSIENT_BYTES - usedBytes));
		const diff = phase === "completed" ? fleetActualEditDiff(result, Math.min(16 * 1024, remaining)) : { truncated: false };
		const contentBudget = Math.max(0, remaining - (diff.text ? Buffer.byteLength(diff.text) : 0));
		const content = fleetToolContent(isRecord(result) ? result.content : undefined, contentBudget);
		const previousText = fleetToolOutputText(fleetRun.toolUpdates[toolCallId]?.content);
		fleetRun.toolUpdates[toolCallId] = {
			toolName,
			phase,
			content: content.content,
			isError,
			contentTruncated: content.truncated,
			actualDiffTruncated: diff.truncated,
			actualDiff: diff.text,
		};
		// Stream tool output deltas to the Web UI (partialResult is cumulative,
		// so diff against the previous snapshot; replace on truncation).
		if (phase === "streaming") {
			const newText = fleetToolOutputText(content.content);
			if (content.truncated || !newText.startsWith(previousText)) {
				pushStreamingDelta({ toolCallId, toolName, text: newText, replace: true });
			} else {
				const delta = newText.slice(previousText.length);
				if (delta) pushStreamingDelta({ toolCallId, toolName, text: delta });
			}
		}
	};

	const appendStreaming = (contentIndex: number, kind: "text" | "thinking", delta: string | undefined, full: string | undefined) => {
		if (!Number.isSafeInteger(contentIndex) || contentIndex < 0 || contentIndex >= MAX_FLEET_STREAMING_PARTS) return;
		const parts = fleetRun.streamingParts;
		while (parts.length <= contentIndex) parts.push({ type: "text", text: "" });
		const part = parts[contentIndex];
		part.type = kind;
		if (full !== undefined) {
			const capped = capFleetText(full, MAX_FLEET_STREAMING_BYTES);
			part.text = capped.text;
			part.truncated = capped.truncated;
			pushStreamingDelta({ index: contentIndex, type: kind, text: capped.text, replace: true });
			return;
		}
		if (!delta || part.truncated) return;
		if (Buffer.byteLength(part.text) + Buffer.byteLength(delta) > MAX_FLEET_STREAMING_BYTES) {
			const capped = capFleetText(part.text + delta, MAX_FLEET_STREAMING_BYTES);
			part.text = capped.text;
			part.truncated = true;
			pushStreamingDelta({ index: contentIndex, type: kind, text: capped.text, replace: true });
			return;
		}
		part.text += delta;
		pushStreamingDelta({ index: contentIndex, type: kind, text: delta });
	};

	const emitUpdate = (kind: FleetTouchKind = "semantic") => {
		fleetRun.model = currentResult.model;
		fleetRun.thinkingLevel = currentResult.thinkingLevel;
		if (kind === "semantic") refreshProgressSummary();
		fleetStore.touch(kind, fleetRun);
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// Inject the control extension so the parent can steer this run. Added after
		// the role's own flags so it is present even when the role restricts tools.
		if (controlSocketPath) {
			try {
				await fs.promises.access(CONTROL_EXT_PATH);
				args.push("-e", CONTROL_EXT_PATH);
			} catch {
				/* control extension missing: run without a control channel */
			}
		}

		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			// Child Pi has no hosted SessionManager. Propagate the invoking extension
			// context's session ID explicitly; process env is process-global and can
			// belong to another hosted session (or to a standalone CLI parent).
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					...(failbackParentSessionId
						? { MODEL_FAILBACK_SESSION_ID: failbackParentSessionId }
						: {}),
					...(usageRootSessionId ? { PI_USAGE_ROOT_SESSION_ID: usageRootSessionId } : {}),
					...(controlSocketPath ? { SUBAGENT_CONTROL_SOCKET: controlSocketPath } : {}),
					MODEL_FAILBACK_CHILD: "1",
				},
			});
			childProcess = proc;
			childPid = proc.pid;
			if (stopRequested) terminateProcess();
			let buffer = "";
			const durableToolResultIds = new Set<string>();
			const appendDurableMessage = (message: Message): boolean => {
				if (message.role === "toolResult") {
					if (durableToolResultIds.has(message.toolCallId)) return false;
					durableToolResultIds.add(message.toolCallId);
				}
				currentResult.messages.push(message);
				return true;
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (!event || typeof event !== "object" || Array.isArray(event)) return;

				// In-flight assistant text/thinking arrives as delta-only message_update
				// events. Accumulate them into transient state so the Web UI can show
				// live reasoning; message_end remains the durable authoritative message.
				if (event.type === "message_start") {
					fleetRun.streamingParts = [];
					clearStreamingDeltas();
					fleetRun.streamingReset++;
				}

				if (event.type === "message_update" && event.assistantMessageEvent) {
					const assistantEvent = event.assistantMessageEvent;
					const contentIndex = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : 0;
					switch (assistantEvent.type) {
						case "thinking_start":
							appendStreaming(contentIndex, "thinking", undefined, undefined);
							break;
						case "thinking_delta":
							appendStreaming(contentIndex, "thinking", typeof assistantEvent.delta === "string" ? assistantEvent.delta : "", undefined);
							break;
						case "thinking_end":
							appendStreaming(contentIndex, "thinking", undefined, typeof assistantEvent.content === "string" ? assistantEvent.content : undefined);
							break;
						case "text_start":
							appendStreaming(contentIndex, "text", undefined, undefined);
							break;
						case "text_delta":
							appendStreaming(contentIndex, "text", typeof assistantEvent.delta === "string" ? assistantEvent.delta : "", undefined);
							break;
						case "text_end":
							appendStreaming(contentIndex, "text", undefined, typeof assistantEvent.content === "string" ? assistantEvent.content : undefined);
							break;
					}
					emitUpdate("delta");
				}

				if (event.type === "message_end" && isRecord(event.message)) {
					const msg = event.message as Message;
					if (!appendDurableMessage(msg)) return;
					if (msg.role === "toolResult") {
						delete fleetRun.toolUpdates[msg.toolCallId];
						clearStreamingDeltas();
						fleetRun.streamingReset++;
					}

					if (msg.role === "assistant") {
						fleetRun.streamingParts = [];
						clearStreamingDeltas();
						fleetRun.streamingReset++;
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						// 子进程内 model-failback 会在同一任务中 setModel；以每条 assistant
						// message_end 的真实 provider/model 覆盖启动配置，Fleet UI 显示最终落点。
						if (typeof msg.provider === "string" && typeof msg.model === "string") {
							currentResult.model = `${msg.provider}/${msg.model}`;
						} else if (msg.model) {
							currentResult.model = msg.model;
						}
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				// The child may emit its resolved thinking level (set/clamped at startup
				// or during model failback). Prefer it as the authoritative final value;
				// otherwise the launch configuration stays in place.
				if (event.type === "thinking_level_changed" && typeof event.level === "string") {
					currentResult.thinkingLevel = event.level;
					emitUpdate();
				}

				// Both message_end and the legacy tool_result_end event can carry a durable
				// tool result. appendDurableMessage deduplicates them by toolCallId.
				// Tool execution events below are Fleet-only transient state and cannot
				// affect content or details.

				if (event.type === "tool_result_end" && isRecord(event.message)) {
					const msg = event.message as Message;
					if (appendDurableMessage(msg)) {
						if (msg.role === "toolResult") {
							delete fleetRun.toolUpdates[msg.toolCallId];
							clearStreamingDeltas();
							fleetRun.streamingReset++;
						}
						emitUpdate();
					}
				}

				if (event.type === "tool_execution_start" && isToolId(event.toolCallId)) {
					// Register the tool the moment it starts, with no output yet. Otherwise
					// a long-running tool is invisible until its first partial result, and a
					// tool that never streams output is invisible until it finishes.
					updateFleetTool(event.toolCallId, isToolName(event.toolName) ? event.toolName : "tool", "streaming", undefined);
					emitUpdate("semantic");
				}

				if (event.type === "tool_execution_update" && isToolId(event.toolCallId)) {
					updateFleetTool(event.toolCallId, isToolName(event.toolName) ? event.toolName : "tool", "streaming", event.partialResult);
					emitUpdate("delta");
				}

				if (event.type === "tool_execution_end" && isToolId(event.toolCallId)) {
					updateFleetTool(event.toolCallId, isToolName(event.toolName) ? event.toolName : "tool", "completed", event.result, Boolean(event.isError));
					clearStreamingDeltas();
					fleetRun.streamingReset++;
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				clearForceKillTimerIfGroupGone();
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});
		});

		currentResult.exitCode = stopRequested ? 130 : exitCode;
		if (stopRequested) {
			currentResult.stopReason = "stopped";
			currentResult.errorMessage = "Stopped by user";
		}
		return currentResult;
	} finally {
		settled = true;
		if (forceKillTimer && !stopRequested) clearTimeout(forceKillTimer);
		currentResult.endedAt = Date.now();
		let fleetStatus: Exclude<FleetRunStatus, "running">;
		if (stopRequested) fleetStatus = "stopped";
		else if (isFailedResult(currentResult)) fleetStatus = "failed";
		else fleetStatus = "completed";
		fleetStore.finish(fleetRun, fleetStatus);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		// Remove the control socket so a stale path cannot be reused by a later run.
		if (controlSocketPath)
			try {
				fs.unlinkSync(controlSocketPath);
			} catch {
				/* never created, or already gone */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both"; project-level agents override user-level agents with the same name.',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

const StatusParams = Type.Object({
	runId: Type.Optional(Type.String({ description: "Background run id; omit to list all tracked runs" })),
});

const StopParams = Type.Object({
	runId: Type.String({ description: "Background run id to stop" }),
});

const LogsParams = Type.Object({
	runId: Type.String({ description: "Background run id to read" }),
	tail: Type.Optional(Type.Number({ description: "Return only the last N transcript entries (default: all)" })),
});

const SteerParams = Type.Object({
	runId: Type.String({ description: "Background run id to steer" }),
	message: Type.String({ description: "Instruction delivered to the running subagent at its next turn boundary" }),
});

const WaitParams = Type.Object({
	runIds: Type.Optional(
		Type.Array(Type.String(), {
			description: "Run ids to wait for. Omit to wait for every currently running background subagent.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Give up after this many milliseconds and report still-running runs (default 600000)." }),
	),
});

export default function (pi: ExtensionAPI) {
	const fleetStore = new FleetStore();
	const fleetWebServer = new FleetWebServer(fleetStore);
	// Background runs are tracked here so the main agent can inspect and stop them
	// while they are still running. Settled runs stay queryable until pruned.
	const backgroundRuns = new BackgroundRunRegistry<SingleResult>();
	const restoreFleetHistory = (ctx: { sessionManager: { getBranch(): SessionEntry[] } }) => {
		fleetStore.restore(collectRestoredFleetRuns(ctx.sessionManager.getBranch()));
	};

	pi.on("session_start", (_event, ctx) => {
		restoreFleetHistory(ctx);
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			"agent-team-fleet",
			(tui, theme) => new FleetWidget(fleetStore, tui, theme),
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const run of fleetStore.list()) {
			if (run.status === "running") fleetStore.stop(run.id);
		}
		backgroundRuns.clear();
		if (ctx.mode === "tui") ctx.ui.setWidget("agent-team-fleet", undefined);
		fleetStore.clear();
		await fleetWebServer.close();
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreFleetHistory(ctx);
	});

	// Remind the agent about finished runs it never collected.
	//
	// Two triggers, because a run can finish at either moment:
	//   - while the agent is mid-turn: deferring keeps the result from interrupting
	//     work in progress. By the time the turn ends the agent has usually already
	//     collected it, and nothing is sent.
	//   - while the agent is idle: nothing else will wake it, so the reminder goes
	//     out immediately.
	// The `notified` flag keeps a run from being reported twice and prevents the
	// reminder from feeding itself in a loop.
	const reportUncollectedResults = (): void => {
		const pending = backgroundRuns.needsReminder();
		if (pending.length === 0) return;
		const lines = pending.map((record) => {
			const output = record.result ? getResultOutput(record.result) : "(no result captured)";
			const preview = output.length > 2000 ? `${output.slice(0, 2000)}…` : output;
			return `### [${record.agent}] run ${record.runId} — ${record.status}\n\n${preview}`;
		});
		for (const record of pending) backgroundRuns.markNotified(record.runId);
		const summary =
			`${pending.length} background subagent result(s) are waiting to be collected. ` +
			"Call subagent_wait to read the full result.";
		try {
			pi.sendUserMessage(`${summary}\n\n${lines.join("\n\n---\n\n")}`, { deliverAs: "followUp" });
		} catch {
			/* session already disposed (print/json mode); results stay queryable by runId */
		}
	};

	pi.on("agent_settled", reportUncollectedResults);

	pi.registerCommand("subagents", {
		description: "Open the live subagent FleetView",
		handler: async (_args, ctx) => showFleetOverlay(ctx, fleetStore, (runId) => fleetWebServer.open(runId)),
	});

	pi.registerShortcut("ctrl+alt+f", {
		description: "Open the live subagent FleetView",
		handler: async (ctx) => showFleetOverlay(ctx, fleetStore, (runId) => fleetWebServer.open(runId)),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array). Each returns one runId immediately;",
			"the subagent's output is not included.",
			"Collect results with subagent_wait, which blocks until the run settles. To look without blocking,",
			"use subagent_status (status) or subagent_logs (transcript so far).",
			"While a run is going, subagent_steer redirects it and subagent_stop terminates it.",
			"For sequential work, call subagent again with the previous result.",
			`Default agent scope is "both": user-level agents plus ${CONFIG_DIR_NAME}/agents from the current project.`,
			`Project-level agents override user-level agents with the same name.`,
		].join(" "),
		parameters: SubagentParams,
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			// Retain the persisted root session across nested --no-session subagents.
			const usageRootSessionId = process.env.PI_USAGE_ROOT_SESSION_ID ?? ctx.sessionManager.getSessionId();
			// A host must use its own context (process.env is shared by hosted sessions).
			// A --no-session child has no root SessionManager, so nested children retain
			// the root ID explicitly injected by their parent.
			const failbackParentSessionId = process.env.MODEL_FAILBACK_CHILD === "1"
				? process.env.MODEL_FAILBACK_SESSION_ID
				: ctx.sessionManager.getSessionId();
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Background is the default here too: every task becomes its own tracked
				// run, so the caller can supervise or stop tasks individually. All tasks
				// are started immediately; concurrency is bounded by the OS and by the
				// caller's own judgement rather than by a hidden semaphore.
				const started: BackgroundRunRecord<SingleResult>[] = [];
				for (const t of params.tasks) {
					const record = await startBackgroundRun(
						backgroundRuns,
						(control) =>
							runSingleAgent(
								ctx.cwd,
								agents,
								"parallel",
								t.agent,
								t.task,
								t.cwd,
									makeDetails("parallel"),
								fleetStore,
								ctx.modelRegistry,
								ctx.isProjectTrusted?.(),
								usageRootSessionId,
								failbackParentSessionId,
								control,
							),
						{ agent: t.agent, mode: "parallel", task: t.task, agentScope, projectAgentsDir: discovery.projectAgentsDir },
						() => {
							// A run finishing while the agent is idle has nothing else to wake it,
							// so report immediately; mid-turn results wait for agent_settled.
							// isIdle is absent from minimal hosts (and the harness).
							if (ctx.isIdle?.() ?? false) reportUncollectedResults();
						},
					);
					if (record) started.push(record);
				}

				if (started.length === 0) {
					return {
						content: [
							{ type: "text", text: "Failed to start parallel subagents: no subprocess started in time." },
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const listing = started.map((r) => `  runId: ${r.runId} — ${r.agent}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text:
								`${started.length} background subagent(s) started:\n${listing}\n\n` +
								"Call subagent_wait (with no arguments) to collect all of their results. " +
								"Do not finish the turn before collecting results you depend on.",
						},
					],
					details: { ...makeDetails("parallel")([]), liveRunIds: started.map((r) => r.runId) },
				};
			}

			if (params.agent && params.task) {
				// Every subagent is a background run: register it as soon as the
				// subprocess exists and return immediately so the caller can supervise it.
				const record = await startBackgroundRun(
					backgroundRuns,
					(control) =>
						runSingleAgent(
							ctx.cwd,
							agents,
							"single",
							params.agent as string,
							params.task as string,
							params.cwd,
							makeDetails("single"),
							fleetStore,
							ctx.modelRegistry,
							ctx.isProjectTrusted?.(),
							usageRootSessionId,
							failbackParentSessionId,
							control,
						),
					{ agent: params.agent as string, mode: "single", task: params.task as string, agentScope, projectAgentsDir: discovery.projectAgentsDir },
					() => {
						// A run finishing while the agent is idle has nothing else to wake it,
						// so report immediately; mid-turn results wait for agent_settled.
						// isIdle is absent from minimal hosts (and the harness).
						if (ctx.isIdle?.() ?? false) reportUncollectedResults();
					},
				);
				if (!record) {
					return {
						content: [
							{ type: "text", text: "Failed to start background subagent: the subprocess did not start in time." },
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text:
								`Background subagent started (runId: ${record.runId}, agent: ${params.agent}). ` +
								"Call subagent_wait to collect its result, or subagent_status / subagent_logs / subagent_steer / subagent_stop to supervise it. " +
								"Do not finish the turn before collecting a result you depend on.",
						},
					],
					details: { ...makeDetails("single")([]), liveRunIds: [record.runId] },
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "both";
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks) {
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${t.task}`)}`;
				}
				return new OpencodeToolShell(
					new Text(text, 0, 0),
					(s) => theme.bg("toolPendingBg", s),
					(s) => theme.fg("muted", s),
				);
			}
			const agentName = args.agent || "...";
			const task = args.task || "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", task)}`;
			return new OpencodeToolShell(
				new Text(text, 0, 0),
				(s) => theme.bg("toolPendingBg", s),
				(s) => theme.fg("muted", s),
			);
		},

		renderResult: (result, options, theme, context) =>
			renderSubagentResult(result, options, context.isError, theme, fleetStore),
	});

	// ---------------------------------------------------------------------
	// Background run control tools
	//
	// These let the main agent inspect, redirect and stop subagents it started
	// with `subagent`, and collect their results. Stop goes through the same
	// FleetStore control port and SIGTERM/SIGKILL escalation as the user-facing
	// overlay, so semantics match.
	// ---------------------------------------------------------------------

	const describeRun = (record: ReturnType<typeof backgroundRuns.list>[number]): string => {
		const elapsed = Math.max(0, (record.endedAt ?? Date.now()) - record.startedAt);
		const seconds = (elapsed / 1000).toFixed(1);
		const lines = [
			`runId: ${record.runId}`,
			`agent: ${record.agent}`,
			`status: ${record.status}`,
			`elapsed: ${seconds}s`,
		];
		if (record.result) {
			const usage = record.result.usage;
			lines.push(`turns: ${usage.turns}`);
			if (record.result.model) lines.push(`model: ${record.result.model}`);
			if (usage.cost > 0) lines.push(`cost: $${usage.cost.toFixed(4)}`);
			if (record.result.stopReason) lines.push(`stopReason: ${record.result.stopReason}`);
		}
		lines.push(`task: ${record.task.length > 120 ? `${record.task.slice(0, 120)}...` : record.task}`);
		return lines.join("\n");
	};

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Report background subagent runs started with subagent. " +
			"Omit runId to list every tracked run; pass a runId for a single run's status. " +
			"Returns immediately — use this to check progress, not subagent_wait.",
		parameters: StatusParams,

		async execute(_toolCallId, params) {
			if (params.runId) {
				const record = backgroundRuns.get(params.runId);
				if (!record) {
					return {
						content: [{ type: "text", text: `No background run with id "${params.runId}".` }],
						isError: true,
					};
				}
				return { content: [{ type: "text", text: describeRun(record) }] };
			}

			const records = backgroundRuns.list();
			if (records.length === 0) {
				return { content: [{ type: "text", text: "No background subagent runs are tracked in this session." }] };
			}
			const running = records.filter((record) => record.status === "running").length;
			const body = records.map(describeRun).join("\n\n");
			return {
				content: [{ type: "text", text: `${records.length} run(s), ${running} running:\n\n${body}` }],
			};
		},
	});

	pi.registerTool({
		name: "subagent_logs",
		label: "Subagent Logs",
		description:
			"Read the transcript of a background subagent run. Returns the final report for settled runs " +
			"and the messages collected so far for running ones.",
		parameters: LogsParams,

		async execute(_toolCallId, params) {
			const record = backgroundRuns.get(params.runId);
			if (!record) {
				return {
					content: [{ type: "text", text: `No background run with id "${params.runId}".` }],
					isError: true,
				};
			}

			// Settled runs report through the final result; running ones read the live
			// transcript the data-flow layer is still appending to.
			const messages = (record.result?.messages ?? record.live?.messages ?? []) as Message[];
			if (messages.length === 0) {
				return {
					content: [
						{ type: "text", text: `Run ${record.runId} (${record.status}) has no transcript entries yet.` },
					],
				};
			}

			const items = getDisplayItems(messages, true);
			const requested = params.tail && params.tail > 0 ? Math.floor(params.tail) : items.length;
			const shown = items.slice(Math.max(0, items.length - requested));
			const rendered = shown.map((item) => {
				if (item.type === "text") return item.text;
				if (item.type === "toolCall") return `[tool call] ${item.name}`;
				return `[tool result] ${item.name}${item.isError ? " (error)" : ""}\n${item.text}`;
			});
			const header = `Run ${record.runId} (${record.agent}, ${record.status}), showing ${shown.length}/${items.length} entries:`;
			return { content: [{ type: "text", text: `${header}\n\n${rendered.join("\n\n")}` }] };
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description:
			"Stop a running background subagent. Uses the same SIGTERM/SIGKILL escalation as the Fleet overlay. " +
			"Messages collected so far are preserved and the run is marked stopped.",
		parameters: StopParams,

		async execute(_toolCallId, params) {
			const record = backgroundRuns.get(params.runId);
			if (!record) {
				return {
					content: [{ type: "text", text: `No background run with id "${params.runId}".` }],
					isError: true,
				};
			}
			if (record.status !== "running") {
				return {
					content: [
						{ type: "text", text: `Run ${record.runId} is already ${record.status}; nothing to stop.` },
					],
				};
			}
			const stopped = record.stop();
			return {
				content: [
					{
						type: "text",
						text: stopped
							? `Stop requested for run ${record.runId}. The subagent will be marked stopped once it exits.`
							: `Run ${record.runId} could not be stopped (it may have just finished).`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: [
			"Send an instruction to a running background subagent.",
			"Delivered at the subagent's next turn boundary (after it finishes its current tool calls,",
			"before its next model call) — it redirects the work, it does not interrupt generation.",
			"Use subagent_stop when you need an immediate stop.",
		].join(" "),
		parameters: SteerParams,

		async execute(_toolCallId, params) {
			const record = backgroundRuns.get(params.runId);
			if (!record) {
				return {
					content: [{ type: "text", text: `No background run with id "${params.runId}".` }],
					isError: true,
				};
			}
			if (record.status !== "running") {
				return {
					content: [
						{
							type: "text",
							text: `Run ${record.runId} is ${record.status}; it can no longer be steered.`,
						},
					],
					isError: true,
				};
			}
			if (!record.controlSocketPath) {
				return {
					content: [
						{
							type: "text",
							text:
								`Run ${record.runId} has no control channel` +
								(process.platform === "win32" ? " on Windows." : " (the subagent may have exited).") +
								" Use subagent_status / subagent_logs instead.",
						},
					],
					isError: true,
				};
			}

			const sent = await sendControlCommand(record.controlSocketPath, {
				type: "steer",
				message: params.message,
			});
			if (!sent.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Could not steer run ${record.runId}: ${sent.error ?? "unknown error"}.`,
						},
					],
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Steering message queued for run ${record.runId}. ` +
							"It is delivered at the subagent's next turn boundary.",
					},
				],
			};
		},

		// The queued instruction is the one thing the reader needs to verify, so the row
		// prints it under the status line. It is read from `context.args` rather than
		// folded into `content`, keeping the model-facing contract unchanged.
		renderResult(result, _options, theme, context) {
			const status = result.content[0]?.type === "text" ? result.content[0].text : "";
			const message = typeof context.args?.message === "string" ? context.args.message : "";
			let text = theme.fg(context.isError ? "error" : "muted", status);
			if (message) text += `\n${theme.fg("dim", "  message: ")}${theme.fg("accent", message)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description: [
			"Wait for background subagents to finish and return their results.",
			"Waits for the given runIds, or for every running background subagent when omitted.",
			"This blocks until the run settles (up to timeoutMs), so use subagent_status or subagent_logs",
			"to check progress without waiting. Aborting it (or pressing Esc) ends the wait without",
			"stopping the subagents.",
		].join(" "),
		parameters: WaitParams,
		renderShell: "self",

		// subagent_wait carries the settled results in `details`, so this is where the
		// transcript shows what the subagent actually did (tool calls, output, usage).
		renderResult: (result, options, theme, context) =>
			renderSubagentResult(result, options, context.isError, theme, fleetStore),

		async execute(_toolCallId, params, signal, onUpdate) {
			// Explicitly requested ids are resolved even when the run already settled
			// (that is the common case: wait is how the caller collects a result).
			// Without ids, act on everything still outstanding so a finished-but-
			// uncollected result is not silently dropped.
			const requested = params.runIds?.length
				? params.runIds.map((id) => backgroundRuns.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r))
				: backgroundRuns.outstanding();

			if (requested.length === 0) {
				const missing = params.runIds?.filter((id) => !backgroundRuns.get(id)) ?? [];
				return {
					content: [
						{
							type: "text",
							text: missing.length
								? `No such run(s): ${missing.join(", ")}.`
								: "No background subagent result is outstanding.",
						},
					],
				};
			}

			const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 600_000;
			// Waiting must stay interruptible: it can block for the whole timeout, and the
			// caller (or Esc) has to be able to end it early. Aborting the wait does not
			// touch the subagents; they keep running in the background.
			let timedOut = false;
			let aborted = false;
			const total = requested.length;
			const waitStartedAt = Date.now();
			const settledCount = () =>
				requested.filter((r) => backgroundRuns.get(r.runId)?.status !== "running").length;
			// A bare "0/1 settled" never changes while a single run works, which is no
			// better than a static "Working". Report elapsed time and the subagent's own
			// latest words so the caller can see what the run is doing and saying.
			const describeProgress = (): string => {
				const settled = settledCount();
				const elapsed = Math.round((Date.now() - waitStartedAt) / 1000);
				const lines = [`${settled}/${total} settled after ${elapsed}s`];
				for (const record of requested) {
					const current = backgroundRuns.get(record.runId);
					if (!current || current.status !== "running") continue;
					const label = total > 1 ? `run ${current.runId} (${current.agent})` : current.agent;
					// The summary is maintained by the data-flow layer on semantic events, so
					// this tick is O(outstanding runs) and never re-scans a transcript.
					const said = current.progressSummary?.() ?? "";
					lines.push(said ? `${label}: ${said}` : `${label}: starting`);
				}
				return lines.join("\n");
			};
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let abortResolve: () => void = () => {};
			const abortHandler = () => {
				aborted = true;
				abortResolve();
			};
			const abortPromise = new Promise<void>((resolve) => {
				abortResolve = resolve;
				if (!signal) return;
				if (signal.aborted) {
					aborted = true;
					resolve();
					return;
				}
				signal.addEventListener("abort", abortHandler, { once: true });
			});
			// Report progress while waiting, otherwise the row sits on "Working" with no
			// sign of which runs are still outstanding.
			const progressTimer = setInterval(() => {
				onUpdate?.({ content: [{ type: "text", text: `${describeProgress()}…` }] });
			}, 1000);
			progressTimer.unref?.();
			try {
				await Promise.race([
					Promise.allSettled(requested.map((record) => record.settled)),
					new Promise<void>((resolve) => {
						timeoutTimer = setTimeout(() => {
							timedOut = true;
							resolve();
						}, timeoutMs);
						// Do not keep the process alive purely for the timeout.
						timeoutTimer.unref?.();
					}),
					abortPromise,
				]);
			} finally {
				// Release every resource the wait created, including when it ends early
				// (settled, timed out, or aborted): the interval must not keep ticking
				// and the abort listener must not stay attached to a long-lived signal.
				clearInterval(progressTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", abortHandler);
			}

			const sections = requested.map((record) => {
				const settled = backgroundRuns.get(record.runId) ?? record;
				const status = settled.status;
				if (status === "running") {
					const why = aborted
						? "still running when the wait was aborted"
						: `still running after ${Math.round(timeoutMs / 1000)}s`;
					return `### [${settled.agent}] run ${settled.runId} — ${why}\n\nNo result yet. Use subagent_status or subagent_logs to inspect progress.`;
				}
				const output = settled.result ? getResultOutput(settled.result) : "(no result captured)";
				return `### [${settled.agent}] run ${settled.runId} — ${status}\n\n${output}`;
			});

			const finished = requested.filter((r) => backgroundRuns.get(r.runId)?.status !== "running").length;
			// Mark delivered results as collected so they leave the outstanding set.
			for (const record of requested) {
				if (backgroundRuns.get(record.runId)?.status !== "running") backgroundRuns.markCollected(record.runId);
			}
			const header = aborted
				? `Wait aborted: ${finished}/${requested.length} finished, ${requested.length - finished} still running.`
				: timedOut
					? `Waited ${Math.round(timeoutMs / 1000)}s: ${finished}/${requested.length} finished, ${requested.length - finished} still running.`
					: `${finished}/${requested.length} background subagent(s) finished.`;
			// Carry the settled results in `details` so the TUI transcript and Fleet
			// history restore can render the full record (tool calls, usage, diffs).
			// Only settled runs have a result object to contribute. Scope metadata is
			// taken from the runs themselves so details stay self-describing.
			const settledRecords = requested.filter((record) => backgroundRuns.get(record.runId)?.result);
			const settledResults = settledRecords.map((record) => backgroundRuns.get(record.runId)?.result as SingleResult);
			const first = settledRecords[0];
			const details: SubagentDetails | undefined = first
				? {
						mode: settledResults.length > 1 ? "parallel" : "single",
						agentScope: first.agentScope,
						projectAgentsDir: first.projectAgentsDir,
						results: settledResults,
					}
				: undefined;
			return {
				content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
				details,
			};
		},
	});
}
