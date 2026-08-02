/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type SessionEntry,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	FleetStore,
	FleetWidget,
	showFleetOverlay,
	type FleetRunStatus,
	type RestoredFleetRun,
} from "./fleet-view.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startedAt?: number;
	endedAt?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
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

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
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

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
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

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	mode: "single" | "parallel" | "chain",
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	fleetStore: FleetStore,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

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
		step,
	};
	let childProcess: ReturnType<typeof spawn> | null = null;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
	let stopRequested = false;
	let parentAborted = false;
	let settled = false;

	const terminateProcess = () => {
		if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) return;
		childProcess.kill("SIGTERM");
		forceKillTimer = setTimeout(() => {
			if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
				childProcess.kill("SIGKILL");
			}
		}, 5000);
		forceKillTimer.unref?.();
	};

	const fleetRun = fleetStore.add({
		mode,
		agent: currentResult.agent,
		task: currentResult.task,
		messages: currentResult.messages,
		usage: currentResult.usage,
		model: currentResult.model,
		stop: () => {
			if (settled || stopRequested) return false;
			stopRequested = true;
			terminateProcess();
			return true;
		},
	});
	currentResult.runId = fleetRun.id;
	currentResult.startedAt = fleetRun.startedAt;

	const abortFromParent = () => {
		parentAborted = true;
		if (!stopRequested) {
			stopRequested = true;
			terminateProcess();
		}
	};
	if (signal) {
		if (signal.aborted) abortFromParent();
		else signal.addEventListener("abort", abortFromParent, { once: true });
	}

	const emitUpdate = () => {
		fleetRun.model = currentResult.model;
		fleetStore.touch();
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			childProcess = proc;
			if (stopRequested) terminateProcess();
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
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
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
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
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});
		});

		currentResult.exitCode = stopRequested ? 130 : exitCode;
		if (stopRequested) {
			currentResult.stopReason = "stopped";
			currentResult.errorMessage = parentAborted ? "Stopped with the parent operation" : "Stopped by user";
		}
		return currentResult;
	} finally {
		settled = true;
		if (forceKillTimer) clearTimeout(forceKillTimer);
		if (signal) signal.removeEventListener("abort", abortFromParent);
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
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
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
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const fleetStore = new FleetStore();
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

	pi.on("session_shutdown", (_event, ctx) => {
		for (const run of fleetStore.list()) {
			if (run.status === "running") run.stop();
		}
		if (ctx.mode === "tui") ctx.ui.setWidget("agent-team-fleet", undefined);
		fleetStore.clear();
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreFleetHistory(ctx);
	});

	pi.registerCommand("subagents", {
		description: "Open the live subagent FleetView",
		handler: async (_args, ctx) => showFleetOverlay(ctx, fleetStore),
	});

	pi.registerShortcut("ctrl+alt+f", {
		description: "Open the live subagent FleetView",
		handler: async (ctx) => showFleetOverlay(ctx, fleetStore),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "both": user-level agents plus ${CONFIG_DIR_NAME}/agents from the current project.`,
			`Project-level agents override user-level agents with the same name.`,
		].join(" "),
		parameters: SubagentParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
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

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						"chain",
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						fleetStore,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
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

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						"parallel",
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						fleetStore,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isStoppedResult(r)
						? "stopped"
						: isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					"single",
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					fleetStore,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
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
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < args.chain.length; i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${cleanTask}`);
				}
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks) {
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${t.task}`)}`;
				}
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const task = args.task || "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", task)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
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
				const displayItems = getDisplayItems(r.messages, expanded);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isRunning) header += theme.fg("warning", "  running");
					if (isStopped) header += theme.fg("warning", "  stopped");
					else if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) header += theme.fg("dim", `  ${usageStr}`);
					container.addChild(new Text(header, 0, 0));
					if (isError && !isStopped && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					addSectionTitle(container, "Task");
					container.addChild(new Text(theme.fg("dim", r.task), 1, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
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
					return container;
				}

				const container = new Container();
				let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isRunning) header += theme.fg("warning", "  running");
				if (isStopped) header += theme.fg("warning", "  stopped");
				else if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) header += theme.fg("dim", `  ${usageStr}`);
				container.addChild(new Text(header, 0, 0));
				if (isError && !isStopped && r.errorMessage) {
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 1, 0));
					return container;
				}
				if (displayItems.length === 0 && !finalOutput) {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 1, 0));
					return container;
				}

				addCollapsedActivity(container, displayItems, COLLAPSED_ITEM_COUNT);
				if (getToolCalls(displayItems).length > 0) {
					container.addChild(new Text(theme.fg("muted", "Ctrl+O: inspect every call and result"), 1, 0));
				}
				if (finalOutput) {
					addSectionTitle(container, isRunning ? "Progress" : "Result");
					container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
				}
				return container;
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

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const runningCount = details.results.filter((r) => r.exitCode === -1).length;
				const stoppedCount = details.results.filter(isStoppedResult).length;
				const icon =
					runningCount > 0
						? theme.fg("warning", "●")
						: stoppedCount > 0
							? theme.fg("warning", "■")
							: successCount === details.results.length
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === -1
								? theme.fg("warning", "●")
								: isStoppedResult(r)
									? theme.fg("warning", "■")
									: r.exitCode === 0
										? theme.fg("success", "✓")
										: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages, true);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `── Step ${r.step} · `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						if (getToolCalls(displayItems).length > 0) {
							addSectionTitle(container, "Activity", formatActivitySummary(displayItems));
						}
						addExpandedItems(container, displayItems);

						if (finalOutput) {
							addSectionTitle(container, r.exitCode === -1 ? "Progress" : "Result");
							container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				const container = new Container();
				const header =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				container.addChild(new Text(header, 0, 0));
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "●")
							: isStoppedResult(r)
								? theme.fg("warning", "■")
								: r.exitCode === 0
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const finalOutput = getFinalOutput(r.messages);
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(`${theme.fg("muted", `── Step ${r.step} · `)}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
					);
					addCollapsedActivity(container, displayItems, 5);
					if (finalOutput) {
						addSectionTitle(container, r.exitCode === -1 ? "Progress" : "Result");
						container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
					} else if (getToolCalls(displayItems).length === 0) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 1, 0));
					}
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				container.addChild(new Text(theme.fg("muted", "Ctrl+O: inspect every call and result"), 0, 0));
				return container;
			}

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

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
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
				return container;
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
