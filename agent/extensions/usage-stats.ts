import { createReadStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	BorderedLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Period = "day" | "yesterday" | "week" | "month" | "all";

const PERIODS: readonly Period[] = ["day", "yesterday", "week", "month", "all"];
const UNKNOWN_MODEL = { provider: "unknown", model: "unknown" };

interface UsageStatsConfig {
	showCommandCodeQuota?: boolean;
	showOpenCodeGoQuota?: boolean;
	showDeepSeekBalance?: boolean;
	showWorkBuddyQuota?: boolean;
}

async function readUsageStatsConfig(): Promise<UsageStatsConfig> {
	try {
		const parsed = JSON.parse(await readFile(join(getAgentDir(), "usage-stats.json"), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const values = parsed as Record<string, unknown>;
		const config: UsageStatsConfig = {};
		if (typeof values.showCommandCodeQuota === "boolean") config.showCommandCodeQuota = values.showCommandCodeQuota;
		if (typeof values.showOpenCodeGoQuota === "boolean") config.showOpenCodeGoQuota = values.showOpenCodeGoQuota;
		if (typeof values.showDeepSeekBalance === "boolean") config.showDeepSeekBalance = values.showDeepSeekBalance;
		if (typeof values.showWorkBuddyQuota === "boolean") config.showWorkBuddyQuota = values.showWorkBuddyQuota;
		return config;
	} catch {
		return {};
	}
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface ModelUsage {
	provider: string;
	model: string;
	periods: Record<Period, UsageTotals>;
}

interface CurrentSessionModelUsage {
	provider: string;
	model: string;
	main: UsageTotals;
	subagents: UsageTotals;
}

interface CurrentSessionUsage {
	main: UsageTotals;
	subagents: UsageTotals;
	subagentRecords: number;
	models: CurrentSessionModelUsage[];
}

interface UsageReport {
	rows: ModelUsage[];
	totals: Record<Period, UsageTotals>;
	currentSession?: CurrentSessionUsage;
	sessionCount: number;
	runtimeRecords: number;
	skippedFiles: number;
	invalidLines: number;
	unattributedEntries: number;
	generatedAt: Date;
}

interface RuntimeUsageRecord {
	version: 1;
	timestamp: string;
	provider: string;
	model: string;
	kind: "assistant" | "tool" | "compaction" | "branch_summary";
	usage: unknown;
	/** Root persisted session that spawned this --no-session process, if any. */
	rootSessionId?: string;
}

interface CachedUsageRecord {
	model: { provider: string; model: string };
	usage: UsageTotals;
	timestamp?: number;
	rootSessionId?: string;
}

interface FileFingerprint {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
}

interface CachedFileAggregate {
	fingerprint: FileFingerprint;
	records: CachedUsageRecord[];
	invalidLines: number;
	unattributedEntries: number;
	runtimeRecords: number;
}

const fileAggregateCache = new Map<string, CachedFileAggregate>();
let fileAggregateCacheLoaded = false;
let fileAggregateCacheDirty = false;
let fileAggregateCacheLoadPromise: Promise<void> | undefined;

function persistentCachePath(): string {
	return join(getAgentDir(), "usage-cache.json");
}

async function privateFileStat(path: string) {
	try {
		let fileStat = await stat(path);
		if (!fileStat.isFile()) return undefined;
		if ((fileStat.mode & 0o777) !== 0o600) {
			try {
				await chmod(path, 0o600);
				fileStat = await stat(path);
			} catch {
				// Continue using the file if the permission repair is unavailable.
			}
		}
		return fileStat;
	} catch {
		return undefined;
	}
}

async function secureUsageDirectory(): Promise<void> {
	try {
		await mkdir(runtimeUsageDirectory(), { recursive: true, mode: 0o700 });
		const directoryStat = await stat(runtimeUsageDirectory());
		if (directoryStat.isDirectory() && (directoryStat.mode & 0o777) !== 0o700) {
			await chmod(runtimeUsageDirectory(), 0o700);
		}
	} catch {
		// Permission hardening must never interrupt the agent.
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isUsageTotals(value: unknown): value is UsageTotals {
	if (!value || typeof value !== "object") return false;
	const totals = value as Partial<UsageTotals>;
	return [totals.input, totals.output, totals.cacheRead, totals.cacheWrite, totals.cost].every(isFiniteNumber);
}

function isCachedUsageRecord(value: unknown): value is CachedUsageRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<CachedUsageRecord>;
	const model = record.model;
	return Boolean(
		model &&
		typeof model.provider === "string" &&
		model.provider.length > 0 &&
		typeof model.model === "string" &&
		model.model.length > 0 &&
		isUsageTotals(record.usage) &&
		(record.timestamp === undefined || isFiniteNumber(record.timestamp)) &&
		(record.rootSessionId === undefined || (typeof record.rootSessionId === "string" && record.rootSessionId.length > 0)),
	);
}

function isCachedFileAggregate(value: unknown): value is CachedFileAggregate {
	if (!value || typeof value !== "object") return false;
	const aggregate = value as Partial<CachedFileAggregate>;
	return Boolean(
		aggregate.fingerprint &&
		isFiniteNumber(aggregate.fingerprint.mtimeMs) &&
		isFiniteNumber(aggregate.fingerprint.ctimeMs) &&
		isFiniteNumber(aggregate.fingerprint.size) &&
		Array.isArray(aggregate.records) &&
		aggregate.records.every(isCachedUsageRecord) &&
		isFiniteNumber(aggregate.invalidLines) &&
		isFiniteNumber(aggregate.unattributedEntries) &&
		isFiniteNumber(aggregate.runtimeRecords),
	);
}

async function loadPersistentFileCache(): Promise<void> {
	if (fileAggregateCacheLoaded) return;
	if (!fileAggregateCacheLoadPromise) {
		fileAggregateCacheLoadPromise = (async () => {
			try {
				await privateFileStat(persistentCachePath());
				const parsed = JSON.parse(await readFile(persistentCachePath(), "utf8")) as unknown;
				if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 2) {
					fileAggregateCacheDirty = true;
				} else {
					const files = (parsed as { files?: unknown }).files;
					if (!files || typeof files !== "object") {
						fileAggregateCacheDirty = true;
					} else {
						for (const [key, value] of Object.entries(files)) {
							if (isCachedFileAggregate(value)) fileAggregateCache.set(key, value);
							else fileAggregateCacheDirty = true;
						}
					}
				}
			} catch (error) {
				const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
				if (code !== "ENOENT") fileAggregateCacheDirty = true;
				// The persistent cache is optional; a missing or corrupt cache is rebuilt.
			} finally {
				fileAggregateCacheLoaded = true;
			}
		})();
	}
	await fileAggregateCacheLoadPromise;
}

async function savePersistentFileCache(): Promise<void> {
	if (!fileAggregateCacheDirty) return;
	const path = persistentCachePath();
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		const files = Object.fromEntries(fileAggregateCache.entries());
		await writeFile(temporaryPath, JSON.stringify({ version: 2, files }), { encoding: "utf8", mode: 0o600 });
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, path);
		await chmod(path, 0o600);
		fileAggregateCacheDirty = false;
	} catch {
		// Cache persistence must never interrupt displaying usage statistics.
	}
}

let runtimeWriteQueue: Promise<void> = Promise.resolve();

function runtimeUsageDirectory(): string {
	return join(getAgentDir(), "subagent-usage");
}

function localDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function runtimeUsagePath(date: Date): string {
	return join(runtimeUsageDirectory(), `${localDateKey(date)}.jsonl`);
}

function rootSessionId(): string | undefined {
	const value = process.env.PI_USAGE_ROOT_SESSION_ID?.trim();
	return value || undefined;
}

function persistRuntimeUsage(
	model: { provider: string; model: string },
	kind: RuntimeUsageRecord["kind"],
	usage: unknown,
): Promise<void> {
	const sessionId = rootSessionId();
	const record: RuntimeUsageRecord = {
		version: 1,
		timestamp: new Date().toISOString(),
		provider: model.provider,
		model: model.model,
		kind,
		usage,
		...(sessionId ? { rootSessionId: sessionId } : {}),
	};

	runtimeWriteQueue = runtimeWriteQueue
		.then(async () => {
			const path = runtimeUsagePath(new Date(record.timestamp));
			await secureUsageDirectory();
			await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
			await chmod(path, 0o600);
		})
		.catch(() => {
			// Usage tracking must never interrupt the agent when the ledger is unavailable.
		});
	return runtimeWriteQueue;
}

interface ScanResult {
	report?: UsageReport;
	error?: string;
	/** OpenAI Codex subscription quota from the ChatGPT usage endpoint, when resolvable. */
	codexQuota?: SubscriptionQuotaInfo;
	/** Command Code credits and rolling quota windows, when resolvable. */
	commandCodeQuota?: CommandCodeQuotaInfo;
	/** OpenCode Go subscription quota from its official usage endpoint, when resolvable. */
	opencodeGoQuota?: SubscriptionQuotaInfo;
	/** DeepSeek API account balance from its official balance endpoint, when resolvable. */
	deepSeekBalance?: DeepSeekBalanceInfo;
	/** WorkBuddy credit packs from the WorkBuddy plugin billing endpoint, when resolvable. */
	workBuddyQuota?: WorkBuddyQuotaInfo;
}

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function emptyPeriods(): Record<Period, UsageTotals> {
	return {
		day: emptyTotals(),
		yesterday: emptyTotals(),
		week: emptyTotals(),
		month: emptyTotals(),
		all: emptyTotals(),
	};
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(target: UsageTotals, rawUsage: unknown): void {
	if (!rawUsage || typeof rawUsage !== "object") return;
	const usage = rawUsage as Record<string, unknown>;
	const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : undefined;

	target.input += asNumber(usage.input);
	target.output += asNumber(usage.output);
	target.cacheRead += asNumber(usage.cacheRead);
	target.cacheWrite += asNumber(usage.cacheWrite);
	target.cost += asNumber(cost?.total);
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
}

function normalizedUsage(rawUsage: unknown): UsageTotals {
	const result = emptyTotals();
	addUsage(result, rawUsage);
	return result;
}

function totalTokens(totals: UsageTotals): number {
	return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

function cacheHitRate(totals: UsageTotals): number | undefined {
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	return promptTokens > 0 ? (totals.cacheRead / promptTokens) * 100 : undefined;
}

function formatHitRate(totals: UsageTotals): string {
	const rate = cacheHitRate(totals);
	return rate === undefined ? "-" : `${rate.toFixed(1)}%`;
}

function formatTokens(value: number): string {
	if (value === 0) return "0M";
	const millions = value / 1_000_000;
	if (millions < 0.01) return "<0.01M";
	if (millions < 10) return `${millions.toFixed(2)}M`;
	if (millions < 100) return `${millions.toFixed(1)}M`;
	return `${Math.round(millions)}M`;
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

// --- OpenAI Codex subscription quota (ChatGPT non-public usage endpoint) ---
//
// Mirrors the Codex CLI (`backend-client::Client::get_rate_limits`, ChatGPT path
// style): GET {chatgpt-base}/wham/usage with the OAuth access token that pi has
// already resolved for provider `openai-codex`. Never displays or persists the
// token; any failure skips the quota row without affecting the rest of /usage.

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_USAGE_PATH = "/wham/usage";
const OPENAI_CODEX_REQUEST_TIMEOUT_MS = 8_000;
const OPENAI_CODEX_QUOTA_CACHE_MS = 90_000;

/**
 * 订阅额度窗口。导出给 model-failback 复用同一份 endpoint、鉴权与解析逻辑，
 * 调用方只能取得已解析的额度/重置时间，无法取得 access token 或原始响应。
 */
export interface SubscriptionQuotaWindow {
	label: string;
	percent: number;
	resetsAt?: Date;
}

export interface SubscriptionQuotaInfo {
	planType?: string;
	windows: SubscriptionQuotaWindow[];
	/**
	 * 额度取不到时的简短原因（仅错误类别，如 `HTTP 401`、`timeout`，
	 * 绝不含 access token 或响应原文）。凭据未配置时不设置，整行静默隐藏。
	 */
	unavailable?: string;
}

let codexQuotaInFlight: Promise<SubscriptionQuotaInfo | undefined> | undefined;
let codexQuotaCached: { at: number; value: SubscriptionQuotaInfo | undefined } | undefined;

/** Minimal structural view of the model registry auth resolution used by quota fetches. */
export interface SubscriptionQuotaAuthResolver {
	getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string; baseUrl?: string } } | undefined>;
}

function numericValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function windowPercent(record: Record<string, unknown>): number | undefined {
	const direct = numericValue(record.used_percent);
	if (direct !== undefined) return Math.max(0, Math.min(100, direct));
	const used = numericValue(record.used);
	const max = numericValue(record.max);
	if (used !== undefined && max !== undefined && max > 0) return Math.max(0, Math.min(100, (used / max) * 100));
	return undefined;
}

function windowMinutes(record: Record<string, unknown>): number | undefined {
	const seconds = numericValue(record.limit_window_seconds);
	if (seconds !== undefined && seconds > 0) return seconds / 60;
	const minutes = numericValue(record.window_minutes);
	return minutes !== undefined && minutes > 0 ? minutes : undefined;
}

function windowResetTime(record: Record<string, unknown>): Date | undefined {
	const resetAt = numericValue(record.reset_at);
	if (resetAt !== undefined) return new Date(resetAt * 1000);
	const resetsAt = record.resets_at;
	if (typeof resetsAt === "string" && resetsAt.length > 0) {
		const parsed = Date.parse(resetsAt);
		if (!Number.isNaN(parsed)) return new Date(parsed);
	}
	const after = numericValue(record.reset_after_seconds) ?? numericValue(record.resets_in_secs);
	if (after !== undefined && after >= 0) return new Date(Date.now() + after * 1000);
	return undefined;
}

function minutesLabel(minutes: number): string {
	if (minutes <= 0) return "limit";
	if (minutes === 300) return "5h";
	if (minutes === 10_080) return "weekly";
	if (minutes % 60 === 0) return `${Math.round(minutes / 60)}h`;
	if (minutes < 60) return `${Math.round(minutes)}m`;
	return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
}

/** 只保留可读字符的短标签，避免把响应原文带进面板。 */
function safeLabel(value: unknown, maxLength = 24): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && /^[A-Za-z0-9_. -]+$/.test(trimmed) ? trimmed.slice(0, maxLength) : undefined;
}

function parseCodexWindow(value: unknown, fallbackLabel: string, fallbackMinutes: number | undefined): SubscriptionQuotaWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const percent = windowPercent(record);
	if (percent === undefined) return undefined;
	const minutes = windowMinutes(record) ?? fallbackMinutes;
	return {
		label: minutes === undefined ? fallbackLabel : minutesLabel(minutes),
		percent,
		resetsAt: windowResetTime(record),
	};
}

function parseCodexQuota(json: unknown): SubscriptionQuotaInfo | undefined {
	if (!json || typeof json !== "object") return undefined;
	const root = json as Record<string, unknown>;
	const windows: SubscriptionQuotaWindow[] = [];

	// Current ChatGPT usage endpoint shape: rate_limit.primary/secondary_window.
	const rateLimit = root.rate_limit;
	if (rateLimit && typeof rateLimit === "object") {
		const details = rateLimit as Record<string, unknown>;
		const primary = parseCodexWindow(details.primary_window ?? details.primary, "5h", 300);
		const secondary = parseCodexWindow(details.secondary_window ?? details.secondary, "weekly", 10_080);
		if (primary) windows.push(primary);
		if (secondary) windows.push(secondary);
	}

	// Pro / prolite shape: the account-wide limit may collapse to a single window,
	// with per-model limits published separately under additional_rate_limits.
	// Used only as a fallback so the row never disappears entirely.
	if (windows.length === 0 && Array.isArray(root.additional_rate_limits)) {
		for (const entry of root.additional_rate_limits as unknown[]) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const details = record.rate_limit;
			if (!details || typeof details !== "object") continue;
			const nested = details as Record<string, unknown>;
			const name = safeLabel(record.limit_name) ?? "limit";
			for (const candidate of [nested.primary_window, nested.secondary_window]) {
				const parsed = parseCodexWindow(candidate, name, undefined);
				if (!parsed) continue;
				const label = parsed.label === name ? name : `${name} ${parsed.label}`;
				if (windows.some((window) => window.label === label && window.percent === parsed.percent)) continue;
				if (windows.length >= 3) break;
				windows.push({ ...parsed, label });
			}
			if (windows.length >= 3) break;
		}
	}

	// Legacy shape (older /backend-api/usage): limits["5h"] / limits["1week"] entries.
	if (windows.length === 0 && root.limits && typeof root.limits === "object") {
		for (const [key, value] of Object.entries(root.limits as Record<string, unknown>)) {
			const entry = Array.isArray(value) ? value[0] : value;
			if (/5h|300/i.test(key)) {
				const window = parseCodexWindow(entry, "5h", 300);
				if (window) windows.push(window);
			} else if (/week|10080|7d/i.test(key)) {
				const window = parseCodexWindow(entry, "weekly", 10_080);
				if (window) windows.push(window);
			}
		}
	}

	const planType = safeLabel(root.plan_type ?? root.planType, 32);
	if (windows.length === 0) return { planType, windows: [], unavailable: "no usable windows" };
	return { planType, windows };
}

