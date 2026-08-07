import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { FleetRun, FleetStore } from "./fleet-view.ts";

const MAX_WEB_RUN_BYTES = 256 * 1024;
const WEB_TEXT_TRUNCATION = "\n\n[Fleet Web payload truncated]";
const WEB_RUN_OPTIONS = [
	{ textBytes: 24 * 1024, messageLimit: 128, contentPartLimit: 32, updateLimit: 64 },
	{ textBytes: 8 * 1024, messageLimit: 64, contentPartLimit: 16, updateLimit: 32 },
	{ textBytes: 2 * 1024, messageLimit: 32, contentPartLimit: 8, updateLimit: 16 },
	{ textBytes: 512, messageLimit: 0, contentPartLimit: 0, updateLimit: 0 },
] as const;

type WebContentPart = { type: string; text?: string };
type WebTextOmission = { chars: number; lines: number };
type WebToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	argumentTruncation?: { edits: Array<{ oldText?: WebTextOmission; newText?: WebTextOmission }>; omittedEdits?: number };
	argumentText?: string;
	argumentOmission?: string;
};
type WebMessage =
	| { role: "assistant"; content: Array<{ type: "text"; text: string } | WebToolCall> }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: WebContentPart[];
			isError?: boolean;
			omittedContentParts?: number;
			details?: { diff: string };
	  };
type WebOmissions = {
	messages: number;
	toolUpdates: number;
	assistantContentParts: number;
};
type WebToolUpdate = {
	toolName: string;
	phase: "streaming" | "completed";
	content: WebContentPart[];
	isError?: boolean;
	actualDiff?: string;
	contentTruncated?: boolean;
	actualDiffTruncated?: boolean;
	omittedContentParts?: number;
};
type WebRun = {
	id: string;
	mode: FleetRun["mode"];
	agent: string;
	task: string;
	messages: WebMessage[];
	toolUpdates: Record<string, WebToolUpdate>;
	omitted: WebOmissions;
	model?: string;
	status: FleetRun["status"];
	stopping?: boolean;
	startedAt: number;
	endedAt?: number;
};
type WebRunOptions = (typeof WEB_RUN_OPTIONS)[number];

function capPrefix(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return value.slice(0, low);
}

function capWebText(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	const suffixBytes = Buffer.byteLength(WEB_TEXT_TRUNCATION);
	return capPrefix(value, Math.max(0, maxBytes - suffixBytes)) + WEB_TEXT_TRUNCATION;
}

function countOmittedLines(value: string, keptChars: number): number {
	const omitted = value.slice(keptChars);
	if (!omitted) return 0;
	return (omitted.match(/\n/g)?.length ?? 0) + (omitted.startsWith("\n") ? 0 : 1);
}

function capEditText(value: string, maxBytes: number): { text: string; omission?: WebTextOmission } {
	const text = capPrefix(value, maxBytes);
	if (text.length === value.length) return { text };
	return {
		text,
		omission: { chars: value.length - text.length, lines: countOmittedLines(value, text.length) },
	};
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function webContent(value: unknown, options: WebRunOptions): { content: WebContentPart[]; omittedParts: number } {
	if (!Array.isArray(value)) return { content: [], omittedParts: 0 };
	return { content: value.slice(0, options.contentPartLimit).map((part) => {
		const item = recordOf(part);
		if (!item) return { type: "output" };
		const result: WebContentPart = { type: typeof item.type === "string" ? item.type : "output" };
		if (typeof item.text === "string") result.text = capWebText(item.text, options.textBytes);
		return result;
	}), omittedParts: Math.max(0, value.length - options.contentPartLimit) };
}

function webEditArguments(args: Record<string, unknown>, options: WebRunOptions): { arguments: Record<string, unknown>; argumentTruncation?: WebToolCall["argumentTruncation"] } {
	const result: Record<string, unknown> = {};
	for (const name of ["file_path", "path"]) if (typeof args[name] === "string") result[name] = capWebText(args[name] as string, options.textBytes);
	const rawEdits = Array.isArray(args.edits)
		? args.edits
		: typeof args.edits === "string"
			? (() => {
				try {
					const parsed = JSON.parse(args.edits as string);
					return Array.isArray(parsed) ? parsed : [];
				} catch {
					return [];
				}
			})()
			: [];
	const edits: Array<Record<string, string>> = [];
	const truncations: Array<{ oldText?: WebTextOmission; newText?: WebTextOmission }> = [];
	for (const rawEdit of rawEdits.slice(0, options.contentPartLimit)) {
		const edit = recordOf(rawEdit);
		if (!edit) continue;
		const sanitized: Record<string, string> = {};
		const omission: { oldText?: WebTextOmission; newText?: WebTextOmission } = {};
		for (const name of ["oldText", "newText"] as const) {
			if (typeof edit[name] !== "string") continue;
			const capped = capEditText(edit[name] as string, options.textBytes);
			sanitized[name] = capped.text;
			if (capped.omission) omission[name] = capped.omission;
		}
		edits.push(sanitized);
		truncations.push(omission);
	}
	if (typeof args.oldText === "string" || typeof args.newText === "string") {
		const sanitized: Record<string, string> = {};
		const omission: { oldText?: WebTextOmission; newText?: WebTextOmission } = {};
		for (const name of ["oldText", "newText"] as const) {
			if (typeof args[name] !== "string") continue;
			const capped = capEditText(args[name] as string, options.textBytes);
			sanitized[name] = capped.text;
			if (capped.omission) omission[name] = capped.omission;
		}
		edits.push(sanitized);
		truncations.push(omission);
	}
	if (edits.length) result.edits = edits;
	const omittedEdits = Math.max(0, rawEdits.length - Math.min(rawEdits.length, options.contentPartLimit));
	if (truncations.some((item) => item.oldText || item.newText) || omittedEdits) {
		return { arguments: result, argumentTruncation: { edits: truncations, ...(omittedEdits ? { omittedEdits } : {}) } };
	}
	return { arguments: result };
}

function boundedArgumentPreview(value: unknown, maxBytes: number): { text: string; truncated: boolean } {
	let truncated = false;
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): unknown => {
		if (typeof item === "string") {
			const text = capPrefix(item, Math.max(16, Math.floor(maxBytes / 128)));
			truncated ||= text.length !== item.length;
			return text;
		}
		if (item === null || typeof item === "number" || typeof item === "boolean") return item;
		if (typeof item !== "object" || depth >= 2 || seen.has(item)) {
			truncated = true;
			return "[omitted]";
		}
		seen.add(item);
		if (Array.isArray(item)) {
			if (item.length > 8) truncated = true;
			return item.slice(0, 8).map((entry) => visit(entry, depth + 1));
		}
		const result: Record<string, unknown> = {};
		let count = 0;
		for (const key in item as Record<string, unknown>) {
			if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
			if (count++ >= 8) {
				truncated = true;
				break;
			}
			const cappedKey = capPrefix(key, 64);
			truncated ||= cappedKey.length !== key.length;
			result[cappedKey] = visit((item as Record<string, unknown>)[key], depth + 1);
		}
		return result;
	};
	const text = JSON.stringify(visit(value, 0));
	return { text: capWebText(text, maxBytes), truncated: truncated || Buffer.byteLength(text) > maxBytes };
}

