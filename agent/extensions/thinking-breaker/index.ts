/**
 * thinking-breaker 探针 —— Phase 1：只观测，不干预。
 *
 * 目的：在决定任何"熔断"策略之前，先拿到真实数据回答三个问题：
 *   1. 哪些 provider/model 真的吐 `thinking_delta` 原文？（有的吐，有的不吐）
 *   2. `delta` 是增量还是累计？（误判会导致凭空造出"复读"）
 *   3. `usage.reasoning` 是否有值？
 *
 * 本扩展**绝不** abort / block / 改消息。写失败也绝不打断 agent。
 *
 * 落盘（`~/.pi/agent/thinking-breaker/`）：
 *   YYYY-MM-DD.jsonl            每条 assistant 消息一行指标摘要
 *   YYYY-MM-DD.thinking.jsonl   每条 assistant 消息一行思考原文（可单独删除）
 *   YYYY-MM-DD.stream.jsonl     每个 thinking_delta 一行流式明细（用于判定增量/累计）
 */

import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIR_NAME = "thinking-breaker";
const CONFIG_NAME = "thinking-breaker.json";
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(thinking|stream))?\.jsonl$/;

interface ProbeConfig {
	enabled: boolean;
	/** 保留天数，session_start 时惰性清理。<=0 关闭清理。 */
	retentionDays: number;
	/** 单文件上限，超过后停止写入并告警一次。 */
	maxFileBytes: number;
	/** 是否把思考原文写入 .thinking.jsonl（用户选择 full 模式）。 */
	captureThinkingText: boolean;
	/** 是否写流式明细（用于判定 delta 增量/累计）。 */
	captureStreamDetail: boolean;
	/** 单条消息思考原文的最大留存字符数，防止单行过大。 */
	maxThinkingCharsPerMessage: number;
	/** dry-run 告警：命中复读模式时在界面提示，但不拦截。 */
	dryRunAlert: boolean;
	/** 界面告警的最小连续重复次数。 */
	alertMinRepeats: number;
}

const DEFAULT_CONFIG: ProbeConfig = {
	enabled: true,
	retentionDays: 14,
	maxFileBytes: 20 * 1024 * 1024,
	captureThinkingText: true,
	captureStreamDetail: true,
	maxThinkingCharsPerMessage: 200_000,
	dryRunAlert: true,
	alertMinRepeats: 20,
};

function loadConfig(raw: unknown): ProbeConfig {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
	const r = raw as Record<string, unknown>;
	const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
	const num = (v: unknown, d: number) =>
		typeof v === "number" && Number.isFinite(v) ? v : d;
	return {
		enabled: bool(r.enabled, DEFAULT_CONFIG.enabled),
		retentionDays: num(r.retentionDays, DEFAULT_CONFIG.retentionDays),
		maxFileBytes: num(r.maxFileBytes, DEFAULT_CONFIG.maxFileBytes),
		captureThinkingText: bool(r.captureThinkingText, DEFAULT_CONFIG.captureThinkingText),
		captureStreamDetail: bool(r.captureStreamDetail, DEFAULT_CONFIG.captureStreamDetail),
		maxThinkingCharsPerMessage: num(
			r.maxThinkingCharsPerMessage,
			DEFAULT_CONFIG.maxThinkingCharsPerMessage,
		),
		dryRunAlert: bool(r.dryRunAlert, DEFAULT_CONFIG.dryRunAlert),
		alertMinRepeats: num(r.alertMinRepeats, DEFAULT_CONFIG.alertMinRepeats),
	};
}

// ---------------------------------------------------------------- 路径与落盘

function probeDir(): string {
	return join(getAgentDir(), DIR_NAME);
}

