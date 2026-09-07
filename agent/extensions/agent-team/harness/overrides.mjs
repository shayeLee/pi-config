#!/usr/bin/env node
/**
 * agent-team agent-discovery override harness
 *
 * Loads the real `agents.ts` with jiti and asserts the `agents.override.json`
 * rules in the role directory:
 *   - Field-level override on top of Markdown frontmatter (model/tools/thinking).
 *   - `tools` replaces the frontmatter list (not merged) and accepts a comma
 *     separated string or a string array.
 *   - Empty values (`""` / `[]`) clear the frontmatter value (back to default).
 *   - Invalid field types are ignored (frontmatter value kept).
 *   - Malformed JSON / non-object roots are ignored without crashing.
 *   - Override keys without a matching Markdown agent are ignored.
 *   - Missing override file leaves the Markdown config intact.
 *
 * Run:
 *   node agent/extensions/agent-team/harness/overrides.mjs
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
const AGENTS_ENTRY = path.join(EXTENSION_DIR, "agents.ts");

const MD = `---
name: worker
description: md agent
tools: read, bash
model: md/provider
thinking: low
---
md body prompt
`;

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

function writeProject(dir) {
	const agentsDir = path.join(dir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(path.join(agentsDir, "worker.md"), MD);
	return agentsDir;
}

/** Create a user-level agent dir with a same-name `worker` and a user-only `usertool`. */
function writeUserDir(userCfg) {
	const agentsDir = path.join(userCfg, "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "worker.md"),
		`---
name: worker
description: user agent
tools: read
model: user-md/provider
---
user body
`,
	);
	fs.writeFileSync(
		path.join(agentsDir, "usertool.md"),
		`---
name: usertool
description: user-only agent
tools: read
model: user-tool-md/provider
---
user tool body
`,
	);
	fs.writeFileSync(
		path.join(agentsDir, "agents.override.json"),
		JSON.stringify({
			worker: { model: "user-override/provider" },
			usertool: { model: "user-tool-override/provider" },
		}),
	);
	return agentsDir;
}

/** Point getAgentDir() at `userCfg`, run `fn`, then restore the env var exactly. */
function withUserDir(userCfg, fn) {
	const saved = process.env.PI_CODING_AGENT_DIR;
	const had = "PI_CODING_AGENT_DIR" in process.env;
	process.env.PI_CODING_AGENT_DIR = userCfg;
	try {
		fn();
	} finally {
		if (had) process.env.PI_CODING_AGENT_DIR = saved;
		else delete process.env.PI_CODING_AGENT_DIR;
	}
}