function webArguments(name: string, value: unknown, options: WebRunOptions): {
	arguments: Record<string, unknown>;
	argumentTruncation?: WebToolCall["argumentTruncation"];
	argumentText?: string;
	argumentOmission?: string;
} {
	const args = recordOf(value) ?? {};
	if (name === "edit") return webEditArguments(args, options);
	const names: Record<string, string[]> = {
		bash: ["command", "timeout"],
		read: ["file_path", "path", "offset", "limit"],
		write: ["file_path", "path", "content"],
		ls: ["path", "limit"],
		find: ["pattern", "path", "limit"],
		grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
	};
	if (!names[name]) {
		const preview = boundedArgumentPreview(args, options.textBytes);
		return {
			arguments: {},
			argumentText: preview.text,
			...(preview.truncated ? { argumentOmission: "parameters truncated for Web UI" } : {}),
		};
	}
	const selected = names[name];
	const result: Record<string, unknown> = {};
	for (const key of selected) {
		if (typeof args[key] === "string") result[key] = capWebText(args[key] as string, options.textBytes);
		else if (args[key] !== undefined && (typeof args[key] === "number" || typeof args[key] === "boolean")) result[key] = args[key];
	}
	return { arguments: result };
}

type WebMessageResult = { message?: WebMessage; omittedAssistantContentParts: number };

function webMessage(message: FleetRun["messages"][number], options: WebRunOptions): WebMessageResult {
	if (message.role === "assistant") {
		const content: Array<{ type: "text"; text: string } | WebToolCall> = [];
		let omittedAssistantContentParts = 0;
		const parts = options.contentPartLimit ? message.content.slice(0, options.contentPartLimit) : [];
		omittedAssistantContentParts += message.content.length - parts.length;
		for (const part of parts) {
			if (part.type === "text" && part.text.trim()) content.push({ type: "text", text: capWebText(part.text, options.textBytes) });
			else if (part.type === "toolCall") {
				const sanitized = webArguments(part.name, part.arguments, options);
				content.push({ type: "toolCall", id: part.id, name: part.name, ...sanitized });
			} else {
				omittedAssistantContentParts++;
			}
		}
		return { message: { role: "assistant", content }, omittedAssistantContentParts };
	}
	if (message.role !== "toolResult") return { omittedAssistantContentParts: 0 };
	const output = webContent(message.content, options);
	const result: Extract<WebMessage, { role: "toolResult" }> = {
		role: "toolResult",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: output.content,
		...(output.omittedParts ? { omittedContentParts: output.omittedParts } : {}),
	};
	if (message.isError) result.isError = true;
	const details = recordOf(message.details);
	const diff = typeof details?.diff === "string" ? details.diff : typeof details?.patch === "string" ? details.patch : undefined;
	if (diff !== undefined) result.details = { diff: capWebText(diff, options.textBytes) };
	return { message: result, omittedAssistantContentParts: 0 };
}

function webRun(run: FleetRun | undefined, options: WebRunOptions): WebRun | undefined {
	if (!run) return undefined;
	const selectedMessages = options.messageLimit ? run.messages.slice(-options.messageLimit) : [];
	let omittedMessages = run.messages.length - selectedMessages.length;
	let omittedAssistantContentParts = 0;
	const messages: WebMessage[] = [];
	for (const message of selectedMessages) {
		const converted = webMessage(message, options);
		if (converted.message) messages.push(converted.message);
		else omittedMessages++;
		omittedAssistantContentParts += converted.omittedAssistantContentParts;
	}
	const toolUpdates: Record<string, WebToolUpdate> = {};
	const allUpdates = Object.entries(run.toolUpdates);
	const updates = options.updateLimit ? allUpdates.slice(-options.updateLimit) : [];
	const omittedToolUpdates = allUpdates.length - updates.length;
	for (const [id, update] of updates as Array<[string, FleetRun["toolUpdates"][string]]>) {
		const output = webContent(update.content, options);
		toolUpdates[id] = {
			toolName: update.toolName,
			phase: update.phase,
			content: output.content,
			...(output.omittedParts ? { omittedContentParts: output.omittedParts } : {}),
			...(update.isError ? { isError: true } : {}),
			...(update.actualDiff ? { actualDiff: capWebText(update.actualDiff, options.textBytes) } : {}),
			...(update.contentTruncated ? { contentTruncated: true } : {}),
			...(update.actualDiffTruncated ? { actualDiffTruncated: true } : {}),
		};
	}
	return {
		id: run.id,
		mode: run.mode,
		agent: capWebText(run.agent, options.textBytes),
		task: capWebText(run.task, options.textBytes),
		messages,
		toolUpdates,
		omitted: {
			messages: omittedMessages,
			toolUpdates: omittedToolUpdates,
			assistantContentParts: omittedAssistantContentParts,
		},
		...(run.model ? { model: capWebText(run.model, options.textBytes) } : {}),
		status: run.status,
		...(run.stopping ? { stopping: true } : {}),
		startedAt: run.startedAt,
		...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
	};
}

function selectWebRun(run: FleetRun | undefined, revision: number): WebRun | undefined {
	for (const options of WEB_RUN_OPTIONS) {
		const candidate = webRun(run, options);
		if (Buffer.byteLength(JSON.stringify({ revision, run: candidate })) <= MAX_WEB_RUN_BYTES) return candidate;
	}
	const minimal = webRun(run, WEB_RUN_OPTIONS[WEB_RUN_OPTIONS.length - 1]);
	if (Buffer.byteLength(JSON.stringify({ revision, run: minimal })) <= MAX_WEB_RUN_BYTES) return minimal;
	return minimal
		? { ...minimal, agent: "", task: "", model: undefined }
		: undefined;
}

