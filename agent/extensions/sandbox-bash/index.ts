/**
 * Sandbox Bash Extension — OS-level write isolation for bash commands.
 *
 * Path-scope guards the file tools by path boundary; this extension guards the
 * *bash* tool (and `!` commands) by wrapping every command in macOS's native
 * `sandbox-exec` (Seatbelt). Unlike a regex pattern guard, this is enforced by
 * the kernel: any write outside the authorized roots fails with "Operation not
 * permitted" regardless of how the command is phrased.
 *
 * Scope rules:
 *   - write inside authorized roots  -> allowed
 *   - write outside authorized roots -> denied by the kernel
 *   - read / exec / network          -> allowed (toolchain keeps running)
 *
 * Authorized write roots = cwd + path-scope extraRoots + /tmp + /private/tmp
 * + os.tmpdir(), MINUS the pi agent dir and its parent (~/.pi), which hold
 * credentials/config (auth.json, settings.json, this extension's own code). The
 * exclusion is enforced twice: roots reaching a sensitive dir are dropped after
 * comparing their raw, `..`-preserving and realpath forms, and the profile also
 * denies the sensitive dirs *after* every allow clause, so a broad root (`~`)
 * cannot be written through. When cwd itself lives under a sensitive dir (pi
 * was started inside it, so the project must stay writable), the sensitive dirs
 * are classified instead: dirs inside the cwd subtree stay writable, dirs
 * strictly containing the cwd get no deny but every root covering them is
 * dropped, and disjoint dirs are denied as usual — so credentials outside the
 * cwd are never relaxed just to keep the project writable.
 *
 * On top of the dir-level denies, the exact pi config/credential FILES
 * (auth.json, oauth.json, trust.json, settings.json, models.json,
 * models-store.json, path-scope.json, sandbox-bash.json, bash-guard.json,
 * absolute from getAgentDir()) stay write-denied in EVERY cwd situation — even
 * when the project itself lives inside the agent dir and the dir-level denies
 * are lifted. And ~/.pi/agent/extensions (extension source code) stays
 * editable from any project cwd, re-allowed after the dir-level denies.
 * extraRoots are read from the USER-level ~/.pi/agent/path-scope.json only: a
 * checked-in project must not be able to widen the kernel write boundary.
 * Relative root entries are anchored to the session cwd. Reads are deliberately
 * NOT restricted (the model can already read files via the `read` tool; the
 * highest-impact surface is write), except the denyRead denylist. Network is
 * also NOT restricted: the earlier `sandbox` extension (sandbox-runtime) failed
 * on macOS because its proxy-based network allowlist broke DNS/direct
 * connections.
 *
 * Config (user-level): ~/.pi/agent/sandbox-bash.json
 *   {
 *     "enabled": true,
 *     "allowWrite": ["~/Downloads"],
 *     "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"]
 *   }
 *   - allowWrite: extra write-authorized roots, absolute, `~` or cwd-relative
 *   - denyRead:   sensitive paths denied for reads (data + metadata)
 *
 * On platforms without /usr/bin/sandbox-exec, this extension does nothing
 * (leaves the built-in bash tool untouched).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createBashToolDefinition,
	getAgentDir,
	type BashOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	buildProfile,
	filterSensitiveRoots,
	validateSandboxBashConfig,
	type SandboxBashConfig,
} from "./core";
import { sensitiveWriteFiles } from "./deny-core";

type UI = { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };

interface LoadedConfig {
	config: SandboxBashConfig;
	pathScopeRoots: string[];
}

type ConfigFileResult =
	| { status: "absent" }
	| { status: "valid"; config: SandboxBashConfig }
	| { status: "invalid"; reason: string };

function readConfigFile(path: string): ConfigFileResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { status: "absent" };
		}
		return { status: "invalid", reason: `cannot read file (${String(error)})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: "invalid", reason: "invalid JSON" };
	}
	const validation = validateSandboxBashConfig(parsed);
	if ("error" in validation) return { status: "invalid", reason: validation.error };
	return { status: "valid", config: validation.config };
}

/** Read path-scope's extraRoots so the sandbox authorizes the same paths. */
function readPathScopeRoots(): string[] {
	const configPath = join(getAgentDir(), "path-scope.json");
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		const roots = parsed.extraRoots;
		if (Array.isArray(roots) && roots.every((r) => typeof r === "string" && r.trim() && !r.includes("\0"))) {
			return roots as string[];
		}
	} catch {
		// absent or invalid path-scope.json -> no extra roots
	}
	return [];
}

/**
 * The pi agent dir (~/.pi/agent) and its parent (~/.pi) hold credentials/config
 * (auth.json, settings.json, this extension's own code) and must never become
 * sandbox write roots. Comparison against symlinks and `..` detours happens in
 * core.filterSensitiveRoots, which checks the raw *and* the realpath form.
 */
