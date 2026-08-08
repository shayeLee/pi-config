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
 *   SCENARIO:chain STEP:1/STEP:2   -> chain steps with a durable tool result + final text
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
	task.includes("SCENARIO:long_running") || task.includes("SCENARIO:stubborn") || task.includes("SCENARIO:descendant");
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

if (task.includes("SCENARIO:tool_result_end_only")) {
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
} else if (task.includes("SCENARIO:chain")) {
	// (4) Chain steps. Step 1 carries a durable tool result that must NOT leak
	// into {previous}; only the final assistant text may be substituted.
	if (task.includes("STEP:1")) {
		emit({
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolName: "bash",
				toolCallId: "call-chain-tool",
				content: [{ type: "text", text: "CHAIN-TOOL-SECRET" }],
				isError: false,
			},
		});
		emit(assistant("CHAIN-FIRST-ANSWER"));
	} else {
		emit(assistant("CHAIN-SECOND-ANSWER"));
	}
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