/** Extracts the ChatGPT account id from the access-token JWT claim, in memory only. */
function chatgptAccountIdFromAccessToken(accessToken: string): string | undefined {
	try {
		const payloadPart = accessToken.split(".")[1];
		if (!payloadPart) return undefined;
		const base64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"];
		if (!auth || typeof auth !== "object") return undefined;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

async function fetchOpenAICodexQuota(resolver: SubscriptionQuotaAuthResolver, signal?: AbortSignal): Promise<SubscriptionQuotaInfo | undefined> {
	try {
		const authResult = await resolver.getProviderAuth(OPENAI_CODEX_PROVIDER_ID);
		const accessToken = authResult?.auth?.apiKey;
		if (!accessToken) return undefined;
		const baseUrl = (authResult?.auth?.baseUrl?.trim() || OPENAI_CODEX_DEFAULT_BASE_URL).replace(/\/+$/, "");

		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_REQUEST_TIMEOUT_MS);
		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "codex-cli",
			};
			const accountId = chatgptAccountIdFromAccessToken(accessToken);
			if (accountId) headers["ChatGPT-Account-Id"] = accountId;
			const response = await fetch(`${baseUrl}${OPENAI_CODEX_USAGE_PATH}`, { headers, signal: controller.signal });
			if (!response.ok) return { windows: [], unavailable: `HTTP ${response.status}` };
			let json: unknown;
			try {
				json = await response.json();
			} catch {
				return { windows: [], planType: undefined, unavailable: "non-JSON response" };
			}
			return parseCodexQuota(json) ?? { windows: [], unavailable: "unexpected response shape" };
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch (error: unknown) {
		// 面板要求「取不到就不影响统计」。用户中途关闭面板时保持静默；
		// 其余失败给出最短原因，让 /usage 说明为什么这一行没数据，而不是整行消失。
		if (signal?.aborted) return undefined;
		const aborted = error instanceof Error && error.name === "AbortError";
		return { windows: [], unavailable: aborted ? "timeout after 8s" : "request failed" };
	}
}

/**
 * 获取 ChatGPT/Codex 账户的订阅窗口；结果只保存在内存 90 秒。
 * 供 /usage 和 model-failback 共用，失败时返回 undefined，绝不抛出凭据或响应内容。
 */
export async function getOpenAICodexQuota(
	resolver: SubscriptionQuotaAuthResolver,
	signal?: AbortSignal,
): Promise<SubscriptionQuotaInfo | undefined> {
	const cached = codexQuotaCached;
	if (cached && Date.now() - cached.at < OPENAI_CODEX_QUOTA_CACHE_MS) return cached.value;
	if (!codexQuotaInFlight) {
		codexQuotaInFlight = fetchOpenAICodexQuota(resolver, signal)
			.then((value) => {
				codexQuotaCached = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				codexQuotaInFlight = undefined;
			});
	}
	return codexQuotaInFlight;
}

function formatResetTime(date: Date): string {
	const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const now = new Date();
	const sameDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	if (sameDay) return hhmm;
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hhmm}`;
}

function renderCodexQuotaLines(quota: SubscriptionQuotaInfo, width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const planType = quota.planType ? ` (${quota.planType})` : "";
	if (quota.windows.length === 0) {
		const reason = quota.unavailable ?? "no data";
		const hint = /^HTTP 4(01|03)$/.test(reason) ? " · Codex 登录可能已失效，运行 /login openai-codex 重新登录" : "";
		return [truncateToWidth(theme.fg("warning", `Codex quota${planType}: unavailable (${reason})${hint}`), innerWidth, "")];
	}
	const parts = quota.windows.map((window) => {
		const reset = window.resetsAt ? ` · resets ${formatResetTime(window.resetsAt)}` : "";
		return `${window.label} ${Math.round(100 - window.percent)}% left${reset}`;
	});
	const line = truncateToWidth(theme.fg("accent", `Codex quota${planType}: ${parts.join("  │  ")}`), innerWidth, "");
	return [line];
}

// --- OpenCode Go subscription quota ---

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

let openCodeGoQuotaInFlight: Promise<SubscriptionQuotaInfo | undefined> | undefined;
let openCodeGoQuotaCached: { at: number; value: SubscriptionQuotaInfo | undefined } | undefined;

function parseOpenCodeGoQuota(json: unknown): SubscriptionQuotaInfo | undefined {
	if (!json || typeof json !== "object") return undefined;
	const usage = (json as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const records = usage as Record<string, unknown>;
	const windows: SubscriptionQuotaWindow[] = [];
	for (const [key, label] of [["rolling", "5h"], ["weekly", "weekly"], ["monthly", "monthly"]] as const) {
		const value = records[key];
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		const percent = numericValue(record.percent);
		if (percent === undefined) continue;
		const resetsAt = record.resetsAt;
		const resetTime = typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt))
			? new Date(resetsAt)
			: undefined;
		windows.push({ label, percent: Math.max(0, Math.min(100, percent)), resetsAt: resetTime });
	}
	return windows.length > 0 ? { windows } : undefined;
}

async function fetchOpenCodeGoQuota(resolver: SubscriptionQuotaAuthResolver, signal?: AbortSignal): Promise<SubscriptionQuotaInfo | undefined> {
	try {
		const authResult = await resolver.getProviderAuth(OPENCODE_GO_PROVIDER_ID);
		const apiKey = authResult?.auth?.apiKey;
		if (!apiKey) return undefined;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(OPENCODE_GO_USAGE_URL, {
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
				signal: controller.signal,
			});
			if (!response.ok) return undefined;
			return parseOpenCodeGoQuota((await response.json()) as unknown);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		// Quota display is best-effort; any failure leaves /usage unchanged.
		return undefined;
	}
}

/** 获取 OpenCode Go 账户的订阅窗口；失败时静默返回 undefined。 */
export async function getOpenCodeGoQuota(
	resolver: SubscriptionQuotaAuthResolver,
	signal?: AbortSignal,
): Promise<SubscriptionQuotaInfo | undefined> {
	const cached = openCodeGoQuotaCached;
	if (cached && Date.now() - cached.at < OPENAI_CODEX_QUOTA_CACHE_MS) return cached.value;
	if (!openCodeGoQuotaInFlight) {
		openCodeGoQuotaInFlight = fetchOpenCodeGoQuota(resolver, signal)
			.then((value) => {
				openCodeGoQuotaCached = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				openCodeGoQuotaInFlight = undefined;
			});
	}
	return openCodeGoQuotaInFlight;
}

function renderOpenCodeGoQuotaLines(quota: SubscriptionQuotaInfo, width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const parts = quota.windows.map((window) => {
		const reset = window.resetsAt ? ` · resets ${formatResetTime(window.resetsAt)}` : "";
		return `${window.label} ${Math.round(100 - window.percent)}% left${reset}`;
	});
	return [truncateToWidth(theme.fg("accent", `OpenCode Go quota: ${parts.join("  │  ")}`), innerWidth, "")];
}

// --- Command Code subscription quota ---
// Command Code documents /usage in its own CLI, but does not publish a quota API.
// These alpha endpoints are the ones used by that CLI; keep this opt-in and
// best-effort so a schema or endpoint change simply hides this line.

const COMMAND_CODE_PROVIDER_ID = "command-code";
const COMMAND_CODE_API_BASE_URL = "https://api.commandcode.ai";

interface CommandCodeQuotaInfo {
	planId?: string;
	remainingCredits?: number;
	windows: SubscriptionQuotaWindow[];
}

let commandCodeQuotaInFlight: Promise<CommandCodeQuotaInfo | undefined> | undefined;
let commandCodeQuotaCached: { at: number; value: CommandCodeQuotaInfo | undefined } | undefined;

function commandCodeResetTime(value: unknown): Date | undefined {
	const number = numericValue(value);
	if (number !== undefined) {
		const date = new Date(number < 1e12 ? number * 1000 : number);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

function commandCodePlanId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9_. -]{1,60}$/.test(value) ? value : undefined;
}

function parseCommandCodeQuota(creditsJson: unknown, subscriptionJson: unknown): CommandCodeQuotaInfo | undefined {
	const root = creditsJson && typeof creditsJson === "object" ? creditsJson as Record<string, unknown> : undefined;
	const credits = root?.credits && typeof root.credits === "object" ? root.credits as Record<string, unknown> : undefined;
	const windowsRoot = root?.windowLimits && typeof root.windowLimits === "object"
		? root.windowLimits as Record<string, unknown>
		: undefined;
	const windows: SubscriptionQuotaWindow[] = [];
	for (const [key, label] of [["fiveHour", "5h"], ["weekly", "weekly"]] as const) {
		const window = windowsRoot?.[key];
		if (!window || typeof window !== "object") continue;
		const values = window as Record<string, unknown>;
		const used = numericValue(values.used);
		const cap = numericValue(values.cap);
		if (used === undefined || cap === undefined || cap <= 0) continue;
		windows.push({
			label,
			percent: Math.max(0, Math.min(100, (used / cap) * 100)),
			resetsAt: commandCodeResetTime(values.resetAt ?? values.reset_at),
		});
	}

	const creditValues = credits
		? [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits].map(numericValue)
		: [];
	const remainingCredits = creditValues.some((value) => value !== undefined)
		? creditValues.reduce((total, value) => total + (value ?? 0), 0)
		: undefined;
	const subscription = subscriptionJson && typeof subscriptionJson === "object"
		? (subscriptionJson as Record<string, unknown>).data
		: undefined;
	const planId = subscription && typeof subscription === "object"
		? commandCodePlanId((subscription as Record<string, unknown>).planId)
		: undefined;
	return remainingCredits === undefined && windows.length === 0 ? undefined : { planId, remainingCredits, windows };
}

async function fetchCommandCodeQuota(resolver: SubscriptionQuotaAuthResolver, signal?: AbortSignal): Promise<CommandCodeQuotaInfo | undefined> {
	try {
		const authResult = await resolver.getProviderAuth(COMMAND_CODE_PROVIDER_ID);
		const apiKey = authResult?.auth?.apiKey;
		if (!apiKey) return undefined;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_REQUEST_TIMEOUT_MS);
		try {
			const request = async (path: string) => {
				const response = await fetch(`${COMMAND_CODE_API_BASE_URL}${path}`, {
					headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
					signal: controller.signal,
				});
				return response.ok ? response.json() as Promise<unknown> : undefined;
			};
			const whoami = await request("/alpha/whoami");
			if (!whoami || typeof whoami !== "object") return undefined;
			const org = (whoami as Record<string, unknown>).org;
			const orgId = org && typeof org === "object" && typeof (org as Record<string, unknown>).id === "string"
				? (org as Record<string, unknown>).id
				: undefined;
			const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
			const [credits, subscription] = await Promise.all([
				request(`/alpha/billing/credits${query}`),
				request(`/alpha/billing/subscriptions${query}`),
			]);
			return parseCommandCodeQuota(credits, subscription);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		return undefined;
	}
}

/** 获取 Command Code 账户的 credits 与订阅窗口；失败时静默返回 undefined。 */
export async function getCommandCodeQuota(
	resolver: SubscriptionQuotaAuthResolver,
	signal?: AbortSignal,
): Promise<CommandCodeQuotaInfo | undefined> {
	const cached = commandCodeQuotaCached;
	if (cached && Date.now() - cached.at < OPENAI_CODEX_QUOTA_CACHE_MS) return cached.value;
	if (!commandCodeQuotaInFlight) {
		commandCodeQuotaInFlight = fetchCommandCodeQuota(resolver, signal)
			.then((value) => {
				if (!signal?.aborted) commandCodeQuotaCached = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				commandCodeQuotaInFlight = undefined;
			});
	}
	return commandCodeQuotaInFlight;
}

function renderCommandCodeQuotaLines(quota: CommandCodeQuotaInfo, width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const plan = quota.planId ? ` (${quota.planId})` : "";
	const parts: string[] = [];
	if (quota.remainingCredits !== undefined) parts.push(`credits ${quota.remainingCredits.toFixed(2)} remaining`);
	for (const window of quota.windows) {
		const reset = window.resetsAt ? ` · resets ${formatResetTime(window.resetsAt)}` : "";
		parts.push(`${window.label} ${Math.round(100 - window.percent)}% left${reset}`);
	}
	return [truncateToWidth(theme.fg("accent", `Command Code quota${plan}: ${parts.join("  │  ")}`), innerWidth, "")];
}

// --- DeepSeek API account balance ---

const DEEPSEEK_PROVIDER_ID = "deepseek";
const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_BALANCE_PATH = "/user/balance";

interface DeepSeekBalanceEntry {
	currency: string;
	totalBalance: number;
	grantedBalance?: number;
	toppedUpBalance?: number;
}

interface DeepSeekBalanceInfo {
	isAvailable?: boolean;
	entries: DeepSeekBalanceEntry[];
}

let deepSeekBalanceInFlight: Promise<DeepSeekBalanceInfo | undefined> | undefined;
let deepSeekBalanceCached: { at: number; value: DeepSeekBalanceInfo | undefined } | undefined;

function parseDeepSeekBalance(json: unknown): DeepSeekBalanceInfo | undefined {
	if (!json || typeof json !== "object") return undefined;
	const root = json as Record<string, unknown>;
	if (!Array.isArray(root.balance_infos)) return undefined;
	const entries: DeepSeekBalanceEntry[] = [];
	for (const value of root.balance_infos) {
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		const currency = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
		const totalBalance = numericValue(record.total_balance);
		if (!/^[A-Z]{3}$/.test(currency) || totalBalance === undefined) continue;
		entries.push({
			currency,
			totalBalance,
			grantedBalance: numericValue(record.granted_balance),
			toppedUpBalance: numericValue(record.topped_up_balance),
		});
	}
	if (entries.length === 0) return undefined;
	return {
		isAvailable: typeof root.is_available === "boolean" ? root.is_available : undefined,
		entries,
	};
}

async function fetchDeepSeekBalance(resolver: SubscriptionQuotaAuthResolver, signal?: AbortSignal): Promise<DeepSeekBalanceInfo | undefined> {
	try {
		const authResult = await resolver.getProviderAuth(DEEPSEEK_PROVIDER_ID);
		const apiKey = authResult?.auth?.apiKey;
		if (!apiKey) return undefined;
		const baseUrl = (authResult?.auth?.baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, "");
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${baseUrl}${DEEPSEEK_BALANCE_PATH}`, {
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
				signal: controller.signal,
			});
			if (!response.ok) return undefined;
			return parseDeepSeekBalance((await response.json()) as unknown);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		// Balance display is best-effort; any failure leaves /usage unchanged.
		return undefined;
	}
}

