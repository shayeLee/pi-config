/**
 * Path Scope Extension (permission gate)
 *
 * Covers the built-in file tools: read / write / edit / grep / find / ls.
 *
 *   - Path inside the project working directory  -> allowed (no prompt)
 *   - Path outside the project                     -> ask the user to allow;
 *                                                      denied if declined
 *   - bash is intentionally NOT restricted here and runs without path-scope
 *     checks.
 *
 * Once a path is approved, it stays approved for the rest of the session.
 *
 * Controls (config file, takes precedence over environment variables):
 *   User-level:   ~/.pi/agent/path-scope.json
 *   Project-level: <project>/.pi/path-scope.json
 *
 * A project path-scope.json by itself is not a Pi trust-requiring resource.
 * It is therefore only read when the project is trusted and Pi has another
 * trust-requiring project resource, or when trust.json contains an explicit
 * true decision. In particular, this JSON alone never causes Pi to show a
 * trust prompt and cannot silently become active because Pi auto-trusted a
 * project with no protected resources.
 *
 *   {
 *     "enabled": true,
 *     "extraRoots": ["~/Downloads", "/Users/mz/workspace"],
 *     "noUI": "deny"
 *   }
 *
 *   - enabled:    false -> disable this extension entirely
 *   - extraRoots: additional roots treated as "inside"; user-level and
 *                 project-level lists are concatenated (both apply)
 *   - noUI:       "allow" -> in non-interactive mode, allow out-of-project
 *                           paths without prompting; "deny" (default)
 *
 * Environment variables (fallback when neither config file is invalid and
 * the config file does not set the corresponding value):
 *   PATH_SCOPE=0                 -> disable this extension entirely
 *   PATH_SCOPE_EXTRA=/abs/a,/abs/b  -> additional roots treated as "inside"
 *   PATH_SCOPE_NOUI=allow        -> same as noUI: "allow"
 *
 * Invalid JSON/schema is warned about and that file is ignored. Valid settings
 * from the other source remain usable, but environment fallbacks are disabled
 * for the session and the safe defaults (enabled=true, noUI=deny) are used for
 * fields not supplied by a valid file. This prevents malformed configuration
 * or ambient environment values from unexpectedly widening access.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export interface PathScopeConfig {
	enabled?: boolean;
	extraRoots?: string[];
	noUI?: "allow" | "deny";
}

export type PathScopeConfigValidation =
	| { config: PathScopeConfig }
	| { error: string };

/** Pure schema validation, exported so it can be tested without Pi or fs. */
export function validatePathScopeConfig(value: unknown): PathScopeConfigValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { error: "expected a JSON object" };
	}

	const allowedKeys = new Set(["enabled", "extraRoots", "noUI"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) return { error: `unknown property ${JSON.stringify(key)}` };
	}

	const candidate = value as Record<string, unknown>;
	if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
		return { error: "enabled must be a boolean" };
	}
	if (candidate.extraRoots !== undefined) {
		if (!Array.isArray(candidate.extraRoots) ||
			!candidate.extraRoots.every((root) => typeof root === "string" && root.trim().length > 0 && !root.includes("\0"))) {
			return { error: "extraRoots must be an array of non-empty strings" };
		}
	}
	if (candidate.noUI !== undefined && candidate.noUI !== "allow" && candidate.noUI !== "deny") {
		return { error: 'noUI must be "allow" or "deny"' };
	}

	const config: PathScopeConfig = {};
	if (candidate.enabled !== undefined) config.enabled = candidate.enabled as boolean;
	if (candidate.extraRoots !== undefined) config.extraRoots = candidate.extraRoots as string[];
	if (candidate.noUI !== undefined) config.noUI = candidate.noUI as "allow" | "deny";
	return { config };
}

type ConfigFileResult =
	| { status: "absent" }
	| { status: "valid"; config: PathScopeConfig }
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

	const validation = validatePathScopeConfig(parsed);
	return "config" in validation
		? { status: "valid", config: validation.config }
		: { status: "invalid", reason: validation.error };
}

const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/** Match the built-in file tools' input normalization before scope checks. */
export function normalizePathInput(input: string): string {
	let normalized = input.trim().replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
	return normalized;
}