function serializeFleetRun(run: WebRun | undefined, revision: number): string {
	const payload = { revision, run };
	return JSON.stringify(payload);
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subagent Fleet</title>
<style>
:root{color-scheme:dark;--bg:#0a0c10;--surface:#11141b;--surface-2:#171b24;--inset:#0b0e13;--line:#202634;--line-strong:#2c3444;--text:#e7eaf0;--muted:#98a2b3;--faint:#5d6677;--accent:#6ee7a0;--success:#4ade80;--warning:#f0b429;--error:#f87171;--radius:10px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 var(--sans);overflow:hidden;-webkit-font-smoothing:antialiased}::selection{background:rgba(110,231,160,.3)}header{position:relative;z-index:30;height:52px;padding:0 max(20px,calc((100vw - 920px)/2));display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:var(--bg);background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(10px)}.brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:650;letter-spacing:-.01em}.brand-mark{color:var(--accent);font-size:14px;line-height:1}.brand-path{color:var(--muted);font-weight:400}.live{display:inline-flex;align-items:center;color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums}.live:not(:empty)::before{content:"●";margin-right:7px;color:var(--accent);font-size:9px}.live.off::before{color:var(--error)}.live.reconnecting::before{color:var(--warning)}main{height:calc(100vh - 52px);min-height:0}article{width:min(920px,100%);height:100%;margin:0 auto;padding:0 26px 110px;overflow:auto;min-height:0;scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}article::-webkit-scrollbar{width:10px}article::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:5px;border:2px solid var(--bg)}article::-webkit-scrollbar-thumb:hover{background:var(--faint)}.loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:96px 0;color:var(--muted);font-size:13px}.loading::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid var(--line-strong);border-top-color:var(--accent);animation:spin .8s linear infinite}.notice{padding:96px 0;text-align:center;color:var(--muted);font-size:13px}.run-header{position:sticky;top:0;z-index:10;margin:0 -26px;padding:22px 26px 16px;background:linear-gradient(180deg,var(--bg) 84%,transparent);backdrop-filter:blur(8px)}.run-header::after{content:"";position:absolute;left:26px;right:26px;bottom:8px;border-top:1px solid var(--line)}.eyebrow{margin:0 0 7px;color:var(--accent);font-size:11px;font-weight:600;letter-spacing:.1em}h1{margin:0;color:var(--text);font-size:23px;line-height:1.3;letter-spacing:-.025em;font-weight:650}.run-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:12px;color:var(--muted);font-family:var(--mono);font-size:12px}.run-meta span{display:inline-flex;align-items:center;gap:8px}.run-meta span:not(:last-child)::after{content:"";width:3px;height:3px;border-radius:50%;background:var(--faint)}.chip{display:inline-flex;align-items:center;gap:6px;padding:1px 10px;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-2);font-family:var(--sans);font-size:11px;font-weight:600;letter-spacing:.02em}.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.chip.running{color:var(--accent)}.chip.complete{color:var(--success)}.chip.failed{color:var(--error)}.chip.stopped,.chip.interrupted{color:var(--warning)}.chip.incomplete{color:var(--muted)}.entry{margin:26px 0}.entry h3{margin:0 0 8px;color:var(--faint);font-size:11px;font-weight:600;letter-spacing:.08em}.entry.error h3{color:var(--error)}.markdown{font-family:var(--sans);font-size:15px;line-height:1.75;color:#d4dae3}.markdown p{margin:0 0 14px}.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:26px 0 10px;color:var(--text);line-height:1.3;font-weight:650}.markdown h1{font-size:1.4em}.markdown h2{font-size:1.22em}.markdown h3{font-size:1.08em;letter-spacing:normal}.markdown ul,.markdown ol{margin:0 0 14px;padding-left:24px}.markdown li{margin:2px 0}.markdown code{font-family:var(--mono);font-size:.86em;color:#b8e09a;background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:1px 5px}.markdown pre,pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;background:var(--inset);border:1px solid var(--line);border-radius:8px;padding:12px 14px;color:#c4cdd9;font:12.5px/1.6 var(--mono)}.entry.collapsible:not(.expanded) pre{max-height:12em;overflow:hidden;mask-image:linear-gradient(to bottom,#000 68%,transparent)}.omissions{display:flex;flex-wrap:wrap;gap:4px 16px;margin:18px 0;padding:9px 14px;background:var(--surface);border:1px dashed var(--line-strong);border-radius:var(--radius)}.omission-chip{color:var(--muted);font-size:11.5px}.omission-chip::before{content:"…";margin-right:6px;color:var(--faint)}.toggle{margin-top:10px;padding:2px 0;border:0;background:none;color:var(--muted);cursor:pointer;font:12px var(--sans);display:inline-flex;align-items:center;gap:5px}.toggle:hover{color:var(--accent)}.toggle::before{content:"▸";color:var(--accent);font-size:10px;transition:transform .15s ease}.entry.expanded .toggle::before,.tool-execution.expanded .toggle::before{transform:rotate(90deg)}.tool-execution{position:relative;margin:14px 0;padding:13px 16px 13px 20px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 1px 0 rgba(255,255,255,.02)}.tool-execution::before{content:"";position:absolute;top:0;bottom:0;left:0;width:3px;border-radius:var(--radius) 0 0 var(--radius);background:var(--faint)}.tool-execution.complete::before{background:var(--success)}.tool-execution.failed::before{background:var(--error)}.tool-execution.running::before{background:var(--accent);animation:pulse 1.4s ease-in-out infinite}.tool-execution.stopped::before,.tool-execution.interrupted::before{background:var(--warning)}.tool-execution.incomplete::before{background:var(--faint)}.tool-execution h3{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0;color:var(--text);font-size:12px;font-weight:650}.tool-name{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-weight:600}.tool-name-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--faint)}.tool-execution.complete .tool-name-dot{background:var(--success)}.tool-execution.failed .tool-name-dot{background:var(--error)}.tool-execution.running .tool-name-dot{background:var(--accent)}.tool-execution.stopped .tool-name-dot,.tool-execution.interrupted .tool-name-dot{background:var(--warning)}.tool-status{flex:none;display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface-2);font-size:11px;font-weight:600}.tool-status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.tool-status.complete{color:var(--success);border-color:rgba(74,222,128,.35)}.tool-status.failed{color:var(--error);border-color:rgba(248,113,113,.35)}.tool-status.running{color:var(--accent);border-color:rgba(110,231,160,.35)}.tool-status.stopped,.tool-status.interrupted{color:var(--warning);border-color:rgba(240,180,41,.35)}.tool-status.incomplete{color:var(--muted)}.tool-input{margin:10px 0 0;padding:10px 12px;background:var(--inset);border:1px solid var(--line);border-radius:8px;color:#c4cdd9;font:12px/1.6 var(--mono)}.tool-divider{border-top:1px solid var(--line);margin:12px 0 10px}.output-label{margin-bottom:6px;color:var(--faint);font-size:10px;font-weight:600;letter-spacing:.1em}.tool-output{margin:0;padding:10px 12px;background:var(--inset);border:1px solid var(--line);border-radius:8px;color:#c4cdd9;font:12px/1.6 var(--mono)}.tool-output.error{color:var(--error)}.tool-execution.collapsible.collapse-ready:not(.expanded) .tool-output{max-height:12em;overflow:hidden;mask-image:linear-gradient(to bottom,#000 68%,transparent)}.tool-edit-diff{margin-top:10px;background:var(--inset);border:1px solid var(--line);border-radius:8px;overflow-x:auto}.tool-edit-path{position:sticky;left:0;display:flex;align-items:center;gap:8px;padding:8px 12px;color:var(--muted);border-bottom:1px solid var(--line);font:12px var(--mono)}.tool-edit-path::before{content:"diff";flex:none;padding:1px 7px;border:1px solid rgba(110,231,160,.3);border-radius:999px;background:rgba(110,231,160,.12);color:var(--accent);font-family:var(--sans);font-size:10px;font-weight:600;letter-spacing:.06em}.tool-edit-block{padding:8px 0}.tool-edit-block+.tool-edit-block{border-top:1px solid var(--line)}.tool-edit-number{display:block;padding:0 12px 6px;color:var(--faint);font-size:11px;font-family:var(--sans)}.diff-line{display:flex;min-height:1.55em;padding:0 12px;white-space:pre;font:12px/1.55 var(--mono)}.diff-prefix{flex:none;display:inline-block;width:1.7em;user-select:none;color:var(--faint)}.diff-line.delete{background:rgba(248,113,113,.1);color:#f2a29e}.diff-line.delete .diff-prefix{color:var(--error)}.diff-line.add{background:rgba(74,222,128,.1);color:#9de7b5}.diff-line.add .diff-prefix{color:var(--success)}.diff-line.context{color:#9aa4b4}@keyframes pulse{50%{opacity:.35}}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.tool-execution.running::before,.loading::before{animation:none}}@media(max-width:720px){header{padding:0 16px}.brand-path{display:none}article{padding:0 14px 80px}.run-header{margin:0 -14px;padding:18px 14px 14px}.run-header::after{left:14px;right:14px}.run-meta{gap:4px 9px}.tool-execution{padding:12px 12px 12px 16px}h1{font-size:20px}}
</style>
<body><header><div class="brand"><span class="brand-mark">◆</span><span class="brand-name">fleet</span><span class="brand-path">/ 子代理运行</span></div><span id="updated" class="live"></span></header><main><article id="detail"><div class="loading">加载中…</div></article></main>
<script>
const base = location.pathname.replace(/\\/$/, "");
const detail = document.querySelector("#detail");
const updated = document.querySelector("#updated");
const selected = decodeURIComponent(location.hash.slice(1));
let displayedDetail = "";
let refreshScheduled = false;
let refreshInFlight = false;
let refreshPending = false;
let autoScrollPausedUntil = 0;
let autoScrollPauseTimer;
let autoScrolling = false;
let shouldAutoScroll = false;
let knownToolBlockIds = new Set();
let previousToolUpdatesFingerprint;
let hasLoadedRun = false;

function scrollToBottom() {
	autoScrolling = true;
	detail.scrollTo({ top: detail.scrollHeight });
	requestAnimationFrame(() => { autoScrolling = false; });
}

function pauseAutoScroll() {
	if (autoScrolling) return;
	autoScrollPausedUntil = Date.now() + 5000;
	if (autoScrollPauseTimer) clearTimeout(autoScrollPauseTimer);
	autoScrollPauseTimer = setTimeout(() => {
		autoScrollPauseTimer = undefined;
		if (shouldAutoScroll && Date.now() >= autoScrollPausedUntil) scrollToBottom();
	}, 5000);
}

detail.addEventListener("wheel", pauseAutoScroll, { passive: true });
detail.addEventListener("pointerdown", pauseAutoScroll, { passive: true });
detail.addEventListener("touchstart", pauseAutoScroll, { passive: true });
document.addEventListener("keydown", pauseAutoScroll);

function duration(run) {
	const end = run.endedAt || Date.now();
	const seconds = Math.max(0, Math.floor((end - run.startedAt) / 1000));
	return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m" + String(seconds % 60).padStart(2, "0") + "s";
}

function text(element, value) {
	element.textContent = value;
	return element;
}

function appendInline(element, value) {
	const codeMark = String.fromCharCode(96);
	for (const codePart of value.split(/(\\x60[^\\x60]*\\x60)/g)) {
		if (codePart.startsWith(codeMark) && codePart.endsWith(codeMark)) {
			const code = document.createElement("code");
			text(code, codePart.slice(1, -1));
			element.append(code);
			continue;
		}
		for (const boldPart of codePart.split(/(\\*\\*[^*]+\\*\\*)/g)) {
			if (boldPart.startsWith("**") && boldPart.endsWith("**")) {
				const strong = document.createElement("strong");
				text(strong, boldPart.slice(2, -2));
				element.append(strong);
			} else {
				element.append(document.createTextNode(boldPart));
			}
		}
	}
}

function addMarkdownEntry(title, source) {
	const entry = document.createElement("section");
	const heading = document.createElement("h3");
	const content = document.createElement("div");
	entry.className = "entry";
	content.className = "markdown";
	text(heading, title);
	entry.append(heading, content);

	let paragraph = [];
	let list;
	let listKind = "";
	let codeLines = null;
	const codeFence = /^\\s*\\x60{3}/;
	const flushParagraph = () => {
		if (!paragraph.length) return;
		const p = document.createElement("p");
		paragraph.forEach((line, index) => {
			if (index > 0) p.append(document.createElement("br"));
			appendInline(p, line);
		});
		content.append(p);
		paragraph = [];
	};
	const closeList = () => {
		list = undefined;
		listKind = "";
	};
	const appendListItem = (kind, value) => {
		flushParagraph();
		if (!list || listKind !== kind) {
			list = document.createElement(kind);
			listKind = kind;
			content.append(list);
		}
		const item = document.createElement("li");
		appendInline(item, value);
		list.append(item);
	};
	for (const line of source.split("\\n")) {
		if (codeLines) {
			if (codeFence.test(line)) {
				const pre = document.createElement("pre");
				text(pre, codeLines.join("\\n"));
				content.append(pre);
				codeLines = null;
			} else {
				codeLines.push(line);
			}
			continue;
		}
		if (codeFence.test(line)) {
			flushParagraph();
			closeList();
			codeLines = [];
			continue;
		}
		const headingMatch = /^(#{1,6})\\s+(.+)$/.exec(line);
		const bulletMatch = /^[-*+]\\s+(.+)$/.exec(line);
		const orderedMatch = /^\\d+\\.\\s+(.+)$/.exec(line);
		if (headingMatch) {
			flushParagraph();
			closeList();
			const element = document.createElement("h" + headingMatch[1].length);
			appendInline(element, headingMatch[2]);
			content.append(element);
		} else if (bulletMatch) {
			appendListItem("ul", bulletMatch[1]);
		} else if (orderedMatch) {
			appendListItem("ol", orderedMatch[1]);
		} else if (!line.trim()) {
			flushParagraph();
			closeList();
		} else {
			closeList();
			paragraph.push(line);
		}
	}
	if (codeLines) {
		const pre = document.createElement("pre");
		text(pre, codeLines.join("\\n"));
		content.append(pre);
	}
	flushParagraph();
	detail.append(entry);
}

function addEntry(title, body, klass = "", collapsible = false) {
	const entry = document.createElement("section");
	const heading = document.createElement("h3");
	const pre = document.createElement("pre");
	entry.className = "entry " + klass;
	text(heading, title);
	text(pre, body);
	entry.append(heading, pre);
	if (collapsible && body.split("\\n").length > 8) {
		entry.classList.add("collapsible");
		const toggle = document.createElement("button");
		toggle.className = "toggle";
		text(toggle, "展开");
		toggle.onclick = () => {
			const expanded = entry.classList.toggle("expanded");
			text(toggle, expanded ? "收起" : "展开");
		};
		entry.append(toggle);
	}
	detail.append(entry);
}

function toolOutput(content, emptyText) {
	return content.map((part) => (part.type === "text" ? part.text : "[" + part.type + " output]")).join("\\n") || emptyText;
}

function addOmissionNotice(omitted) {
	const notices = [];
	if (omitted && omitted.messages) notices.push("已省略 " + omitted.messages + " 条消息");
	if (omitted && omitted.toolUpdates) notices.push("已省略 " + omitted.toolUpdates + " 条工具更新");
	if (omitted && omitted.assistantContentParts) notices.push("已省略 " + omitted.assistantContentParts + " 个助手内容片段");
	if (!notices.length) return;
	const banner = document.createElement("div");
	banner.className = "omissions";
	for (const notice of notices) {
		const chip = document.createElement("span");
		chip.className = "omission-chip";
		text(chip, notice);
		banner.append(chip);
	}
	detail.append(banner);
}

const ansiColors = {
	30: "#6f7883", 31: "#ef8b8b", 32: "#8bd5a5", 33: "#e6be69", 34: "#8fb8ff", 35: "#d5a6ff", 36: "#82d9d4", 37: "#e7e9ed",
	90: "#8b949e", 91: "#ffaaa5", 92: "#b5edc5", 93: "#f2d28b", 94: "#afc9ff", 95: "#e0bcff", 96: "#aae9e5", 97: "#ffffff",
};

function appendAnsiText(parent, value) {
	let offset = 0;
	let color = "";
	let bold = false;
	const appendText = (segment) => {
		if (!segment) return;
		if (!color && !bold) parent.append(document.createTextNode(segment));
		else {
			const span = document.createElement("span");
			if (color) span.style.color = color;
			if (bold) span.style.fontWeight = "700";
			text(span, segment);
			parent.append(span);
		}
	};
	value.replace(/\\x1B\\[[0-?]*[ -/]*[@-~]/g, (sequence, index) => {
		appendText(value.slice(offset, index));
		offset = index + sequence.length;
		if (!sequence.endsWith("m")) return sequence;
		for (const code of sequence.slice(2, -1).split(";").map((item) => Number(item || 0))) {
			if (code === 0) { color = ""; bold = false; }
			else if (code === 1) bold = true;
			else if (code === 22) bold = false;
			else if (code === 39) color = "";
			else if (ansiColors[code]) color = ansiColors[code];
		}
		return sequence;
	});
	appendText(value.slice(offset));
}

function editBlocks(args) {
	let edits = Array.isArray(args.edits) ? args.edits : [];
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) edits = parsed;
		} catch {}
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string") edits = edits.concat({ oldText: args.oldText, newText: args.newText });
	return edits.filter((edit) => edit && typeof edit === "object");
}

function appendDiffLine(parent, kind, value) {
	const line = document.createElement("div");
	const prefix = document.createElement("span");
	line.className = "diff-line " + kind;
	prefix.className = "diff-prefix";
	text(prefix, kind === "delete" ? "-" : kind === "add" ? "+" : " ");
	line.append(prefix, document.createTextNode(value));
	parent.append(line);
}

function actualDiffBody(line, markerLength = 0) {
	const body = line.slice(markerLength);
	// Pi's numbered diff format prefixes every line with a marker column. Remove
	// only whitespace immediately before a line number; source-code indentation
	// after that number remains untouched.
	return body.replace(/^\\s+(?=\\d+\\s)/, "");
}

function appendActualToolDiff(parent, value) {
	for (const line of value.split("\\n")) {
		if (line.startsWith("-") && !line.startsWith("---")) appendDiffLine(parent, "delete", actualDiffBody(line, 1));
		else if (line.startsWith("+") && !line.startsWith("+++")) appendDiffLine(parent, "add", actualDiffBody(line, 1));
		else appendDiffLine(parent, "context", actualDiffBody(line));
	}
}

const MAX_EXACT_DIFF_LINES = 1_500;
const MAX_EXACT_DIFF_CHARS = 256 * 1024;
const MAX_RENDERED_DIFF_LINES = 2_000;
const MAX_RENDERED_DIFF_CHARS = 128 * 1024;
const MAX_RENDERED_DIFF_LINE_CHARS = 8 * 1024;

function splitDiffLines(value) {
	if (!value) return [];
	const lines = value.split("\\n");
	return lines.map((text, index) => ({
		text,
		terminalNewline: index === lines.length - 1 && value.endsWith("\\n"),
		newline: index < lines.length - 1 || value.endsWith("\\n"),
	}));
}

function sameDiffLine(left, right) {
	return left.text === right.text && left.terminalNewline === right.terminalNewline;
}

function displayDiffLine(line) {
	return line.terminalNewline ? line.text + "⏎" : line.text;
}

/** Returns a minimum line edit script, or undefined when an exact diff would be too expensive. */
function lineDiff(oldLines, newLines) {
	if (oldLines.length + newLines.length > MAX_EXACT_DIFF_LINES) return undefined;
	const columns = newLines.length + 1;
	const scores = new Uint16Array((oldLines.length + 1) * columns);
	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
		const row = oldIndex * columns;
		const nextRow = (oldIndex + 1) * columns;
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
			scores[row + newIndex] = sameDiffLine(oldLines[oldIndex], newLines[newIndex])
				? scores[nextRow + newIndex + 1] + 1
				: Math.max(scores[nextRow + newIndex], scores[row + newIndex + 1]);
		}
	}
	const operations = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length && newIndex < newLines.length) {
		if (sameDiffLine(oldLines[oldIndex], newLines[newIndex])) {
			operations.push({ kind: "context", value: oldLines[oldIndex++] });
			newIndex++;
		} else if (scores[(oldIndex + 1) * columns + newIndex] >= scores[oldIndex * columns + newIndex + 1]) {
			operations.push({ kind: "delete", value: oldLines[oldIndex++] });
		} else {
			operations.push({ kind: "add", value: newLines[newIndex++] });
		}
	}
	while (oldIndex < oldLines.length) operations.push({ kind: "delete", value: oldLines[oldIndex++] });
	while (newIndex < newLines.length) operations.push({ kind: "add", value: newLines[newIndex++] });
	return operations;
}