async function getDeepSeekBalance(resolver: SubscriptionQuotaAuthResolver, signal?: AbortSignal): Promise<DeepSeekBalanceInfo | undefined> {
	const cached = deepSeekBalanceCached;
	if (cached && Date.now() - cached.at < OPENAI_CODEX_QUOTA_CACHE_MS) return cached.value;
	if (!deepSeekBalanceInFlight) {
		deepSeekBalanceInFlight = fetchDeepSeekBalance(resolver, signal)
			.then((value) => {
				deepSeekBalanceCached = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				deepSeekBalanceInFlight = undefined;
			});
	}
	return deepSeekBalanceInFlight;
}

function formatDeepSeekBalanceAmount(currency: string, value: number): string {
	const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
	return `${symbol}${value.toFixed(2)}`;
}

function renderDeepSeekBalanceLines(balance: DeepSeekBalanceInfo, width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const parts = balance.entries.map((entry) => {
		const details: string[] = [];
		if (entry.grantedBalance !== undefined) details.push(`granted ${formatDeepSeekBalanceAmount(entry.currency, entry.grantedBalance)}`);
		if (entry.toppedUpBalance !== undefined) details.push(`topped-up ${formatDeepSeekBalanceAmount(entry.currency, entry.toppedUpBalance)}`);
		const detailText = details.length > 0 ? ` (${details.join(" · ")})` : "";
		return `${entry.currency} ${formatDeepSeekBalanceAmount(entry.currency, entry.totalBalance)}${detailText}`;
	});
	const status = balance.isAvailable === undefined ? "" : balance.isAvailable ? " · available" : " · unavailable";
	return [truncateToWidth(theme.fg("accent", `DeepSeek balance: ${parts.join("  │  ")}${status}`), innerWidth, "")];
}