function localDateKey(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
		date.getDate(),
	).padStart(2, "0")}`;
}

function ledgerPath(date: Date, kind?: "thinking" | "stream"): string {
	const suffix = kind ? `.${kind}` : "";
	return join(probeDir(), `${localDateKey(date)}${suffix}.jsonl`);
}

let dirSecured = false;

async function secureDir(): Promise<void> {
	if (dirSecured) return;
	await mkdir(probeDir(), { recursive: true, mode: 0o700 });
	try {
		const dirStat = await stat(probeDir());
		if (dirStat.isDirectory() && (dirStat.mode & 0o777) !== 0o700) await chmod(probeDir(), 0o700);
	} catch {
		// 权限加固失败不影响观测。
	}
	dirSecured = true;
}

/** 串行化写入，避免并发 append 交错；任何失败都被吞掉，绝不打断 agent。 */
let writeQueue: Promise<void> = Promise.resolve();
const fileSizes = new Map<string, number>();
const capWarned = new Set<string>();
let writeErrorCount = 0;

function appendJsonl(path: string, record: unknown, maxBytes: number): Promise<void> {
	writeQueue = writeQueue
		.then(async () => {
			let size = fileSizes.get(path);
			if (size === undefined) {
				size = await stat(path).then((s) => s.size).catch(() => 0);
			}
			if (size >= maxBytes) {
				// 静默停止；/breaker status 会显示已达上限的文件。
				capWarned.add(path);
				return;
			}
			const line = `${JSON.stringify(record)}\n`;
			await secureDir();
			await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
			fileSizes.set(path, size + Buffer.byteLength(line, "utf8"));
		})
		.catch(() => {
			// 观测失败绝不打断 agent，只记数供 /breaker 展示。
			writeErrorCount += 1;
		});
	return writeQueue;
}

/** 惰性清理过期文件；只由主 Pi 在 session_start 执行。 */
async function collectGarbage(retentionDays: number): Promise<number> {
	if (!(retentionDays > 0)) return 0;
	const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
	let removed = 0;
	try {
		const entries = await readdir(probeDir(), { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const match = FILE_RE.exec(entry.name);
			if (!match) continue;
			const fileDate = Date.parse(`${match[1]}T00:00:00`);
			if (!Number.isFinite(fileDate) || fileDate >= cutoff) continue;
			try {
				await rm(join(probeDir(), entry.name), { force: true });
				removed += 1;
			} catch {
				// 单个文件删除失败不影响其余。
			}
		}
	} catch {
		// 目录不存在或不可读时静默跳过。
	}
	return removed;
}

// ---------------------------------------------------------------- 分析工具

interface RepeatStat {
	top: string;
	count: number;
	coverage: number;
}

/** 空白分词后的最高频 token 及其字符覆盖率。 */
function analyzeTokenRepeat(text: string): RepeatStat | null {
	const tokens = text.split(/\s+/).filter(Boolean);
	if (tokens.length < 20) return null;
	const counts = new Map<string, number>();
	for (const token of tokens) {
		if (token.length > 200) continue;
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	let top = "";
	let count = 0;
	for (const [token, n] of counts) {
		if (n > count || (n === count && token.length > top.length)) {
			top = token;
			count = n;
		}
	}
	if (count < 3) return null;
	const totalChars = text.length || 1;
	return { top: top.slice(0, 120), count, coverage: (count * top.length) / totalChars };
}

/** 行级最高频重复（捕获整行复读）。 */
function analyzeLineRepeat(text: string): RepeatStat | null {
	const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4);
	if (lines.length < 10) return null;
	const counts = new Map<string, number>();
	for (const line of lines) {
		if (line.length > 300) continue;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	let top = "";
	let count = 0;
	for (const [line, n] of counts) {
		if (n > count) {
			top = line;
			count = n;
		}
	}
	if (count < 3) return null;
	const totalChars = text.length || 1;
	return { top: top.slice(0, 120), count, coverage: (count * top.length) / totalChars };
}

/**
 * 尾部周期性检测 —— 直接度量 "OK OK OK ..." 这类复读。
 * 对末尾窗口尝试周期 p，返回最佳周期的重复次数与覆盖比例。
 */
function detectTailPeriod(
	text: string,
	windowSize = 2000,
	maxPeriod = 200,
): { period: number; repeats: number; tailChars: number } | null {
	if (text.length < 60) return null;
	const tail = text.slice(-windowSize);
	const limit = Math.min(maxPeriod, Math.floor(tail.length / 2));
	let best: { period: number; repeats: number; tailChars: number } | null = null;
	for (let period = 1; period <= limit; period++) {
		const unit = tail.slice(-period);
		if (!unit.trim()) continue;
		let repeats = 1;
		let cursor = tail.length - period;
		while (cursor - period >= 0) {
			if (tail.slice(cursor - period, cursor) !== unit) break;
			repeats += 1;
			cursor -= period;
		}
		if (repeats < 4) continue;
		const covered = repeats * period;
		if (!best || covered > best.repeats * best.period) {
			best = { period, repeats, tailChars: covered };
		}
	}
	return best;
}

function shorten(value: string, max = 4000): string {
	return value.length <= max ? value : `${value.slice(0, max)}…[截断 ${value.length - max} 字符]`;
}

/**
 * dry-run 判定：只依靠“思考原文的尾部周期复读”，不看思考时长/ token 量。
 * 返回 null 表示无异常。
 *
 * 保守纪律：
 *   - 必须真的拿到思考原文（否则无从判断，宁可不动）；
 *   - deltaMode 必须是 incremental（cumulative 说明 delta 是累计值，拼接会凭空造出复读）；
 *   - 只接受尾部连续重复，不靠全篇词频（全篇词频对模板化枚举有误报）。
 */
function evaluateRepetition(
	thinkingText: string,
	deltaMode: string,
	minRepeats: number,
): { kind: "tail"; period: number; repeats: number; tailChars: number } | null {
	if (thinkingText.length === 0) return null;
	if (deltaMode !== "incremental") return null;
	const tail = detectTailPeriod(thinkingText);
	if (!tail || tail.repeats < minRepeats) return null;
	return { kind: "tail", ...tail };
}

// ---------------------------------------------------------------- 流式累加器

interface StreamStats {
	provider: string;
	model: string;
	turnIndex: number | undefined;
	startedAt: number;
	thinkingStart: number;
	thinkingDelta: number;
	thinkingEnd: number;
	thinkingDeltaChars: number;
	/** 各 contentIndex 上最后一个 delta 的字符数，用于判定增量/累计。 */
	lastDeltaLen: Map<number, number>;
	/** 各 contentIndex 上 partial thinking 的最大长度。 */
	maxPartialLen: Map<number, number>;
	redactedSeen: boolean;
	textDelta: number;
	textDeltaChars: number;
	toolcallStart: number;
	toolcallEnd: number;
	firstThinkingDeltaAt: number | undefined;
	lastThinkingDeltaAt: number | undefined;
	streamDetailWritten: number;
}

function newStreamStats(provider: string, model: string): StreamStats {
	return {
		provider,
		model,
		turnIndex: undefined,
		startedAt: Date.now(),
		thinkingStart: 0,
		thinkingDelta: 0,
		thinkingEnd: 0,
		thinkingDeltaChars: 0,
		lastDeltaLen: new Map(),
		maxPartialLen: new Map(),
		redactedSeen: false,
		textDelta: 0,
		textDeltaChars: 0,
		toolcallStart: 0,
		toolcallEnd: 0,
		firstThinkingDeltaAt: undefined,
		lastThinkingDeltaAt: undefined,
		streamDetailWritten: 0,
	};
}

/** 从 partial 的 thinking 块取当前累计长度。 */
function partialThinkingLen(partial: unknown): number {
	if (typeof partial !== "object" || partial === null) return 0;
	const content = (partial as { content?: unknown }).content;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: unknown; thinking?: unknown; redacted?: unknown };
		if (b.type !== "thinking") continue;
		if (typeof b.thinking === "string") total += b.thinking.length;
	}
	return total;
}

function partialRedacted(partial: unknown): boolean {
	if (typeof partial !== "object" || partial === null) return false;
	const content = (partial as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "thinking" &&
			(block as { redacted?: unknown }).redacted === true,
	);
}

/** 从结束后的 assistant message 里取思考原文。 */
function extractThinkingText(message: unknown): { text: string; redacted: boolean; blocks: number } {
	if (typeof message !== "object" || message === null) return { text: "", redacted: false, blocks: 0 };
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return { text: "", redacted: false, blocks: 0 };
	const parts: string[] = [];
	let redacted = false;
	let blocks = 0;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: unknown; thinking?: unknown; redacted?: unknown };
		if (b.type !== "thinking") continue;
		blocks += 1;
		if (b.redacted === true) redacted = true;
		if (typeof b.thinking === "string") parts.push(b.thinking);
	}
	return { text: parts.join("\n"), redacted, blocks };
}

function extractUsage(message: unknown): Record<string, unknown> | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		reasoning: u.reasoning,
		totalTokens: u.totalTokens,
		reasoningReported: typeof u.reasoning === "number",
	};
}

// ---------------------------------------------------------------- 扩展主体

export default function thinkingBreaker(pi: ExtensionAPI) {
	let config: ProbeConfig = { ...DEFAULT_CONFIG };
	let sessionId = "unknown";
	let currentTurn: number | undefined;
	let current: StreamStats | undefined;
	let probeEnabled = DEFAULT_CONFIG.enabled;
	/** 本次会话的 dry-run 告警次数。 */
	let alertCount = 0;
	/** 每个 provider/model 是否观测到 thinking_delta，供 /breaker 汇总。 */
	const deltaSeen = new Map<string, { deltas: number; chars: number; redacted: boolean }>();

	// 探针必须完全静默地失败：任何异常都不能影响 agent。
	const safe = async (fn: () => Promise<void> | void): Promise<void> => {
		try {
			await fn();
		} catch {
			// 观测失败不打断 agent。
		}
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await safe(async () => {
			try {
				const raw = JSON.parse(await readFile(join(getAgentDir(), CONFIG_NAME), "utf8")) as unknown;
				config = loadConfig(raw);
			} catch {
				config = { ...DEFAULT_CONFIG };
			}
			probeEnabled = config.enabled;
			if (!probeEnabled) return;

			sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
			await secureDir();
			// 子进程不扫描，避免与主 Pi 竞争。
			if (process.env.MODEL_FAILBACK_CHILD !== "1") {
				await collectGarbage(config.retentionDays);
			}
			ctx.ui.notify(
				`[thinking-breaker] 探针已启用（仅观测）。日志: ${probeDir()}`,
				"info",
			);
		});
	});

	pi.on("turn_start", async (event) => {
		await safe(() => {
			currentTurn = (event as { turnIndex?: number }).turnIndex;
		});
	});

	pi.on("message_start", async (event, ctx) => {
		await safe(() => {
			if (!probeEnabled) return;
			const message = (event as { message?: unknown }).message;
			if (typeof message !== "object" || message === null) return;
			if ((message as { role?: unknown }).role !== "assistant") return;
			const provider = String((message as { provider?: unknown }).provider ?? ctx.model?.provider ?? "unknown");
			const model = String((message as { model?: unknown }).model ?? ctx.model?.id ?? "unknown");
			current = newStreamStats(provider, model);
			current.turnIndex = currentTurn;
		});
	});

	pi.on("message_update", async (event) => {
		await safe(async () => {
			if (!probeEnabled || !current) return;
			const streamEvent = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
			if (typeof streamEvent !== "object" || streamEvent === null) return;
			const ev = streamEvent as {
				type?: unknown;
				contentIndex?: unknown;
				delta?: unknown;
				partial?: unknown;
			};
			const type = String(ev.type ?? "");
			const contentIndex = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
			const delta = typeof ev.delta === "string" ? ev.delta : "";

			if (type === "thinking_start") {
				current.thinkingStart += 1;
				current.maxPartialLen.set(contentIndex, partialThinkingLen(ev.partial));
				return;
			}
			if (type === "thinking_delta") {
				current.thinkingDelta += 1;
				current.thinkingDeltaChars += delta.length;
				if (current.firstThinkingDeltaAt === undefined) current.firstThinkingDeltaAt = Date.now();
				current.lastThinkingDeltaAt = Date.now();
				current.lastDeltaLen.set(contentIndex, delta.length);
				const partialLen = partialThinkingLen(ev.partial);
				current.maxPartialLen.set(
					contentIndex,
					Math.max(current.maxPartialLen.get(contentIndex) ?? 0, partialLen),
				);
				if (partialRedacted(ev.partial)) current.redactedSeen = true;

				const key = `${current.provider}/${current.model}`;
				const seen = deltaSeen.get(key) ?? { deltas: 0, chars: 0, redacted: false };
				seen.deltas += 1;
				seen.chars += delta.length;
				seen.redacted = seen.redacted || current.redactedSeen;
				deltaSeen.set(key, seen);

				// 流式明细：只写前 N 条，够判定增量/累计即可，避免文件膨胀。
				if (config.captureStreamDetail && current.streamDetailWritten < 40) {
					current.streamDetailWritten += 1;
					await appendJsonl(
						ledgerPath(new Date(), "stream"),
						{
							v: 1,
							ts: new Date().toISOString(),
							sessionId,
							provider: current.provider,
							model: current.model,
							turnIndex: current.turnIndex,
							contentIndex,
							deltaLen: delta.length,
							partialThinkingLen: partialLen,
							deltaHead: delta.slice(0, 120),
						},
						config.maxFileBytes,
					);
				}
				return;
			}
			if (type === "thinking_end") {
				current.thinkingEnd += 1;
				const partialLen = partialThinkingLen(ev.partial);
				current.maxPartialLen.set(
					contentIndex,
					Math.max(current.maxPartialLen.get(contentIndex) ?? 0, partialLen),
				);
				if (partialRedacted(ev.partial)) current.redactedSeen = true;
				return;
			}
			if (type === "text_delta") {
				current.textDelta += 1;
				current.textDeltaChars += delta.length;
				return;
			}
			if (type === "toolcall_start") {
				current.toolcallStart += 1;
				return;
			}
			if (type === "toolcall_end") {
				current.toolcallEnd += 1;
			}
		});
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		await safe(async () => {
			if (!probeEnabled || !current) return;
			const message = (event as { message?: unknown }).message;
			if (typeof message !== "object" || message === null) return;
			if ((message as { role?: unknown }).role !== "assistant") return;

			const stats = current;
			current = undefined;

			const thinking = extractThinkingText(message);
			const usage = extractUsage(message);
			const stopReason = String((message as { stopReason?: unknown }).stopReason ?? "unknown");

			// 增量 vs 累计：delta 之和若接近最终长度即为增量；若最大 delta 长度接近最终
			// 长度则为累计。判定错误会凭空造出"复读"，因此必须显式记录。
			const deltaSum = stats.thinkingDeltaChars;
			const finalLen = thinking.text.length;
			let deltaMode: "incremental" | "cumulative" | "mixed" | "unknown" = "unknown";
			if (stats.thinkingDelta > 0 && finalLen > 0) {
				const maxDelta = Math.max(0, ...stats.lastDeltaLen.values());
				const sumRatio = deltaSum / finalLen;
				if (maxDelta >= finalLen * 0.9 && sumRatio > 2) deltaMode = "cumulative";
				else if (sumRatio >= 0.9 && sumRatio <= 1.15) deltaMode = "incremental";
				else deltaMode = "mixed";
			}

			const tokenRepeat = analyzeTokenRepeat(thinking.text);
			const lineRepeat = analyzeLineRepeat(thinking.text);
			const tailPeriod = detectTailPeriod(thinking.text);
			const verdict = evaluateRepetition(thinking.text, deltaMode, config.alertMinRepeats);

			const record = {
				v: 1,
				ts: new Date().toISOString(),
				sessionId,
				provider: stats.provider,
				model: stats.model,
				turnIndex: stats.turnIndex,
				durationMs: Date.now() - stats.startedAt,
				stopReason,
				stream: {
					thinkingStart: stats.thinkingStart,
					thinkingDelta: stats.thinkingDelta,
					thinkingEnd: stats.thinkingEnd,
					thinkingDeltaChars: stats.thinkingDeltaChars,
					thinkingDeltaMs:
						stats.firstThinkingDeltaAt !== undefined && stats.lastThinkingDeltaAt !== undefined
							? stats.lastThinkingDeltaAt - stats.firstThinkingDeltaAt
							: undefined,
					textDelta: stats.textDelta,
					textDeltaChars: stats.textDeltaChars,
					toolcallStart: stats.toolcallStart,
					toolcallEnd: stats.toolcallEnd,
					redacted: stats.redactedSeen,
					deltaMode,
				},
				thinking: {
					blocks: thinking.blocks,
					chars: finalLen,
					redacted: thinking.redacted,
					maxPartialChars: Math.max(0, ...stats.maxPartialLen.values()),
				},
				text: { chars: stats.textDeltaChars },
				usage,
				repeat: {
					token: tokenRepeat,
					line: lineRepeat,
					tail: tailPeriod,
				},
				verdict,
			};

			await appendJsonl(ledgerPath(new Date()), record, config.maxFileBytes);

			if (config.captureThinkingText && thinking.text.length > 0) {
				await appendJsonl(
					ledgerPath(new Date(), "thinking"),
					{
						v: 1,
						ts: new Date().toISOString(),
						sessionId,
						provider: stats.provider,
						model: stats.model,
						turnIndex: stats.turnIndex,
						redacted: thinking.redacted,
						chars: thinking.text.length,
						thinking: shorten(thinking.text, config.maxThinkingCharsPerMessage),
					},
					config.maxFileBytes,
				);
			}

			// dry-run：只提示，不 abort / 不 block / 不改消息。
			if (config.dryRunAlert && verdict) {
				alertCount += 1;
				const unit = thinking.text.slice(-verdict.period).replace(/\s+/g, " ").trim().slice(0, 40);
				ctx.ui.notify(
					`🔁 [thinking-breaker dry-run] ${stats.provider}/${stats.model} 思考尾部连续重复 ` +
						`${verdict.repeats} 次（单元 “${unit}”，共 ${verdict.tailChars} 字符）。\n` +
						`本次仅观测，未拦截。详情: /breaker`, 
					"warning",
				);
			}
		});
	});

	pi.registerCommand("breaker", {
		description: "thinking-breaker 探针：状态 / on / off / purge / open",
		handler: async (args: string, ctx: ExtensionContext) => {
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "status";

			if (sub === "open") {
				ctx.ui.notify(`thinking-breaker 日志目录:\n${probeDir()}`, "info");
				return;
			}

			if (sub === "purge") {
				let removed = 0;
				try {
					const entries = await readdir(probeDir(), { withFileTypes: true });
					for (const entry of entries) {
						if (!entry.isFile() || !FILE_RE.test(entry.name)) continue;
						await rm(join(probeDir(), entry.name), { force: true });
						removed += 1;
					}
				} catch {
					// 目录不存在即视为已清空。
				}
				ctx.ui.notify(`[thinking-breaker] 已删除 ${removed} 个日志文件`, "info");
				return;
			}

			if (sub === "on" || sub === "off") {
				probeEnabled = sub === "on";
				ctx.ui.notify(
					`[thinking-breaker] 本次会话观测已${probeEnabled ? "开启" : "关闭"}（配置文件 ${CONFIG_NAME} 控制持久默认值）`,
					"info",
				);
				return;
			}

			// status
			const lines: string[] = [];
			lines.push(`thinking-breaker 探针（仅观测，不干预）`);
			lines.push(`状态: ${probeEnabled ? "开启" : "关闭"}`);
			lines.push(`目录: ${probeDir()}`);
			lines.push(`保留: ${config.retentionDays} 天 · 单文件上限: ${Math.round(config.maxFileBytes / 1024 / 1024)}MB`);
			lines.push(`原文留存: ${config.captureThinkingText ? "开" : "关"}`);
			lines.push(`流式明细: ${config.captureStreamDetail ? "开" : "关"}`);
			lines.push(
				`dry-run: ${config.dryRunAlert ? `开（阈值 ${config.alertMinRepeats} 次连续重复，只提示不拦截）` : "关"}` +
					(alertCount > 0 ? ` · 本次会话已提示 ${alertCount} 次` : ""),
			);
			if (capWarned.size > 0) lines.push(`⚠ 已达上限停止写入: ${capWarned.size} 个文件（可 /breaker purge 或调大 maxFileBytes）`);
			if (writeErrorCount > 0) lines.push(`⚠ 写入失败 ${writeErrorCount} 次（不影响 agent）`);

			// 读取最近两天的摘要做汇总。
			const today = new Date();
			const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
			const records: Array<Record<string, unknown>> = [];
			for (const date of [today, yesterday]) {
				try {
					const text = await readFile(ledgerPath(date), "utf8");
					for (const line of text.split("\n")) {
						if (!line.trim()) continue;
						try {
							records.push(JSON.parse(line) as Record<string, unknown>);
						} catch {
							// 跳过坏行。
						}
					}
				} catch {
					// 文件不存在则跳过。
				}
			}

			if (records.length === 0) {
				lines.push("");
				lines.push("尚无记录。正常对话几轮后再执行 /breaker。");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// 按模型汇总。熔断可行性取决于“模型+接入路径”是否吐思考原文，
			// 而同一模型可能经不同 provider 接入，能力不同，因此按“模型”分组、
			// 在组内列出 provider 明细，避免把能力不同的接入合并成单一结论。
			const byModel = new Map<
				string,
				{
					n: number;
					withDelta: number;
					withThinking: number;
					alerts: number;
					thinkingChars: number;
					reasoningReported: number;
					maxReasoning: number;
					redacted: number;
					modes: Set<string>;
					maxTailRepeats: number;
					providers: Map<string, number>;
				}
			>();
			for (const record of records) {
				const model = String(record.model ?? "?");
				const provider = String(record.provider ?? "?");
				const row =
					byModel.get(model) ??
					{
						n: 0,
						withDelta: 0,
						withThinking: 0,
						alerts: 0,
						thinkingChars: 0,
						reasoningReported: 0,
						maxReasoning: 0,
						redacted: 0,
						modes: new Set<string>(),
						maxTailRepeats: 0,
						providers: new Map<string, number>(),
					};
				row.n += 1;
				row.providers.set(provider, (row.providers.get(provider) ?? 0) + 1);
				const stream = (record.stream ?? {}) as Record<string, unknown>;
				const thinking = (record.thinking ?? {}) as Record<string, unknown>;
				const usage = (record.usage ?? {}) as Record<string, unknown>;
				const repeat = (record.repeat ?? {}) as Record<string, unknown>;
				const tail = (repeat.tail ?? undefined) as { repeats?: number } | undefined;

				if (typeof stream.thinkingDelta === "number" && stream.thinkingDelta > 0) row.withDelta += 1;
				// 分母只用“真的思考了”的消息：无思考的快速工具调用会把捕获率算成假的低值。
				if (typeof thinking.blocks === "number" && thinking.blocks > 0) row.withThinking += 1;
				if (record.verdict) row.alerts += 1;
				if (typeof thinking.chars === "number") row.thinkingChars += thinking.chars;
				if (usage.reasoningReported === true) {
					row.reasoningReported += 1;
					if (typeof usage.reasoning === "number") {
						row.maxReasoning = Math.max(row.maxReasoning, usage.reasoning);
					}
				}
				if (thinking.redacted === true || stream.redacted === true) row.redacted += 1;
				if (typeof stream.deltaMode === "string") row.modes.add(stream.deltaMode);
				if (tail && typeof tail.repeats === "number") {
					row.maxTailRepeats = Math.max(row.maxTailRepeats, tail.repeats);
				}
				byModel.set(model, row);
			}

			lines.push("");
			lines.push(`近两天消息数: ${records.length}`);
			lines.push("按模型汇总（熔断可行性看模型+接入路径，不看 provider 归属）:");
			for (const [model, row] of [...byModel.entries()].sort((a, b) => b[1].n - a[1].n)) {
				const deltaRate = row.withThinking > 0 ? Math.round((row.withDelta / row.withThinking) * 100) : 0;
				const avgThinking = row.withThinking > 0 ? Math.round(row.thinkingChars / row.withThinking) : 0;
				const reasoningRate = row.withThinking > 0 ? Math.round((row.reasoningReported / row.withThinking) * 100) : 0;
				const flags: string[] = [];
				if (row.withThinking === 0) flags.push("无思考样本");
				else if (deltaRate === 0) flags.push("无思考原文→不可熔断");
				if (row.alerts > 0) flags.push(`dry-run命中×${row.alerts}`);
				if (row.redacted > 0) flags.push(`redacted×${row.redacted}`);
				if (row.maxTailRepeats >= config.alertMinRepeats) flags.push(`尾部复读×${row.maxTailRepeats}`);
				const providerList = [...row.providers.entries()]
					.sort((a, b) => b[1] - a[1])
					.map(([p, c]) => `${p}×${c}`)
					.join(", ");
				lines.push(
					`  ${model}  消息${row.n}(有思考${row.withThinking})  ` +
						`思考时delta捕获${deltaRate}%  平均思考${avgThinking}字  ` +
						`reasoning上报${reasoningRate}%${row.maxReasoning > 0 ? `(峰值${row.maxReasoning})` : ""}  ` +
						`deltaMode=${[...row.modes].join("/") || "?"}` +
						(flags.length > 0 ? `  ⚠ ${flags.join(" · ")}` : ""),
				);
				lines.push(`    接入: ${providerList}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
