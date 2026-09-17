/**
 * thinking-breaker —— 思考复读探针 + 熔断（Phase 2）。
 *
 * Phase 1 只观测，用来回答三个问题：哪些 provider 真的吐思考原文、`delta` 是增量
 * 还是累计、`usage.reasoning` 有没有值。2601 条真实思考原文的结论是：只有
 * `workbuddy/deepseek-v4.1-flash` 会尾部周期复读，`delta` 全为增量，`usage`
 * 不可用 —— 唯一可靠的信号就是思考原文的尾部周期。
 *
 * Phase 2 在**流式过程中**熔断（`enforce`，默认关，需显式开启）：
 *   1. 尾部窗口节流检测到周期复读 → 打标记 → `ctx.abort()`
 *   2. `message_end` 里把复读段从思考块中剥掉再落盘 —— 否则中止后的思考块会
 *      完整留在上下文里（事故记录：35 万字符 ≈ 8.8 万 token）白烧下一轮
 *   3. 自动续跑；同一模型第二次命中则交给 model-failback 换链
 *
 * 熔断的三条纪律：
 *   - **只信尾部周期**。全篇词频会被模板化枚举污染（"第 1 项…第 2 项…"）。
 *   - **delta 必须校验为增量**。累计模式下拼接 delta 会凭空造出复读。
 *   - **只在能验证时动手**。拿不到思考原文、或 delta 校验不过，一律只观测。
 *
 * 落盘（`~/.pi/agent/thinking-breaker/`）：
 *   YYYY-MM-DD.jsonl            每条 assistant 消息一行指标摘要
 *   YYYY-MM-DD.thinking.jsonl   每条 assistant 消息一行思考原文（可单独删除）
 *   YYYY-MM-DD.stream.jsonl     每个 thinking_delta 一行流式明细（用于判定增量/累计）
 *
 * 任何写失败、检测异常都绝不打断 agent。
 */

import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * `MessageEndEventResult` 没有从包根导出，而 `message_end` 的返回值必须与
 * `AgentMessage` 结构一致才能通过重载解析。用导出的 `MessageEndEvent` 取出
 * 消息类型，避免手写一份会漂移的副本。
 */
type AgentMessageLike = MessageEndEvent["message"];
import {
	DeltaGuard,
	TailWindow,
	capKeptPrefix,
	detectTailPeriod,
	shouldBreak,
	stripAllLoopTail,
	type TailPeriod,
} from "./detect.ts";
import { ESCALATE_EVENT, type EscalateReply, type EscalateRequest } from "./escalate.ts";

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
	/**
	 * 熔断开关。默认 **关** —— 拦截是侵入性行为，必须由用户显式打开。
	 * 打开后：命中即 abort，剥掉复读思考，自动续跑。
	 */
	enforce: boolean;
	/** 熔断所需的最小连续重复次数。实测 10 在 2648 条真实思考上零误报。 */
	enforceMinRepeats: number;
	/** 熔断所需的最小思考长度；太短的思考不值得动手。 */
	enforceMinChars: number;
	/** 复读单元长度上限，与观测阈值保持一致。 */
	enforceMaxPeriod: number;
	/** 流式检测的节流间隔（ms）。一次事故有 10 万个 delta，绝不能逐个检测。 */
	enforceCheckIntervalMs: number;
	/** 熔断后回灌给下一个模型的思考前缀上限（字符）。 */
	enforceKeepPrefixChars: number;
	/** 同一会话内第几次命中时升级为换模型。 */
	enforceEscalateAfter: number;
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
	enforce: false,
	enforceMinRepeats: 10,
	enforceMinChars: 20_000,
	enforceMaxPeriod: 200,
	enforceCheckIntervalMs: 750,
	enforceKeepPrefixChars: 4_000,
	enforceEscalateAfter: 2,
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
		enforce: bool(r.enforce, DEFAULT_CONFIG.enforce),
		enforceMinRepeats: num(r.enforceMinRepeats, DEFAULT_CONFIG.enforceMinRepeats),
		enforceMinChars: num(r.enforceMinChars, DEFAULT_CONFIG.enforceMinChars),
		enforceMaxPeriod: num(r.enforceMaxPeriod, DEFAULT_CONFIG.enforceMaxPeriod),
		enforceCheckIntervalMs: num(r.enforceCheckIntervalMs, DEFAULT_CONFIG.enforceCheckIntervalMs),
		enforceKeepPrefixChars: num(r.enforceKeepPrefixChars, DEFAULT_CONFIG.enforceKeepPrefixChars),
		enforceEscalateAfter: num(r.enforceEscalateAfter, DEFAULT_CONFIG.enforceEscalateAfter),
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