// --- WorkBuddy credit packs ---
// Same non-public billing endpoint the WorkBuddy desktop app and the
// pi-workbuddy-connect sidebar use. Credits are account-level, so this is
// best-effort like the other quota rows: any failure hides the line only.

const WORKBUDDY_PROVIDER_ID = "workbuddy";
const WORKBUDDY_BILLING_BASE_URL = "https://www.workbuddy.ai";
const WORKBUDDY_RESOURCE_PATH = "/v2/billing/meter/get-user-resource";
const WORKBUDDY_PRODUCT_CODE = "p_tcaca";
const WORKBUDDY_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

interface WorkBuddyCreditPack {
	name: string;
	remain: number;
	size: number;
	expiresAt?: Date;
}

interface WorkBuddyQuotaInfo {
	total: number;
	packs: WorkBuddyCreditPack[];
}

let workBuddyQuotaInFlight: Promise<WorkBuddyQuotaInfo | undefined> | undefined;
let workBuddyQuotaCached: { at: number; value: WorkBuddyQuotaInfo | undefined } | undefined;

function workBuddyStamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseWorkBuddyQuota(json: unknown): WorkBuddyQuotaInfo | undefined {
	if (!json || typeof json !== "object") return undefined;
	const envelope = json as Record<string, unknown>;
	if (numericValue(envelope.code) !== 0) return undefined;
	const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : undefined;
	const response = data?.Response && typeof data.Response === "object" ? data.Response as Record<string, unknown> : undefined;
	const body = response?.Data && typeof response.Data === "object" ? response.Data as Record<string, unknown> : undefined;
	const accounts = body?.Accounts;
	if (!Array.isArray(accounts)) return undefined;

	const packs: WorkBuddyCreditPack[] = [];
	let total = 0;
	for (const value of accounts) {
		if (!value || typeof value !== "object") continue;
		const account = value as Record<string, unknown>;
		const size = numericValue(account.CycleCapacitySize) ?? 0;
		const cycleRemain = numericValue(account.CycleCapacityRemain) ?? 0;
		const cycleUsed = numericValue(account.CycleCapacityUsed) ?? 0;
		// 周期额度未下发时退回一次性总额度，与桌面端侧栏口径一致。
		const remain = Math.max(0, size > 0 || cycleRemain > 0 || cycleUsed > 0
			? cycleRemain
			: numericValue(account.CapacityRemain) ?? 0);
		const expiresAt = typeof account.CycleEndTime === "string" && !Number.isNaN(Date.parse(account.CycleEndTime.replace(" ", "T")))
			? new Date(account.CycleEndTime.replace(" ", "T"))
			: undefined;
		const name = typeof account.PackageName === "string" && account.PackageName.trim() !== ""
			? account.PackageName.trim()
			: "(unnamed)";
		total += remain;
		packs.push({ name, remain, size: size > 0 ? size : numericValue(account.CapacitySize) ?? 0, expiresAt });
	}
	return packs.length > 0 ? { total, packs } : undefined;
}

