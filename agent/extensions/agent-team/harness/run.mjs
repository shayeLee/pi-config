#!/usr/bin/env node
/**
 * agent-team data-flow harness
 *
 * Loads the real agent-team extension (`../index.ts`) with a mock ExtensionAPI,
 * then registers and invokes the `subagent` tool. Subagent processes are driven
 * by a fake `pi` executable (JSONL events, no real model) placed first on PATH —
 * the same PATH mechanism the extension itself relies on via getPiInvocation().
 *
 * Asserted data-flow guarantees (see ../README.md "JSON 事件采集"):
 *   1. A toolResult delivered only via `tool_result_end` is kept as a durable
 *      message in the result transcript.
 *   2. The same toolCallId arriving via both `tool_result_end` and `message_end`
 *      is deduplicated to a single message.
 *   3. `tool_execution_update` / `tool_execution_end` are transient Fleet state
 *      and never appear in the final content/details messages.
 *   4. In chain mode, `{previous}` is replaced only by the previous step's final
 *      assistant text — never its tool results or full transcript.
 *
 * A temporary project with a generated `.pi/agents/worker.md` agent config is
 * created per run; the harness asserts the config reached the subagent process
 * (model/tools flags, appended system prompt) and that cwd was forwarded.
 *
 * Run:
 *   node agent/extensions/agent-team/harness/run.mjs
 *
 * The pi-coding-agent package (provider of the extension runtime modules and
 * jiti) is located via $PI_PACKAGE_ROOT if set, otherwise via $VOLTA_HOME's
 * image packages layout; set PI_PACKAGE_ROOT to a directory containing
 * dist/index.js and node_modules if auto-detection fails.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HARNESS_DIR, "..");
const EXTENSION_ENTRY = path.join(EXTENSION_DIR, "index.ts");
const FAKE_PI_SOURCE = path.join(HARNESS_DIR, "fake-pi.cjs");

const AGENT_CONFIG = `---
name: worker
description: Harness test agent
tools: read, grep, find, ls, bash, edit, write
model: fake/provider
---
You are the harness worker agent. Report findings as final text.
`;
const SYSTEM_PROMPT_BODY = "You are the harness worker agent. Report findings as final text.";

let passed = 0;
let failed = 0;
function check(name, condition, extra) {
	if (condition) {
		passed += 1;
		console.log(`  ok    ${name}`);
	} else {
		failed += 1;
		console.error(`  FAIL  ${name}${extra !== undefined ? `  (${extra})` : ""}`);
	}
}

function finalText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = (message.content || [])
			.filter((part) => part?.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

function findPiPackageRoot() {
	const explicit = process.env.PI_PACKAGE_ROOT;
	if (explicit) {
		const resolved = path.resolve(explicit);
		if (fs.existsSync(path.join(resolved, "dist/index.js"))) return resolved;
		console.error(`PI_PACKAGE_ROOT set but no dist/index.js found in: ${resolved}`);
		process.exit(1);
	}
	const voltaHome = process.env.VOLTA_HOME || path.join(os.homedir(), ".volta");
	const candidates = [
		path.join(
			voltaHome,
			"tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent",
		),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, "dist/index.js"))) return candidate;
	}
	console.error(
		"Could not locate the pi-coding-agent package. Set PI_PACKAGE_ROOT to its path " +
			"(a directory containing dist/index.js and node_modules).",
	);
	process.exit(1);
}

function extensionAliases(pkgRoot, require) {
	return {
		"@earendil-works/pi-coding-agent": path.join(pkgRoot, "dist/index.js"),
		"@earendil-works/pi-agent-core": path.join(pkgRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
		"@earendil-works/pi-tui": path.join(pkgRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
		"@earendil-works/pi-ai": path.join(pkgRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
		typebox: require.resolve("typebox"),
		"typebox/compile": require.resolve("typebox/compile"),
		"typebox/value": require.resolve("typebox/value"),
		"@sinclair/typebox": require.resolve("typebox"),
	};
}

function createMockExtensionApi() {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	// Records every pi.sendUserMessage call so tests can assert that background
	// results are injected back as follow-up messages.
	const sentUserMessages = [];
	const api = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
		sendUserMessage(content, options) {
			sentUserMessages.push({ content, options });
		},
	};
	return { api, handlers, tools, commands, shortcuts, sentUserMessages };
}

async function main() {
	const pkgRoot = findPiPackageRoot();
	const jitiEntry = pathToFileURL(path.join(pkgRoot, "dist/index.js")).href;
	const require = createRequire(jitiEntry);
	const { createJiti } = await import(
		pathToFileURL(path.join(pkgRoot, "node_modules/jiti/lib/jiti-static.mjs")).href
	);
	const jiti = createJiti(jitiEntry, { moduleCache: false, alias: extensionAliases(pkgRoot, require) });

	// --- temporary project: generated agent config + fake `pi` on PATH --------
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-harness-"));
	const projectDir = path.join(tmpRoot, "project");
	const agentsDir = path.join(projectDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "worker.md"), AGENT_CONFIG);

	const binDir = path.join(tmpRoot, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const fakePiPath = path.join(binDir, "pi");
	fs.copyFileSync(FAKE_PI_SOURCE, fakePiPath);
	fs.chmodSync(fakePiPath, 0o755);

	const logPath = path.join(tmpRoot, "fake-pi-log.jsonl");
	const savedEnv = {
		PATH: process.env.PATH,
		FAKE_PI_LOG: process.env.FAKE_PI_LOG,
	};
	process.env.PATH = binDir + path.delimiter + (process.env.PATH ?? "");
	process.env.FAKE_PI_LOG = logPath;

	try {
		// --- load the real extension with a mock ExtensionAPI ------------------
		const factory = await jiti.import(EXTENSION_ENTRY, { default: true });
		if (typeof factory !== "function") {
			console.error(`Extension ${EXTENSION_ENTRY} did not export a factory function`);
			process.exit(1);
		}
		const { api, handlers, tools, commands, shortcuts, sentUserMessages } = createMockExtensionApi();
		await factory(api);

		const subagent = tools.get("subagent");
		check("subagent tool registered", Boolean(subagent));
		check("session_start handler registered", (handlers.get("session_start") ?? []).length === 1);
		check("subagents command registered", Boolean(commands.get("subagents")));
		check("ctrl+alt+f shortcut registered", Boolean(shortcuts.get("ctrl+alt+f")));
		const statusTool = tools.get("subagent_status");
		const logsTool = tools.get("subagent_logs");
		const stopTool = tools.get("subagent_stop");
		const steerTool = tools.get("subagent_steer");
		const waitTool = tools.get("subagent_wait");
		check("subagent_status registered", Boolean(statusTool));
		check("subagent_logs registered", Boolean(logsTool));
		check("subagent_stop registered", Boolean(stopTool));
		check("subagent_steer registered", Boolean(steerTool));
		check("subagent_wait registered", Boolean(waitTool));
		check("chain mode removed from the tool schema", !("chain" in (subagent.parameters?.properties ?? {})));
		if (!subagent) process.exit(1);

		const ctx = {
			cwd: projectDir,
			modelRegistry: {
				getAll: () => [
					{
						provider: "fake",
						id: "provider",
						reasoning: true,
						thinkingLevelMap: {
							off: null,
							minimal: null,
							low: null,
							medium: null,
							high: "high",
							xhigh: null,
							max: null,
						},
					},
				],
			},
			// The extension reads the root session id for usage attribution and nested
			// model-failback propagation; the harness runs without a hosted session.
			sessionManager: { getSessionId: () => "harness-session" },
		};
		const callTool = (tool, params) => tool.execute("harness-call", params, undefined, undefined, ctx);

		// Every subagent is a background run now. These data-flow assertions need the
		// settled transcript, so this helper starts a run and collects it through
		// subagent_wait: the same path a caller uses. It exposes the collected result
		// the way the old blocking call did, so the assertions below read unchanged.
		const run = async (params) => {
			const started = await subagent.execute("harness-call", params, undefined, undefined, ctx);
			const ids = [...(started.content[0]?.text ?? "").matchAll(/runId: (\d+)/g)].map((m) => m[1]);
			if (ids.length === 0) return started;
			const waited = await callTool(waitTool, { runIds: ids, timeoutMs: 30000 });
			const details = waited.details;
			// Mirror the first settled result's final text in `content`, matching the
			// shape a blocking call used to return.
			const settled = details?.results ?? [];
			const firstText = settled.length > 0 ? finalText(settled[0].messages) : "";
			return {
				content: [{ type: "text", text: firstText }],
				details,
				isError: settled.some((r) => isFailed(r)),
			};
		};
		const isFailed = (r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";

		// --- (1) tool_result_end-only keeps a durable toolResult ---------------
		console.log("\n[1] tool_result_end-only preserves a durable toolResult");
		const result1 = await run({ agent: "worker", task: "SCENARIO:tool_result_end_only" });
		const messages1 = result1.details.results[0].messages;
		const onlyToolResults = messages1.filter((m) => m.role === "toolResult" && m.toolCallId === "call-only");
		check(
			"final content is assistant text",
			result1.content[0]?.text === "FINAL-ANSWER-A",
			JSON.stringify(result1.content),
		);
		check("tool_result_end toolResult kept exactly once", onlyToolResults.length === 1);
		check(
			"toolResult content preserved",
			onlyToolResults[0]?.content?.[0]?.text === "TOOL-ONLY-SECRET",
			JSON.stringify(onlyToolResults[0]?.content),
		);
		check("no other toolResults", messages1.filter((m) => m.role === "toolResult").length === 1);
		check("result exitCode 0", result1.details.results[0].exitCode === 0);

		// --- (2) dedup with message_end sharing the same toolCallId ------------
		console.log("\n[2] tool_result_end + message_end with the same toolCallId are deduplicated");
		const result2 = await run({ agent: "worker", task: "SCENARIO:dedup" });
		const messages2 = result2.details.results[0].messages;
		const dupToolResults = messages2.filter((m) => m.role === "toolResult" && m.toolCallId === "call-dup");
		check("exactly one toolResult for call-dup", dupToolResults.length === 1);
		check(
			"final content is assistant text",
			result2.content[0]?.text === "FINAL-ANSWER-B",
			JSON.stringify(result2.content),
		);
		check("result exitCode 0", result2.details.results[0].exitCode === 0);

		// --- (3) tool_execution_update/end stay out of content/details ---------
		console.log("\n[3] tool_execution_update/end never enter content/details messages");
		const result3 = await run({ agent: "worker", task: "SCENARIO:transient" });
		const messages3 = result3.details.results[0].messages;
		const serialized3 = JSON.stringify(messages3);
		check("no toolResult messages", messages3.every((m) => m.role !== "toolResult"));
		check("no TRANSIENT text in transcript", !serialized3.includes("TRANSIENT"));
		check(
			"transcript is exactly the assistant message_end",
			messages3.length === 1 && messages3[0].role === "assistant",
			JSON.stringify(messages3.map((m) => m.role)),
		);
		check(
			"final content is assistant text",
			result3.content[0]?.text === "FINAL-ANSWER-C",
			JSON.stringify(result3.content),
		);
		check("details messages carry no transient output", !JSON.stringify(result3.details).includes("TRANSIENT"));

		// --- (4) model-failback updates result/Fleet model to final target --------
		console.log("\n[4] model-failback updates subagent model metadata");
		const resultFailback = await run({ agent: "worker", task: "SCENARIO:model_failback" });
		const failbackResult = resultFailback.details.results[0];
		check("failback final answer preserved", resultFailback.content[0]?.text === "FAILBACK-FINAL-ANSWER");
		check(
			"failback result model is final target",
			failbackResult.model === "rightcode-codex/gpt-5.6-terra",
			String(failbackResult.model),
		);

		// --- (4) parallel: every task becomes its own background run -------------
		console.log("\n[4] parallel mode starts one background run per task");
		const par = await subagent.execute(
			"harness-call",
			{
				tasks: [
					{ agent: "worker", task: "SCENARIO:tool_result_end_only" },
					{ agent: "worker", task: "SCENARIO:dedup" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const parText = par.content[0]?.text ?? "";
		const parIds = [...parText.matchAll(/runId: (\d+)/g)].map((m) => m[1]);
		check("parallel starts one run per task", parIds.length === 2, `ids=${parIds.join(",")}`);
		check("parallel does not return task output inline", !parText.includes("FINAL-ANSWER-A"));
		check("parallel lists every agent", parText.includes("worker"));

		const parWait = await callTool(waitTool, { runIds: parIds, timeoutMs: 20000 });
		const parWaitText = parWait.content[0]?.text ?? "";
		check(
			"subagent_wait collects every parallel result",
			parWaitText.includes("2/2 background subagent(s) finished"),
			parWaitText.split("\n")[0],
		);
		check(
			"parallel results carry both task outputs",
			parWaitText.includes("FINAL-ANSWER-A") && parWaitText.includes("FINAL-ANSWER-B"),
		);

		// --- (5) subagent_wait returns structured details for every run ----------
		console.log("\n[5] subagent_wait carries structured details for every settled run");
		const parWaitDetails = parWait.details;
		check("subagent_wait exposes details", Boolean(parWaitDetails));
		check("details record both parallel results", parWaitDetails?.results.length === 2, String(parWaitDetails?.results.length));
		check("details report parallel mode", parWaitDetails?.mode === "parallel", String(parWaitDetails?.mode));
		check(
			"details preserve each task's transcript",
			parWaitDetails?.results.every((r) => r.messages.some((m) => m.role === "assistant")) ?? false,
		);
		check("details carry the discovered agent scope", parWaitDetails?.agentScope === "both", String(parWaitDetails?.agentScope));

		// --- (6) agent config and cwd reach the subagent process ----------------
		console.log("\n[6] agent config and cwd reach the subagent process");
		const cfg = await run({ agent: "worker", task: "SCENARIO:tool_result_end_only" });
		const calls = fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const cfgCall = calls.find((c) => c.task === "SCENARIO:tool_result_end_only");
		const modelIndex = cfgCall.argv.indexOf("--model");
		const toolsIndex = cfgCall.argv.indexOf("--tools");
		const thinkingIndex = cfgCall.argv.indexOf("--thinking");
		check(
			"json mode flags passed",
			cfgCall.argv.includes("--mode") && cfgCall.argv.includes("--no-session") && cfgCall.argv.includes("-p"),
		);
		check("agent model flag passed", modelIndex >= 0 && cfgCall.argv[modelIndex + 1] === "fake/provider");
		check("agent thinking flag passed", thinkingIndex >= 0 && cfgCall.argv[thinkingIndex + 1] === "high");
		check("resolved thinkingLevel is stored in result", cfg.details.results[0].thinkingLevel === "high");
		check("agent tools flag passed", toolsIndex >= 0 && cfgCall.argv[toolsIndex + 1]?.split(",").includes("bash"));
		check("system prompt appended via file", cfgCall.argv.includes("--append-system-prompt"));
		check("agent system prompt content reached subagent", cfgCall.systemPrompt.includes(SYSTEM_PROMPT_BODY));
		check("subagent cwd forwarded", cfgCall.cwd === fs.realpathSync(projectDir), JSON.stringify(cfgCall.cwd));
		check("chain mode is gone from the tool schema", !JSON.stringify(cfgCall.argv).includes("{previous}"));

		// --- (9) message_update deltas stay out of the durable transcript ------
		console.log("\n[9] message_update thinking/text deltas stay out of the durable transcript");
		const result9 = await run({ agent: "worker", task: "SCENARIO:streaming" });
		const messages9 = result9.details.results[0].messages;
		const serialized9 = JSON.stringify(messages9);
		check(
			"final content is the authoritative message_end text",
			result9.content[0]?.text === "FINAL-ANSWER-STREAM",
			JSON.stringify(result9.content),
		);
		check("thinking/text deltas never enter the transcript", !serialized9.includes("THINKING-DELTA") && !serialized9.includes("STREAM-"), serialized9);
		check("authoritative thinking preserved from message_end", serialized9.includes("FULL-THINKING"));
		check(
			"transcript has exactly one assistant message and no toolResults",
			messages9.length === 1 && messages9[0].role === "assistant",
			JSON.stringify(messages9.map((m) => m.role)),
		);
		check("result exitCode 0", result9.details.results[0].exitCode === 0);

		// --- (10) malformed contentIndex is ignored without crashing ------------
		console.log("\n[10] malformed contentIndex is ignored without crashing");
		const result10 = await run({ agent: "worker", task: "SCENARIO:bad_index" });
		check(
			"final content is assistant text",
			result10.content[0]?.text === "FINAL-ANSWER-BADINDEX",
			JSON.stringify(result10.content),
		);
		check("malformed deltas never enter the transcript", !JSON.stringify(result10.details).includes("BAD-"));
		check("result exitCode 0", result10.details.results[0].exitCode === 0);

		// --- (5)-(8) stop-flow tests: POSIX-only (production uses taskkill /T on
		// Windows, which has no process-group SIGTERM/SIGKILL semantics) ---------
		const isWindows = process.platform === "win32";
		if (isWindows) {
			console.log("\n[5-8] stop-flow tests skipped on Windows (best-effort taskkill /T, no process-group semantics)");
		} else {

		// --- (5) stopping a running subagent via the parent AbortSignal ----------
		console.log("\n[5] abort stops a running subagent (SIGTERM, exit 130, stopped)");
		const logHasSignal = (taskMarker, signal) =>
			fs
				.readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.some((entry) => entry.signal === signal && typeof entry.task === "string" && entry.task.includes(taskMarker));
		// fake `pi` logs a ready marker once its signal handlers are installed;
		// abort only after that so a slow CI cannot race the handlers.
		const waitForReady = async (taskMarker) => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const entries = fs
					.readFileSync(logPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				if (entries.some((entry) => entry.ready && typeof entry.ready === "string" && entry.ready.includes(taskMarker))) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error(`fake pi did not become ready for ${taskMarker}`);
		};

		const started5 = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:long_running" },
			undefined,
			undefined,
			ctx,
		);
		const id5 = /runId: (\d+)/.exec(started5.content[0]?.text ?? "")?.[1];
		await waitForReady("SCENARIO:long_running");
		await callTool(stopTool, { runId: id5 });
		const result5 = await callTool(waitTool, { runIds: [id5], timeoutMs: 30000 });
		const r5 = result5.details.results[0];
		check("stopped result has exitCode 130", r5.exitCode === 130, String(r5.exitCode));
		check("stopped result reports stopReason 'stopped'", r5.stopReason === "stopped", String(r5.stopReason));
		check("stop is recorded in errorMessage", typeof r5.errorMessage === "string" && r5.errorMessage.length > 0, String(r5.errorMessage));
		check("SIGTERM reached the subagent process", logHasSignal("SCENARIO:long_running", "SIGTERM"));

		// --- (6) stopping every task of a parallel call --------------------------
		console.log("\n[6] each parallel task can be stopped individually");
		const started6 = await subagent.execute(
			"harness-call",
			{
				tasks: [
					{ agent: "worker", task: "SCENARIO:long_running P1" },
					{ agent: "worker", task: "SCENARIO:long_running P2" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const ids6 = [...(started6.content[0]?.text ?? "").matchAll(/runId: (\d+)/g)].map((m) => m[1]);
		check("parallel started two runs", ids6.length === 2, String(ids6.length));
		await waitForReady("SCENARIO:long_running P1");
		await waitForReady("SCENARIO:long_running P2");
		// Stop only the first task: the second must be unaffected.
		await callTool(stopTool, { runId: ids6[0] });
		const stopped6 = await callTool(waitTool, { runIds: [ids6[0]], timeoutMs: 30000 });
		check(
			"the stopped parallel task reports exit 130",
			stopped6.details.results[0]?.exitCode === 130,
			String(stopped6.details.results[0]?.exitCode),
		);
		const other6 = await callTool(statusTool, { runId: ids6[1] });
		check(
			"stopping one task leaves the other running",
			(other6.content[0]?.text ?? "").includes("status: running"),
			(other6.content[0]?.text ?? "").split("\n")[2],
		);
		await callTool(stopTool, { runId: ids6[1] });
		const both6 = await callTool(waitTool, { runIds: ids6, timeoutMs: 30000 });
		check(
			"both parallel tasks end up stopped",
			both6.details.results.every((r) => r.exitCode === 130 && r.stopReason === "stopped"),
			JSON.stringify(both6.details.results.map((r) => ({ code: r.exitCode, reason: r.stopReason }))),
		);
		check(
			"SIGTERM reached both subagent processes",
			logHasSignal("SCENARIO:long_running P1", "SIGTERM") && logHasSignal("SCENARIO:long_running P2", "SIGTERM"),
		);

		// --- (7) stubborn subagent: SIGKILL escalation after 5s ------------------
		console.log("\n[7] stubborn subagent is force-killed after the 5s SIGKILL escalation");
		const started7 = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:stubborn" },
			undefined,
			undefined,
			ctx,
		);
		const id7 = /runId: (\d+)/.exec(started7.content[0]?.text ?? "")?.[1];
		await waitForReady("SCENARIO:stubborn");
		const tAbort7 = Date.now();
		await callTool(stopTool, { runId: id7 });
		const result7 = await callTool(waitTool, { runIds: [id7], timeoutMs: 30000 });
		const elapsed7 = Date.now() - tAbort7;
		const r7 = result7.details.results[0];
		check("stubborn stop escalates to SIGKILL after ~5s", elapsed7 >= 5000 && elapsed7 < 12_000, `${elapsed7}ms`);
		check("force-killed result still reports exitCode 130", r7.exitCode === 130, String(r7.exitCode));
		check("SIGTERM was delivered before escalation", logHasSignal("SCENARIO:stubborn", "SIGTERM"));

		// --- (8) group kill reaches a descendant after the leader exits ---------
		// The fake leader spawns a same-group descendant that ignores SIGTERM.
		// The leader exits on SIGTERM; only the group SIGKILL escalation (5s)
		// can take the descendant down. This guards the README claim
		// "已退出组长的后代仍会被该进程组信号覆盖".
		console.log("\n[8] process-group termination reaches descendants after the leader exits");
		const waitForDescendantPid = async () => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const entries = fs
					.readFileSync(logPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				const entry = entries.find((e) => typeof e.descendantPid === "number" && e.task.includes("SCENARIO:descendant"));
				if (entry) return entry.descendantPid;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error("descendant pid was never logged");
		};
		const started8 = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:descendant" },
			undefined,
			undefined,
			ctx,
		);
		const id8 = /runId: (\d+)/.exec(started8.content[0]?.text ?? "")?.[1];
		const descendantPid = await waitForDescendantPid();
		// The descendant writes its own ready marker after installing its
		// ignore-SIGTERM handlers; only then is aborting safe.
		const waitForDescendantReady = async () => {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const entries = fs
					.readFileSync(logPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				if (entries.some((entry) => entry.descendantReady === true && entry.task && entry.task.includes("SCENARIO:descendant"))) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error("descendant never became ready");
		};
		await waitForDescendantReady();
		await waitForReady("SCENARIO:descendant");
		const tAbort8 = Date.now();
		await callTool(stopTool, { runId: id8 });
		const result8 = await callTool(waitTool, { runIds: [id8], timeoutMs: 30000 });
		const r8 = result8.details.results[0];
		check("descendant subagent stopped (exit 130)", r8.exitCode === 130 && r8.stopReason === "stopped", JSON.stringify({ code: r8.exitCode, reason: r8.stopReason }));
		check("leader exited on SIGTERM", logHasSignal("SCENARIO:descendant", "SIGTERM"));
		// Immediately after the leader exits, the descendant must still be alive:
		// it ignored SIGTERM, so only the 5s group SIGKILL escalation may kill it.
		let aliveAfterLeaderExit = false;
		try {
			process.kill(descendantPid, 0);
			aliveAfterLeaderExit = true;
		} catch {
			/* already gone */
		}
		check("descendant survives the SIGTERM round", aliveAfterLeaderExit);
		let descendantGone = false;
		let elapsedToGone = 0;
		while (Date.now() - tAbort8 < 8000) {
			try {
				process.kill(descendantPid, 0);
				await new Promise((resolve) => setTimeout(resolve, 200));
			} catch {
				descendantGone = true;
				elapsedToGone = Date.now() - tAbort8;
				break;
			}
		}
		check("descendant killed by the group SIGKILL escalation", descendantGone);
		check("descendant survived until the ~5s escalation", elapsedToGone >= 4000 && elapsedToGone < 8000, `${elapsedToGone}ms`);
		if (!descendantGone) {
			try {
				process.kill(descendantPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		} // end POSIX-only stop-flow tests

		// --- (9) background mode: async start, status/logs/stop, follow-up inject --
		console.log("\n[9] background subagent: async start, status, logs, stop, result injection");

		// (9a) A background run returns immediately with a usable runId.
		const bgStart = Date.now();
		const bgResult = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:long_running" },
			undefined,
			undefined,
			ctx,
		);
		const bgElapsed = Date.now() - bgStart;
		const bgText = bgResult.content[0]?.text ?? "";
		const bgRunId = /runId: (\d+)/.exec(bgText)?.[1];
		check("background call returns without waiting for the subagent", bgElapsed < 3000, `${bgElapsed}ms`);
		check("background call reports a runId", Boolean(bgRunId), bgText.slice(0, 80));

		// (9b) subagent_status lists it as running.
		const bgStatus = await callTool(statusTool, { runId: bgRunId });
		const bgStatusText = bgStatus.content[0]?.text ?? "";
		check("subagent_status reports running", bgStatusText.includes("status: running"), bgStatusText.split("\n")[2]);

		const bgList = await callTool(statusTool, {});
		check("subagent_status lists tracked runs", (bgList.content[0]?.text ?? "").includes(String(bgRunId)));

		// (9c) subagent_stop terminates it and the run settles as stopped.
		const bgStop = await callTool(stopTool, { runId: bgRunId });
		check("subagent_stop accepts the request", (bgStop.content[0]?.text ?? "").includes("Stop requested"));

		let bgSettled = false;
		for (let i = 0; i < 100; i++) {
			const s = await callTool(statusTool, { runId: bgRunId });
			if (!(s.content[0]?.text ?? "").includes("status: running")) {
				bgSettled = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		check("stopped background run leaves the running state", bgSettled);
		const bgFinal = await callTool(statusTool, { runId: bgRunId });
		check(
			"stopped background run reports status stopped",
			(bgFinal.content[0]?.text ?? "").includes("status: stopped"),
			(bgFinal.content[0]?.text ?? "").split("\n")[2],
		);

		// (9d) Stopping a settled run is a no-op, and unknown ids error out.
		const bgStopAgain = await callTool(stopTool, { runId: bgRunId });
		check(
			"stopping a settled run reports it is already terminal",
			(bgStopAgain.content[0]?.text ?? "").includes("already stopped"),
		);
		const bgUnknown = await callTool(stopTool, { runId: "does-not-exist" });
		check("unknown runId is rejected", bgUnknown.isError === true);

		// (9e) subagent_logs reads a settled run's transcript.
		const bgLogs = await callTool(logsTool, { runId: bgRunId });
		check("subagent_logs returns the transcript", (bgLogs.content[0]?.text ?? "").includes("Run " + bgRunId));

		// (9f) A finished-but-uncollected run is reported once, at turn end.
		// Notifications are deliberately deferred to agent_settled: by then the agent
		// has usually collected the result itself, and no message is sent at all.
		const fireSettled = async () => {
			for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
		};
		const injectBefore = sentUserMessages.length;
		const bgDone = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_result_end_only" },
			undefined,
			undefined,
			ctx,
		);
		const bgDoneId = /runId: (\d+)/.exec(bgDone.content[0]?.text ?? "")?.[1];
		// Wait for the run to settle without collecting it through subagent_wait.
		for (let i = 0; i < 100; i++) {
			const s = await callTool(statusTool, { runId: bgDoneId });
			if (!(s.content[0]?.text ?? "").includes("status: running")) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await fireSettled();
		const reminded = sentUserMessages.slice(injectBefore);
		check("an uncollected run is reported at turn end", reminded.length === 1, String(reminded.length));
		check(
			"the reminder uses followUp delivery",
			reminded[0]?.options?.deliverAs === "followUp",
			JSON.stringify(reminded[0]?.options),
		);
		check(
			"the reminder carries the subagent's output preview",
			String(reminded[0]?.content ?? "").includes("FINAL-ANSWER-A"),
			String(reminded[0]?.content ?? "").slice(0, 120),
		);
		check(
			"the reminder names the runId",
			String(reminded[0]?.content ?? "").includes(String(bgDoneId)),
		);
		// It must not be reported a second time.
		await fireSettled();
		check(
			"an already-reported run is not reported again",
			sentUserMessages.length === injectBefore + 1,
			String(sentUserMessages.length - injectBefore),
		);
		// Collecting it silences future reminders even if one was missed.
		await callTool(waitTool, { runIds: [bgDoneId], timeoutMs: 5000 });
		await fireSettled();
		check(
			"a collected run produces no reminder",
			sentUserMessages.length === injectBefore + 1,
			String(sentUserMessages.length - injectBefore),
		);

		// (9g) A run finishing while the agent is idle reports immediately.
		// Nothing else would wake the agent in that state, so the reminder must not
		// wait for a settle that may never come.
		const idleBefore = sentUserMessages.length;
		ctx.isIdle = () => true;
		const idleRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_result_end_only" },
			undefined,
			undefined,
			ctx,
		);
		const idleRunId = /runId: (\d+)/.exec(idleRun.content[0]?.text ?? "")?.[1];
		let idleReminded;
		for (let i = 0; i < 100; i++) {
			idleReminded = sentUserMessages.slice(idleBefore).find((m) => String(m.content).includes("waiting to be collected"));
			if (idleReminded) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		check("an idle-settled run reports without waiting for another turn", Boolean(idleReminded));
		check(
			"the immediate reminder names the runId",
			String(idleReminded?.content ?? "").includes(String(idleRunId)),
		);
		await fireSettled();
		check(
			"the immediate reminder is not repeated at turn end",
			sentUserMessages.length === idleBefore + 1,
			String(sentUserMessages.length - idleBefore),
		);
		ctx.isIdle = () => false;

		// (9i) subagent_wait collects results reliably, independent of injection.
		const waitRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_result_end_only" },
			undefined,
			undefined,
			ctx,
		);
		const waitRunId = /runId: (\d+)/.exec(waitRun.content[0]?.text ?? "")?.[1];
		check("wait target started", Boolean(waitRunId));
		const waited = await callTool(waitTool, { runIds: [waitRunId], timeoutMs: 20000 });
		const waitedText = waited.content[0]?.text ?? "";
		check("subagent_wait returns once the run settles", waitedText.includes("finished"), waitedText.split("\n")[0]);
		check("subagent_wait carries the subagent's final output", waitedText.includes("FINAL-ANSWER-A"));
		check("subagent_wait reports the terminal status", /run \d+ — completed/.test(waitedText));

		// (9j) subagent_wait honours a timeout and reports still-running runs.
		const slowRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:long_running" },
			undefined,
			undefined,
			ctx,
		);
		const slowRunId = /runId: (\d+)/.exec(slowRun.content[0]?.text ?? "")?.[1];
		const timedOutWait = await callTool(waitTool, { runIds: [slowRunId], timeoutMs: 600 });
		const timedOutText = timedOutWait.content[0]?.text ?? "";
		check("subagent_wait honours its timeout", timedOutText.includes("still running"), timedOutText.split("\n")[0]);
		check("subagent_wait reports 0 finished on timeout", /0\/1 finished/.test(timedOutText));

		// (9j-2) Waiting can block for the whole timeout, so it must stay
		// interruptible and must not look hung while it waits.
		const ac = new AbortController();
		const progressUpdates = [];
		const abortWait = waitTool.execute(
			"harness-call",
			{ runIds: [slowRunId], timeoutMs: 60_000 },
			ac.signal,
			(update) => progressUpdates.push(update),
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		check(
			"subagent_wait reports progress while waiting",
			progressUpdates.length > 0 && String(progressUpdates[0]?.content?.[0]?.text ?? "").includes("settled"),
			JSON.stringify(progressUpdates[0]?.content?.[0]?.text),
		);
		ac.abort();
		// Race the wait against a short deadline so a wait that ignores the signal
		// fails the assertion instead of hanging the suite.
		const abortedResult = await Promise.race([
			abortWait,
			new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
		]);
		const abortedText = abortedResult?.content?.[0]?.text ?? "";
		check(
			"aborting subagent_wait ends the wait early",
			abortedText.includes("aborted"),
			abortedText.split("\n")[0] || "(still waiting after 3s)",
		);
		check(
			"aborting the wait leaves the subagent running",
			(await callTool(statusTool, { runId: slowRunId })).content[0]?.text?.includes("status: running"),
		);
		if (slowRunId) await callTool(stopTool, { runId: slowRunId });

		// (9k) Waiting on an unknown id is reported, not silently ignored.
		const badWait = await callTool(waitTool, { runIds: ["nope"], timeoutMs: 500 });
		check(
			"subagent_wait reports unknown run ids",
			(badWait.content[0]?.text ?? "").includes("No such run"),
			(badWait.content[0]?.text ?? "").slice(0, 60),
		);

		// (9l) A settled-but-uncollected run is still reachable without passing ids,
		// so a result is never dropped just because the caller omitted the runId.
		const orphan = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_result_end_only" },
			undefined,
			undefined,
			ctx,
		);
		const orphanId = /runId: (\d+)/.exec(orphan.content[0]?.text ?? "")?.[1];
		await new Promise((resolve) => setTimeout(resolve, 800));
		const noArgWait = await callTool(waitTool, { timeoutMs: 5000 });
		const noArgText = noArgWait.content[0]?.text ?? "";
		check(
			"no-arg subagent_wait collects a settled, uncollected run",
			noArgText.includes("FINAL-ANSWER-A"),
			noArgText.split("\n")[0],
		);
		const drained = await callTool(waitTool, { timeoutMs: 500 });
		check(
			"collected results leave the outstanding set",
			(drained.content[0]?.text ?? "").includes("No background subagent result is outstanding"),
			(drained.content[0]?.text ?? "").slice(0, 70),
		);
		const afterCollect = await callTool(logsTool, { runId: orphanId });
		check(
			"a collected run is still readable by id",
			(afterCollect.content[0]?.text ?? "").includes("Run " + orphanId),
			(afterCollect.content[0]?.text ?? "").slice(0, 60),
		);

		// (9m) The transcript must show what the subagent actually did.
		// `subagent` only announces runs (its details carry no results); the settled
		// record arrives through `subagent_wait`. Both must render the tool-call
		// activity, otherwise the run is invisible in the TUI even though the result
		// is correct — a regression that output-only assertions cannot catch.
		// Theme helpers wrap content ("bg"/"fg" take a color then the text, "bold"
		// takes the text), so echoing the last argument yields the visible text.
		const fakeTheme = new Proxy(
			{},
			{ get: () => (...args) => String(args[args.length - 1] ?? "") },
		);
		check(
			"subagent_wait executes its own renderResult",
			typeof waitTool.renderResult === "function",
		);
		const renderToText = (tool, result) => {
			if (typeof tool.renderResult !== "function") return "";
			const component = tool.renderResult(result, { expanded: true, isPartial: false }, fakeTheme, {
				isError: false,
			});
			return component.render(200).join("\n");
		};
		const renderedWait = renderToText(waitTool, await callTool(waitTool, { runIds: [orphanId], timeoutMs: 5000 }));
		check(
			"subagent_wait renders the subagent's tool calls",
			renderedWait.includes("bash"),
			renderedWait.slice(0, 160),
		);
		// A realistic run that actually calls tools: the transcript must show the
		// calls, which is the whole point of rendering the settled record.
		const toolRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_calls" },
			undefined,
			undefined,
			ctx,
		);
		const toolRunId = /runId: (\d+)/.exec(toolRun.content[0]?.text ?? "")?.[1];
		const toolWaitResult = await callTool(waitTool, { runIds: [toolRunId], timeoutMs: 5000 });
		const renderWith = (expanded) => {
			if (typeof waitTool.renderResult !== "function") return "";
			return waitTool
				.renderResult(toolWaitResult, { expanded, isPartial: false }, fakeTheme, { isError: false })
				.render(200)
				.join("\n");
		};
		const collapsedText = renderWith(false);
		const expandedText = renderWith(true);
		check(
			"the collapsed transcript shows which tools ran",
			collapsedText.includes("bash") && collapsedText.includes("read"),
			collapsedText.slice(0, 200),
		);
		check("the expanded transcript shows tool arguments", expandedText.includes("ls /tmp/tool-call-demo"));
		check(
			"the expanded transcript shows tool results",
			expandedText.includes("line-one") && expandedText.includes("data.txt"),
			expandedText.slice(0, 200),
		);
		check(
			"the final output is still rendered",
			collapsedText.includes("FINAL-ANSWER-TOOLS"),
			collapsedText.slice(-160),
		);
		check(
			"subagent_wait exposes renderShell self so the rail is not doubled",
			waitTool.renderShell === "self",
			String(waitTool.renderShell),
		);

		// (9n) The `subagent` row must show a started run live. Its details carry no
		// settled results, so the renderer reads the run's live FleetStore entry;
		// otherwise the row degrades to plain announcement text and the user cannot
		// see which tools the running subagent is calling.
		const renderSubagentRow = (result, expanded = false) => {
			if (typeof subagent.renderResult !== "function") return "";
			return subagent
				.renderResult(result, { expanded, isPartial: false }, fakeTheme, { isError: false })
				.render(200)
				.join("\n");
		};
		const liveRunStarted = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:long_running" },
			undefined,
			undefined,
			ctx,
		);
		const liveRunId = /runId: (\d+)/.exec(liveRunStarted.content[0]?.text ?? "")?.[1];
		check(
			"subagent details carry liveRunIds for a started run",
			Array.isArray(liveRunStarted.details?.liveRunIds) &&
				liveRunStarted.details.liveRunIds.includes(liveRunId),
			JSON.stringify(liveRunStarted.details?.liveRunIds),
		);
		check("subagent exposes its own renderResult", typeof subagent.renderResult === "function");
		const liveRowText = renderSubagentRow(liveRunStarted);
		check(
			"the subagent row shows the running run's agent",
			liveRowText.includes("worker") && liveRowText.includes("(project)"),
			liveRowText.slice(0, 160),
		);
		check(
			"the subagent row shows the run as running",
			liveRowText.includes("running"),
			liveRowText.slice(0, 160),
		);
		if (liveRunId) await callTool(stopTool, { runId: liveRunId });

		// (9o) While a run is working, its row must show both the tool calls it has
		// already made and the one executing right now. The in-flight call is not in
		// the durable transcript, so this is the case that only a live view covers.
		const workingRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_in_flight" },
			undefined,
			undefined,
			ctx,
		);
		const workingRunId = /runId: (\d+)/.exec(workingRun.content[0]?.text ?? "")?.[1];
		let workingRowText = "";
		for (let i = 0; i < 60; i++) {
			workingRowText = renderSubagentRow(workingRun);
			if (workingRowText.includes("bash") && workingRowText.includes("read")) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		check(
			"a working run's row shows the tool it already called",
			workingRowText.includes("read"),
			workingRowText.slice(0, 220),
		);
		check(
			"a working run's row shows the tool still executing",
			workingRowText.includes("bash"),
			workingRowText.slice(0, 220),
		);
		check(
			"a working run's row is marked as running, not finished",
			workingRowText.includes("running") && !workingRowText.includes("FINAL-ANSWER"),
			workingRowText.slice(0, 220),
		);
		const workingExpanded = renderSubagentRow(workingRun, true);
		check(
			"an expanded working row shows the in-flight tool's streaming output",
			workingExpanded.includes("IN-FLIGHT-OUTPUT"),
			workingExpanded.slice(-240),
		);

		// (9p) The row is CONSTRUCTED once, when the tool returns, and the TUI then
		// repaints that same component tree. A component that snapshots FleetStore
		// at construction shows nothing for the rest of the run; it must re-read
		// state on every render instead.
		const frozenRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_in_flight" },
			undefined,
			undefined,
			ctx,
		);
		const frozenRunId = /runId: (\d+)/.exec(frozenRun.content[0]?.text ?? "")?.[1];
		// Build the component while the run has produced nothing yet.
		const frozenComponent = subagent.renderResult(frozenRun, { expanded: true, isPartial: false }, fakeTheme, {
			isError: false,
		});
		const firstFrame = frozenComponent.render(200).join("\n");
		check(
			"a just-started row shows no activity yet, and says it is starting",
			!firstFrame.includes("read") && !firstFrame.includes("IN-FLIGHT-OUTPUT") && firstFrame.includes("starting"),
			firstFrame.slice(0, 160),
		);
		// Let the run make progress, then repaint WITHOUT rebuilding the component.
		let laterFrame = "";
		for (let i = 0; i < 60; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			laterFrame = frozenComponent.render(200).join("\n");
			if (laterFrame.includes("IN-FLIGHT-OUTPUT")) break;
		}
		check(
			"repainting the same component shows the tool the run called meanwhile",
			laterFrame.includes("read"),
			laterFrame.slice(0, 220),
		);
		check(
			"repainting the same component shows in-flight streaming output",
			laterFrame.includes("IN-FLIGHT-OUTPUT"),
			laterFrame.slice(0, 220),
		);
		if (frozenRunId) await callTool(stopTool, { runId: frozenRunId });
		if (workingRunId) await callTool(stopTool, { runId: workingRunId });

		// After the run settles, its durable messages hold the tool calls. Reading
		// the announced row without collecting through subagent_wait must surface
		// them, so an uncollected run is still legible in the transcript.
		const settledLiveRun = await subagent.execute(
			"harness-call",
			{ agent: "worker", task: "SCENARIO:tool_calls" },
			undefined,
			undefined,
			ctx,
		);
		const settledLiveRunId = /runId: (\d+)/.exec(settledLiveRun.content[0]?.text ?? "")?.[1];
		for (let i = 0; i < 50; i++) {
			const s = await callTool(statusTool, { runId: settledLiveRunId });
			if (!(s.content[0]?.text ?? "").includes("status: running")) break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const settledLiveRowText = renderSubagentRow(settledLiveRun);
		check(
			"the uncollected subagent row shows a tool the run called",
			settledLiveRowText.includes("bash"),
			settledLiveRowText.slice(0, 200),
		);

		// --- (10) steer: the control channel reaches the running subagent --------
		console.log("\n[10] subagent_steer delivers an instruction to a running subagent");
		const readFakeLog = () => {
			if (!fs.existsSync(logPath)) return [];
			return fs
				.readFileSync(logPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return {};
					}
				});
		};

		if (isWindows) {
			console.log("  skip  steer tests are POSIX-only (AF_UNIX control channel)");
		} else {
			const steerRun = await subagent.execute(
				"harness-call",
				{ agent: "worker", task: "SCENARIO:steerable" },
				undefined,
				undefined,
				ctx,
			);
			const steerRunId = /runId: (\d+)/.exec(steerRun.content[0]?.text ?? "")?.[1];
			check("steerable background run started", Boolean(steerRunId));

			let socketPath;
			for (let i = 0; i < 100; i++) {
				const entry = readFakeLog().find((e) => e.steerable);
				if (entry?.socketPath) {
					socketPath = entry.socketPath;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			check("subagent received SUBAGENT_CONTROL_SOCKET", Boolean(socketPath), String(socketPath));

			const steerSent = await callTool(steerTool, { runId: steerRunId, message: "CHANGE-DIRECTION-NOW" });
			check(
				"subagent_steer reports the message was queued",
				(steerSent.content[0]?.text ?? "").includes("Steering message queued"),
				(steerSent.content[0]?.text ?? "").slice(0, 100),
			);

			let delivered;
			for (let i = 0; i < 100; i++) {
				delivered = readFakeLog().find((e) => e.steerReceived);
				if (delivered) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			check("steer reached the subagent process", Boolean(delivered), JSON.stringify(delivered?.steerReceived));
			check(
				"steer payload is intact",
				delivered?.steerReceived?.type === "steer" &&
					delivered?.steerReceived?.message === "CHANGE-DIRECTION-NOW",
			);

			await callTool(stopTool, { runId: steerRunId });
			for (let i = 0; i < 100; i++) {
				const s = await callTool(statusTool, { runId: steerRunId });
				if (!(s.content[0]?.text ?? "").includes("status: running")) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const steerAfterStop = await callTool(steerTool, { runId: steerRunId, message: "too late" });
			check(
				"steering a settled run is rejected",
				steerAfterStop.isError === true &&
					(steerAfterStop.content[0]?.text ?? "").includes("can no longer be steered"),
				(steerAfterStop.content[0]?.text ?? "").slice(0, 90),
			);
			const steerUnknown = await callTool(steerTool, { runId: "nope", message: "x" });
			check("steering an unknown run is rejected", steerUnknown.isError === true);
		}
	} finally {
		process.env.PATH = savedEnv.PATH ?? "";
		process.env.FAKE_PI_LOG = savedEnv.FAKE_PI_LOG ?? "";
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("harness error:", error);
	process.exit(1);
});
