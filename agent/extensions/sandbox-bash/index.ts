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
 * credentials/config (auth.json, settings.json, this extension's own code).
 * Reads are deliberately NOT restricted (the model can already read files via
 * the `read` tool; the highest-impact surface is write), except the denyRead
 * denylist. Network is also NOT restricted: the earlier `sandbox` extension
 * (sandbox-runtime) failed on macOS because its proxy-based network allowlist
 * broke DNS/direct connections.
 *
 * Config (user-level): ~/.pi/agent/sandbox-bash.json
 *   {
 *     "enabled": true,
 *     "allowWrite": ["~/Downloads"],
 *     "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"]
 *   }
 *   - allowWrite: extra write-authorized roots, absolute or `~`
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
	normalizeConfigPath,
	validateSandboxBashConfig,
	type SandboxBashConfig,
} from "./core";

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
		if (Array.isArray(roots) && roots.every((r) => typeof r === "string" && r.trim())) {
			return roots as string[];
		}
	} catch {
		// absent or invalid path-scope.json -> no extra roots
	}
	return [];
}

/**
 * True when a candidate root is the pi agent dir (~/.pi/agent) or its parent
 * (~/.pi) or a subpath of either. These hold credentials/config (auth.json,
 * settings.json, extension code) and must never become sandbox write roots.
 */
function isSensitiveRoot(value: string): boolean {
	const agentDir = normalizeConfigPath(getAgentDir());
	const parentDir = dirname(agentDir);
	const abs = normalizeConfigPath(value);
	return (
		abs === agentDir ||
		abs === parentDir ||
		abs.startsWith(agentDir + "/") ||
		abs.startsWith(parentDir + "/")
	);
}

/** Authorized write roots = path-scope roots + allowWrite, minus sensitive paths. */
function authorizedRoots(cfg: LoadedConfig): string[] {
	return [...cfg.pathScopeRoots, ...(cfg.config.allowWrite ?? [])].filter((r) => !isSensitiveRoot(r));
}

const SUPPORTED = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

function createSandboxedBashOps(profile: string): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			return new Promise((resolveResult, reject) => {
				const child = spawn("sandbox-exec", ["-p", profile, "bash", "-c", command], {
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

	pi.registerTool({
		...toolTemplate,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const cfg = getConfig(ctx);
			const currentEnabled = cfg.config.enabled ?? true;
			if (!currentEnabled) {
				return createBashToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			}
			const profile = buildProfile(ctx.cwd, authorizedRoots(cfg), cfg.config.denyRead ?? []);
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
		const profile = buildProfile(ctx.cwd, authorizedRoots(cfg), cfg.config.denyRead ?? []);
		return { operations: createSandboxedBashOps(profile) };
	});
}