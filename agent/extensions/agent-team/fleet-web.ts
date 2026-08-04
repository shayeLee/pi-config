import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { FleetStore } from "./fleet-view.ts";

const PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subagent Fleet</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#111827;color:#e5e7eb;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}header{padding:16px 20px;border-bottom:1px solid #374151;font-size:18px;font-weight:700}main{height:calc(100vh - 58px);min-height:0}article{height:100%;padding:20px;overflow:auto;min-height:0}h2{margin:0 0 5px}pre{white-space:pre-wrap;word-break:break-word;background:#172033;border:1px solid #374151;border-radius:6px;padding:12px;margin:8px 0 18px}.entry{margin:18px 0}.entry h3{font-size:12px;text-transform:uppercase;color:#93c5fd;margin:0 0 5px}.entry.collapsible:not(.expanded) pre{max-height:10.5em;overflow:hidden;mask-image:linear-gradient(to bottom,#000 70%,transparent)}.toggle{border:1px solid #4b5563;border-radius:5px;background:#243047;color:#bfdbfe;padding:4px 9px;cursor:pointer;font:inherit;font-size:12px}.toggle:hover{background:#334155}.markdown{font-family:ui-sans-serif,system-ui,sans-serif;font-size:16px;line-height:1.65}.markdown p{margin:0 0 14px}.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:24px 0 10px;color:#e5e7eb;line-height:1.25}.markdown h1{font-size:1.55em}.markdown h2{font-size:1.32em}.markdown h3{font-size:1.15em}.markdown ul,.markdown ol{margin:0 0 14px;padding-left:28px}.markdown code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#243047;border-radius:4px;padding:1px 4px}.markdown pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}.tool{color:#fbbf24}.error{color:#fca5a5}.muted{color:#9ca3af;font-size:12px}
</style><body><header>Subagent Fleet <span id="updated" class="muted"></span></header><main><article id="detail"><span class="muted">Loading…</span></article></main>
<script>
const base = location.pathname.replace(/\\/$/, "");
const detail = document.querySelector("#detail");
const updated = document.querySelector("#updated");
const selected = decodeURIComponent(location.hash.slice(1));
let displayedDetail = "";

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
	if (collapsible && body.split("\\n").length > 5) {
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

function renderDetail(run) {
	const version = run ? run.id + "\\n" + run.status + "\\n" + JSON.stringify(run.messages) : "";
	const changed = version !== displayedDetail;
	if (!changed) return false;
	displayedDetail = version;
	detail.replaceChildren();
	if (!run) {
		text(detail.appendChild(document.createElement("p")), "This subagent is no longer available.");
		return changed;
	}
	const title = document.createElement("h2");
	text(title, "#" + run.id + " " + run.agent);
	detail.append(title);
	const meta = document.createElement("p");
	meta.className = "muted";
	text(meta, run.status + " · " + run.mode + " · " + (run.model || "model pending") + " · " + duration(run));
	detail.append(meta);
	addMarkdownEntry("Task", run.task);
	for (const message of run.messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text" && part.text.trim()) addMarkdownEntry("Assistant", part.text);
				else if (part.type === "toolCall") addEntry("Tool call: " + part.name, JSON.stringify(part.arguments, null, 2), "tool", true);
			}
		} else if (message.role === "toolResult") {
			const output = message.content.map((part) => (part.type === "text" ? part.text : "[" + part.type + " output]")).join("\\n");
			addEntry((message.isError ? "Failed " : "") + "Tool result: " + message.toolName, output || "(no text output)", message.isError ? "error" : "", true);
		}
	}
	return changed;
}

async function refresh() {
	try {
		const response = await fetch(base + "/data?run=" + encodeURIComponent(selected), { cache: "no-store" });
		if (!response.ok) throw new Error("Page is no longer available");
		const data = await response.json();
		const detailChanged = renderDetail(data.run);
		if (detailChanged) requestAnimationFrame(() => detail.scrollTo({ top: detail.scrollHeight }));
		updated.textContent = "· refreshed " + new Date().toLocaleTimeString();
	} catch (error) {
		detail.replaceChildren();
		text(detail.appendChild(document.createElement("p")), error instanceof Error ? error.message : String(error));
		updated.textContent = "· disconnected";
	}
}

void refresh();
setInterval(() => void refresh(), 1000);
</script>`;

/** A loopback-only, read-only view that lives for the current Pi session. */
export class FleetWebServer {
	private server?: Server;
	private port?: number;
	private readonly token = randomBytes(20).toString("hex");

	constructor(private store: FleetStore) {}

	async open(runId: string): Promise<void> {
		await this.start();
		const url = `http://127.0.0.1:${this.port}/fleet/${this.token}/#${encodeURIComponent(runId)}`;
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.unref();
	}

	async close(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		this.port = undefined;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	private async start(): Promise<void> {
		if (this.server && this.port) return;
		this.server = createServer((request, response) => {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			const prefix = `/fleet/${this.token}`;
			if (!url.pathname.startsWith(prefix)) {
				response.writeHead(404).end();
				return;
			}
			if (url.pathname === `${prefix}/data`) {
				const requestedId = url.searchParams.get("run");
				const run = this.store.list().find((item) => item.id === requestedId);
				response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
				response.end(JSON.stringify({ run }));
				return;
			}
			if (url.pathname === `${prefix}/` || url.pathname === prefix) {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				response.end(PAGE);
				return;
			}
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(0, "127.0.0.1", () => {
				this.server?.off("error", reject);
				const address = this.server?.address();
				if (!address || typeof address === "string") return reject(new Error("Could not start Fleet web UI"));
				this.port = address.port;
				resolve();
			});
		});
	}
}