/**
 * 子进程归属字段。
 *
 * agent-team 用 `--no-session` 启动 subagent 子进程，子进程的 sessionId 是临时
 * uuid、磁盘上没有对应 session 文件，事后无法判断它属于哪个父会话。只有
 * `PI_USAGE_ROOT_SESSION_ID`（由 agent-team 注入）能把它归属回去，与 usage-stats
 * 的账本口径一致。主进程没有这个变量，字段自然省略（JSON.stringify 丢弃 undefined）。
 */
function ownershipFields(): { rootSessionId?: string; child: boolean } {
	const rootSessionId = process.env.PI_USAGE_ROOT_SESSION_ID?.trim();
	return {
		rootSessionId: rootSessionId || undefined,
		child: process.env.MODEL_FAILBACK_CHILD === "1",
	};
}

/** 串行化写入，避免同进程内并发 append 交错；任何失败都被吞掉，绝不打断 agent。 */
let writeQueue: Promise<void> = Promise.resolve();
const capWarned = new Set<string>();
let writeErrorCount = 0;

function appendJsonl(path: string, record: unknown, maxBytes: number): Promise<void> {
	writeQueue = writeQueue
		.then(async () => {
			// 每次写入前重新 stat 真实大小。主 Pi 与若干 subagent 子进程共写同一个
			// 按日期命名的文件，若靠进程内累加值判断，每个进程都会各自写满一份
			// maxFileBytes，实际上限变成「进程数 × maxFileBytes」。读真实大小才封得住。
			const size = await stat(path).then((s) => s.size).catch(() => 0);
			if (size >= maxBytes) {
				// 静默停止；/breaker status 会显示已达上限的文件。
				capWarned.add(path);
				return;
			}
			const line = `${JSON.stringify(record)}\n`;
			await secureDir();
			await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
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
	/** —— 以下为熔断（enforce）相关状态 —— */
	/** 当前 thinking 块的流式累加器（只保留尾部窗口）。 */
	window: TailWindow;
	/** delta 增量校验器；校验不过则本条消息永不熔断。 */
	guard: DeltaGuard;
	/** 上次检测的时间戳，用于节流。 */
	lastCheckAt: number;
	/** 命中后打上标记，供 message_end 识别“这次 abort 是我们自己干的”。 */
	abortHit: TailPeriod | null;
	/** 命中时的已产出字符数。 */
	abortChars: number;
	/** 命中时的连续命中次数。 */
	abortStrikes: number;
	/** 命中时已产出的工具调用数：非 0 说明模型其实干了活，不动手。 */
	abortToolCalls: number;
}

function newStreamStats(provider: string, model: string, windowChars: number): StreamStats {
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
		window: new TailWindow(windowChars),
		guard: new DeltaGuard(),
		lastCheckAt: 0,
		abortHit: null,
		abortChars: 0,
		abortStrikes: 0,
		abortToolCalls: 0,
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

/**
 * 把 assistant 消息里所有 thinking 块的内容换成剥掉复读后的文本。
 *
 * 只改 `thinking` 字段，**保留** `thinkingSignature`/`redacted` 等结构字段：
 * 签名由 provider 生成，丢弃它可能让后续请求被拒（某些 provider 会校验）。
 * 首块保留截断后的前缀（它是模型对当前任务的真实分析），其余块清空——
 * 复读只会发生在最后一块，保留多块只会重复回灌上下文。
 *
 * 返回 null 表示无需替换（没有 thinking 块）。
 */
function replaceThinkingText(message: AgentMessageLike, text: string): AgentMessageLike | null {
	if (typeof message !== "object" || message === null) return null;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return null;
	let firstThinking = true;
	let touched = false;
	const nextContent = content.map((block) => {
		if (typeof block !== "object" || block === null) return block;
		const b = block as { type?: unknown; thinking?: unknown };
		if (b.type !== "thinking") return block;
		touched = true;
		if (firstThinking) {
			firstThinking = false;
			return { ...block, thinking: text };
		}
		return { ...block, thinking: "" };
	});
	if (!touched) return null;
	// content 已被逐块重建，结构与 AgentMessage 一致；断言仅为绕过 content 的
	// 判别联合收窄（thinking 块的其余字段由 spread 原样保留）。
	return { ...message, content: nextContent } as AgentMessageLike;
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
	/**
	 * 熔断开关。与 probeEnabled 分开：观测与拦截是两件事，用户可能只想看数据。
	 * 未开启时行为与 Phase 1 完全一致（只提示）。
	 */
	let enforceEnabled = DEFAULT_CONFIG.enforce;
	/** 本会话每个模型的连续命中次数；升级换模型的依据。 */
	const strikesByModel = new Map<string, number>();
	/** 本会话熔断统计，供 /breaker 展示。 */
	let breakStats = { count: 0, savedChars: 0, savedMs: 0, escalated: 0 };
	/** 每个 provider/model 是否观测到 thinking_delta，供 /breaker 汇总。 */
	const deltaSeen = new Map<string, { deltas: number; chars: number; redacted: boolean }>();

	// 探针必须完全静默地失败：任何异常都不能影响 agent。
	const safe = async (fn: () => Promise<void> | void): Promise<void> => {
		try {
			await fn();
		} catch {
			// 观测/熔断失败不打断 agent。
		}
	};

	/**
	 * 熔断判定与执行（在流式过程中调用，已由调用方保证在 safe() 里）。
	 *
	 * 保守纪律：
	 *   - 已经产出工具调用或文本的消息一律不动手（模型在干活，不是空转）
	 *   - 已经打过标记就不重复 abort
	 *   - 节流：每 `enforceCheckIntervalMs` 才跑一次周期性检测
	 *     （一次事故有 10 万个 delta，逐个检测是 O(n²)）
	 *   - delta 增量校验不过则彻底放弃本条消息
	 */
	const maybeBreak = (ctx: ExtensionContext): void => {
		if (!enforceEnabled) return;
		const stats = current;
		if (!stats || stats.abortHit) return;
		if (stats.abortToolCalls > 0 || stats.textDeltaChars > 0) return;
		if (stats.window.totalChars < config.enforceMinChars) return;
		const now = Date.now();
		if (now - stats.lastCheckAt < config.enforceCheckIntervalMs) return;
		stats.lastCheckAt = now;

		const decision = shouldBreak(stats.window.tail, stats.window.totalChars, stats.guard.isTrusted, {
			minRepeats: config.enforceMinRepeats,
			minChars: config.enforceMinChars,
			maxPeriod: config.enforceMaxPeriod,
			windowChars: config.enforceMaxPeriod * 10,
		});
		if (!decision) return;

		const key = `${stats.provider}/${stats.model}`;
		const strikes = (strikesByModel.get(key) ?? 0) + 1;
		strikesByModel.set(key, strikes);
		stats.abortHit = decision.hit;
		stats.abortChars = decision.chars;
		stats.abortStrikes = strikes;

		// 先打标记再 abort：message_end 会紧跟在 abort 后面触发，
		// 标记必须在那之前就位，否则会被误认为“用户按了 Esc”。
		ctx.ui.notify(
			`🔁 [thinking-breaker] ${key} 思考尾部连续重复 ${decision.hit.repeats} 次` +
				`（单元 ${decision.hit.period} 字符，已产出 ${decision.chars} 字符），已中止本轮`,
			"warning",
		);
		ctx.abort();
	};

	/**
	 * 续跑指令。
	 *
	 * 不说“你刚才复读了”——那会让模型开始解释自己的行为，又浪费一轮。直接给一个
	 * 动作要求，并保留任务上下文。
	 */
	const continuationText = (modelKey: string, repeats: number) =>
		`[thinking-breaker] 上一个模型(${modelKey})在思考中反复重复同一段内容` +
		`（连续 ${repeats} 次）而被中止，未产出任何结果。` +
		`请基于已有的工具结果直接继续当前任务，不要重复已完成的步骤，也不要解释这次中止。`;

	/**
	 * 熔断后的收尾：续跑或升级换模型。
	 *
	 * 升级条件用“同一会话同一模型的连续命中次数”而不是全局限流：第一次给该模型
	 * 一次改正的机会（截断后的上下文已经比它自己产出的干净得多），第二次就不再
	 * 浪费时间。
	 *
	 * 升级失败（model-failback 未安装 / 链上没有 fallback）时降级为同模型续跑——
	 * 截断已经拿回了大部分收益，不能因为升级失败而把任务丢掉。
	 */
	const finishBreak = async (
		ctx: ExtensionContext,
		stats: StreamStats,
		strippedChars: number,
	): Promise<void> => {
		const key = `${stats.provider}/${stats.model}`;
		const repeats = stats.abortHit?.repeats ?? 0;
		const shouldEscalate = config.enforceEscalateAfter > 0 && stats.abortStrikes >= config.enforceEscalateAfter;

		if (shouldEscalate) {
			const escalated = await requestEscalation(ctx, key, stats, strippedChars);
			if (escalated) {
				breakStats.escalated += 1;
				return;
			}
		}

		try {
			pi.sendUserMessage(continuationText(key, repeats), { deliverAs: "steer" });
		} catch {
			ctx.ui.notify("[thinking-breaker] 自动续跑失败，请手动继续", "error");
		}
	};

	/**
	 * 向 model-failback 发出升级请求，并等待它同步回复。
	 *
	 * 事件总线是同步 emit，但接手方需要 await 持久化 ban + setModel，因此用
	 * 一个 promise + 超时把异步回复桥回来。超时后放弃升级，降级为同模型续跑：
	 * 绝不能让一个卡住的订阅者把 agent 挂死。
	 */
	const requestEscalation = async (
		ctx: ExtensionContext,
		key: string,
		stats: StreamStats,
		strippedChars: number,
	): Promise<boolean> => {
		if (!pi.events) return false;
		const hit = stats.abortHit;
		if (!hit) return false;
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				ctx.ui.notify("[thinking-breaker] 升级请求超时，改在同模型继续", "warning");
				resolve(false);
			}, 10_000);
			const request: EscalateRequest = {
				version: 1,
				sessionId,
				key,
				reason: "thinking_loop",
				note:
					`思考尾部连续重复 ${hit.repeats} 次（单元 ${hit.period} 字符，` +
					`已产出 ${stats.abortChars} 字符，剥掉 ${strippedChars} 字符）`,
				evidence: {
					period: hit.period,
					repeats: hit.repeats,
					chars: stats.abortChars,
					strikes: stats.abortStrikes,
				},
				accept: (reply: EscalateReply) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (!reply.ok) {
						ctx.ui.notify(
							`[thinking-breaker] 升级换模型未完成（${reply.message ?? "未知原因"}），改在同模型继续`,
							"warning",
						);
					}
					resolve(reply.ok);
				},
			};
			try {
				pi.events!.emit(ESCALATE_EVENT, request);
			} catch {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(false);
			}
		});
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
			enforceEnabled = config.enabled && config.enforce;
			if (!probeEnabled) return;

			sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
			await secureDir();
			// 子进程不扫描，避免与主 Pi 竞争。
			if (process.env.MODEL_FAILBACK_CHILD !== "1") {
				await collectGarbage(config.retentionDays);
			}
			ctx.ui.notify(
				`[thinking-breaker] 探针已启用（${enforceEnabled ? "观测 + 熔断" : "仅观测"}）。日志: ${probeDir()}`,
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
			current = newStreamStats(provider, model, config.enforceMaxPeriod * 10);
			current.turnIndex = currentTurn;
		});
	});

	pi.on("message_update", async (event, ctx) => {
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

				// 熔断路径：累加尾部窗口 + 在线校验 delta 为增量，再节流检测。
				// 顺序很重要 —— 先累加再检测，否则检测的是上一轮的尾部。
				current.window.append(delta);
				current.guard.observe(delta.length, partialLen);
				maybeBreak(ctx);

				// 流式明细：只写前 N 条，够判定增量/累计即可，避免文件膨胀。
				if (config.captureStreamDetail && current.streamDetailWritten < 40) {
					current.streamDetailWritten += 1;
					await appendJsonl(
						ledgerPath(new Date(), "stream"),
						{
							v: 1,
							ts: new Date().toISOString(),
							sessionId,
							...ownershipFields(),
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
				// 已经产出工具调用的消息说明模型在干活，复读检测不得动手。
				current.abortToolCalls = current.toolcallStart;
				return;
			}
			if (type === "toolcall_end") {
				current.toolcallEnd += 1;
			}
		});
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		// message_end 是唯一能改消息的时机，也是熔断收尾的地方。返回值必须
		// 在 safe() 之外拿到，因此这里不用 safe 包裹整个函数，而是手动 try/catch。
		let replacement: { message: AgentMessageLike } | undefined;
		await safe(async () => {
			if (!probeEnabled || !current) return;
			const message = event.message as unknown as AgentMessageLike;
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

			// —— 熔断收尾 ——
			// 我们自己在流式过程中 abort 的消息（stats.abortHit 非空）需要：
			//   1. 把复读段从思考块里剥掉：中止后的思考块会完整留在上下文里，
			//      事故记录是 35 万字符 ≈ 8.8 万 token，白烧下一轮；
			//   2. 自动续跑（或升级换模型）。
			// 用户按 Esc 中止（abortHit 为空）则什么都不做，保持原行为。
			const enforced = enforceEnabled && stats.abortHit !== null && stopReason === "aborted";
			let strippedChars = 0;
			if (enforced) {
				const stripped = stripAllLoopTail(thinking.text);
				strippedChars = stripped.dropped;
				const capped = capKeptPrefix(stripped.kept, config.enforceKeepPrefixChars);
				const replaced = replaceThinkingText(message, capped.text);
				if (replaced) {
					replacement = { message: replaced };
				} else {
					// 没有 thinking 块就无从替换；中止已经生效，但复读会留在上下文里。
					// 罕见（provider 形状变了），显式告知而不是默默继续。
					ctx.ui.notify(
						"[thinking-breaker] 已中止复读，但消息里找不到可替换的思考块，复读仍留在上下文中",
						"warning",
					);
				}
				breakStats.count += 1;
				breakStats.savedChars += strippedChars;
				breakStats.savedMs += Date.now() - stats.startedAt;
			}

			const record = {
				v: 1,
				ts: new Date().toISOString(),
				sessionId,
				...ownershipFields(),
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
					/** 在线增量校验的最大偏差；非 0 说明 provider 的计数与拼接不完全一致。 */
					guardSkew: stats.guard.skew,
					guardTrusted: stats.guard.isTrusted,
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
				/** 熔断台账：仅在真的动手时有值。 */
				break: enforced
					? {
							hitPeriod: stats.abortHit?.period,
							hitRepeats: stats.abortHit?.repeats,
							charsAtHit: stats.abortChars,
							strikes: stats.abortStrikes,
							strippedChars,
							savedMs: Date.now() - stats.startedAt,
						}
					: undefined,
			};

			await appendJsonl(ledgerPath(new Date()), record, config.maxFileBytes);

			if (config.captureThinkingText && thinking.text.length > 0) {
				await appendJsonl(
					ledgerPath(new Date(), "thinking"),
					{
						v: 1,
						ts: new Date().toISOString(),
						sessionId,
						...ownershipFields(),
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

			if (enforced) {
				await finishBreak(ctx, stats, strippedChars);
				return;
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
		return replacement;
	});

	pi.registerCommand("breaker", {
		description: "thinking-breaker：状态 / on / off / enforce on|off / purge / open",
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
				if (!probeEnabled) enforceEnabled = false;
				ctx.ui.notify(
					`[thinking-breaker] 本次会话观测已${probeEnabled ? "开启" : "关闭"}（配置文件 ${CONFIG_NAME} 控制持久默认值）`,
					"info",
				);
				return;
			}

			// 熔断开关：只对本次会话生效，持久默认值由配置文件控制。
			if (sub === "enforce") {
				const next = tokens[1];
				if (next !== "on" && next !== "off") {
					ctx.ui.notify(
						`[thinking-breaker] 用法: /breaker enforce on|off\n` +
							`当前: ${enforceEnabled ? "开" : "关"}（配置文件 ${CONFIG_NAME} 的 "enforce" 控制持久默认值）`,
						"info",
					);
					return;
				}
				enforceEnabled = next === "on" && probeEnabled;
				ctx.ui.notify(
					`[thinking-breaker] 熔断已${enforceEnabled ? "开启" : "关闭"}。` +
						`阈值: 连续 ${config.enforceMinRepeats} 次 / ${config.enforceMinChars} 字符起判`,
					"info",
				);
				return;
			}

			// status
			const lines: string[] = [];
			lines.push(`thinking-breaker（观测${enforceEnabled ? " + 熔断" : "，不干预"}）`);
			lines.push(`状态: ${probeEnabled ? "开启" : "关闭"}`);
			lines.push(`目录: ${probeDir()}`);
			lines.push(`保留: ${config.retentionDays} 天 · 单文件上限: ${Math.round(config.maxFileBytes / 1024 / 1024)}MB`);
			lines.push(`原文留存: ${config.captureThinkingText ? "开" : "关"}`);
			lines.push(`流式明细: ${config.captureStreamDetail ? "开" : "关"}`);
			lines.push(
				`dry-run: ${config.dryRunAlert ? `开（阈值 ${config.alertMinRepeats} 次连续重复，只提示不拦截）` : "关"}` +
					(alertCount > 0 ? ` · 本次会话已提示 ${alertCount} 次` : ""),
			);
			lines.push(
				`熔断: ${enforceEnabled ? "开" : "关（/breaker enforce on 开启）"}` +
					`（阈值 ${config.enforceMinRepeats} 次 / ${config.enforceMinChars} 字符，` +
					`第 ${config.enforceEscalateAfter} 次命中换模型）`,
			);
			if (breakStats.count > 0) {
				lines.push(
					`本次会话已熔断 ${breakStats.count} 次 · 剥掉复读 ${breakStats.savedChars} 字符 · ` +
						`节省 ${Math.round(breakStats.savedMs / 1000)} 秒` +
						(breakStats.escalated > 0 ? ` · 升级换模型 ${breakStats.escalated} 次` : ""),
				);
			}
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