async function fetchWorkBuddyQuota(resolver: SubscriptionQuotaAuthResolver, signal?: AbortSignal): Promise<WorkBuddyQuotaInfo | undefined> {
	try {
		const authResult = await resolver.getProviderAuth(WORKBUDDY_PROVIDER_ID);
		const accessToken = authResult?.auth?.apiKey;
		if (!accessToken) return undefined;
		const baseUrl = (authResult?.auth?.baseUrl?.trim() || WORKBUDDY_BILLING_BASE_URL).replace(/\/+$/, "");
		const now = new Date();
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), OPENAI_CODEX_REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(`${baseUrl}${WORKBUDDY_RESOURCE_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: "application/json, text/plain, */*",
					"Content-Type": "application/json",
					"X-Requested-With": "XMLHttpRequest",
					Origin: baseUrl,
					Referer: `${baseUrl}/`,
					"User-Agent": WORKBUDDY_CLIENT_UA,
				},
				body: JSON.stringify({
					PageNumber: 1,
					PageSize: 100,
					ProductCode: WORKBUDDY_PRODUCT_CODE,
					Status: [0, 3],
					PackageEndTimeRangeBegin: workBuddyStamp(now),
					PackageEndTimeRangeEnd: workBuddyStamp(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
				}),
				signal: controller.signal,
			});
			if (!response.ok) return undefined;
			return parseWorkBuddyQuota((await response.json()) as unknown);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		// Quota display is best-effort; any failure leaves /usage unchanged.
		return undefined;
	}
}

/** 获取 WorkBuddy 账户的积分包余量；失败时静默返回 undefined。 */
export async function getWorkBuddyQuota(
	resolver: SubscriptionQuotaAuthResolver,
	signal?: AbortSignal,
): Promise<WorkBuddyQuotaInfo | undefined> {
	const cached = workBuddyQuotaCached;
	if (cached && Date.now() - cached.at < OPENAI_CODEX_QUOTA_CACHE_MS) return cached.value;
	if (!workBuddyQuotaInFlight) {
		workBuddyQuotaInFlight = fetchWorkBuddyQuota(resolver, signal)
			.then((value) => {
				workBuddyQuotaCached = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				workBuddyQuotaInFlight = undefined;
			});
	}
	return workBuddyQuotaInFlight;
}

function renderWorkBuddyQuotaLines(quota: WorkBuddyQuotaInfo, width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const parts = [`${quota.total} credits left`];
	for (const pack of quota.packs) {
		const amount = pack.size > 0 ? `${pack.remain}/${pack.size}` : String(pack.remain);
		const expires = pack.expiresAt ? ` · expires ${formatResetTime(pack.expiresAt)}` : "";
		parts.push(`${pack.name} ${amount}${expires}`);
	}
	return [truncateToWidth(theme.fg("accent", `WorkBuddy quota: ${parts.join("  │  ")}`), innerWidth, "")];
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getEntryTimestamp(entry: Record<string, unknown>, fallback?: number): number | undefined {
	const direct = parseTimestamp(entry.timestamp);
	if (direct !== undefined) return direct;

	const message = entry.message;
	if (message && typeof message === "object") {
		const messageTimestamp = parseTimestamp((message as Record<string, unknown>).timestamp);
		if (messageTimestamp !== undefined) return messageTimestamp;
	}

	return fallback;
}

function startOfToday(now: Date): number {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfYesterday(now: Date): number {
	const start = new Date(startOfToday(now));
	start.setDate(start.getDate() - 1);
	return start.getTime();
}

function startOfWeek(now: Date): number {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const day = start.getDay();
	const daysSinceMonday = (day + 6) % 7;
	start.setDate(start.getDate() - daysSinceMonday);
	return start.getTime();
}

function startOfMonth(now: Date): number {
	return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function modelRef(provider: unknown, model: unknown): { provider: string; model: string } | undefined {
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	const normalizedProvider = provider.trim();
	const normalizedModel = model.trim();
	if (!normalizedProvider || !normalizedModel) return undefined;
	return { provider: normalizedProvider, model: normalizedModel };
}

function modelKey(model: { provider: string; model: string }): string {
	return `${model.provider}/${model.model}`;
}

function getOrCreateModel(map: Map<string, ModelUsage>, model: { provider: string; model: string }): ModelUsage {
	const key = modelKey(model);
	let result = map.get(key);
	if (!result) {
		result = { ...model, periods: emptyPeriods() };
		map.set(key, result);
	}
	return result;
}

function getOrCreateSessionModel(
	map: Map<string, CurrentSessionModelUsage>,
	model: { provider: string; model: string },
): CurrentSessionModelUsage {
	const key = modelKey(model);
	let result = map.get(key);
	if (!result) {
		result = { provider: model.provider, model: model.model, main: emptyTotals(), subagents: emptyTotals() };
		map.set(key, result);
	}
	return result;
}

function addToPeriods(
	model: ModelUsage,
	totals: Record<Period, UsageTotals>,
	usage: UsageTotals,
	timestamp: number | undefined,
	periodStarts: Pick<Record<Period, number>, "day" | "yesterday" | "week" | "month">,
	now: number,
): void {
	addTotals(model.periods.all, usage);
	addTotals(totals.all, usage);

	if (timestamp === undefined || timestamp > now) return;
	if (timestamp >= periodStarts.yesterday && timestamp < periodStarts.day) {
		addTotals(model.periods.yesterday, usage);
		addTotals(totals.yesterday, usage);
	}
	for (const period of ["day", "week", "month"] as const) {
		if (timestamp >= periodStarts[period]) {
			addTotals(model.periods[period], usage);
			addTotals(totals[period], usage);
		}
	}
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
	return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
}

function cancelled(): Error {
	return new Error("Scan cancelled");
}

async function parseSessionAggregate(path: string, fingerprint: FileFingerprint, signal: AbortSignal): Promise<CachedFileAggregate> {
	const records: CachedUsageRecord[] = [];
	let invalidLines = 0;
	let unattributedEntries = 0;
	let fallbackTimestamp: number | undefined;
	let currentModel: { provider: string; model: string } | undefined;
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			if (signal.aborted) {
				lines.close();
				input.destroy();
				throw cancelled();
			}
			if (!line.trim()) continue;

			let entry: Record<string, unknown>;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (!parsed || typeof parsed !== "object") {
					invalidLines++;
					continue;
				}
				entry = parsed as Record<string, unknown>;
			} catch {
				invalidLines++;
				continue;
			}

			if (entry.type === "session") {
				fallbackTimestamp = parseTimestamp(entry.timestamp);
				continue;
			}
			if (entry.type === "model_change") {
				currentModel = modelRef(entry.provider, entry.modelId) ?? currentModel;
				continue;
			}

			const timestamp = getEntryTimestamp(entry, fallbackTimestamp);
			let rawUsage: unknown;
			let entryModel: { provider: string; model: string } | undefined;
			const message = entry.message;

			if (entry.type === "message" && message && typeof message === "object") {
				const typedMessage = message as Record<string, unknown>;
				if (typedMessage.role === "assistant") {
					entryModel = modelRef(typedMessage.provider, typedMessage.model) ?? currentModel;
					rawUsage = typedMessage.usage;
					if (entryModel) currentModel = entryModel;
				} else if (typedMessage.role === "toolResult") {
					rawUsage = typedMessage.usage;
					entryModel = currentModel;
				}
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				rawUsage = entry.usage;
				entryModel = currentModel;
			}

			if (rawUsage === undefined) continue;
			if (!entryModel) {
				entryModel = UNKNOWN_MODEL;
				unattributedEntries++;
			}
			records.push({ model: entryModel, usage: normalizedUsage(rawUsage), timestamp });
		}
	} finally {
		lines.close();
	}

	return { fingerprint, records, invalidLines, unattributedEntries, runtimeRecords: 0 };
}

async function parseRuntimeAggregate(path: string, fingerprint: FileFingerprint, signal: AbortSignal): Promise<CachedFileAggregate> {
	const records: CachedUsageRecord[] = [];
	let invalidLines = 0;
	const input = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			if (signal.aborted) {
				lines.close();
				input.destroy();
				throw cancelled();
			}
			if (!line.trim()) continue;

			try {
				const parsed = JSON.parse(line) as Partial<RuntimeUsageRecord>;
				const model = modelRef(parsed.provider, parsed.model);
				if (parsed.version !== 1 || !model || parsed.usage === undefined) {
					invalidLines++;
					continue;
				}
				const rootSessionId = typeof parsed.rootSessionId === "string" && parsed.rootSessionId.trim()
					? parsed.rootSessionId.trim()
					: undefined;
				records.push({ model, usage: normalizedUsage(parsed.usage), timestamp: parseTimestamp(parsed.timestamp), rootSessionId });
			} catch {
				invalidLines++;
			}
		}
	} finally {
		lines.close();
	}

	return { fingerprint, records, invalidLines, unattributedEntries: 0, runtimeRecords: records.length };
}

async function getCachedAggregate(
	key: string,
	path: string,
	kind: "session" | "runtime",
	signal: AbortSignal,
): Promise<CachedFileAggregate | undefined> {
	const fileStat = await privateFileStat(path);
	if (!fileStat) {
		if (fileAggregateCache.delete(key)) fileAggregateCacheDirty = true;
		return undefined;
	}

	const fingerprint = { mtimeMs: fileStat.mtimeMs, ctimeMs: fileStat.ctimeMs, size: fileStat.size };
	const cached = fileAggregateCache.get(key);
	if (cached && sameFingerprint(cached.fingerprint, fingerprint)) return cached;
	if (signal.aborted) throw cancelled();

	if (fileAggregateCache.delete(key)) fileAggregateCacheDirty = true;
	const aggregate = kind === "session"
		? await parseSessionAggregate(path, fingerprint, signal)
		: await parseRuntimeAggregate(path, fingerprint, signal);
	fileAggregateCache.set(key, aggregate);
	fileAggregateCacheDirty = true;
	return aggregate;
}

function removeMissingCachedFiles(prefix: string, activeKeys: Set<string>): void {
	for (const key of fileAggregateCache.keys()) {
		if (key.startsWith(prefix) && !activeKeys.has(key) && fileAggregateCache.delete(key)) fileAggregateCacheDirty = true;
	}
}

async function scanUsage(
	signal: AbortSignal,
	currentSession?: { path: string; id: string },
): Promise<UsageReport> {
	await loadPersistentFileCache();
	const sessions = await SessionManager.listAll();
	if (signal.aborted) throw cancelled();

	const sessionPaths = [...new Set(sessions.map((session) => session.path).filter(Boolean))];
	const nowDate = new Date();
	const now = nowDate.getTime();
	const periodStarts = {
		day: startOfToday(nowDate),
		yesterday: startOfYesterday(nowDate),
		week: startOfWeek(nowDate),
		month: startOfMonth(nowDate),
	};
	const totals = emptyPeriods();
	const models = new Map<string, ModelUsage>();
	const sessionKeys = new Set(sessionPaths.map((path) => `session:${path}`));
	let sessionCount = 0;
	let runtimeRecords = 0;
	let skippedFiles = 0;
	let invalidLines = 0;
	let unattributedEntries = 0;
	const currentSessionUsage = currentSession
		? { main: emptyTotals(), subagents: emptyTotals(), subagentRecords: 0, models: [] as CurrentSessionModelUsage[] }
		: undefined;
	const sessionModels = new Map<string, CurrentSessionModelUsage>();

	for (const path of sessionPaths) {
		if (signal.aborted) throw cancelled();
		const aggregate = await getCachedAggregate(`session:${path}`, path, "session", signal).catch((error: unknown) => {
			if (signal.aborted || (error instanceof Error && error.message === "Scan cancelled")) throw error;
			return undefined;
		});
		if (!aggregate) {
			skippedFiles++;
			continue;
		}
		sessionCount++;
		invalidLines += aggregate.invalidLines;
		unattributedEntries += aggregate.unattributedEntries;
		for (const record of aggregate.records) {
			const model = getOrCreateModel(models, record.model);
			addToPeriods(model, totals, record.usage, record.timestamp, periodStarts, now);
			if (currentSessionUsage && path === currentSession?.path) {
				addTotals(currentSessionUsage.main, record.usage);
				addTotals(getOrCreateSessionModel(sessionModels, record.model).main, record.usage);
			}
		}
	}
	removeMissingCachedFiles("session:", sessionKeys);

	// Include runtime records written by this process before taking the file listing.
	await runtimeWriteQueue;
	let runtimePaths: string[] = [];
	let runtimeListingReliable = false;
	await secureUsageDirectory();
	try {
		const entries = await readdir(runtimeUsageDirectory(), { withFileTypes: true });
		runtimeListingReliable = true;
		runtimePaths = entries
			.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
			.map((entry) => join(runtimeUsageDirectory(), entry.name));
	} catch (error) {
		if (signal.aborted) throw error;
		// ENOENT means there are no runtime records yet; other errors leave the cache intact.
	}

	const runtimeKeys = new Set(runtimePaths.map((path) => `runtime:${path}`));
	for (const path of runtimePaths) {
		if (signal.aborted) throw cancelled();
		const aggregate = await getCachedAggregate(`runtime:${path}`, path, "runtime", signal).catch((error: unknown) => {
			if (signal.aborted || (error instanceof Error && error.message === "Scan cancelled")) throw error;
			return undefined;
		});
		if (!aggregate) {
			skippedFiles++;
			continue;
		}
		runtimeRecords += aggregate.runtimeRecords;
		invalidLines += aggregate.invalidLines;
		for (const record of aggregate.records) {
			const model = getOrCreateModel(models, record.model);
			addToPeriods(model, totals, record.usage, record.timestamp, periodStarts, now);
			if (currentSessionUsage && record.rootSessionId === currentSession?.id) {
				addTotals(currentSessionUsage.subagents, record.usage);
				currentSessionUsage.subagentRecords++;
				addTotals(getOrCreateSessionModel(sessionModels, record.model).subagents, record.usage);
			}
		}
	}
	if (runtimeListingReliable) removeMissingCachedFiles("runtime:", runtimeKeys);
	await savePersistentFileCache();

	if (currentSessionUsage) {
		currentSessionUsage.models = [...sessionModels.values()]
			.filter((row) =>
				totalTokens(row.main) > 0 || row.main.cost > 0 ||
				totalTokens(row.subagents) > 0 || row.subagents.cost > 0)
			.sort((a, b) => {
				const tokenDifference =
					totalTokens(b.main) + totalTokens(b.subagents) - totalTokens(a.main) - totalTokens(a.subagents);
				return tokenDifference || (b.main.cost + b.subagents.cost) - (a.main.cost + a.subagents.cost);
			});
	}

	const rows = [...models.values()]
		.filter((row) => totalTokens(row.periods.all) > 0 || row.periods.all.cost > 0)
		.sort((a, b) => {
			const tokenDifference = totalTokens(b.periods.all) - totalTokens(a.periods.all);
			return tokenDifference || b.periods.all.cost - a.periods.all.cost;
		});

	return {
		rows,
		totals,
		currentSession: currentSessionUsage,
		sessionCount,
		runtimeRecords,
		skippedFiles,
		invalidLines,
		unattributedEntries,
		generatedAt: nowDate,
	};
}

function dateText(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function periodLabel(period: Period, now: Date): string {
	if (period === "day") return `Today ${dateText(now)}`;
	if (period === "yesterday") return `Yesterday ${dateText(new Date(startOfYesterday(now)))}`;
	if (period === "week") {
		const start = new Date(startOfWeek(now));
		return `This week ${dateText(start)}+`;
	}
	if (period === "month") return `This month ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	return "All time";
}

function periodFromArgs(args: string): Period {
	const value = args.trim().toLowerCase();
	if (!value) return "day";
	if (value === "day" || value === "today" || value === "daily") return "day";
	if (value === "yesterday" || value === "yday") return "yesterday";
	if (value === "week" || value === "weekly") return "week";
	if (value === "month" || value === "monthly") return "month";
	return "all";
}

function frameUsageLines(lines: string[], width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const side = theme.fg("borderAccent", "│");
	const top = theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`);
	const bottom = theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`);
	const framed = lines.map((line) => {
		const content = truncateToWidth(line, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return `${side}${content}${padding}${side}`;
	});
	return [top, ...framed, bottom];
}

interface SessionRow {
	provider: string;
	model: string;
	src: "main" | "sub";
	totals: UsageTotals;
}

function buildSessionRows(report: UsageReport): SessionRow[] {
	const session = report.currentSession;
	if (!session) return [];
	const rows: SessionRow[] = [];
	for (const model of session.models) {
		if (totalTokens(model.main) > 0 || model.main.cost > 0) {
			rows.push({ provider: model.provider, model: model.model, src: "main", totals: model.main });
		}
		if (totalTokens(model.subagents) > 0 || model.subagents.cost > 0) {
			rows.push({ provider: model.provider, model: model.model, src: "sub", totals: model.subagents });
		}
	}
	rows.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals) || b.totals.cost - a.totals.cost);
	return rows;
}

