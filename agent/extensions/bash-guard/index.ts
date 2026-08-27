/**
 * Bash Guard Extension (command-level permission gate)
 *
 * path-scope guards the *file* tools by path boundary, and intentionally does
 * not touch bash (a command string cannot be reduced to safe path checks).
 * This extension covers that gap by pattern-matching the bash/powershell
 * command text: dangerous commands are either confirmed with the user (ask)
 * or blocked outright (block).
 *
 * Scope rules:
 *   - safe command            -> allowed (no prompt)
 *   - command in allowlist    -> allowed (no prompt)
 *   - dangerous command + UI  -> ask (default) or block (mode: "block")
 *   - dangerous command, no UI-> block, unless noUI: "allow"
 *
 * Config file (takes precedence over environment variables):
 *   User-level:   ~/.pi/agent/bash-guard.json
 *
 * Environment variables (fallback when the config file does not set the value):
 *   BASH_GUARD=0          -> disable this extension entirely
 *   BASH_GUARD_MODE=block -> same as mode: "block"
 *   BASH_GUARD_NOUI=allow -> same as noUI: "allow"
 *
 * Invalid JSON/schema is warned about and the file is ignored; environment
 * fallbacks are then disabled and safe defaults are used.
 * See README.md (same directory) for the full reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	compileRules,
	isAllowlisted,
	normalizeCommand,
	validateBashGuardConfig,
	type BashGuardConfig,
} from "./core";

type ConfigFileResult =
	| { status: "absent" }
	| { status: "valid"; config: BashGuardConfig }
	| { status: "invalid"; reason: string };

function readJsonConfig(configPath: string): ConfigFileResult {
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { status: "absent" };
		}
		return { status: "invalid", reason: `cannot read file (${String(error)})` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { status: "invalid", reason: `invalid JSON (${String(error)})` };
	}

	const validation = validateBashGuardConfig(parsed);
	return "config" in validation
		? { status: "valid", config: validation.config }
		: { status: "invalid", reason: validation.error };
}

interface LoadedConfig {
	config: BashGuardConfig;
	suppressEnvironment: boolean;
}

type UI = { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };

export default function (pi: ExtensionAPI) {
	// Instance/session scoped: a fresh instance (including /reload) rereads the file.
	let loaded: LoadedConfig | undefined;
	const warned = new Set<string>();

	const warn = (ctx: UI, message: string) => {
		if (!warned.has(message)) {
			warned.add(message);
			ctx.ui.notify(`bash-guard: ${message}`, "warning");
		}
	};

	const getConfig = (ctx: UI): LoadedConfig => {
		if (loaded) return loaded;
		const configPath = path.join(getAgentDir(), "bash-guard.json");
		const result = readJsonConfig(configPath);
		if (result.status === "invalid") {
			warn(ctx, `无效配置 ${configPath}，已忽略：${result.reason}；修复后请 /reload`);
		}
		const suppressEnvironment = result.status === "invalid";
		loaded = {
			config: result.status === "valid" ? result.config : {},
			suppressEnvironment,
		};
		return loaded;
	};

	const reload = () => {
		loaded = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		reload();
		getConfig(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;

		const loadedConfig = getConfig(ctx);
		const { config, suppressEnvironment } = loadedConfig;

		// enabled check: config wins, otherwise disabled only via BASH_GUARD=0.
		const enabled = config.enabled ?? (suppressEnvironment || process.env.BASH_GUARD !== "0");
		if (!enabled) return undefined;

		const rawCommand = (event.input as { command?: unknown }).command;
		if (typeof rawCommand !== "string" || !rawCommand.trim()) return undefined;

		const command = normalizeCommand(rawCommand);

		// Allowlist short-circuits all checks.
		const allowlist = config.allowlist ?? [];
		if (isAllowlisted(command, allowlist)) return undefined;

		const rules = compileRules(config.patterns ?? [], (source, error) => {
			warn(ctx, `无效正则 pattern ${JSON.stringify(source)}，已忽略：${error}`);
		});
		const matched = rules.find((rule) => rule.pattern.test(command));
		if (!matched) return undefined;

		let mode = config.mode;
		if (mode === undefined) {
			mode = !suppressEnvironment && process.env.BASH_GUARD_MODE === "block" ? "block" : "ask";
		}

		let noUI = config.noUI;
		if (noUI === undefined) {
			noUI = !suppressEnvironment && process.env.BASH_GUARD_NOUI === "allow" ? "allow" : "block";
		}

		// Non-interactive: fail closed unless explicitly allowed.
		if (!ctx.hasUI) {
			if (noUI === "allow") return undefined;
			return { block: true, reason: `危险命令（${matched.name}），无交互环境已拦截` };
		}

		if (mode === "block") {
			ctx.ui.notify(`已拦截危险命令（${matched.name}）`, "error");
			return { block: true, reason: `危险命令已拦截（${matched.name}）` };
		}

		const ok = await ctx.ui.confirm(
			"危险命令确认",
			`检测到危险命令（${matched.name}）：\n\n  ${command}\n\n是否仍要执行？`,
		);
		if (!ok) {
			return { block: true, reason: `用户拒绝了危险命令（${matched.name}）` };
		}
		return undefined;
	});
}