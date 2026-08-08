#!/usr/bin/env node
/**
 * agent-team presentation-layer harness
 *
 * Automates the "展示层" guarantees of the data/presentation separation
 * principle (see ../README.md "核心原则：数据与展示分离"):
 *   - FleetStore: the state container consumed by the UI. State transitions,
 *     listener notifications, prune/restore limits, no-op stops.
 *   - FleetWidget.render: the TUI FleetView — 6-item cap, 15s retention,
 *     task truncation, running counter. Driven by a mock TUI/theme; no real
 *     terminal involved.
 *   - Fleet web serialization (webRun/selectWebRun/serializeFleetRun): payload
 *     size cap (256 KiB), message/text/part truncation, edit-argument
 *     sanitization, omission counters. This is the presentation layer's own
 *     read-only snapshot of the data-flow products; it must never mutate them.
 *   - FleetWebServer HTTP: token auth (404 on wrong token), revision
 *     increment, JSON data endpoint, SSE update events, clean close. The
 *     browser-open step is injected with a stub so no window is launched.
 *
 * Run:
 *   node agent/extensions/agent-team/harness/presentation.mjs
 *
 * Same pi-coding-agent package discovery as run.mjs ($PI_PACKAGE_ROOT or the
 * $VOLTA_HOME image-package layout).
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HARNESS_DIR, "..");

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

function findPiPackageRoot() {
	const explicit = process.env.PI_PACKAGE_ROOT;
	if (explicit) {
		const resolved = path.resolve(explicit);
		if (fs.existsSync(path.join(resolved, "dist/index.js"))) return resolved;
		console.error(`PI_PACKAGE_ROOT set but no dist/index.js found in: ${resolved}`);
		process.exit(1);
	}
	const voltaHome = process.env.VOLTA_HOME || path.join(os.homedir(), ".volta");
	const candidate = path.join(
		voltaHome,
		"tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent",
	);
	if (fs.existsSync(path.join(candidate, "dist/index.js"))) return candidate;
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

function mockTheme() {
	// Every Theme method returns the last argument (the rendered text) so
	// styling has no effect on width assertions.
	return new Proxy(
		{},
		{
			get: (_target, _prop) => (...args) => (args.length > 1 ? args[args.length - 1] : args[0]),
		},
	);
}

function mockTui() {
	return {
		requestRender() {},
		terminal: { rows: 24 },
	};
}

function makeRun(overrides = {}) {
	return {
		id: "1",
		mode: "single",
		agent: "worker",
		task: "inspect the repo",
		messages: [],
		toolUpdates: {},
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: "fake/provider",
		status: "running",
		startedAt: Date.now(),
		stop: () => false,
		...overrides,
	};
}

function bigText(bytes) {
	return "x".repeat(bytes);
}

async function main() {
	const pkgRoot = findPiPackageRoot();
	const jitiEntry = pathToFileURL(path.join(pkgRoot, "dist/index.js")).href;
	const require = createRequire(jitiEntry);
	const { createJiti } = await import(
		pathToFileURL(path.join(pkgRoot, "node_modules/jiti/lib/jiti-static.mjs")).href
	);
	const jiti = createJiti(jitiEntry, { moduleCache: false, alias: extensionAliases(pkgRoot, require) });

	const fleetStoreModule = await jiti.import(path.join(EXTENSION_DIR, "fleet-store.ts"));
	const fleetView = await jiti.import(path.join(EXTENSION_DIR, "fleet-view.ts"));
	const fleetWeb = await jiti.import(path.join(EXTENSION_DIR, "fleet-web.ts"));
	const piTui = await jiti.import(path.join(pkgRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"));
	const { FleetStore } = fleetStoreModule;
	const { FleetWidget } = fleetView;
	const { FleetWebServer, webRun, selectWebRun, serializeFleetRun, WEB_RUN_OPTIONS } = fleetWeb;
	const { visibleWidth } = piTui;

	// ------------------------------------------------------------------------
	console.log("\n[0] data-flow layer must not depend on the presentation layer");
	{
		const indexSource = fs.readFileSync(path.join(EXTENSION_DIR, "index.ts"), "utf8");
		const storeSource = fs.readFileSync(path.join(EXTENSION_DIR, "fleet-store.ts"), "utf8");
		const viewSource = fs.readFileSync(path.join(EXTENSION_DIR, "fleet-view.ts"), "utf8");
		const webSource = fs.readFileSync(path.join(EXTENSION_DIR, "fleet-web.ts"), "utf8");
		const agentsSource = fs.readFileSync(path.join(EXTENSION_DIR, "agents.ts"), "utf8");
		// Collect symbols from every static named import of a specifier (handles
		// multiple import statements, single/double quotes, `type` modifiers).
		const importSymbols = (source, spec) => {
			const symbols = [];
			const re = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*['\"]${spec}['\"]`, "g");
			let match;
			while ((match = re.exec(source))) {
				for (const part of match[1].split(",")) {
					const symbol = part.trim().replace(/^type\s*/, "");
					if (symbol) symbols.push(symbol);
				}
			}
			return symbols;
		};
		const UI_ONLY = new Set(["FleetWidget", "showFleetOverlay", "FleetWebServer"]);
		const viewSymbols = importSymbols(indexSource, "./fleet-view.ts");
		const webSymbols = importSymbols(indexSource, "./fleet-web.ts");
		check(
			"index.ts imports only UI symbols from the presentation layer",
			viewSymbols.every((s) => UI_ONLY.has(s)) && webSymbols.every((s) => UI_ONLY.has(s)),
			[...viewSymbols, ...webSymbols].join(", "),
		);
		const storeSymbols = importSymbols(indexSource, "./fleet-store.ts");
		check("index.ts pulls FleetStore from the neutral fleet-store.ts", storeSymbols.includes("FleetStore"));
		// Only named static imports are allowed from local modules (no default,
		// namespace, or dynamic imports that could smuggle a layer across).
		const hasForbiddenImportKind = (source, spec) => {
			const re = new RegExp(`import\\s*(?:\\*\\s*as\\s+\\w+|\\w+)\\s*from\\s*['\"]${spec}['\"]`, "g");
			return re.test(source);
		};
		check(
			"index.ts uses only named imports from local modules",
			!["./fleet-view.ts", "./fleet-web.ts", "./fleet-store.ts"].some((spec) => hasForbiddenImportKind(indexSource, spec)),
		);
		// Locate the composition-root body precisely (brace matching, string- and
		// comment-aware) so UI symbols are only allowed inside that function.
		const defaultFnIndex = indexSource.indexOf("export default function");
		const fnOpen = indexSource.indexOf("{", defaultFnIndex);
		let depth = 0;
		let fnClose = -1;
		let inString = false;
		let stringChar = "";
		let inLineComment = false;
		let inBlockComment = false;
		for (let i = fnOpen; i < indexSource.length && fnClose === -1; i++) {
			const ch = indexSource[i];
			const next = indexSource[i + 1];
			if (inLineComment) {
				if (ch === "\n") inLineComment = false;
				continue;
			}
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					i++;
				}
				continue;
			}
			if (inString) {
				if (ch === "\\") {
					i++;
					continue;
				}
				if (ch === stringChar) inString = false;
				continue;
			}
			if (ch === "/" && next === "/") {
				inLineComment = true;
				i++;
				continue;
			}
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				inString = true;
				stringChar = ch;
				continue;
			}
			if (ch === "{") depth++;
			if (ch === "}") {
				depth--;
				if (depth === 0) fnClose = i;
			}
		}
		check("composition root body span is found", fnOpen >= 0 && fnClose > fnOpen);
		for (const symbol of [...UI_ONLY]) {
			const uses = [];
			let from = 0;
			while ((from = indexSource.indexOf(symbol, from)) !== -1) {
				const lineStart = indexSource.lastIndexOf("\n", from) + 1;
				const lineEnd = indexSource.indexOf("\n", from);
				const line = indexSource.slice(lineStart, lineEnd === -1 ? indexSource.length : lineEnd);
				if (line.includes("import")) {
					from += symbol.length;
					continue;
				}
				uses.push(from);
				from += symbol.length;
			}
			check(
				`${symbol} used only inside the composition root`,
				uses.length > 0 && uses.every((pos) => pos > fnOpen && pos < fnClose),
				JSON.stringify(uses),
			);
		}
		const forbiddenFrom = (source, specs) => !specs.some((spec) => source.includes(`from \"${spec}`) || source.includes(`from '${spec}`));
		check("fleet-store.ts imports from neither layer", forbiddenFrom(storeSource, ["./fleet-view", "./fleet-web", "./index"]));
		check("fleet-view.ts imports only from the neutral contract", importSymbols(viewSource, "./index.ts").length === 0 && importSymbols(viewSource, "./fleet-web.ts").length === 0);
		check("fleet-web.ts imports only from the neutral contract", importSymbols(webSource, "./index.ts").length === 0 && importSymbols(webSource, "./fleet-view.ts").length === 0);
		check("agents.ts imports from neither presentation layer nor fleet-store", forbiddenFrom(agentsSource, ["./fleet-view", "./fleet-web", "./fleet-store", "./index"]));
	}

	// ------------------------------------------------------------------------
	console.log("\n[1] FleetStore state container");
	// --- add / ids / notifications ------------------------------------------
	{
		const store = new FleetStore();
		let notified = 0;
		const unsubscribe = store.subscribe(() => notified++);
		const run = store.add(makeRun({ agent: "worker-a" }));
		check("add assigns id 1", run.id === "1");
		check("add starts as running", run.status === "running");
		check("add notifies subscribers", notified === 1);
		check("store lists the run", store.list().length === 1);
		check("store.stop on running calls run.stop", (() => {
			let stopped = false;
			const r = store.add(makeRun({ stop: () => (stopped = true) }));
			const ok = store.stop(r.id);
			return ok && stopped;
		})());
		check("finish flips status and sets endedAt", (() => {
			const r = store.add(makeRun());
			store.finish(r, "completed");
			return r.status === "completed" && r.endedAt !== undefined && r.stopping === false;
		})());
		check("finish is a no-op on a finished run", (() => {
			const r = store.add(makeRun());
			store.finish(r, "completed");
			const endedAt = r.endedAt;
			store.finish(r, "failed");
			return r.status === "completed" && r.endedAt === endedAt;
		})());
		check("stop returns false for unknown id", store.stop("nope") === false);
		check("stop returns false for a finished run", (() => {
			const r = store.add(makeRun());
			store.finish(r, "completed");
			return store.stop(r.id) === false;
		})());
		check("markStopping flags a running run once", (() => {
			const r = store.add(makeRun());
			store.markStopping(r);
			const first = r.stopping;
			store.markStopping(r);
			return first === true && r.stopping === true;
		})());
		check("clear empties the store", (() => {
			store.add(makeRun());
			store.clear();
			return store.list().length === 0;
		})());
		check("touch notifies", (() => {
			const before = notified;
			store.touch();
			return notified === before + 1;
		})());
		unsubscribe();
		check("unsubscribe stops notifications", (() => {
			const before = notified;
			store.touch();
			return notified === before;
		})());
	}

	// --- prune: >32 removes oldest completed, keeps running -------------------
	{
		const store = new FleetStore();
		for (let i = 0; i < 33; i++) store.add(makeRun({ agent: `a${i}` }));
		check("33 running runs are all kept (prune needs completed)", store.list().length === 33);
		for (const run of store.list().slice(0, 10)) store.finish(run, "completed");
		const before = store.list().map((r) => r.agent);
		const beforeRunning = store.list().filter((r) => r.status === "running");
		store.add(makeRun({ agent: "extra" }));
		const after = store.list();
		const afterAgents = after.map((r) => r.agent);
		check("prune keeps at most 32 runs", after.length === 32);
		// 34 entries after the extra add: the two oldest completed (a0, a1) are removed.
		check("prune removed exactly the two oldest completed runs", !afterAgents.includes("a0") && !afterAgents.includes("a1") && afterAgents.includes("a2") && afterAgents.includes("a9"));
		// Identity check: the exact run objects held by the data-flow layer survive.
		check("prune keeps every running run by object identity", beforeRunning.every((run) => after.includes(run)));
		const removed = before.filter((agent) => !afterAgents.includes(agent));
		check("prune removed exactly the oldest completed objects", removed.length === 2 && removed[0] === "a0" && removed[1] === "a1", removed.join(", "));
		check("prune keeps the new extra run", afterAgents.includes("extra"));
		// Net change is 1 (two completed removed, one running added).
		check("prune net change is one run", before.length - after.length === 1);
	}

	// --- restore: history rebuild, running preserved, stop is a no-op ---------
	{
		const store = new FleetStore();
		const active = store.add(makeRun({ agent: "active" }));
		const restored = [];
		for (let i = 0; i < 40; i++) {
			restored.push({
				...makeRun({ id: undefined, agent: `hist-${i}`, status: "completed", endedAt: Date.now() - i * 1000 }),
				stop: undefined,
			});
		}
		store.restore(restored);
		const ids = store.list();
		// restore places history first, then prune() drops the oldest completed
		// entry (hist-8) to bring the store back under the 32-run cap.
		check("restore + prune keeps 32 runs, history first", ids.length === 32 && ids[0].agent === "hist-9" && ids[ids.length - 1] === active);
		check("restore drops the oldest history entries", !ids.some((r) => r.agent === "hist-0" || r.agent === "hist-8") && ids.some((r) => r.agent === "hist-39"));
		check("restore keeps the running run", ids.filter((r) => r.agent === "active").length === 1 && active.status === "running");
		check("restored runs stop is a no-op", (() => {
			const hist = ids.find((r) => r.agent === "hist-9");
			if (!hist || hist.status !== "completed") return false;
			return store.stop(hist.id) === false && hist.stopping !== true;
		})());
	}

	// ------------------------------------------------------------------------
	console.log("\n[2] FleetWidget.render (TUI FleetView)");
	{
		const theme = mockTheme();
		const tui = mockTui();
		const store = new FleetStore();
		const widget = new FleetWidget(store, tui, theme);
		try {
			check("empty store renders nothing", widget.render(80).length === 0);

			const run = store.add(makeRun({ task: "short task" }));
			const lines = widget.render(80);
			check("one run renders a header + one row", lines.length === 2 && lines[0].includes("Fleet"));
			check("row shows agent", lines[1].includes("worker"));
			check("row shows task", lines[1].includes("short task"));

			// 7 running runs -> only the newest 6 are visible.
			for (let i = 0; i < 6; i++) store.add(makeRun({ agent: `w${i}`, task: `task ${i}` }));
			const capped = widget.render(80);
			check("at most 6 runs are visible", capped.length === 7 && capped.filter((l) => l.includes("task ")).length === 6);
			// The counter counts only the visible (sliced) runs.
			check("running counter in header", capped[0].includes("6 running"));

			// A completed run is retained for 15s, then dropped (isolated store so
			// the slice(-6) window cannot hide the old run behind newer entries).
			const store15 = new FleetStore();
			const widget15 = new FleetWidget(store15, tui, theme);
			try {
				// add() forces status "running"; finish() first, then age the run.
				const oldDone = store15.add(makeRun({ agent: "old-done" }));
				store15.finish(oldDone, "completed");
				oldDone.endedAt = Date.now() - 20_000;
				const freshDone = store15.add(makeRun({ agent: "fresh-done" }));
				store15.finish(freshDone, "completed");
				const retained = widget15.render(80);
				check("completed run within 15s stays visible", retained.some((l) => l.includes("fresh-done")));
				check("completed run older than 15s is hidden", !retained.some((l) => l.includes("old-done")));
				check("hidden old run still lives in the store", store15.list().includes(oldDone) && store15.list().includes(freshDone));
			} finally {
				widget15.dispose();
			}

			// Long task is truncated to the widget width (ANSI-aware visible width).
			const longRun = store.add(makeRun({ agent: "wide", task: bigText(200) }));
			const narrow = widget.render(40);
			const wideRow = narrow.find((l) => l.includes("wide"));
			check("long task is truncated to width", wideRow !== undefined && visibleWidth(wideRow) <= 40, wideRow);
			check("truncation marker present", wideRow !== undefined && wideRow.includes("…"));
		} finally {
			widget.dispose();
		}
	}

	// ------------------------------------------------------------------------
	console.log("\n[3] Fleet web serialization (webRun/selectWebRun/serializeFleetRun)");
	{
		check("selectWebRun(undefined) is undefined", selectWebRun(undefined, 1) === undefined);

		const small = makeRun({
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "hello" }] },
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "out" }],
					isError: false,
				},
			],
			toolUpdates: { u1: { toolName: "bash", phase: "completed", content: [{ type: "text", text: "live" }] } },
		});
		const smallWeb = selectWebRun(small, 1);
		check("small run keeps both messages", smallWeb?.messages.length === 2);
		check("small run keeps toolUpdates", Object.keys(smallWeb?.toolUpdates ?? {}).length === 1);
		check("small run serializes as JSON", (() => {
			try {
				return JSON.parse(serializeFleetRun(smallWeb, 1)).run.id === "1";
			} catch {
				return false;
			}
		})());
		check("serializers never mutate the source run (deep-frozen fixture)", (() => {
			const deepFreeze = (value) => {
				if (value && typeof value === "object" && !Object.isFrozen(value)) {
					Object.freeze(value);
					for (const key of Object.keys(value)) deepFreeze(value[key]);
				}
				return value;
			};
			const source = deepFreeze(
				makeRun({
					agent: "worker",
					task: "deep freeze task",
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "deep text" }] },
						{ role: "assistant", content: [{ type: "toolCall", id: "t9", name: "edit", arguments: { file_path: "x.ts", edits: [{ oldText: "a", newText: "b" }] } }] },
						{ role: "toolResult", toolCallId: "t9", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff: "@@ -1 +1 @@" } },
					],
					toolUpdates: { u9: { toolName: "bash", phase: "streaming", content: [{ type: "text", text: "live" }] } },
					status: "running",
					startedAt: 1,
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, contextTokens: 6, turns: 7 },
				}),
			);
			const before = JSON.parse(JSON.stringify(source));
			webRun(source, WEB_RUN_OPTIONS[0]);
			selectWebRun(source, 1);
			serializeFleetRun(webRun(source, WEB_RUN_OPTIONS[0]), 1);
			// JSON round-trip comparison: the source holds a stop() function that
			// JSON.stringify skips, so both sides serialize identically.
			return JSON.stringify(source) === JSON.stringify(before);
		})());

		// A huge single assistant text is capped at the first tier's textBytes.
		const hugeText = makeRun({
			messages: [{ role: "assistant", content: [{ type: "text", text: bigText(500 * 1024) }] }],
		});
		const hugeWeb = selectWebRun(hugeText, 1);
		check(
			"huge text capped below 24 KiB + truncation marker",
			hugeWeb?.messages[0].content[0].text.length < 24 * 1024 + 100 &&
				hugeWeb.messages[0].content[0].text.includes("[Fleet Web payload truncated]"),
		);

		// Many messages push the payload over the cap; selectWebRun must downgrade.
		const many = makeRun({
			messages: Array.from({ length: 200 }, (_, i) => ({
				role: "assistant",
				content: [{ type: "text", text: bigText(20 * 1024) + i }],
			})),
		});
		const manyWeb = selectWebRun(many, 1);
		const manyBytes = Buffer.byteLength(serializeFleetRun(manyWeb, 1));
		check("payload stays under 256 KiB", manyBytes <= 256 * 1024, `${manyBytes} bytes`);
		check("downgrade drops messages and reports omissions", (manyWeb?.omitted.messages ?? 0) > 0 && manyWeb.messages.length < 200);
		check("downgraded payload still round-trips", JSON.parse(serializeFleetRun(manyWeb, 1)).run.messages.length === manyWeb.messages.length);

		// A pathological run forces the minimal tier, which blanks agent/task.
		const insane = makeRun({
			agent: bigText(40 * 1024),
			task: bigText(40 * 1024),
			messages: Array.from({ length: 300 }, (_, i) => ({
				role: "assistant",
				content: [{ type: "text", text: bigText(60 * 1024) + i }],
			})),
		});
		const insaneWeb = selectWebRun(insane, 1);
		const insaneBytes = Buffer.byteLength(serializeFleetRun(insaneWeb, 1));
		check("pathological payload stays under 256 KiB", insaneBytes <= 256 * 1024, `${insaneBytes} bytes`);
		check(
			"downgrade keeps the payload bounded and reports dropped messages",
			insaneWeb !== undefined && insaneWeb.messages.length < 300 && (insaneWeb.omitted.messages ?? 0) > 0,
		);

		// An oversized id must not blow the cap even on the minimal tier: the
		// last-resort fallback truncates it (P2 review item).
		const bigIdRun = makeRun({
			id: bigText(300 * 1024),
			messages: Array.from({ length: 300 }, (_, i) => ({
				role: "assistant",
				content: [{ type: "text", text: bigText(60 * 1024) + i }],
			})),
		});
		const bigIdWeb = selectWebRun(bigIdRun, 1);
		const bigIdBytes = Buffer.byteLength(serializeFleetRun(bigIdWeb, 1));
		check("oversized id payload stays under 256 KiB", bigIdBytes <= 256 * 1024, `${bigIdBytes} bytes`);
		check("oversized id is truncated by the last-resort fallback", (bigIdWeb?.id.length ?? 0) < 300 * 1024, bigIdWeb?.id.length);

		// Edit arguments are sanitized: edits array, oldText/newText, omissions.
		const editArgs = {
			file_path: "a.ts",
			edits: [
				{ oldText: bigText(40 * 1024), newText: "short" },
				{ oldText: "x", newText: "y" },
			],
		};
		const editRun = makeRun({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "edit", arguments: editArgs }],
				},
			],
		});
		const editWeb = webRun(editRun, WEB_RUN_OPTIONS[0]);
		const call = editWeb?.messages[0].content[0];
		check("edit toolCall kept with sanitized arguments", call?.type === "toolCall" && call.name === "edit" && call.arguments.file_path === "a.ts");
		check("edit oldText is capped at the tier limit", call.arguments.edits[0].oldText.length <= 24 * 1024 && call.arguments.edits[0].oldText.length > 0);
		check("edit truncation is reported", Array.isArray(call.argumentTruncation?.edits) && call.argumentTruncation.edits[0].oldText !== undefined);
		check("unchanged edit has no truncation marker", call.argumentTruncation.edits[1].oldText === undefined && call.argumentTruncation.edits[1].newText === undefined);

		// toolResult content parts are capped with an omission counter.
		const manyParts = makeRun({
			messages: [
				{
					role: "toolResult",
					toolCallId: "c9",
					toolName: "bash",
					content: Array.from({ length: 50 }, (_, i) => ({ type: "text", text: `part-${i}-` + bigText(1000) })),
				},
			],
		});
		const partsWeb = webRun(manyParts, WEB_RUN_OPTIONS[0]);
		const toolResult = partsWeb?.messages[0];
		check(
			"toolResult content capped to contentPartLimit with counter",
			toolResult?.content.length === 32 && toolResult.omittedContentParts === 18,
			JSON.stringify(toolResult && { n: toolResult.content.length, o: toolResult.omittedContentParts }),
		);

		// details.diff is capped for edit tool results.
		const diffRun = makeRun({
			messages: [
				{
					role: "toolResult",
					toolCallId: "c10",
					toolName: "edit",
					content: [],
					details: { diff: bigText(100 * 1024) },
				},
			],
		});
		const diffWeb = webRun(diffRun, WEB_RUN_OPTIONS[0]);
		check("toolResult diff is capped with a truncation marker", (diffWeb?.messages[0].details?.diff?.length ?? 0) <= 24 * 1024 && (diffWeb?.messages[0].details?.diff ?? "").includes("[Fleet Web payload truncated]"), diffWeb?.messages[0].details?.diff?.length);

		// toolUpdates are truncated by updateLimit.
		const updatesRun = makeRun({
			toolUpdates: Object.fromEntries(
				Array.from({ length: 80 }, (_, i) => [i, { toolName: "bash", phase: "streaming", content: [{ type: "text", text: "u" }] }]),
			),
		});
		const updatesWeb = webRun(updatesRun, WEB_RUN_OPTIONS[0]);
		check("toolUpdates truncated to updateLimit with omission", Object.keys(updatesWeb?.toolUpdates ?? {}).length === 64 && updatesWeb?.omitted.toolUpdates === 16);
	}

	// ------------------------------------------------------------------------
	console.log("\n[4] FleetWebServer HTTP (token auth, revision, SSE, close)");
	{
		const store = new FleetStore();
		let openedUrl;
		const server = new FleetWebServer(store, {
			openBrowser: (url) => {
				openedUrl = url;
				return Promise.resolve();
			},
		});
		const run = store.add(makeRun({ agent: "web-agent" }));
		await server.open(run.id);

		const parsed = new URL(openedUrl);
		const port = parsed.port;
		const token = parsed.pathname.split("/")[2];
		check("openBrowser received a loopback URL with token", parsed.hostname === "127.0.0.1" && token.length >= 32);
		const base = `http://127.0.0.1:${port}/fleet/${token}`;

		const res1 = await fetch(`${base}/data?run=${run.id}`, { cache: "no-store" });
		const data1 = await res1.json();
		check("data endpoint returns JSON with revision 1", res1.status === 200 && data1.revision === 1 && data1.run?.id === run.id && data1.run?.agent === "web-agent" && data1.run?.status === "running");
		check("data endpoint sets no-store", (res1.headers.get("cache-control") || "").includes("no-store"));

		store.finish(run, "completed");
		const res2 = await fetch(`${base}/data?run=${run.id}`, { cache: "no-store" });
		const data2 = await res2.json();
		check("revision increments when the run changes", data2.revision === 2 && data2.run?.status === "completed", JSON.stringify(data2.revision));

		const resUnchanged = await fetch(`${base}/data?run=${run.id}`, { cache: "no-store" });
		const dataUnchanged = await resUnchanged.json();
		check("unchanged run keeps the same revision", dataUnchanged.revision === 2);

		const badToken = await fetch(`http://127.0.0.1:${port}/fleet/wrong-token/data?run=${run.id}`);
		check("wrong token is rejected with 404", badToken.status === 404);

		const page = await fetch(`${base}/`);
		check("index serves HTML", page.status === 200 && (page.headers.get("content-type") || "").includes("text/html"));

		// The store.finish() call in the data-endpoint tests scheduled a 50ms
		// debounce broadcast; wait it out explicitly so it cannot bleed into the
		// SSE window below (no client is attached then, so it is silently dropped).
		await new Promise((resolve) => setTimeout(resolve, 200));

		const sse = await fetch(`${base}/events`);
		check(
			"SSE endpoint streams update events",
			sse.status === 200 && (sse.headers.get("content-type") || "").includes("text/event-stream"),
		);
		const decoder = new TextDecoder();
		const readWithTimeout = async (reader, timeoutMs) => {
			let timer;
			try {
				return await Promise.race([
					reader.read(),
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs);
					}),
				]);
			} catch (error) {
				// Abandoning a pending read() is illegal on web streams; cancel the
				// reader so the connection is torn down cleanly on failure.
				await reader.cancel().catch(() => {});
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		// Connection A: the server pushes an update on connect.
		const sseA = await fetch(`${base}/events`);
		const readerA = sseA.body.getReader();
		const firstA = await readWithTimeout(readerA, 1500);
		check("SSE first event is an update", decoder.decode(firstA.value).includes("event: update"));
		await readerA.cancel().catch(() => {});
		// Connection B: consume the connect-time update, then a store change must
		// produce a genuinely new broadcast (the old store.finish() debounce fired
		// long before this connection existed, so it cannot fake this assertion).
		const sseB = await fetch(`${base}/events`);
		const readerB = sseB.body.getReader();
		await readWithTimeout(readerB, 1500);
		store.touch();
		const secondB = await readWithTimeout(readerB, 3000);
		check("store change broadcasts a new update event", decoder.decode(secondB.value).includes("event: update"));
		await readerB.cancel().catch(() => {});

		await server.close();
		let refused = false;
		try {
			await fetch(`${base}/data?run=${run.id}`);
		} catch {
			refused = true;
		}
		check("server is closed and port refused", refused);
		await server.close(); // idempotent
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error("presentation harness error:", error);
	process.exit(1);
});