function renderUsageTable(
	report: UsageReport,
	period: Period,
	selectedIndex: number,
	startIndex: number,
	width: number,
	theme: any,
	codexQuota?: SubscriptionQuotaInfo,
	openCodeGoQuota?: SubscriptionQuotaInfo,
	deepSeekBalance?: DeepSeekBalanceInfo,
	commandCodeQuota?: CommandCodeQuotaInfo,
	workBuddyQuota?: WorkBuddyQuotaInfo,
): string[] {
	const innerWidth = Math.max(1, width - 2);
	const metricWidths = [11, 10, 8, 10, 10, 10, 10];
	const metricWidth = metricWidths.reduce((sum, value) => sum + value, 0) + metricWidths.length;
	const nameWidth = Math.max(12, innerWidth - metricWidth - 1);
	const now = report.generatedAt;
	const sortedRows = [...report.rows].sort((a, b) => {
		const tokenDifference = totalTokens(b.periods[period]) - totalTokens(a.periods[period]);
		return tokenDifference || b.periods[period].cost - a.periods[period].cost;
	});
	const lines: string[] = [];
	lines.push(truncateToWidth(theme.bold("Usage by provider/model"), innerWidth, ""));
	const tabs = PERIODS.map((item, index) => {
		const label = `[${index + 1}] ${periodLabel(item, now)}`;
		return item === period ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
	}).join("  ");
	lines.push(truncateToWidth(tabs, innerWidth, ""));
	const runtimeText = report.runtimeRecords > 0 ? ` · ${report.runtimeRecords} --no-session records` : "";
	lines.push(
		truncateToWidth(
			theme.fg("dim", `${report.sessionCount} sessions · ${report.rows.length} provider/models${runtimeText} · refreshed ${now.toLocaleTimeString()}`),
			innerWidth,
			"",
		),
	);
	if (codexQuota) lines.push(...renderCodexQuotaLines(codexQuota, width, theme));
	if (openCodeGoQuota) lines.push(...renderOpenCodeGoQuotaLines(openCodeGoQuota, width, theme));
	if (deepSeekBalance) lines.push(...renderDeepSeekBalanceLines(deepSeekBalance, width, theme));
	if (commandCodeQuota) lines.push(...renderCommandCodeQuotaLines(commandCodeQuota, width, theme));
	if (workBuddyQuota) lines.push(...renderWorkBuddyQuotaLines(workBuddyQuota, width, theme));
	const headerCells = ["provider/model", "tokens(M)", "cost", "hit%", "input(M)", "output(M)", "cacheR(M)", "cacheW(M)"];
	const header = headerCells
		.map((cell, index) => {
			const cellWidth = index === 0 ? nameWidth : metricWidths[index - 1]!;
			return cell.padStart(cellWidth);
		})
		.join(" ");
	lines.push(truncateToWidth(theme.fg("muted", header), innerWidth, ""));

	if (sortedRows.length === 0) {
		lines.push(theme.fg("dim", "No usage data found."));
	} else {
		const maxRows = Math.max(1, Math.min(18, sortedRows.length));
		const visibleRows = sortedRows.slice(startIndex, startIndex + maxRows);
		for (const [offset, row] of visibleRows.entries()) {
			const rowIndex = startIndex + offset;
			const values = row.periods[period];
			const cells = [
				truncateToWidth(`${row.provider}/${row.model}`, nameWidth, "…").padStart(nameWidth),
				formatTokens(totalTokens(values)).padStart(metricWidths[0]!),
				formatCost(values.cost).padStart(metricWidths[1]!),
				formatHitRate(values).padStart(metricWidths[2]!),
				formatTokens(values.input).padStart(metricWidths[3]!),
				formatTokens(values.output).padStart(metricWidths[4]!),
				formatTokens(values.cacheRead).padStart(metricWidths[5]!),
				formatTokens(values.cacheWrite).padStart(metricWidths[6]!),
			];
			let line = cells.join(" ");
			if (rowIndex === selectedIndex) line = theme.bg("selectedBg", line);
			lines.push(truncateToWidth(line, innerWidth, ""));
		}
	}

	if (report.currentSession) {
		const { main, subagents, subagentRecords } = report.currentSession;
		const combined = emptyTotals();
		addTotals(combined, main);
		addTotals(combined, subagents);
		const subagentText = subagentRecords > 0
			? ` · subagents ${formatTokens(totalTokens(subagents))}, ${formatCost(subagents.cost)} (${subagentRecords} records)`
			: "";
		lines.push(
			truncateToWidth(
				theme.fg("accent", `Current session: ${formatTokens(totalTokens(combined))}, ${formatCost(combined.cost)}${subagentText}`),
				innerWidth,
				"",
			),
		);
	}

	const total = report.totals[period];
	const totalCells = [
		"TOTAL".padStart(nameWidth),
		formatTokens(totalTokens(total)).padStart(metricWidths[0]!),
		formatCost(total.cost).padStart(metricWidths[1]!),
		formatHitRate(total).padStart(metricWidths[2]!),
		formatTokens(total.input).padStart(metricWidths[3]!),
		formatTokens(total.output).padStart(metricWidths[4]!),
		formatTokens(total.cacheRead).padStart(metricWidths[5]!),
		formatTokens(total.cacheWrite).padStart(metricWidths[6]!),
	];
	lines.push(truncateToWidth(theme.bold(totalCells.join(" ")), innerWidth, ""));

	const notes: string[] = [];
	if (report.unattributedEntries > 0) notes.push(`${report.unattributedEntries} usage entries could not be attributed to a model`);
	if (report.skippedFiles > 0) notes.push(`${report.skippedFiles} session files skipped`);
	if (report.invalidLines > 0) notes.push(`${report.invalidLines} invalid JSONL lines ignored`);
	if (notes.length > 0) lines.push(truncateToWidth(theme.fg("warning", notes.join(" · ")), innerWidth, "…"));
	lines.push(truncateToWidth(theme.fg("dim", "1-5 period · ↑↓/PgUp/PgDn scroll · Esc close"), innerWidth, ""));
	return frameUsageLines(lines, width, theme);
}

