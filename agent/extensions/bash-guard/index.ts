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
 *   - boundary rule, all write targets inside the authorized roots -> allowed
 *     (project cwd + `path-scope.json` extraRoots; see "authorized roots" below)
 *   - dangerous command + UI  -> ask (default) or block (mode: "block")
 *   - dangerous command, no UI-> block, unless noUI: "allow"
 *
 * Authorized roots for the scope exemption mirror the boundary the other two
 * extensions enforce: path-scope lets the file tools write inside those roots
 * without asking, and sandbox-bash makes them kernel-writable. Only the two
 * rules that exist *because* a write crosses the boundary (`破坏性删除`,
 * `写入系统目录`) can be exempted; authority rules (`sudo`, git history/remote,
 * remote script execution, disk/partition ops, global installs) always ask.
 * The legacy exemption is fail-closed: unknown shell syntax, unknown commands,
 * globs, variables, or an operand that cannot be canonicalized (including a
 * symlink pointing outside the roots or at the pi config dir) keeps the normal
 * flow. A separate explicit `rmExemptRoots` setting supports terminal-glob rm
 * cleanup only; it is never inferred from broad path-scope extraRoots.
 *
 * Config file (takes precedence over environment variables):
 *   User-level:   ~/.pi/agent/bash-guard.json
 *
 * Environment variables (fallback when the config file does not set the value):
 *   BASH_GUARD=0          -> disable this extension entirely
 *   BASH_GUARD_MODE=block -> same as mode: "block"
 *   BASH_GUARD_NOUI=allow -> same as noUI: "allow"
 *   BASH_GUARD_SCOPE_EXEMPT=0 -> disable the authorized-roots exemption
 *
 * rmExemptRoots is config-file-only. Invalid JSON/schema is warned about and the file is ignored; environment
 * fallbacks are then disabled and safe defaults are used.
 * See README.md (same directory) for the full reference.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	analyseExplicitRmExemption,
	analyseScopeExemption,
	compileRules,
	isAllowlisted,
	isPathCoveredBy,
	normalizeCommand,
	validateBashGuardConfig,
	type BashGuardConfig,
} from "./core";
import { canonicalizePath } from "./canonicalize";

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

/** Expand a leading `~`. */
function expandHome(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return trimmed;
}

/** Absolute + lexically normalized (symlinks untouched). */
function absoluteConfigPath(input: string, base: string = process.cwd()): string {
	const expanded = expandHome(input);
	// Relative entries are anchored to `base` (the session cwd), never to whatever
	// directory pi happened to be started in.
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
}

/**
 * Absolute path that KEEPS `..` segments. `path.resolve` would collapse
 * `a/link/../b` to `a/b` lexically, while the filesystem resolves `..` against
 * the real directory behind `link` — so canonicalization must use this form, or
 * a root/operand written through a symlinked component could be judged against
 * the wrong directory.
 */
