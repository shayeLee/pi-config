#!/usr/bin/env node
/**
 * Fake `pi` for the agent-team data-flow harness.
 *
 * Never calls a real model. It parses the argv produced by the extension
 * (see runSingleAgent: `pi --mode json -p --no-session [--model ..] [--tools ..]
 * [--append-system-prompt <file>] Task: <task>`) and emits deterministic JSONL
 * events in the pi `--mode json` line format, chosen by markers embedded in the
 * task text:
 *
 *   SCENARIO:tool_result_end_only  -> tool_result_end only (durable toolResult)
 *   SCENARIO:dedup                 -> tool_result_end + message_end, same toolCallId
 *   SCENARIO:transient             -> tool_execution_update/end + assistant message_end
 *   SCENARIO:steerable             -> listens on the control socket and logs commands
 *
 * Every invocation appends one JSON line to the file in $FAKE_PI_LOG so the
 * harness can assert exactly what each subagent process received (args, task
 * after {previous} substitution, injected system prompt, cwd).
 */
"use strict";
const fs = require("node:fs");

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_PI_LOG;

const log = (extra) => {
	if (!logPath) return;
	try {
		fs.appendFileSync(logPath, JSON.stringify(extra) + "\n");
	} catch {
		/* ignore */
	}
};

function argValue(name) {
	const index = argv.indexOf(name);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

const systemPromptPath = argValue("--append-system-prompt");
let systemPrompt = "";
if (systemPromptPath) {
	try {
		systemPrompt = fs.readFileSync(systemPromptPath, "utf8");
	} catch {
		/* ignore */
	}
}

const taskArg = argv.find((arg) => arg.startsWith("Task: ")) || "";
const task = taskArg.slice("Task: ".length);

if (logPath) {
	log({ argv, task, systemPrompt, cwd: process.cwd() });
}

// Long-running scenarios used by the stop-flow tests. They emit (or stay
// silent) and then keep the process alive so the extension's termination
// path (SIGTERM, then SIGKILL after 5s) has something to signal.
const aliveAfterWrite =
	task.includes("SCENARIO:long_running") ||
	task.includes("SCENARIO:stubborn") ||
	task.includes("SCENARIO:descendant") ||
	task.includes("SCENARIO:steerable") ||
	task.includes("SCENARIO:tool_in_flight");

// Steerable scenario: the fake subagent listens on the control socket the
// extension injected (SUBAGENT_CONTROL_SOCKET) and reports every command it
// receives, so the harness can prove a steer actually reached the subprocess.
if (task.includes("SCENARIO:steerable")) {
	const net = require("node:net");
	const socketPath = process.env.SUBAGENT_CONTROL_SOCKET;
	log({ steerable: true, socketPath: socketPath ?? null });
	if (socketPath) {
		const server = net.createServer((conn) => {
			let buf = "";
			conn.on("data", (chunk) => {
				buf += chunk.toString();
				let index;
				while ((index = buf.indexOf("\n")) !== -1) {
					const line = buf.slice(0, index);
					buf = buf.slice(index + 1);
					if (!line.trim()) continue;
					let command;
					try {
						command = JSON.parse(line);
					} catch {
						continue;
					}
					// Record receipt so the harness can assert delivery, then keep the
					// process alive so the run stays "running" until explicitly stopped.
					log({ steerReceived: command });
				}
			});
		});
		server.on("error", () => {});
		server.listen(socketPath);
	}
	process.on("SIGTERM", () => {
		log({ signal: "SIGTERM", task });
		process.exit(130);
	});
	process.on("SIGINT", () => process.exit(130));
}
if (task.includes("SCENARIO:descendant")) {
	// Spawn a descendant in the SAME process group (spawn without detached
	// inherits the leader's group). The leader exits on SIGTERM; the
	// descendant ignores SIGTERM so the extension must escalate to SIGKILL
	// and take the whole group down, proving the group-kill semantics in the
	// README ("已退出组长的后代仍会被该进程组信号覆盖").
	const { spawn } = require("node:child_process");
	// The descendant installs its own ignore-SIGTERM handlers and then writes
	// its own ready marker (via the inherited FAKE_PI_LOG env), so the harness
	// never aborts before the descendant is actually protected.
	const descendantScript = [
		"const fs=require('node:fs');",
		"process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});",
		`fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ descendantReady: true, task: ${JSON.stringify(task)} })+'\\n');`,
		"setInterval(()=>{},1000);",
	].join("");
	const child = spawn(process.execPath, ["-e", descendantScript], {
		stdio: "ignore",
		env: { ...process.env, FAKE_PI_LOG: logPath },
	});
	log({ descendantPid: child.pid, task });
	process.on("SIGTERM", () => {
		log({ signal: "SIGTERM", task });
		process.exit(130);
	});
	process.on("SIGINT", () => process.exit(130));
} else if (task.includes("SCENARIO:tool_in_flight")) {
	// A run that is still working: one completed tool call in the durable
	// transcript, plus a tool that is still executing. The `subagent` row must
	// show the completed call AND the in-flight one while the run is running.
	process.on("SIGTERM", () => {
		log({ signal: "SIGTERM", task });
		process.exit(130);
	});
	process.on("SIGINT", () => process.exit(130));
} else if (task.includes("SCENARIO:long_running")) {
	// Cooperate: exit promptly on SIGTERM so the harness can assert the signal
	// was delivered without waiting for the SIGKILL escalation.
	process.on("SIGTERM", () => {
		log({ signal: "SIGTERM", task });
		process.exit(130);
	});
	process.on("SIGINT", () => {
		log({ signal: "SIGINT", task });
		process.exit(130);
	});
} else if (task.includes("SCENARIO:stubborn")) {
	// Ignore SIGTERM on purpose: the extension must escalate to SIGKILL after
	// 5 seconds. SIGKILL cannot be caught, so the process is simply killed.
	process.on("SIGTERM", () => log({ signal: "SIGTERM", task }));
	process.on("SIGINT", () => {});
}

// Ready marker: emitted after the signal handlers are installed. The harness
// polls for it before aborting, avoiding a startup race in slow CI where the
// abort could arrive before the handlers exist.
if (aliveAfterWrite) log({ ready: task });

const lines = [];
const emit = (event) => lines.push(JSON.stringify(event));

const assistant = (text) => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } },
		model: "fake/provider",
		stopReason: "end",
	},
});