function sourceDiffChars(line) {
	return line.text.length + (line.newline ? 1 : 0);
}

function omissionText(lines, chars) {
	if (!lines && !chars) return "";
	const parts = [];
	if (lines) parts.push(lines + " 行");
	if (chars) parts.push(chars + " 字符");
	return "省略 " + parts.join(" · ");
}

function editDiffInput(args, argumentTruncation) {
	const diff = document.createElement("div");
	const path = document.createElement("div");
	const edits = editBlocks(args);
	diff.className = "tool-edit-diff";
	path.className = "tool-edit-path";
	text(path, "edit " + (args.file_path || args.path || "..."));
	diff.append(path);
	for (let index = 0; index < edits.length; index++) {
		const edit = edits[index];
		const block = document.createElement("div");
		const label = document.createElement("div");
		const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
		const newText = typeof edit.newText === "string" ? edit.newText : "";
		const oldLines = splitDiffLines(oldText);
		const newLines = splitDiffLines(newText);
		const operations = oldText.length + newText.length <= MAX_EXACT_DIFF_CHARS ? lineDiff(oldLines, newLines) : undefined;
		const oldPreviewCount = Math.min(oldLines.length, Math.floor(MAX_RENDERED_DIFF_LINES / 2));
		const newPreviewCount = Math.min(newLines.length, Math.floor(MAX_RENDERED_DIFF_LINES / 2));
		const allOperations = operations || [
			...oldLines.slice(0, oldPreviewCount).map((value) => ({ kind: "delete", value })),
			...newLines.slice(0, newPreviewCount).map((value) => ({ kind: "add", value })),
		];
		const transport = argumentTruncation && argumentTruncation.edits ? argumentTruncation.edits[index] : undefined;
		const transportLines = (transport && transport.oldText ? transport.oldText.lines : 0) + (transport && transport.newText ? transport.newText.lines : 0);
		const transportChars = (transport && transport.oldText ? transport.oldText.chars : 0) + (transport && transport.newText ? transport.newText.chars : 0);
		block.className = "tool-edit-block";
		label.className = "tool-edit-number";
		const labelParts = ["edit " + (index + 1) + (operations ? "" : " · 大编辑（跳过精确 diff）")];
		if (transportChars) labelParts.push("传输：" + omissionText(transportLines, transportChars));
		text(label, labelParts.join(" · "));
		block.append(label);
		let renderedCount = 0;
		let renderedChars = 0;
		let renderOmittedLines = 0;
		let renderOmittedChars = 0;
		for (let operationIndex = 0; operationIndex < allOperations.length; operationIndex++) {
			const operation = allOperations[operationIndex];
			const sourceChars = sourceDiffChars(operation.value);
			if (renderedCount >= MAX_RENDERED_DIFF_LINES || renderedChars >= MAX_RENDERED_DIFF_CHARS) {
				renderOmittedLines++;
				renderOmittedChars += sourceChars;
				continue;
			}
			const original = displayDiffLine(operation.value);
			const limit = Math.min(MAX_RENDERED_DIFF_LINE_CHARS, MAX_RENDERED_DIFF_CHARS - renderedChars);
			const isTruncated = original.length > limit;
			const value = isTruncated ? original.slice(0, Math.max(0, limit - 1)) + "…" : original;
			const representedChars = isTruncated ? Math.min(operation.value.text.length, Math.max(0, limit - 1)) : sourceChars;
			appendDiffLine(block, operation.kind, value);
			renderedCount++;
			renderedChars += value.length;
			renderOmittedChars += sourceChars - representedChars;
		}
		if (!operations) {
			const omittedOldLines = oldLines.slice(oldPreviewCount).reduce((total, line) => total + sourceDiffChars(line), 0);
			const omittedNewLines = newLines.slice(newPreviewCount).reduce((total, line) => total + sourceDiffChars(line), 0);
			renderOmittedLines += Math.max(0, oldLines.length - oldPreviewCount) + Math.max(0, newLines.length - newPreviewCount);
			renderOmittedChars += omittedOldLines + omittedNewLines;
		}
		if (renderOmittedLines || renderOmittedChars) {
			appendDiffLine(block, "context", "[预览：" + omissionText(renderOmittedLines, renderOmittedChars) + "]");
		}
		diff.append(block);
	}
	if (!edits.length) appendDiffLine(diff, "context", "（无编辑块）");
	return diff;
}