function anchoredConfigPath(input: string, base: string = process.cwd()): string {
	const expanded = expandHome(input);
	const joined = path.isAbsolute(expanded) ? expanded : `${base}/${expanded}`;
	const segments = joined.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
	return `${joined.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

/**
 * The pi config/credential dirs (~/.pi/agent and ~/.pi) in every form they can
 * take. They hold auth.json, settings.json and the extension code itself, so
 * they are never an authorized write root — even when they appear in
 * path-scope's extraRoots (path-scope only prompts for them there; silently
 * auto-approving `rm -rf` there is something else).
 */
function sensitiveDirs(): string[] {
	const agentDir = absoluteConfigPath(getAgentDir());
	const parentDir = path.dirname(agentDir);
	return [...new Set([
		agentDir,
		parentDir,
		canonicalizePath(agentDir) ?? agentDir,
		canonicalizePath(parentDir) ?? parentDir,
	])];
}

/** True when any form of a candidate is one of, or lives under, a sensitive dir. */
function isSensitiveForm(forms: Array<string | undefined>, sensitive: string[]): boolean {
	return forms.some((form) => form !== undefined && form.length > 0
		&& sensitive.some((root) => isPathCoveredBy(form, root)));
}

/**
 * Read path-scope's `extraRoots` so bash-guard authorizes the same paths as
 * sandbox-bash. Deliberately user-level only: a project-checked-in path-scope.json
 * must not be able to auto-approve destructive bash commands.
 * Absent or malformed -> no extra roots (fail closed).
 */
function readPathScopeExtraRoots(): string[] {
	const configPath = path.join(getAgentDir(), "path-scope.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
		const roots = parsed.extraRoots;
		if (Array.isArray(roots) && roots.every((root) => typeof root === "string" && root.trim().length > 0 && !root.includes("\0"))) {
			return roots as string[];
		}
	} catch {
		// absent or invalid path-scope.json -> no extra roots
	}
	return [];
}

export default function (pi: ExtensionAPI) {
	// Instance/session scoped: a fresh instance (including /reload) rereads the file.
	let loaded: LoadedConfig | undefined;
	// Authorized roots depend on the session cwd, so they are cached per cwd.
	let scopeRoots: { cwd: string; roots: string[]; projectRoot?: string } | undefined;
	let rmExemptRoots: { cwd: string; roots: string[] } | undefined;
	const warned = new Set<string>();

	const warn = (ctx: UI, message: string) => {
		if (!warned.has(message)) {
			warned.add(message);
			ctx.ui.notify(`bash-guard: ${message}`, "warning");
		}
	};

	/** Same once-per-message policy as warn(), for expected (non-error) situations. */
	const note = (ctx: UI, message: string) => {
		if (!warned.has(message)) {
			warned.add(message);
			ctx.ui.notify(`bash-guard: ${message}`, "info");
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
		scopeRoots = undefined;
		rmExemptRoots = undefined;
	};

	/** Canonical authorized write roots: project cwd + path-scope extraRoots. */
	const getScopeRoots = (cwd: string, ctx: UI): { roots: string[]; sensitive: string[]; projectRoot?: string } => {
		const sensitive = sensitiveDirs();
		if (scopeRoots?.cwd === cwd) return { roots: scopeRoots.roots, sensitive, projectRoot: scopeRoots.projectRoot };

		const roots: string[] = [];
		let projectRoot: string | undefined;

		const cwdCanonical = canonicalizePath(anchoredConfigPath(cwd));
		if (cwdCanonical === undefined) {
			warn(ctx, `无法安全规范化项目根，授权根仅限 path-scope extraRoots：${cwd}`);
		} else {
			roots.push(cwdCanonical);
			// Sandbox-bash cwd priority: when the project lives inside a sensitive
			// dir (e.g. this very config repo at ~/.pi), the project tree itself is
			// authorized instead of being rejected by the sensitive check.
			if (sensitive.some((root) => isPathCoveredBy(cwdCanonical, root))) {
				projectRoot = cwdCanonical;
			}
		}

		// Sensitive dirs that strictly CONTAIN the cwd: a broad extraRoot covering
		// one of them would expose credentials outside the cwd (no deny clause can
		// protect them without also denying the project). sandbox-bash drops such
		// roots from the kernel profile; mirror that here so both agree.
		const containingSensitive = projectRoot === undefined
			? []
			: [...new Set(sensitive)].filter((root) => root !== projectRoot && isPathCoveredBy(projectRoot, root));

		for (const entry of readPathScopeExtraRoots()) {
			let absolute: string;
			let anchored: string;
			try {
				absolute = absoluteConfigPath(entry, cwd);
				anchored = anchoredConfigPath(entry, cwd);
			} catch {
				warn(ctx, `extraRoots 条目格式无效，已忽略：${entry}`);
				continue;
			}
			const canonical = canonicalizePath(anchored);
			// Raw, `..`-preserving and symlink-resolved forms are all checked: ~/.pi
			// must never become an authorized root through a link or a detour.
			if (isSensitiveForm([absolute, anchored, canonical], sensitive)) {
				note(ctx, `extraRoots 中的 pi 配置/凭据目录不参与授权根豁免（与 sandbox-bash 一致）：${entry}`);
				continue;
			}
			const forms = [absolute, anchored, canonical ?? ""].filter((form) => form.length > 0);
			if (forms.some((form) => containingSensitive.some((root) => isPathCoveredBy(root, form)))) {
				note(ctx, `extraRoots 宽根覆盖包含项目 cwd 的受保护目录，已忽略（与 sandbox-bash 一致）：${entry}`);
				continue;
			}
			if (canonical === undefined) {
				warn(ctx, `extraRoots 路径无法安全规范化，已忽略：${entry}`);
				continue;
			}
			roots.push(canonical);
		}

		scopeRoots = { cwd, roots: [...new Set(roots)], projectRoot };
		return { roots: scopeRoots.roots, sensitive, projectRoot: scopeRoots.projectRoot };
	};

	const getRmExemptRoots = (cwd: string, config: BashGuardConfig, ctx: UI): string[] => {
		if (rmExemptRoots?.cwd === cwd) return rmExemptRoots.roots;
		const roots: string[] = [];
		for (const entry of config.rmExemptRoots ?? []) {
			try {
				const canonical = canonicalizePath(anchoredConfigPath(entry, cwd));
				if (canonical) roots.push(canonical);
				else warn(ctx, `rmExemptRoots 路径无法安全规范化，已忽略：${entry}`);
			} catch {
				warn(ctx, `rmExemptRoots 条目格式无效，已忽略：${entry}`);
			}
		}
		rmExemptRoots = { cwd, roots: [...new Set(roots)] };
		return rmExemptRoots.roots;
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

		// Authorized-roots exemption: the two boundary rules exist only because a
		// write crosses the path boundary. When every write/delete target provably
		// lands strictly inside cwd + extraRoots, path-scope/sandbox-bash already
		// treat that as an inside operation, so do not prompt or block.
		if (matched.scopeExempt) {
			const scopeExemptEnabled = config.scopeExempt
				?? (suppressEnvironment || process.env.BASH_GUARD_SCOPE_EXEMPT !== "0");
			if (scopeExemptEnabled) {
				const scope = getScopeRoots(ctx.cwd, ctx);
				if (matched.name === "破坏性删除") {
					const explicitRoots = getRmExemptRoots(ctx.cwd, config, ctx);
					if (explicitRoots.length > 0) {
						const explicitVerdict = analyseExplicitRmExemption(rawCommand, {
							cwd: ctx.cwd,
							roots: explicitRoots,
							sensitiveDirs: scope.sensitive,
							projectRoot: scope.projectRoot,
							canonicalize: canonicalizePath,
						});
						if (explicitVerdict.exempt) return undefined;
					}
				}
				// Analyse the RAW command: normalizeCommand() folds newlines into spaces
				// for regex matching, which would merge `echo x > /tmp/a` and a following
				// `rm -rf /etc` into one segment and hide the dangerous line. The lexer
				// treats a newline as a command separator, so every line must be in scope.
				const verdict = analyseScopeExemption(rawCommand, {
					cwd: ctx.cwd,
					roots: scope.roots,
					sensitiveDirs: scope.sensitive,
					projectRoot: scope.projectRoot,
					canonicalize: canonicalizePath,
				});
				if (verdict.exempt) return undefined;
			}
		}

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