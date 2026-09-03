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
 * Two additional, cwd-independent protections ride on this gate:
 *   - denyRead (user-level sandbox-bash.json): read / grep / find / ls are
 *     blocked on paths at/under the listed deny roots (canonical, symlinks
 *     resolved; grep/find additionally block a search root that CONTAINS a
 *     deny root, since recursion would enter it). Path resolution mirrors the
 *     built-in tools' resolveToCwd() then canonicalizes. If sandbox-bash.json
 *     is invalid/unreadable, denyRead is treated as absent and the ordinary
 *     path-scope/extraRoots rules continue to apply. write/edit are
 *     NOT affected by denyRead.
 *   - sensitive config files (auth.json, oauth.json, trust.json, settings.json,
 *     models.json, models-store.json, path-scope.json, sandbox-bash.json,
 *     bash-guard.json — absolute paths derived from getAgentDir() and its
 *     parent): write / edit are blocked on them regardless of cwd, extraRoots
 *     or approval. Agent/extensions source code is NOT in this list and stays
 *     editable.
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
import {
	CWD_DEFAULT_TOOLS,
	DENY_READ_TOOLS,
	WRITE_TOOLS,
	buildSensitiveWriteForms,
	canonicalizeDenyEntries,
	canonicalizeForWriteTarget,
	canonicalizePath,
	evaluateReadDeny,
	readSandboxBashConfig,
	resolveLikeBuiltin,
} from "./sandbox-bash/deny-core";

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

	// denyRead (from the USER-level sandbox-bash.json) restricts the built-in
	// read tool family. Cached per instance; roots are canonicalized per cwd.
	interface DenyState {
		status: "absent" | "valid" | "invalid";
		reason?: string;
		denyRead: string[];
	}
	let denyState: DenyState | undefined;
	let denyRootsCache: { cwd: string; roots: string[] } | undefined;
	let sensitiveFormsCache: string[] | undefined;

	const getDenyState = (): DenyState => {
		if (denyState) return denyState;
		try {
			const result = readSandboxBashConfig(path.join(getAgentDir(), "sandbox-bash.json"));
			if (result.status === "invalid") {
				denyState = { status: "invalid", reason: result.reason, denyRead: [] };
			} else {
				denyState = { status: result.status, denyRead: result.denyRead ?? [] };
			}
		} catch {
			// getAgentDir()/read must never let the tool_call handler throw: an
			// unreadable deny source means "no usable blacklist", so the ordinary
			// read/extraRoots rules continue.
			denyState = { status: "absent", denyRead: [] };
		}
		return denyState;
	};

	/**
	 * Canonical denyRead roots anchored to the session cwd (like the Seatbelt
	 * side). Every entry is isolated by canonicalizeDenyEntries (shared
	 * failure handling with core.canonicalDenyRoots): an illegal file: URL
	 * (fileURLToPath throws) or an unresolvable entry is skipped with a
	 * warning and never throws out of the tool_call handler, nor blocks the
	 * normal extraRoots flow. Resolution itself stays built-in specific
	 * (resolveToCwd) so coverage never shifts when the helper is reused.
	 */
	const denyRootsFor = (cwd: string, ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): string[] => {
		if (denyRootsCache?.cwd === cwd) return denyRootsCache.roots;
		try {
			const state = getDenyState();
			if (state.status !== "valid") {
				denyRootsCache = { cwd, roots: [] };
				return denyRootsCache.roots;
			}
			const roots = canonicalizeDenyEntries(state.denyRead, cwd, (entry, reason) => {
				warn(ctx, `denyRead 路径无法规范化，已忽略：${entry}（${reason}）`);
			});
			denyRootsCache = { cwd, roots };
			return denyRootsCache.roots;
		} catch {
			// Total: a blacklist failure must never break unrelated reads.
			if (denyRootsCache?.cwd !== cwd) denyRootsCache = { cwd, roots: [] };
			return denyRootsCache.roots;
		}
	};

	/**
	 * Absolute sensitive config files write/edit must never touch. Derived
	 * from an absolute getAgentDir() (buildSensitiveWriteForms forces
	 * path.resolve) in raw + canonical form; never throws, never reads file
	 * contents. Checked BEFORE the enabled flag so enabled:false cannot
	 * bypass it, and compared against the dangling-aware target form so a
	 * symlink to a not-yet-existing sensitive file still matches.
	 */
	const sensitiveForms = (): string[] => {
		if (sensitiveFormsCache) return sensitiveFormsCache;
		try {
			sensitiveFormsCache = buildSensitiveWriteForms(getAgentDir());
		} catch {
			sensitiveFormsCache = [];
		}
		return sensitiveFormsCache;
	};

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
		denyState = undefined;
		denyRootsCache = undefined;
		sensitiveFormsCache = undefined;
		getConfig(ctx.cwd, ctx.isProjectTrusted(), ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") return undefined;

		const loaded = getConfig(ctx.cwd, ctx.isProjectTrusted(), ctx);

		// --- denyRead gate: built-in read/grep/find/ls (user-level sandbox-bash.json) ---
		// Runs BEFORE the path-scope boundary checks, so a configured deny list beats
		// cwd / extraRoots / session approval. An invalid sandbox-bash.json has no
		// usable deny list and therefore does not disable the normal read behavior.
		if (DENY_READ_TOOLS.has(event.toolName)) {
			const state = getDenyState();
			const rawPath = (event.input as { path?: unknown }).path;
			const hasPath = typeof rawPath === "string" && rawPath.trim().length > 0;
			// grep/find/ls default a missing `path` to the session cwd (the built-ins
			// resolve `path || "."`), so a cwd-wide search must still be checked here.
			const inputPath = hasPath ? (rawPath as string) : CWD_DEFAULT_TOOLS.has(event.toolName) ? "." : undefined;
			if (state.status === "invalid") {
				warn(ctx, `sandbox-bash.json 无效，denyRead 已按未配置处理：${state.reason}；修复后请 /reload`);
			}
			if (inputPath !== undefined) {
				let denyTarget: string | undefined;
				try {
					denyTarget = canonicalizePath(resolveLikeBuiltin(inputPath, ctx.cwd));
				} catch {
					denyTarget = undefined;
				}
				const decision = evaluateReadDeny({
					toolName: event.toolName,
					target: denyTarget,
					denyRoots: denyRootsFor(ctx.cwd, ctx),
					configBroken: false,
					configReason: state.reason,
				});
				if (decision.block) return decision;
			}
		}

		// --- sensitive config file write protection (write/edit) ---
		// Absolute, cwd-independent, derived from getAgentDir(); beats extraRoots,
		// session approval and the enabled flag. denyRead itself does NOT restrict
		// write/edit — only these exact pi config/credential files do.
		if (WRITE_TOOLS.has(event.toolName)) {
			const rawPath = (event.input as { path?: unknown }).path;
			if (typeof rawPath === "string" && rawPath.trim()) {
				// Dangling-aware: a symlink to a not-yet-existing sensitive config
				// file must still match (canonicalizePath alone returns undefined
				// there and would bypass). Never throws; unresolvable input simply
				// falls through to the boundary flow below.
				let target: string | undefined;
				try {
					target = canonicalizeForWriteTarget(resolveLikeBuiltin(rawPath, ctx.cwd));
				} catch {
					target = undefined;
				}
				if (target !== undefined && sensitiveForms().includes(target)) {
					return {
						block: true,
						reason: `受保护配置文件，禁止 ${event.toolName === "write" ? "写入" : "编辑"}: ${target}`,
					};
				}
			}
		}

		// From here on: the ordinary path-scope boundary flow.
		if (!isEnabled(loaded.config, loaded.suppressEnvironment)) return undefined;

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