function toolExecutionState(result, update, run) {
	if (result) return result.isError ? { className: "failed", label: "失败" } : { className: "complete", label: "已完成" };
	if (update && update.phase === "completed") return update.isError ? { className: "failed", label: "失败" } : { className: "complete", label: "已完成" };
	if (run.stopping) return { className: "running", label: "停止中" };
	switch (run.status) {
		case "running": return { className: "running", label: "运行中" };
		case "stopped": return { className: "stopped", label: "已停止" };
		case "interrupted": return { className: "interrupted", label: "已中断" };
		case "failed": return { className: "failed", label: "失败" };
		case "completed": return { className: "incomplete", label: "无结果" };
	}
}

function toolResultActualDiff(result) {
	const details = result && result.details;
	if (!details || typeof details !== "object") return undefined;
	return typeof details.diff === "string" ? details.diff : typeof details.patch === "string" ? details.patch : undefined;
}

function addToolExecution(call, result, update, run, unmatchedUpdate = false) {
	const entry = document.createElement("section");
	const heading = document.createElement("h3");
	const label = document.createElement("span");
	const status = document.createElement("span");
	const input = call.name === "edit" ? editDiffInput(call.arguments, call.argumentTruncation) : document.createElement("pre");
	const state = toolExecutionState(result, update, run);
	entry.className = "tool-execution " + state.className;
	label.className = "tool-name";
	const dot = document.createElement("span");
	const name = document.createElement("span");
	dot.className = "tool-name-dot";
	text(name, call.name + (unmatchedUpdate ? " · 未匹配的更新" : ""));
	label.append(dot, name);
	status.className = "tool-status " + state.className;
	text(status, state.label);
	heading.append(label, status);
	if (call.name !== "edit") {
		input.className = "tool-input";
		text(input, formatToolCall(call.name, call.arguments, call.argumentText, call.argumentOmission));
	}
	if (call.name === "edit") {
		entry.append(heading);
		const actualDiff = toolResultActualDiff(result) || update?.actualDiff;
		if (actualDiff) {
			const actual = document.createElement("div");
			const actualPath = document.createElement("div");
			actual.className = "tool-edit-diff";
			actualPath.className = "tool-edit-path";
			const editPath = call.arguments && (call.arguments.file_path || call.arguments.path);
			text(actualPath, editPath ? "edit " + editPath : "实际 diff");
			actual.append(actualPath);
			appendActualToolDiff(actual, actualDiff + (update?.actualDiffTruncated && !result ? "\\n\\n[Fleet actual diff truncated]" : ""));
			entry.append(actual);
		}
	} else entry.append(heading, input);
	const outputSource = result || update;
	if (outputSource) {
		const divider = document.createElement("div");
		const outputLabel = document.createElement("div");
		const output = document.createElement("pre");
		const outputText = toolOutput(outputSource.content, result || update?.phase === "completed" ? "(无文本输出)" : "(等待输出)");
		const value = outputText
			+ (update?.contentTruncated && !outputText.includes("[Fleet live output truncated]") ? "\\n\\n[Fleet live output truncated]" : "")
			+ (outputSource.omittedContentParts ? "\\n\\n[已省略 " + outputSource.omittedContentParts + " 个输出片段]" : "");
		divider.className = "tool-divider";
		outputLabel.className = "output-label";
		text(outputLabel, "输出");
		output.className = "tool-output" + (result && result.isError ? " error" : "");
		appendAnsiText(output, value);
		entry.append(divider, outputLabel, output);
		if (result && value.split("\\n").length > 8) {
			entry.classList.add("collapsible");
			setTimeout(() => {
				if (entry.isConnected && !entry.classList.contains("expanded")) entry.classList.add("collapse-ready");
			}, 1000);
			const toggle = document.createElement("button");
			toggle.className = "toggle";
			text(toggle, "展开");
			toggle.onclick = () => {
				const expanded = entry.classList.toggle("expanded");
				text(toggle, expanded ? "收起" : "展开");
			};
			entry.append(toggle);
		}
	}
	detail.append(entry);
}