if (task.includes("SCENARIO:tool_in_flight")) {
	// Durable: the subagent narrated what it is doing, then asked for `read`
	// (which finished). The narration is what wait progress should surface.
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "IN-FLIGHT-NARRATION: reading the input file now" },
			],
			usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } },
			model: "fake/provider",
			stopReason: "end",
		},
	});
	// Durable: assistant asked for `read`, and it finished.
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-done",
					name: "read",
					arguments: { path: "/tmp/in-flight/input.txt" },
				},
			],
			usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } },
			model: "fake/provider",
			stopReason: "end",
		},
	});
	emit({
		type: "message_end",
		message: {
			role: "toolResult",
			toolName: "read",
			toolCallId: "call-done",
			content: [{ type: "text", text: "DURABLE-READ-OUTPUT" }],
			isError: false,
		},
	});
	// In flight: `bash` is executing right now, so it is not in the durable
	// transcript yet and only exists as a Fleet toolUpdate.
	emit({
		type: "tool_execution_update",
		toolCallId: "call-live",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "IN-FLIGHT-OUTPUT" }] },
	});
} else if (task.includes("SCENARIO:tool_result_end_only")) {
	// (1) A durable toolResult that is ONLY ever delivered via the legacy
	// tool_result_end event. It must still be preserved in the transcript.
	emit({
		type: "tool_result_end",
		message: {
			role: "toolResult",
			toolName: "bash",
			toolCallId: "call-only",
			content: [{ type: "text", text: "TOOL-ONLY-SECRET" }],
			isError: false,
		},
	});
	emit(assistant("FINAL-ANSWER-A"));
} else if (task.includes("SCENARIO:tool_calls")) {
	// A realistic run: the assistant calls tools, then reports. The transcript must
	// show the calls and their results, not just the final text.
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "bash", arguments: { command: "ls /tmp/tool-call-demo" }, toolCallId: "call-1" },
			],
		},
	});
	emit({
		type: "message_end",
		message: {
			role: "toolResult",
			toolName: "bash",
			toolCallId: "call-1",
			content: [{ type: "text", text: "data.txt\nresult.txt" }],
			isError: false,
		},
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "/tmp/tool-call-demo/data.txt" }, toolCallId: "call-2" },
			],
		},
	});
	emit({
		type: "message_end",
		message: {
			role: "toolResult",
			toolName: "read",
			toolCallId: "call-2",
			content: [{ type: "text", text: "line-one\nline-two" }],
			isError: false,
		},
	});
	emit(assistant("FINAL-ANSWER-TOOLS"));
} else if (task.includes("SCENARIO:dedup")) {
	// (2) The same toolResult arrives via both tool_result_end and message_end
	// with the same toolCallId. The extension must keep exactly one.
	const toolResult = {
		role: "toolResult",
		toolName: "bash",
		toolCallId: "call-dup",
		content: [{ type: "text", text: "DUP-SECRET" }],
		isError: false,
	};
	emit({ type: "tool_result_end", message: toolResult });
	emit({ type: "message_end", message: toolResult });
	emit(assistant("FINAL-ANSWER-B"));
} else if (task.includes("SCENARIO:transient")) {
	// (3) Fleet-only transient events must never enter the durable transcript.
	emit({
		type: "tool_execution_update",
		toolCallId: "call-x",
		toolName: "bash",
		partialResult: { content: [{ type: "text", text: "TRANSIENT-UPDATE" }] },
	});
	emit({
		type: "tool_execution_end",
		toolCallId: "call-x",
		toolName: "bash",
		result: { content: [{ type: "text", text: "TRANSIENT-END" }], details: { diff: "TRANSIENT-DIFF" } },
		isError: false,
	});
	emit(assistant("FINAL-ANSWER-C"));
} else if (task.includes("SCENARIO:model_failback")) {
	// A terminal source model followed by a failback target. agent-team must
	// expose the final target in Fleet/result metadata, not the startup model.
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } },
			provider: "modelscope",
			model: "Qwen/Qwen3.8-Flash-Next",
			stopReason: "error",
			errorMessage: '429: {"message":"insufficient balance"}',
		},
	});
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "FAILBACK-FINAL-ANSWER" }],
			usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { total: 0.0001 } },
			provider: "rightcode-codex",
			model: "gpt-5.6-terra",
			stopReason: "end",
		},
	});
} else if (task.includes("SCENARIO:streaming")) {
	// (5) In-flight assistant text/thinking arrives as delta-only message_update
	// events (message_start -> *_delta -> *_end -> message_end). The extension
	// must accumulate the deltas into transient Fleet state and keep them out of
	// the durable transcript; message_end stays authoritative.
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
	emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "THINKING-DELTA-0" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "THINKING-DELTA-1" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "FULL-THINKING" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "STREAM-" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "FINAL-ANSWER-STREAM" } });
	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "FULL-THINKING" },
				{ type: "text", text: "FINAL-ANSWER-STREAM" },
			],
			usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } },
			model: "fake/provider",
			stopReason: "end",
		},
	});
} else if (task.includes("SCENARIO:bad_index")) {
	// (6) Malformed contentIndex (huge / negative / fractional) must be ignored
	// without crashing the extension or leaking into the durable transcript.
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1e9, delta: "BAD-BIG" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: -5, delta: "BAD-NEG" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1.5, delta: "BAD-FRAC" } });
	emit({ type: "tool_execution_update", toolCallId: 1, toolName: "bash", partialResult: { content: [{ type: "text", text: "BAD-TOOL" }] } });
	emit(assistant("FINAL-ANSWER-BADINDEX"));
} else {
	emit(assistant("UNKNOWN-TASK-ANSWER"));
}

const payload = lines.join("\n") + "\n";
process.stdout.write(payload, () => {
	if (aliveAfterWrite) {
		setTimeout(() => process.exit(0), 60_000);
	} else {
		process.exit(0);
	}
});