function renderSessionTable(
	report: UsageReport,
	sessionRows: SessionRow[],
	selectedIndex: number,
	startIndex: number,
	width: number,
	theme: any,
	codexQuota?: SubscriptionQuotaInfo,
	openCodeGoQuota?: SubscriptionQuotaInfo,
	deepSeekBalance?: DeepSeekBalanceInfo,
	commandCodeQuota?: CommandCodeQuotaInfo,
	workBuddyQuota?: WorkBuddyQuotaInfo,
): string[] {
	const innerWidth = Math.max(1, width - 2);
	const metricWidths = [11, 10, 8, 10, 10, 10, 10];
	const metricWidth = metricWidths.reduce((sum, value) => sum + value, 0) + metricWidths.length;
	const srcWidth = 5;
	const nameWidth = Math.max(12, innerWidth - metricWidth - srcWidth - 2);
	const session = report.currentSession;
	const combined = emptyTotals();
	if (session) {
		addTotals(combined, session.main);
		addTotals(combined, session.subagents);
	}

	const lines: string[] = [];
	lines.push(truncateToWidth(theme.bold("Current session by provider/model"), innerWidth, ""));
	if (codexQuota) lines.push(...renderCodexQuotaLines(codexQuota, width, theme));
	if (openCodeGoQuota) lines.push(...renderOpenCodeGoQuotaLines(openCodeGoQuota, width, theme));
	if (deepSeekBalance) lines.push(...renderDeepSeekBalanceLines(deepSeekBalance, width, theme));
	if (commandCodeQuota) lines.push(...renderCommandCodeQuotaLines(commandCodeQuota, width, theme));
	if (workBuddyQuota) lines.push(...renderWorkBuddyQuotaLines(workBuddyQuota, width, theme));
	if (session) {
		const subagentText = session.subagentRecords > 0
			? ` · subagents ${formatTokens(totalTokens(session.subagents))}, ${formatCost(session.subagents.cost)} (${session.subagentRecords} records)`
			: "";
		lines.push(
			truncateToWidth(
				theme.fg("accent", `Session total: ${formatTokens(totalTokens(combined))}, ${formatCost(combined.cost)}${subagentText}`),
				innerWidth,
				"",
			),
		);
	} else {
		lines.push(theme.fg("dim", "No session file for this run."));
	}
	lines.push(truncateToWidth(theme.fg("dim", "Tab overview · ↑↓/PgUp/PgDn scroll · Esc close"), innerWidth, ""));

	const headerCells = ["provider/model", "src", "tokens(M)", "cost", "hit%", "input(M)", "output(M)", "cacheR(M)", "cacheW(M)"];
	const headerWidths = [nameWidth, srcWidth, ...metricWidths];
	const header = headerCells
		.map((cell, index) => cell.padStart(headerWidths[index]!))
		.join(" ");
	lines.push(truncateToWidth(theme.fg("muted", header), innerWidth, ""));

	if (sessionRows.length === 0) {
		lines.push(theme.fg("dim", "No usage for the current session yet."));
	} else {
		const maxRows = Math.max(1, Math.min(18, sessionRows.length));
		const visibleRows = sessionRows.slice(startIndex, startIndex + maxRows);
		for (const [offset, row] of visibleRows.entries()) {
			const rowIndex = startIndex + offset;
			const cells = [
				truncateToWidth(`${row.provider}/${row.model}`, nameWidth, "…").padStart(nameWidth),
				row.src.padStart(srcWidth),
				formatTokens(totalTokens(row.totals)).padStart(metricWidths[0]!),
				formatCost(row.totals.cost).padStart(metricWidths[1]!),
				formatHitRate(row.totals).padStart(metricWidths[2]!),
				formatTokens(row.totals.input).padStart(metricWidths[3]!),
				formatTokens(row.totals.output).padStart(metricWidths[4]!),
				formatTokens(row.totals.cacheRead).padStart(metricWidths[5]!),
				formatTokens(row.totals.cacheWrite).padStart(metricWidths[6]!),
			];
			let line = cells.join(" ");
			if (rowIndex === selectedIndex) line = theme.bg("selectedBg", line);
			lines.push(truncateToWidth(line, innerWidth, ""));
		}
	}

	return frameUsageLines(lines, width, theme);
}