function formatToolValue(value) {
	if (typeof value === "string") return value;
	if (value === undefined) return "...";
	if (value === null) return "null";
	if (Array.isArray(value)) return value.map(formatToolValue).join(", ");
	if (typeof value === "object") return Object.entries(value).map(([key, item]) => key + ": " + formatToolValue(item)).join(", ");
	return String(value);
}

function formatToolFields(args, names) {
	return names.filter((name) => args[name] !== undefined).map((name) => "  " + name + ": " + formatToolValue(args[name])).join("\\n");
}

function formatToolCall(name, args, argumentText, argumentOmission) {
	const fields = (names) => formatToolFields(args, names);
	const withFields = (header, names) => {
		const detail = fields(names);
		return detail ? header + "\\n" + detail : header;
	};
	switch (name) {
		case "bash":
			return withFields("$ " + (args.command || "..."), ["timeout"]);
		case "read":
			return withFields("read " + (args.file_path || args.path || "..."), ["offset", "limit"]);
		case "write":
			return withFields("write " + (args.file_path || args.path || "..."), ["content"]);
		case "edit": {
			const header = "edit " + (args.file_path || args.path || "...");
			let edits = Array.isArray(args.edits) ? args.edits : [];
			if (typeof args.edits === "string") {
				try {
					const parsed = JSON.parse(args.edits);
					if (Array.isArray(parsed)) edits = parsed;
				} catch {}
			}
			if (typeof args.oldText === "string" && typeof args.newText === "string") edits = edits.concat({ oldText: args.oldText, newText: args.newText });
			const blocks = edits.map((edit, index) => "  edit " + (index + 1) + ":\\n" + formatToolFields(edit, ["oldText", "newText"])).join("\\n");
			return blocks ? header + "\\n" + blocks : header;
		}
		case "ls":
			return withFields("ls " + (args.path || "."), ["limit"]);
		case "find":
			return withFields("find " + (args.pattern || "*") + " in " + (args.path || "."), ["limit"]);
		case "grep":
			return withFields("grep /" + (args.pattern || "") + "/ in " + (args.path || "."), ["glob", "ignoreCase", "literal", "context", "limit"]);
		default: {
			const detail = argumentText
				? "  参数: " + argumentText
				: Object.entries(args).map(([key, value]) => "  " + key + ": " + formatToolValue(value)).join("\\n");
			const omission = argumentOmission ? "  [" + argumentOmission + "]" : "";
			return detail || omission ? name + "\\n" + [detail, omission].filter(Boolean).join("\\n") : name;
		}
	}
}