export function resolvePathInput(cwd: string, input: string): string {
	const normalized = normalizePathInput(input);
	return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(cwd, normalized);
}

/** Pure path-boundary check; callers must pass canonicalized paths. */
export function isPathInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve symlinks for an existing path. For a not-yet-existing write path,
 * resolve the nearest existing ancestor and append the missing suffix. If an
 * existing path cannot be realpathed (including a broken symlink), fail closed.
 */
function canonicalizePath(input: string): string | undefined {
	const resolved = path.resolve(input);
	let candidate = resolved;
	const missingSuffix: string[] = [];

	while (true) {
		try {
			const canonical = fs.realpathSync(candidate);
			return path.join(canonical, ...missingSuffix);
		} catch {
			try {
				// An existing but unreadable/broken path must not be guessed at.
				fs.lstatSync(candidate);
				return undefined;
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
					return undefined;
				}
			}
		}

		const parent = path.dirname(candidate);
		if (parent === candidate) return undefined;
		missingSuffix.unshift(path.basename(candidate));
		candidate = parent;
	}
}

interface LoadedConfig {
	cacheKey: string;
	config: PathScopeConfig;
	suppressEnvironment: boolean;
}

function mergeConfigs(
	userResult: ConfigFileResult,
	projectResult: ConfigFileResult | undefined,
): LoadedConfig["config"] {
	const user = userResult.status === "valid" ? userResult.config : undefined;
	const project = projectResult?.status === "valid" ? projectResult.config : undefined;
	const hasExtraRoots = user?.extraRoots !== undefined || project?.extraRoots !== undefined;
	const roots = [
		...(user?.extraRoots ?? []),
		...(project?.extraRoots ?? []),
	];

	return {
		...(user?.enabled === undefined && project?.enabled === undefined
			? {}
			: { enabled: project?.enabled ?? user?.enabled }),
		...(hasExtraRoots ? { extraRoots: roots } : {}),
		...(user?.noUI === undefined && project?.noUI === undefined
			? {}
			: { noUI: project?.noUI ?? user?.noUI }),
	};
}

function isInvalid(result: ConfigFileResult | undefined): boolean {
	return result?.status === "invalid";
}

function isProjectConfigAllowed(cwd: string, projectTrusted: boolean): {
	allowed: boolean;
	trustStoreError?: string;
} {
	let hasExplicitTrust = false;
	let trustStoreError: string | undefined;
	try {
		hasExplicitTrust = new ProjectTrustStore(getAgentDir()).get(cwd) === true;
	} catch (error) {
		trustStoreError = `cannot read trust.json (${String(error)})`;
	}

	let hasPiResources = false;
	if (projectTrusted) {
		try {
			hasPiResources = hasTrustRequiringProjectResources(cwd);
		} catch (error) {
			trustStoreError = trustStoreError ?? `cannot inspect project resources (${String(error)})`;
		}
	}

	// A temporary --no-approve decision must override a persisted true entry.
	const allowed = projectTrusted && (hasExplicitTrust || hasPiResources);
	return {
		allowed,
		trustStoreError,
	};
}

function isEnabled(config: PathScopeConfig, suppressEnvironment: boolean): boolean {
	if (config.enabled !== undefined) return config.enabled;
	return !suppressEnvironment && process.env.PATH_SCOPE !== "0";
}