async function main() {
	const pkgRoot = findPiPackageRoot();
	const jitiEntry = pathToFileURL(path.join(pkgRoot, "dist/index.js")).href;
	const require = createRequire(jitiEntry);
	const { createJiti } = await import(
		pathToFileURL(path.join(pkgRoot, "node_modules/jiti/lib/jiti-static.mjs")).href
	);
	const jiti = createJiti(jitiEntry, { moduleCache: false, alias: extensionAliases(pkgRoot, require) });
	const { discoverAgents } = await jiti.import(AGENTS_ENTRY);

	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-overrides-"));
	// Remove the temp tree on exit (normal or via process.exit).
	process.on("exit", () => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// 1. Non-empty override replaces model/tools/thinking; unmatched keys ignored.
	{
		const dir = path.join(tmpRoot, "override");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({
				worker: { model: "json/provider", tools: ["edit", "write"], thinking: "high" },
				ghost: { model: "nope/provider" },
			}),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents.find((a) => a.name === "worker");
		check("override: source is project", w?.source === "project");
		check("override: model overridden", w?.model === "json/provider", w?.model);
		check("override: thinking overridden", w?.thinkingLevel === "high", w?.thinkingLevel);
		check(
			"override: tools replaced (not merged)",
			Array.isArray(w?.tools) && w.tools.join(",") === "edit,write",
			JSON.stringify(w?.tools),
		);
		check("override: description preserved", w?.description === "md agent");
		check("override: systemPrompt preserved", w?.systemPrompt === "md body prompt");
		check("override: key without matching md ignored", agents.length === 1, String(agents.length));
	}

	// 2. Empty values clear the frontmatter value.
	{
		const dir = path.join(tmpRoot, "clear");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { model: "", tools: [], thinking: "" } }),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents[0];
		check("clear: model cleared", w?.model === undefined, String(w?.model));
		check("clear: thinking cleared", w?.thinkingLevel === undefined, String(w?.thinkingLevel));
		check("clear: tools cleared", w?.tools === undefined, JSON.stringify(w?.tools));
	}

	// 3. tools accepts a comma-separated string.
	{
		const dir = path.join(tmpRoot, "tools-string");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { tools: "edit,  write" } }),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents[0];
		check("tools-string: parsed and trimmed", w?.tools?.join(",") === "edit,write", JSON.stringify(w?.tools));
		check("tools-string: model untouched", w?.model === "md/provider", w?.model);
	}

	// 4. Invalid field types are ignored, keeping the Markdown values.
	{
		const dir = path.join(tmpRoot, "invalid-types");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { model: 123, thinking: 456, tools: 789 } }),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents[0];
		check("invalid-types: model kept", w?.model === "md/provider", w?.model);
		check("invalid-types: thinking kept", w?.thinkingLevel === "low", w?.thinkingLevel);
		check("invalid-types: tools kept", w?.tools?.join(",") === "read,bash", JSON.stringify(w?.tools));
	}

	// 8. A tools array containing non-string elements is ignored (field kept).
	{
		const dir = path.join(tmpRoot, "mixed-tools");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { tools: ["edit", 123] } }),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents[0];
		check("mixed-tools: ignored, md tools kept", w?.tools?.join(",") === "read,bash", JSON.stringify(w?.tools));
	}

	// 9. A tools array of only non-string elements is ignored (not cleared).
	{
		const dir = path.join(tmpRoot, "nonstring-tools");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { tools: [123] } }),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents[0];
		check("nonstring-tools: ignored, md tools kept", w?.tools?.join(",") === "read,bash", JSON.stringify(w?.tools));
	}

	// 5. Malformed JSON is ignored without crashing.
	{
		const dir = path.join(tmpRoot, "malformed");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(path.join(agentsDir, "agents.override.json"), "{ not valid json");
		const { agents } = discoverAgents(dir, "project");
		check(
			"malformed: ignored, md kept",
			agents.length === 1 && agents[0].model === "md/provider",
			JSON.stringify(agents[0]?.model),
		);
	}

	// 6. Non-object JSON root is ignored.
	{
		const dir = path.join(tmpRoot, "array-root");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify([{ worker: { model: "x/y" } }]),
		);
		const { agents } = discoverAgents(dir, "project");
		check("array-root: ignored, md kept", agents[0]?.model === "md/provider", agents[0]?.model);
	}

	// 7. Missing override file leaves the Markdown config intact.
	{
		const dir = path.join(tmpRoot, "no-override");
		writeProject(dir);
		const { agents } = discoverAgents(dir, "project");
		check(
			"no-override: md values intact",
			agents.length === 1 && agents[0].model === "md/provider" && agents[0].tools?.join(",") === "read,bash",
			JSON.stringify(agents[0]?.model),
		);
	}

	// 10. both scope: project override wins and replaces the user agent.
	{
		const dir = path.join(tmpRoot, "both");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { model: "project-override/provider" } }),
		);

		const userCfg = path.join(tmpRoot, "user-cfg");
		writeUserDir(userCfg);
		withUserDir(userCfg, () => {
			const { agents } = discoverAgents(dir, "both");
			const w = agents.find((a) => a.name === "worker");
			const ut = agents.find((a) => a.name === "usertool");
			check("both: project override wins", w?.model === "project-override/provider", w?.model);
			check("both: source is project", w?.source === "project");
			check("both: user-only agent loaded with its override", ut?.model === "user-tool-override/provider", ut?.model);
			check("both: user-only agent source is user", ut?.source === "user");
			check("both: exactly two agents", agents.length === 2, String(agents.length));
		});
	}

	// 11. both scope: the user override does not leak into the project agent.
	{
		const dir = path.join(tmpRoot, "both-2");
		writeProject(dir); // project md only, no project override

		const userCfg = path.join(tmpRoot, "user-cfg-2");
		writeUserDir(userCfg);
		withUserDir(userCfg, () => {
			const { agents } = discoverAgents(dir, "both");
			const w = agents.find((a) => a.name === "worker");
			const ut = agents.find((a) => a.name === "usertool");
			check("both: user override does not leak to project", w?.model === "md/provider", w?.model);
			check("both: user-only agent override applied", ut?.model === "user-tool-override/provider", ut?.model);
		});
	}

	// 12. both scope: a project override can configure a same-name user agent
	// without requiring a project Markdown role.
	{
		const dir = path.join(tmpRoot, "both-fallback");
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ worker: { model: "project-fallback/provider", thinking: "high", tools: ["edit", "write"] } }),
		);

		const userCfg = path.join(tmpRoot, "user-cfg-fallback");
		writeUserDir(userCfg);
		withUserDir(userCfg, () => {
			const { agents } = discoverAgents(dir, "both");
			const w = agents.find((a) => a.name === "worker");
			check("both-fallback: source remains user", w?.source === "user");
			check("both-fallback: project model overrides user", w?.model === "project-fallback/provider", w?.model);
			check("both-fallback: project thinking overrides user", w?.thinkingLevel === "high", w?.thinkingLevel);
			check(
				"both-fallback: project tools replace user",
				w?.tools?.join(",") === "edit,write",
				JSON.stringify(w?.tools),
			);
			check("both-fallback: user prompt preserved", w?.description === "user agent" && w?.systemPrompt === "user body");
		});
	}

	// 13. Agent keys are trimmed, so " worker " matches "worker".
	{
		const dir = path.join(tmpRoot, "key-trim");
		const agentsDir = writeProject(dir);
		fs.writeFileSync(
			path.join(agentsDir, "agents.override.json"),
			JSON.stringify({ " worker ": { model: "trimmed/provider" } }),
		);
		const { agents } = discoverAgents(dir, "project");
		const w = agents[0];
		check("key-trim: padded key matches", w?.model === "trimmed/provider", w?.model);
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});