const MODE_LABELS = { single: "单代理", parallel: "并行", chain: "链式" };

function runStatus(run) {
	if (run.stopping) return { className: "running", label: "停止中" };
	switch (run.status) {
		case "running": return { className: "running", label: "运行中" };
		case "completed": return { className: "complete", label: "已完成" };
		case "failed": return { className: "failed", label: "失败" };
		case "stopped": return { className: "stopped", label: "已停止" };
		case "interrupted": return { className: "interrupted", label: "已中断" };
		default: return { className: "incomplete", label: run.status };
	}
}

function renderDetail(run, revision) {
	const changed = String(revision) !== displayedDetail;
	if (!changed) return false;
	displayedDetail = String(revision);
	detail.replaceChildren();
	if (!run) {
		const notice = document.createElement("p");
		notice.className = "notice";
		text(notice, "该子代理已不可用");
		detail.append(notice);
		return changed;
	}
	const runHeader = document.createElement("section");
	const eyebrow = document.createElement("div");
	const title = document.createElement("h1");
	const meta = document.createElement("div");
	eyebrow.className = "eyebrow";
	meta.className = "run-meta";
	text(eyebrow, "子代理 · 运行 #" + run.id);
	text(title, run.agent);
	const status = runStatus(run);
	const statusItem = document.createElement("span");
	statusItem.className = "chip " + status.className;
	text(statusItem, status.label);
	meta.append(statusItem);
	for (const value of [MODE_LABELS[run.mode] || run.mode, run.model || "模型待定", duration(run)]) {
		const item = document.createElement("span");
		text(item, value);
		meta.append(item);
	}
	runHeader.className = "run-header";
	runHeader.append(eyebrow, title, meta);
	detail.append(runHeader);
	addMarkdownEntry("任务", run.task);
	addOmissionNotice(run.omitted);
	const executions = new Map();
	const entries = [];
	const toolUpdates = run.toolUpdates || {};
	for (const message of run.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim()) entries.push({ type: "assistant", text: part.text });
				else if (part.type === "toolCall") {
					const execution = { call: part, result: undefined };
					executions.set(part.id, execution);
					entries.push({ type: "execution", execution });
				}
			}
		} else if (message.role === "toolResult") {
			const execution = executions.get(message.toolCallId);
			if (execution) execution.result = message;
			else entries.push({ type: "orphanResult", result: message });
		}
	}
	for (const [id, update] of Object.entries(toolUpdates)) {
		if (!executions.has(id)) entries.push({ type: "unmatchedUpdate", id, update });
	}
	for (const entry of entries) {
		if (entry.type === "assistant") addMarkdownEntry("助手", entry.text);
		else if (entry.type === "execution") addToolExecution(entry.execution.call, entry.execution.result, toolUpdates[entry.execution.call.id], run);
		else if (entry.type === "unmatchedUpdate") {
			addToolExecution({ type: "toolCall", id: entry.id, name: entry.update.toolName, arguments: {} }, undefined, entry.update, run, true);
		} else {
			const outputText = entry.result.content.map((part) => (part.type === "text" ? part.text : "[" + part.type + " output]")).join("\\n") || "(无文本输出)";
			const output = outputText + (entry.result.omittedContentParts ? "\\n\\n[已省略 " + entry.result.omittedContentParts + " 个输出片段]" : "");
			addEntry((entry.result.isError ? "失败：" : "") + "未匹配的工具结果：" + entry.result.toolName, output, entry.result.isError ? "error" : "", true);
		}
	}
	return changed;
}

