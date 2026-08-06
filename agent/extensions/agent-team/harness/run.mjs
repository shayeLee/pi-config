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
	};
	return { api, handlers, tools, commands, shortcuts };
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
		const { api, handlers, tools, commands, shortcuts } = createMockExtensionApi();
		await factory(api);

		const subagent = tools.get("subagent");
		check("subagent tool registered", Boolean(subagent));
		check("session_start handler registered", (handlers.get("session_start") ?? []).length === 1);
		check("subagents command registered", Boolean(commands.get("subagents")));
		check("ctrl+alt+f shortcut registered", Boolean(shortcuts.get("ctrl+alt+f")));
		if (!subagent) process.exit(1);

		const ctx = { cwd: projectDir };
		const run = (params) => subagent.execute("harness-call", params, undefined, undefined, ctx);

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

		// --- (4) chain {previous} only from the previous final assistant text ---
		console.log("\n[4] chain {previous} is replaced only by the previous step's final assistant text");
		const result4 = await run({
			chain: [
				{ agent: "worker", task: "SCENARIO:chain STEP:1" },
				{ agent: "worker", task: "SCENARIO:chain STEP:2 echo {previous}" },
			],
		});
		const details4 = result4.details;
		const steps4 = details4.results;
		check("two chain steps recorded", steps4.length === 2, String(steps4.length));
		check("both steps exited 0", steps4.every((s) => s.exitCode === 0));
		check(
			"final content is last step's assistant text",
			result4.content[0]?.text === "CHAIN-SECOND-ANSWER",
			JSON.stringify(result4.content),
		);
		const step1 = steps4[0];
		const step2 = steps4[1];
		check(
			"step1 transcript keeps its own durable tool result",
			step1.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call-chain-tool"),
		);
		check("step1 final text is CHAIN-FIRST-ANSWER", finalText(step1.messages) === "CHAIN-FIRST-ANSWER");
		check("step2 final text is CHAIN-SECOND-ANSWER", finalText(step2.messages) === "CHAIN-SECOND-ANSWER");

		// What each fake subagent process actually received (recorded via $FAKE_PI_LOG).
		const calls = fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const step1Call = calls.find((c) => c.task.includes("STEP:1"));
		const step2Call = calls.find((c) => c.task.includes("STEP:2"));
		check("step1 subagent invoked with its task", step1Call?.task === "SCENARIO:chain STEP:1");
		check(
			"step2 subagent invoked with {previous} substituted",
			step2Call?.task === "SCENARIO:chain STEP:2 echo CHAIN-FIRST-ANSWER",
			JSON.stringify(step2Call?.task),
		);
		check("{previous} never includes step1 tool result text", step2Call && !step2Call.task.includes("CHAIN-TOOL-SECRET"));
		check("{previous} never includes a full transcript", step2Call && !step2Call.task.includes("FINAL-ANSWER-A"));
		check("subagent cwd forwarded", step1Call?.cwd === fs.realpathSync(projectDir), JSON.stringify(step1Call?.cwd));

		// Temp agent config reached the child process.
		const modelIndex = step1Call.argv.indexOf("--model");
		const toolsIndex = step1Call.argv.indexOf("--tools");
		check("json mode flags passed", step1Call.argv.includes("--mode") && step1Call.argv.includes("--no-session") && step1Call.argv.includes("-p"));
		check("agent model flag passed", modelIndex >= 0 && step1Call.argv[modelIndex + 1] === "fake/provider");
		check("agent tools flag passed", toolsIndex >= 0 && step1Call.argv[toolsIndex + 1]?.split(",").includes("bash"));
		check("system prompt appended via file", step1Call.argv.includes("--append-system-prompt"));
		check("agent system prompt content reached subagent", step1Call.systemPrompt.includes(SYSTEM_PROMPT_BODY));
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
