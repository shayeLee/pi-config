/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Effective thinking level (off, minimal, low, medium, high, xhigh, max). */
	thinkingLevel?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Field-level overrides applied on top of a Markdown agent's frontmatter.
 * Only fields explicitly present here override the frontmatter; an empty
 * value clears the frontmatter value (falls back to the child default).
 */
export interface AgentOverride {
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
}

/** File name, read from each agent directory, that overrides Markdown frontmatter. */
const OVERRIDE_FILE_NAME = "agents.override.json";

/** Parse a tools value that is either a comma-separated string or a string array. */
function parseToolsValue(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const tools = value.split(",").map((t) => t.trim()).filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}
	if (Array.isArray(value)) {
		const tools = value.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}
	return undefined;
}

/**
 * Load overrides from `<dir>/agents.override.json`, an object keyed by agent name.
 * Unreadable or malformed files are ignored, matching the directory's fail-silent style.
 */
function loadOverridesFromDir(dir: string): Map<string, AgentOverride> {
	const overrides = new Map<string, AgentOverride>();

	let raw: string;
	try {
		raw = fs.readFileSync(path.join(dir, OVERRIDE_FILE_NAME), "utf-8");
	} catch {
		return overrides;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return overrides;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return overrides;
	}

	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		const override: AgentOverride = {};
		if (typeof entry.model === "string") override.model = entry.model.trim() || undefined;
		if (typeof entry.thinking === "string") override.thinkingLevel = entry.thinking.trim() || undefined;
		if (typeof entry.tools === "string") {
			override.tools = parseToolsValue(entry.tools);
		} else if (Array.isArray(entry.tools) && entry.tools.every((t) => typeof t === "string")) {
			override.tools = parseToolsValue(entry.tools);
		}
		overrides.set(name.trim(), override);
	}

	return overrides;
}

/**
 * Apply an override to an agent. Only fields explicitly present in the override
 * are changed, so `{ "tools": [] }` clears tools while `{ "model": "..." }`
 * leaves tools untouched.
 */
function applyOverrides(agent: AgentConfig, override: AgentOverride | undefined): AgentConfig {
	if (!override) return agent;
	const overridden = { ...agent };
	if ("model" in override) overridden.model = override.model;
	if ("thinkingLevel" in override) overridden.thinkingLevel = override.thinkingLevel;
	if ("tools" in override) overridden.tools = override.tools;
	return overridden;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	const overrides = loadOverridesFromDir(dir);

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

		if (!name || !description) {
			continue;
		}

		const tools = parseToolsValue(frontmatter.tools);
		const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined;
		const thinkingLevel = typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() || undefined : undefined;

		agents.push(applyOverrides({
			name,
			description,
			tools,
			model: model || undefined,
			thinkingLevel,
			systemPrompt: body,
			source,
			filePath,
		}, overrides.get(name)));
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
