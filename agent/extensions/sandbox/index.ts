/**
 * Sandbox Extension - OS-level sandboxing for bash commands.
 *
 * Project-local sandbox.json is deliberately treated as executable security
 * policy: it is loaded only for a trusted project which has Pi-recognized
 * trust-requiring resources, or which has an explicit true entry in Pi's
 * trust.json. A trusted project may therefore widen its own bash permissions;
 * do not trust repositories whose .pi configuration you have not reviewed.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	FilesystemConfigSchema,
	NetworkConfigSchema,
	RipgrepConfigSchema,
	SandboxManager,
	SandboxRuntimeConfigSchema,
	type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	createBashToolDefinition,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	type BashOperations,
} from "@earendil-works/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

type ConfigLayer = Partial<SandboxConfig>;

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

// The published schemas are strip schemas. Rebuild the object portions as
// strict schemas so a typo or a newly invented permission is never ignored.
const StrictSeccompConfigSchema = SandboxRuntimeConfigSchema.shape.seccomp.unwrap().strict();
const StrictRuntimeConfigSchema = SandboxRuntimeConfigSchema.strict().extend({
	network: NetworkConfigSchema.strict(),
	filesystem: FilesystemConfigSchema.strict(),
	ripgrep: RipgrepConfigSchema.strict().optional(),
	seccomp: StrictSeccompConfigSchema.optional(),
});
const RuntimeLayerSchema = StrictRuntimeConfigSchema.partial().extend({
	network: NetworkConfigSchema.partial().strict().optional(),
	filesystem: FilesystemConfigSchema.partial().strict().optional(),
	ripgrep: RipgrepConfigSchema.strict().optional(),
	seccomp: StrictSeccompConfigSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLayer(value: unknown, source: string): ConfigLayer {
	if (!isRecord(value)) throw new Error(`${source}: expected a JSON object`);
	const { enabled, ...runtimeValue } = value;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		throw new Error(`${source}.enabled: expected a boolean`);
	}
	try {
		const parsed = RuntimeLayerSchema.parse(runtimeValue) as ConfigLayer;
		return enabled === undefined ? parsed : { ...parsed, enabled };
	} catch (error) {
		throw new Error(`${source}: invalid sandbox configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function readConfigFile(path: string): ConfigLayer {
	try {
		return validateLayer(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${path}: invalid JSON: ${error.message}`);
		throw error;
	}
}

function mergeValues(base: unknown, override: unknown, additiveArrays: boolean): unknown {
	if (Array.isArray(base) && Array.isArray(override)) {
		return additiveArrays ? [...new Set([...base, ...override])] : [...override];
	}
	if (isRecord(base) && isRecord(override)) {
		const result: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(override)) {
			result[key] = key in result ? mergeValues(result[key], value, additiveArrays) : value;
		}
		return result;
	}
	return override;
}

function mergeConfig(base: ConfigLayer, override: ConfigLayer, additiveArrays: boolean): ConfigLayer {
	return mergeValues(base, override, additiveArrays) as ConfigLayer;
}

interface LoadedConfig {
	config: SandboxConfig;
	projectConfigApplied: boolean;
}

function loadConfig(cwd: string, isProjectTrusted: boolean): LoadedConfig {
	const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "extensions", "sandbox.json");

	// Project sandbox policy is not itself a trust-requiring resource. This
	// prevents a repository containing only .pi/sandbox.json from changing the
	// policy merely because it was opened. The second condition is an explicit
	// persisted trust decision, not just a session/UI indication of trust.
	let projectConfigApplied = false;
	let projectConfig: ConfigLayer = {};
	if (existsSync(projectConfigPath) && isProjectTrusted) {
		const explicitlyTrusted = new ProjectTrustStore(getAgentDir()).getEntry(cwd)?.decision === true;
		if (hasTrustRequiringProjectResources(cwd) || explicitlyTrusted) {
			projectConfig = readConfigFile(projectConfigPath);
			projectConfigApplied = true;
		}
	}

	const defaultConfig = validateLayer(DEFAULT_CONFIG, "built-in defaults");
	const globalConfig = existsSync(globalConfigPath) ? readConfigFile(globalConfigPath) : {};
	const globalMerged = mergeConfig(defaultConfig, globalConfig, false);
	const merged = mergeConfig(globalMerged, projectConfig, true);
	const { enabled, ...runtimeConfig } = merged;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		throw new Error("merged sandbox configuration: enabled must be a boolean");
	}
	try {
		const validatedRuntime = StrictRuntimeConfigSchema.parse(runtimeConfig) as SandboxRuntimeConfig;
		return { config: { ...validatedRuntime, enabled: enabled ?? true }, projectConfigApplied };
	} catch (error) {
		throw new Error(`merged sandbox configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function expandHome(value: string): string {
	if (value === "~") return process.env.HOME ?? value;
	if (value.startsWith("~/")) return join(process.env.HOME ?? "~", value.slice(2));
	return value;
}

function absoluteConfigPath(value: string, cwd: string): string {
	const expanded = expandHome(value);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function isSameDirectory(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return resolve(left) === resolve(right);
	}
}

function absolutizeConfigPaths(config: SandboxRuntimeConfig, cwd: string): SandboxRuntimeConfig {
	return {
		...config,
		network: config.network
			? {
					...config.network,
					allowUnixSockets: config.network.allowUnixSockets?.map((value) => absoluteConfigPath(value, cwd)),
				}
			: config.network,
		filesystem: {
			...config.filesystem,
			denyRead: config.filesystem.denyRead.map((value) => absoluteConfigPath(value, cwd)),
			allowWrite: config.filesystem.allowWrite.map((value) => absoluteConfigPath(value, cwd)),
			denyWrite: config.filesystem.denyWrite.map((value) => absoluteConfigPath(value, cwd)),
		},
		ignoreViolations: config.ignoreViolations
			? Object.fromEntries(
					Object.entries(config.ignoreViolations).map(([command, paths]) => [
						command,
						paths.map((value) => absoluteConfigPath(value, cwd)),
					]),
				)
			: config.ignoreViolations,
		ripgrep: config.ripgrep
			? {
					...config.ripgrep,
					command:
						config.ripgrep.command.startsWith(".") || config.ripgrep.command.startsWith("/") || config.ripgrep.command.startsWith("~")
							? absoluteConfigPath(config.ripgrep.command, cwd)
							: config.ripgrep.command,
				}
			: config.ripgrep,
		seccomp: config.seccomp
			? {
					...config.seccomp,
					bpfPath: config.seccomp.bpfPath ? absoluteConfigPath(config.seccomp.bpfPath, cwd) : undefined,
					applyPath: config.seccomp.applyPath ? absoluteConfigPath(config.seccomp.applyPath, cwd) : undefined,
				}
			: config.seccomp,
	};
}

function osc777Field(value: string): string {
	// C0/C1 controls include BEL; explicitly reject ESC, ST (0x9c), and OSC
	// separators too. Dynamic text must never be able to terminate or add OSC fields.
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u001b;]/g, " ").replace(/\s+/g, " ").trim();
}

function notifyOSC777(ctx: { mode: string }, title: string, body: string): void {
	if (ctx.mode !== "tui") return;
	process.stdout.write(`\x1b]777;notify;${osc777Field(title)};${osc777Field(body)}\x07`);
}

function createBlockedBashOps(reason: string): BashOperations {
	return {
		exec: async () => {
			throw new Error(reason);
		},
	};
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const wrappedCommand = await SandboxManager.wrapWithSandbox(command, undefined, undefined, signal);
			return new Promise((resolveResult, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					env: env ?? process.env,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("error", (error) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				});
				child.on("close", (code) => {
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
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	type SandboxState = "blocked" | "disabled" | "enabled";
	let sandboxState: SandboxState = "blocked";
	let initializedConfig: SandboxRuntimeConfig | undefined;
	let initializedCwd: string | undefined;
	let projectConfigApplied = false;
	let violationUnsubscribe: (() => void) | undefined;
	const toolTemplate = createBashToolDefinition(".");

	pi.registerTool({
		...toolTemplate,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			if (sandboxState === "blocked") {
				throw new Error("Sandbox is unavailable; bash is blocked until initialization succeeds (use --no-sandbox or enabled:false to explicitly disable it).");
			}
			const bash = createBashToolDefinition(ctx.cwd, sandboxState === "enabled" ? { operations: createSandboxedBashOps() } : undefined);
			return bash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("user_bash", (_event, _ctx) => {
		if (sandboxState === "enabled") return { operations: createSandboxedBashOps() };
		if (sandboxState === "blocked") {
			return { operations: createBlockedBashOps("Sandbox is unavailable; user bash is blocked until initialization succeeds.") };
		}
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		sandboxState = "blocked";
		initializedConfig = undefined;
		initializedCwd = undefined;
		projectConfigApplied = false;
		violationUnsubscribe?.();
		violationUnsubscribe = undefined;

		if (pi.getFlag("no-sandbox") === true) {
			sandboxState = "disabled";
			ctx.ui.notify("Sandbox disabled via --no-sandbox; ordinary bash is allowed.", "warning");
			return;
		}

		let loaded: LoadedConfig;
		try {
			loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		} catch (error) {
			ctx.ui.notify(`Sandbox configuration failed; bash is blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (loaded.config.enabled === false) {
			sandboxState = "disabled";
			ctx.ui.notify("Sandbox disabled via explicit enabled:false; ordinary bash is allowed.", "info");
			return;
		}

		const runtimePlatform = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "unknown";
		if (!SandboxManager.isSupportedPlatform(runtimePlatform)) {
			ctx.ui.notify(`Sandbox is not supported on ${process.platform}; bash is blocked.`, "error");
			return;
		}
		// sandbox-runtime 0.0.26 builds Linux mandatory-deny rules from
		// process.cwd(), not the command/session cwd. Refuse a cross-cwd session
		// rather than silently omitting protections for the active project.
		if (process.platform === "linux" && !isSameDirectory(ctx.cwd, process.cwd())) {
			ctx.ui.notify(
				`Sandbox cannot safely initialize for ${ctx.cwd}: Linux runtime is anchored to ${process.cwd()}; bash is blocked. Restart pi in the session directory.`,
				"error",
			);
			return;
		}

		try {
			// `enabled` belongs to this extension, not sandbox-runtime. Remove it
			// before strict runtime validation/initialization.
			const runtimeConfig = { ...loaded.config };
			delete runtimeConfig.enabled;
			const config = absolutizeConfigPaths(runtimeConfig, ctx.cwd);
			// Validate once more after path normalization, immediately before init.
			const finalConfig = StrictRuntimeConfigSchema.parse(config) as SandboxRuntimeConfig;
			const askNetwork = async ({ host, port }: { host: string; port?: number }) => {
				if (!ctx.hasUI) return false;
				const target = osc777Field(`${host}${port ? `:${port}` : ""}`);
				if (ctx.mode === "tui") notifyOSC777(ctx, "Pi 需要授权", `沙箱请求连接 ${target}`);
				else ctx.ui.notify(`沙箱网络请求未列入白名单：${target}`, "warning");
				return Boolean(await ctx.ui.confirm(`沙箱网络请求未列入白名单：\n\n  ${target}\n\n允许连接吗？`, ctx.cwd));
			};

			await SandboxManager.initialize(finalConfig, askNetwork);
			sandboxState = "enabled";
			initializedConfig = JSON.parse(JSON.stringify(SandboxManager.getConfig() ?? finalConfig)) as SandboxRuntimeConfig;
			initializedCwd = ctx.cwd;
			projectConfigApplied = loaded.projectConfigApplied;

			try {
				const store = SandboxManager.getSandboxViolationStore();
				let lastLine = "";
				let lastTs = 0;
				violationUnsubscribe = store.subscribe((violations) => {
					const violation = violations[violations.length - 1];
					if (!violation) return;
					const now = Date.now();
					if (violation.line === lastLine && now - lastTs < 1000) return;
					lastLine = violation.line;
					lastTs = now;
					const snippet = osc777Field(violation.line.slice(0, 120));
					if (ctx.mode === "tui") notifyOSC777(ctx, "Pi 沙箱拦截", snippet);
					else if (ctx.hasUI) ctx.ui.notify(`沙箱拦截：${snippet}`, "warning");
				});
			} catch {
				// Monitoring is optional; sandbox enforcement remains active.
			}

			const networkCount = finalConfig.network.allowedDomains.length;
			const writeCount = finalConfig.filesystem.allowWrite.length;
			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`));
			ctx.ui.notify(
				`Sandbox initialized in ${ctx.cwd}${projectConfigApplied ? "\n警告：已加载受信任项目配置；项目配置可放宽 bash 权限，请确保仓库可信。" : ""}`,
				"info",
			);
		} catch (error) {
			sandboxState = "blocked";
			initializedConfig = undefined;
			try {
				await SandboxManager.reset();
			} catch {
				// Keep the fail-closed state even if partial cleanup fails.
			}
			ctx.ui.notify(`Sandbox initialization failed; bash is blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		violationUnsubscribe?.();
		violationUnsubscribe = undefined;
		if (sandboxState === "enabled") {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors; no subsequent command is allowed by this state.
			}
		}
		sandboxState = "blocked";
		initializedConfig = undefined;
		initializedCwd = undefined;
	});

	pi.registerCommand("sandbox", {
		description: "Show the initialized sandbox configuration",
		handler: async (_args, ctx) => {
			if (sandboxState !== "enabled" || !initializedConfig) {
				ctx.ui.notify(sandboxState === "blocked" ? "Sandbox is blocked (not initialized)." : "Sandbox is disabled.", "info");
				return;
			}
			const securityNote = projectConfigApplied
				? "\nSecurity: trusted project policy was applied and may widen permissions."
				: "\nSecurity: project policy was not applied.";
			ctx.ui.notify(
				`Sandbox initialized configuration (cwd: ${initializedCwd ?? ctx.cwd}):\n${JSON.stringify(initializedConfig, null, 2)}${securityNote}`,
				"info",
			);
		},
	});
}