function sensitiveDirs(): string[] {
	const agentDir = getAgentDir();
	return [agentDir, dirname(agentDir)];
}

/** Authorized write roots = path-scope roots + allowWrite, minus sensitive paths. */
function authorizedRoots(
	cfg: LoadedConfig,
	cwd: string,
	onDropped: (entry: string) => void,
): string[] {
	const candidates = [...cfg.pathScopeRoots, ...(cfg.config.allowWrite ?? [])];
	const sensitive = sensitiveDirs();
	const kept = filterSensitiveRoots(candidates, sensitive, cwd);
	for (const entry of candidates) {
		if (!kept.includes(entry)) onDropped(entry);
	}
	return kept;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SUPPORTED = process.platform === "darwin" && existsSync(SANDBOX_EXEC);

function createSandboxedBashOps(profile: string): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			return new Promise((resolveResult, reject) => {
				const child = spawn(SANDBOX_EXEC, ["-p", profile, "bash", "-c", command], {
					cwd,
					detached: true,
					env: env ?? process.env,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				const kill = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						kill();
					}, timeout * 1000);
				}
				const onAbort = () => kill();
				signal?.addEventListener("abort", onAbort, { once: true });

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (error) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				});
				// Resolve on "exit", not "close": a detached background process can
				// keep the stdout/stderr pipes open long after bash exits, which
				// would hang the tool waiting for "close". Destroy the streams on
				// exit to drop any such stragglers.
				child.on("exit", (code) => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolveResult({ exitCode: code });
				});
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	// On platforms without sandbox-exec, do nothing: leave the built-in bash
	// tool untouched rather than blocking it.
	if (!SUPPORTED) return;

	// Instance/session scoped: a fresh instance (including /reload) rereads files.
	let loaded: LoadedConfig | undefined;
	const warned = new Set<string>();

	const warn = (ctx: UI, message: string) => {
		if (!warned.has(message)) {
			warned.add(message);
			ctx.ui.notify(`sandbox-bash: ${message}`, "warning");
		}
	};

	const note = (ctx: UI, message: string) => {
		if (!warned.has(message)) {
			warned.add(message);
			ctx.ui.notify(`sandbox-bash: ${message}`, "info");
		}
	};

	const getConfig = (ctx: UI): LoadedConfig => {
		if (loaded) return loaded;
		const configPath = join(getAgentDir(), "sandbox-bash.json");
		const result = readConfigFile(configPath);
		if (result.status === "invalid") {
			warn(ctx, `无效配置 ${configPath}，已忽略：${result.reason}；修复后请 /reload`);
		}
		loaded = {
			config: result.status === "valid" ? result.config : {},
			pathScopeRoots: readPathScopeRoots(),
		};
		return loaded;
	};

	pi.on("session_start", (_event, ctx) => {
		loaded = undefined;
		getConfig(ctx);
	});

	pi.on("session_shutdown", () => {
		loaded = undefined;
	});

	const toolTemplate = createBashToolDefinition(".");

	/** One profile per call: the tool path and the `!` path must never diverge. */
	const profileFor = (ctx: UI): string => {
		const cfg = getConfig(ctx);
		const agentDir = getAgentDir();
		return buildProfile(
			ctx.cwd,
			authorizedRoots(cfg, ctx.cwd, (entry) => note(ctx, `已从写授权根中排除 pi 配置/凭据目录（设计如此）：${entry}`)),
			cfg.config.denyRead ?? [],
			sensitiveDirs(),
			// Exact pi config/credential files (auth.json, settings.json, ...):
			// write-denied in every cwd situation, even when the dir-level denies
			// are lifted because the project itself lives inside the agent dir.
			sensitiveWriteFiles(agentDir),
			// agent/extensions source code stays editable from any project cwd,
			// re-allowed after the dir-level agent-dir denies.
			[join(agentDir, "extensions")],
		);
	};

	pi.registerTool({
		...toolTemplate,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const cfg = getConfig(ctx);
			const currentEnabled = cfg.config.enabled ?? true;
			if (!currentEnabled) {
				return createBashToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			}
			const profile = profileFor(ctx);
			const bash = createBashToolDefinition(ctx.cwd, {
				operations: createSandboxedBashOps(profile),
			});
			return bash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("user_bash", (_event, ctx) => {
		const cfg = getConfig(ctx);
		const currentEnabled = cfg.config.enabled ?? true;
		if (!currentEnabled) return undefined;
		const profile = profileFor(ctx);
		return { operations: createSandboxedBashOps(profile) };
	});
}