function configuredExtraRoots(config: PathScopeConfig, suppressEnvironment: boolean): string[] {
	if (config.extraRoots !== undefined) return config.extraRoots;
	if (suppressEnvironment) return [];
	const raw = process.env.PATH_SCOPE_EXTRA;
	return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export default function (pi: ExtensionAPI) {
	// Deliberately extension-instance/session scoped. A fresh instance (including
	// /reload) rereads files and does not inherit previously approved paths.
	let loadedConfig: LoadedConfig | undefined;
	const approved = new Set<string>();
	const warned = new Set<string>();

	const warn = (ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }, message: string) => {
		if (!warned.has(message)) {
			warned.add(message);
			ctx.ui.notify(`path-scope: ${message}`, "warning");
		}
	};

	const getConfig = (cwd: string, projectTrusted: boolean, ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): LoadedConfig => {
		const projectAuthorization = isProjectConfigAllowed(cwd, projectTrusted);
		const cacheKey = `${cwd}\0${projectTrusted}\0${projectAuthorization.allowed}\0${projectAuthorization.trustStoreError ?? ""}`;
		if (loadedConfig?.cacheKey === cacheKey) return loadedConfig;

		const userPath = path.join(getAgentDir(), "path-scope.json");
		const userResult = readJsonConfig(userPath);
		if (userResult.status === "invalid") {
			warn(ctx, `无效用户配置 ${userPath}，已忽略：${userResult.reason}；修复后请 /reload`);
		}

		if (projectAuthorization.trustStoreError) {
			warn(ctx, `项目配置的信任判定出现问题，已按安全条件处理：${projectAuthorization.trustStoreError}`);
		}
		const projectPath = path.join(cwd, CONFIG_DIR_NAME, "path-scope.json");
		const projectResult = projectAuthorization.allowed ? readJsonConfig(projectPath) : undefined;
		if (projectResult?.status === "invalid") {
			warn(ctx, `无效项目配置 ${projectPath}，已忽略：${projectResult.reason}；修复后请 /reload`);
		}

		const suppressEnvironment = isInvalid(userResult) || isInvalid(projectResult);
		loadedConfig = {
			cacheKey,
			config: mergeConfigs(userResult, projectResult),
			suppressEnvironment,
		};
		return loadedConfig;
	};

	pi.on("session_start", (_event, ctx) => {
		loadedConfig = undefined;
		getConfig(ctx.cwd, ctx.isProjectTrusted(), ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const loaded = getConfig(ctx.cwd, ctx.isProjectTrusted(), ctx);
		if (!isEnabled(loaded.config, loaded.suppressEnvironment)) return undefined;

		if (event.toolName === "bash") return undefined;

		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !raw.trim()) return undefined;

		const root = canonicalizePath(ctx.cwd);
		if (root === undefined) {
			return { block: true, reason: `无法安全规范化项目根，已拒绝路径访问: ${ctx.cwd}` };
		}

		let target: string | undefined;
		try {
			target = canonicalizePath(resolvePathInput(ctx.cwd, raw));
		} catch {
			return { block: true, reason: `目标路径格式无效，已拒绝访问: ${raw}` };
		}
		if (target === undefined) {
			return { block: true, reason: `无法安全规范化目标路径，已拒绝访问: ${raw}` };
		}

		const extraRootInputs = configuredExtraRoots(loaded.config, loaded.suppressEnvironment);
		const roots = [root];
		for (const extraRoot of extraRootInputs) {
			let resolvedExtraRoot: string | undefined;
			try {
				resolvedExtraRoot = canonicalizePath(resolvePathInput(ctx.cwd, extraRoot));
			} catch {
				// Invalid URL/path syntax is treated like a failed canonicalization.
			}
			if (resolvedExtraRoot) {
				roots.push(resolvedExtraRoot);
			} else {
				warn(ctx, `extraRoots 路径无法安全规范化，已忽略：${extraRoot}`);
			}
		}

		// Inside the canonical project/extra roots -> allow.
		if (roots.some((rootPath) => isPathInside(rootPath, target))) return undefined;

		// Already approved this session -> allow.
		if (approved.has(target)) return undefined;

		const kind = event.toolName === "read" || event.toolName === "grep" || event.toolName === "ls"
			? "读取"
			: "访问/写入";
		const relative = path.relative(root, target).replace(/^\.\.+[/\\]?/, "");

		// Non-interactive: deny by default, unless explicitly allowed.
		if (!ctx.hasUI) {
			if ((loaded.config.noUI ?? (!loaded.suppressEnvironment ? process.env.PATH_SCOPE_NOUI : undefined)) === "allow") {
				approved.add(target);
				return undefined;
			}
			return { block: true, reason: `项目外路径，无交互环境默认拒绝${kind}: ${target}` };
		}

		const ok = await ctx.ui.confirm(
			`${event.toolName} 想要${kind}项目之外的路径:\n\n  ${target}\n\n（相对项目: ${relative || "(同根)"}）\n\n允许吗？`,
			root,
		);
		if (ok) {
			approved.add(target);
			return undefined;
		}
		return { block: true, reason: `用户拒绝${kind}项目外路径: ${target}` };
	});
}