export default function (pi: ExtensionAPI) {
	// --no-session has no JSONL session file, so persist its usage in a separate
	// numeric-only ledger. Normal persisted sessions are read from their JSONL files
	// and are deliberately not written here to avoid double counting.
	pi.on("message_end", async (event, ctx) => {
		if (ctx.sessionManager.isPersisted() || event.message.role !== "assistant") return;
		const message = event.message;
		const model = modelRef(message.provider, message.model) ?? modelRef(ctx.model?.provider, ctx.model?.id) ?? UNKNOWN_MODEL;
		await persistRuntimeUsage(model, "assistant", message.usage);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.sessionManager.isPersisted() || !event.usage) return;
		const model = modelRef(ctx.model?.provider, ctx.model?.id) ?? UNKNOWN_MODEL;
		await persistRuntimeUsage(model, "tool", event.usage);
	});

	pi.on("session_compact", async (event, ctx) => {
		if (ctx.sessionManager.isPersisted() || !event.compactionEntry.usage) return;
		const model = modelRef(ctx.model?.provider, ctx.model?.id) ?? UNKNOWN_MODEL;
		await persistRuntimeUsage(model, "compaction", event.compactionEntry.usage);
	});

	pi.on("session_tree", async (event, ctx) => {
		if (ctx.sessionManager.isPersisted() || !event.summaryEntry?.usage) return;
		const model = modelRef(ctx.model?.provider, ctx.model?.id) ?? UNKNOWN_MODEL;
		await persistRuntimeUsage(model, "branch_summary", event.summaryEntry.usage);
	});

	pi.registerCommand("usage", {
		description: "Show provider/model token and cost usage by period",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/usage requires interactive TUI mode", "warning");
				return;
			}

			const usageStatsConfig = await readUsageStatsConfig();
			const scanResult = await ctx.ui.custom<ScanResult | null>(
				(tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Scanning all Pi sessions...");
					loader.onAbort = () => done(null);

					Promise.all([
						scanUsage(
							loader.signal,
							ctx.sessionManager.getSessionFile()
								? { path: ctx.sessionManager.getSessionFile()!, id: ctx.sessionManager.getSessionId() }
								: undefined,
						),
						getOpenAICodexQuota(ctx.modelRegistry, loader.signal),
						usageStatsConfig.showCommandCodeQuota === true
							? getCommandCodeQuota(ctx.modelRegistry, loader.signal)
							: Promise.resolve(undefined),
						usageStatsConfig.showOpenCodeGoQuota === true
							? getOpenCodeGoQuota(ctx.modelRegistry, loader.signal)
							: Promise.resolve(undefined),
						usageStatsConfig.showDeepSeekBalance === true
							? getDeepSeekBalance(ctx.modelRegistry, loader.signal)
							: Promise.resolve(undefined),
						usageStatsConfig.showWorkBuddyQuota === false
							? Promise.resolve(undefined)
							: getWorkBuddyQuota(ctx.modelRegistry, loader.signal),
					])
						.then(([report, codexQuota, commandCodeQuota, opencodeGoQuota, deepSeekBalance, workBuddyQuota]) => {
							if (!loader.signal.aborted) done({ report, codexQuota, commandCodeQuota, opencodeGoQuota, deepSeekBalance, workBuddyQuota });
						})
						.catch((error: unknown) => {
							if (!loader.signal.aborted) {
								done({ error: error instanceof Error ? error.message : String(error) });
							}
						});

					return loader;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "70%", maxHeight: "70%", margin: 1 },
				},
			);

			if (!scanResult) return;
			if (scanResult.error || !scanResult.report) {
				ctx.ui.notify(`Usage scan failed: ${scanResult.error ?? "unknown error"}`, "error");
				return;
			}

			const report = scanResult.report;
			const codexQuota = scanResult.codexQuota;
			const opencodeGoQuota = scanResult.opencodeGoQuota;
			const deepSeekBalance = scanResult.deepSeekBalance;
			const commandCodeQuota = scanResult.commandCodeQuota;
			const workBuddyQuota = scanResult.workBuddyQuota;
			const initialPeriod = periodFromArgs(args);
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let period = initialPeriod;
					let selectedIndex = 0;
					let startIndex = 0;
					const sessionRows = buildSessionRows(report);
					let view: "overview" | "session" = sessionRows.length > 0 ? "session" : "overview";

					const requestRender = () => tui.requestRender();
					const viewRowCount = () => (view === "overview" ? report.rows.length : sessionRows.length);
					const adjustScroll = () => {
						const rowCount = viewRowCount();
						const maxRows = Math.max(1, Math.min(18, rowCount));
						if (selectedIndex < startIndex) startIndex = selectedIndex;
						if (selectedIndex >= startIndex + maxRows) startIndex = selectedIndex - maxRows + 1;
						startIndex = Math.max(0, Math.min(startIndex, Math.max(0, rowCount - maxRows)));
					};

					return {
						render(width: number): string[] {
							return view === "overview"
								? renderUsageTable(report, period, selectedIndex, startIndex, width, theme, codexQuota, opencodeGoQuota, deepSeekBalance, commandCodeQuota, workBuddyQuota)
								: renderSessionTable(report, sessionRows, selectedIndex, startIndex, width, theme, codexQuota, opencodeGoQuota, deepSeekBalance, commandCodeQuota, workBuddyQuota);
						},
						handleInput(data: string): void {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
								done(undefined);
								return;
							}
							if (matchesKey(data, Key.tab)) {
								const next: "overview" | "session" = view === "overview" ? "session" : "overview";
								if (next === "overview" || sessionRows.length > 0) {
									view = next;
									selectedIndex = 0;
									startIndex = 0;
								}
								requestRender();
								return;
							}
							const periodIndex = Number(data) - 1;
							if (/^[1-9]$/.test(data) && periodIndex >= 0 && periodIndex < PERIODS.length) {
								period = PERIODS[periodIndex]!;
								requestRender();
								return;
							}
							if (viewRowCount() === 0) return;
							if (matchesKey(data, Key.up)) selectedIndex = Math.max(0, selectedIndex - 1);
							else if (matchesKey(data, Key.down)) selectedIndex = Math.min(viewRowCount() - 1, selectedIndex + 1);
							else if (matchesKey(data, Key.pageUp)) selectedIndex = Math.max(0, selectedIndex - 18);
							else if (matchesKey(data, Key.pageDown)) selectedIndex = Math.min(viewRowCount() - 1, selectedIndex + 18);
							else return;
							adjustScroll();
							requestRender();
						},
						invalidate(): void {},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "95%", maxHeight: "85%", margin: 1 },
				},
			);
		},
	});
}
