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

type Period = "day" | "week" | "month" | "all";

const PERIODS: readonly Period[] = ["day", "week", "month", "all"];
const UNKNOWN_MODEL = { provider: "unknown", model: "unknown" };

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

interface UsageReport {
	rows: ModelUsage[];
	totals: Record<Period, UsageTotals>;
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
}

interface CachedUsageRecord {
	model: { provider: string; model: string };
	usage: UsageTotals;
	timestamp?: number;
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
		(record.timestamp === undefined || isFiniteNumber(record.timestamp)),
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
				if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
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
		await writeFile(temporaryPath, JSON.stringify({ version: 1, files }), { encoding: "utf8", mode: 0o600 });
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

function persistRuntimeUsage(
	model: { provider: string; model: string },
	kind: RuntimeUsageRecord["kind"],
	usage: unknown,
): Promise<void> {
	const record: RuntimeUsageRecord = {
		version: 1,
		timestamp: new Date().toISOString(),
		provider: model.provider,
		model: model.model,
		kind,
		usage,
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
}

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function emptyPeriods(): Record<Period, UsageTotals> {
	return {
		day: emptyTotals(),
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

function addToPeriods(
	model: ModelUsage,
	totals: Record<Period, UsageTotals>,
	usage: UsageTotals,
	timestamp: number | undefined,
	periodStarts: Pick<Record<Period, number>, "day" | "week" | "month">,
	now: number,
): void {
	addTotals(model.periods.all, usage);
	addTotals(totals.all, usage);

	if (timestamp === undefined || timestamp > now) return;
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
				records.push({ model, usage: normalizedUsage(parsed.usage), timestamp: parseTimestamp(parsed.timestamp) });
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

async function scanUsage(signal: AbortSignal): Promise<UsageReport> {
	await loadPersistentFileCache();
	const sessions = await SessionManager.listAll();
	if (signal.aborted) throw cancelled();

	const sessionPaths = [...new Set(sessions.map((session) => session.path).filter(Boolean))];
	const nowDate = new Date();
	const now = nowDate.getTime();
	const periodStarts = {
		day: startOfToday(nowDate),
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
		}
	}
	if (runtimeListingReliable) removeMissingCachedFiles("runtime:", runtimeKeys);
	await savePersistentFileCache();

	const rows = [...models.values()]
		.filter((row) => totalTokens(row.periods.all) > 0 || row.periods.all.cost > 0)
		.sort((a, b) => {
			const tokenDifference = totalTokens(b.periods.all) - totalTokens(a.periods.all);
			return tokenDifference || b.periods.all.cost - a.periods.all.cost;
		});

	return {
		rows,
		totals,
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
	if (period === "week") {
		const start = new Date(startOfWeek(now));
		return `This week ${dateText(start)}+`;
	}
	if (period === "month") return `This month ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	return "All time";
}

function periodFromArgs(args: string): Period {
	const value = args.trim().toLowerCase();
	if (!value) return "week";
	if (value === "day" || value === "today" || value === "daily") return "day";
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

function renderUsageTable(
	report: UsageReport,
	period: Period,
	selectedIndex: number,
	startIndex: number,
	width: number,
	theme: any,
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
	lines.push(truncateToWidth(theme.fg("dim", "1-4 period · ↑↓/PgUp/PgDn scroll · Esc close"), innerWidth, ""));
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

			const scanResult = await ctx.ui.custom<ScanResult | null>(
				(tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Scanning all Pi sessions...");
					loader.onAbort = () => done(null);

					scanUsage(loader.signal)
						.then((report) => {
							if (!loader.signal.aborted) done({ report });
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
			const initialPeriod = periodFromArgs(args);
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let period = initialPeriod;
					let selectedIndex = 0;
					let startIndex = 0;

					const requestRender = () => tui.requestRender();
					const adjustScroll = () => {
						const maxRows = Math.max(1, Math.min(18, report.rows.length));
						if (selectedIndex < startIndex) startIndex = selectedIndex;
						if (selectedIndex >= startIndex + maxRows) startIndex = selectedIndex - maxRows + 1;
						startIndex = Math.max(0, Math.min(startIndex, Math.max(0, report.rows.length - maxRows)));
					};

					return {
						render(width: number): string[] {
							return renderUsageTable(report, period, selectedIndex, startIndex, width, theme);
						},
						handleInput(data: string): void {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
								done(undefined);
								return;
							}
							if (data === "1" || data === "2" || data === "3" || data === "4") {
								period = PERIODS[Number(data) - 1]!;
								requestRender();
								return;
							}
							if (report.rows.length === 0) return;
							if (matchesKey(data, Key.up)) selectedIndex = Math.max(0, selectedIndex - 1);
							else if (matchesKey(data, Key.down)) selectedIndex = Math.min(report.rows.length - 1, selectedIndex + 1);
							else if (matchesKey(data, Key.pageUp)) selectedIndex = Math.max(0, selectedIndex - 18);
							else if (matchesKey(data, Key.pageDown)) selectedIndex = Math.min(report.rows.length - 1, selectedIndex + 18);
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