async function refresh() {
	if (refreshInFlight) {
		refreshPending = true;
		return;
	}
	refreshInFlight = true;
	try {
		const response = await fetch(base + "/data?run=" + encodeURIComponent(selected), { cache: "no-store" });
		if (!response.ok) throw new Error("页面已不可用");
		const data = await response.json();
		const currentToolBlockIds = new Set();
		if (data.run) {
			for (const id of Object.keys(data.run.toolUpdates || {})) currentToolBlockIds.add(id);
			for (const message of data.run.messages || []) {
				if (message.role !== "assistant") continue;
				for (const part of message.content || []) if (part.type === "toolCall") currentToolBlockIds.add(part.id);
			}
		}
		const hasNewToolBlock = Array.from(currentToolBlockIds).some((id) => !knownToolBlockIds.has(id));
		knownToolBlockIds = currentToolBlockIds;
		const toolUpdatesFingerprint = JSON.stringify(data.run?.toolUpdates || {});
		const hasToolBlockUpdate = previousToolUpdatesFingerprint !== undefined && previousToolUpdatesFingerprint !== toolUpdatesFingerprint;
		previousToolUpdatesFingerprint = toolUpdatesFingerprint;
		const initialLoad = Boolean(data.run && !hasLoadedRun);
		if (data.run) hasLoadedRun = true;
		const hasStreamingToolUpdate = Boolean(data.run && Object.values(data.run.toolUpdates || {}).some((update) => update.phase === "streaming"));
		shouldAutoScroll = Boolean(data.run && (initialLoad || hasNewToolBlock || hasToolBlockUpdate || (data.run.status === "running" && hasStreamingToolUpdate)));
		const detailChanged = renderDetail(data.run, data.revision);
		if (detailChanged && shouldAutoScroll && Date.now() >= autoScrollPausedUntil) requestAnimationFrame(scrollToBottom);
		updated.textContent = "实时连接";
		updated.classList.remove("off", "reconnecting");
	} catch (error) {
		displayedDetail = "";
		detail.replaceChildren();
		const notice = document.createElement("p");
		notice.className = "notice";
		text(notice, error instanceof Error ? error.message : String(error));
		detail.append(notice);
		updated.textContent = "已断开";
		updated.classList.add("off");
		updated.classList.remove("reconnecting");
	} finally {
		refreshInFlight = false;
		if (refreshPending) {
			refreshPending = false;
			void refresh();
		}
	}
}

function scheduleRefresh() {
	if (refreshScheduled) return;
	refreshScheduled = true;
	requestAnimationFrame(() => {
		refreshScheduled = false;
		void refresh();
	});
}

function closeFleetPage() {
	events.close();
	updated.textContent = "Pi 已退出";
	updated.classList.add("off");
	window.close();
	window.setTimeout(() => {
		if (!window.closed) location.replace("about:blank");
	}, 150);
}

void refresh();
const events = new EventSource(base + "/events");
events.addEventListener("update", scheduleRefresh);
events.addEventListener("shutdown", closeFleetPage);
events.onerror = () => {
	updated.textContent = "正在重连…";
	updated.classList.add("reconnecting");
	updated.classList.remove("off");
};
</script>`;

/** A loopback-only, read-only view that lives for the current Pi session. */
export class FleetWebServer {
	private server?: Server;
	private port?: number;
	private readonly token = randomBytes(20).toString("hex");
	private readonly eventClients = new Set<ServerResponse>();
	private readonly pendingEventClients = new Set<ServerResponse>();
	private readonly drainingEventClients = new Set<ServerResponse>();
	private readonly runRevisions = new Map<string, { fingerprint: string; revision: number }>();
	private broadcastTimer?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	private startPromise?: Promise<void>;
	private lifecycle: Promise<void> = Promise.resolve();
	private closing = false;

	constructor(private store: FleetStore) {}

	async open(runId: string): Promise<void> {
		const port = await this.enqueue(async () => {
			if (this.closing) throw new Error("Fleet web UI is closing");
			await this.start();
			if (!this.port) throw new Error("Could not start Fleet web UI");
			return this.port;
		});
		const url = `http://127.0.0.1:${port}/fleet/${this.token}/#${encodeURIComponent(runId)}`;
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "darwin" ? ["-a", "Safari", url] : process.platform === "win32" ? ["/c", "start", "", url] : [url];
		await new Promise<void>((resolve, reject) => {
			const child = spawn(command, args, { stdio: "ignore", detached: true });
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		await this.enqueue(async () => {
			this.closing = true;
			if (!this.server) return;
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
			this.broadcastTimer = undefined;
			for (const client of this.eventClients) client.end("event: shutdown\ndata: {}\n\n");
			this.eventClients.clear();
			this.pendingEventClients.clear();
			this.drainingEventClients.clear();
			const server = this.server;
			this.server = undefined;
			this.port = undefined;
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.lifecycle.then(operation, operation);
		this.lifecycle = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	private start(): Promise<void> {
		if (this.server && this.port) return Promise.resolve();
		if (!this.startPromise) {
			this.startPromise = this.startServer().finally(() => {
				this.startPromise = undefined;
			});
		}
		return this.startPromise;
	}

	private async startServer(): Promise<void> {
		const unsubscribe = this.store.subscribe(() => this.scheduleBroadcast());
		const server = createServer((request, response) => {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			const prefix = `/fleet/${this.token}`;
			if (!url.pathname.startsWith(prefix)) {
				response.writeHead(404).end();
				return;
			}
			if (url.pathname === `${prefix}/data`) {
				const requestedId = url.searchParams.get("run") || "";
				const run = this.store.list().find((item) => item.id === requestedId);
				const previous = this.runRevisions.get(requestedId);
				let revision = previous?.revision ?? 1;
				let webRun = selectWebRun(run, revision);
				let fingerprint = JSON.stringify(webRun);
				if (previous && previous.fingerprint !== fingerprint) {
					revision = previous.revision + 1;
					webRun = selectWebRun(run, revision);
					fingerprint = JSON.stringify(webRun);
				}
				this.runRevisions.set(requestedId, { fingerprint, revision });
				response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
				response.end(serializeFleetRun(webRun, revision));
				return;
			}
			if (url.pathname === `${prefix}/events`) {
				response.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				});
				this.eventClients.add(response);
				response.once("close", () => {
					this.eventClients.delete(response);
					this.pendingEventClients.delete(response);
					this.drainingEventClients.delete(response);
				});
				this.sendUpdate(response);
				return;
			}
			if (url.pathname === `${prefix}/` || url.pathname === prefix) {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				response.end(PAGE);
				return;
			}
			response.writeHead(404).end();
		});
		try {
			const port = await new Promise<number>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					const address = server.address();
					if (!address || typeof address === "string") return reject(new Error("Could not start Fleet web UI"));
					resolve(address.port);
				});
			});
			this.server = server;
			this.port = port;
			this.unsubscribe = unsubscribe;
		} catch (error) {
			unsubscribe();
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			throw error;
		}
	}

	private scheduleBroadcast(): void {
		if (this.broadcastTimer) return;
		this.broadcastTimer = setTimeout(() => {
			this.broadcastTimer = undefined;
			for (const client of this.eventClients) this.sendUpdate(client);
		}, 50);
		this.broadcastTimer.unref?.();
	}

	private sendUpdate(client: ServerResponse): void {
		if (client.destroyed) {
			this.eventClients.delete(client);
			this.pendingEventClients.delete(client);
			this.drainingEventClients.delete(client);
			return;
		}
		if (client.writableNeedDrain) {
			this.pendingEventClients.add(client);
			return;
		}
		if (client.write("event: update\ndata: {}\n\n")) return;
		this.drainingEventClients.add(client);
		client.once("drain", () => {
			this.drainingEventClients.delete(client);
			if (this.pendingEventClients.delete(client)) this.sendUpdate(client);
		});
	}
}
