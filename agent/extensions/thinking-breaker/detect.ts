/**
 * thinking-breaker — 复读检测的纯函数层。
 *
 * 这一层刻意不依赖 pi 的任何 API：它是熔断决策的唯一依据，必须能被离线回放
 * 测试直接调用（tests/replay.ts 用真实思考原文跑零误报回归）。
 *
 * 判定纪律（由 Phase 1 的 2601 条真实思考原文实测确定）：
 *   - 只看**尾部周期性复读**，不看全篇词频。模板化枚举（"第 1 项…第 2 项…"）
 *     会污染词频统计，但不会形成尾部周期。
 *   - 窗口内容只取自 provider 给出的 `partial`（权威全文），**不拼接 `delta`**。
 *     拼接 delta 在累计模式下会凭空造出复读，因此这个歧义从根上消除。
 */

/** 尾部周期复读的检测结果。 */
export interface TailPeriod {
	/** 重复单元的字符长度 */
	period: number;
	/** 该单元在尾部连续出现的次数（仅统计窗口内） */
	repeats: number;
	/** 被复读覆盖的字符数（窗口内） */
	tailChars: number;
}

export interface TailDetectOptions {
	/** 只看末尾这么多字符；过大会让周期性检测变慢，过小会漏掉长单元。 */
	windowChars: number;
	/** 单元长度上限。超过这个长度的"重复"更像是正常的重复表述。 */
	maxPeriod: number;
	/** 少于这个次数不算复读。 */
	minRepeats: number;
}

export const DEFAULT_TAIL_OPTIONS: TailDetectOptions = {
	windowChars: 2000,
	maxPeriod: 200,
	minRepeats: 4,
};

/**
 * 尾部周期性检测 —— 直接度量 "OK. Let me write. Go." 这类复读。
 *
 * 对末尾窗口尝试周期 p，返回覆盖字符数最多的那个周期。
 * 复杂度 O(maxPeriod × windowChars)（约 40 万次字符比较），因此调用方必须节流，
 * 绝不能每个 delta 都跑：一次事故里有 10 万个 delta。
 */
export function detectTailPeriod(
	text: string,
	options: Partial<TailDetectOptions> = {},
): TailPeriod | null {
	const { windowChars, maxPeriod, minRepeats } = { ...DEFAULT_TAIL_OPTIONS, ...options };
	if (text.length < 60) return null;
	const tail = text.length > windowChars ? text.slice(-windowChars) : text;
	const limit = Math.min(maxPeriod, Math.floor(tail.length / 2));
	let best: TailPeriod | null = null;
	for (let period = 1; period <= limit; period++) {
		const unit = tail.slice(tail.length - period);
		// 纯空白单元（如整段换行）不是复读，是格式。
		if (!unit.trim()) continue;
		let repeats = 1;
		let cursor = tail.length - period;
		while (cursor - period >= 0) {
			if (tail.slice(cursor - period, cursor) !== unit) break;
			repeats += 1;
			cursor -= period;
		}
		if (repeats < minRepeats) continue;
		const covered = repeats * period;
		if (!best || covered > best.repeats * best.period) {
			best = { period, repeats, tailChars: covered };
		}
	}
	return best;
}

/**
 * 尾部窗口 —— 内容直接取自 provider 的 `partial`，而不是拼接 `delta`。
 *
 * 为什么不再拼接 delta：`delta` 是增量还是累计取决于 provider，一旦判错
 * （把累计值拼起来）就会凭空造出复读，是最危险的误判来源。历史上用
 * `DeltaGuard` 在线猜这件事，代价是 259 条真实消息被误判为"不可信"而彻底
 * 丧失熔断资格 —— 事后核对，这 259 条的 delta 累加值 100% 精确等于最终思考
 * 原文长度，即它们全都是增量。猜错的代价远高于收益。
 *
 * `partial.content[].thinking` 就是 provider 给出的权威全文，直接取其尾部即可，
 * 增量/累计的歧义从根上消失。每次更新只做一次 `slice(-windowChars)`，
 * 复杂度 O(windowChars)，与已产出长度无关。
 */
export class TailWindow {
	private buffer = "";
	private seen = 0;
	private readonly windowChars: number;

	constructor(windowChars: number) {
		this.windowChars = windowChars;
	}

	/** 用 provider 给出的完整思考原文刷新窗口与总长度。 */
	update(fullText: string): void {
		this.seen = fullText.length;
		this.buffer =
			fullText.length > this.windowChars ? fullText.slice(-this.windowChars) : fullText;
	}

	/** 已经产出的总字符数（权威值，来自 partial 而非累加）。 */
	get totalChars(): number {
		return this.seen;
	}

	/** 当前窗口内容。 */
	get tail(): string {
		return this.buffer;
	}

	reset(): void {
		this.buffer = "";
		this.seen = 0;
	}
}

export interface BreakDecision {
	hit: TailPeriod;
	/** 触发时已经产出的思考字符数 */
	chars: number;
}

/**
 * 熔断判定：把"检测结果"翻译成"要不要动手"。
 *
 * 两道门都必须过：
 *   1. 思考长度达到 minChars（避免对短思考动手）
 *   2. 尾部周期重复次数达到 minRepeats
 */
export function shouldBreak(
	tailText: string,
	producedChars: number,
	options: { minRepeats: number; minChars: number; maxPeriod: number; windowChars: number },
): BreakDecision | null {
	if (producedChars < options.minChars) return null;
	const hit = detectTailPeriod(tailText, {
		windowChars: options.windowChars,
		maxPeriod: options.maxPeriod,
		minRepeats: options.minRepeats,
	});
	if (!hit) return null;
	return { hit, chars: producedChars };
}

/**
 * 剥掉与末尾**逐字相同**的复读块。
 *
 * 这是行级剥离的补充：当复读全部发生在一行内（如 `OK. OK. OK. …`），行级判据
 * 只能看到 1 种不同的行，无法与"正常长句"区分。这时按字符周期剥离是精确的——
 * 末尾单元逐字重复是无可辩驳的复读。
 */
export function truncateLoopTail(
	text: string,
	hit: TailPeriod,
): { kept: string; dropped: number } {
	const period = hit.period;
	if (period <= 0 || text.length < period) return { kept: text, dropped: 0 };
	const unit = text.slice(text.length - period);
	let cursor = text.length;
	while (cursor - period >= 0 && text.slice(cursor - period, cursor) === unit) {
		cursor -= period;
	}
	return { kept: text.slice(0, cursor), dropped: text.length - cursor };
}

/**
 * 剥掉尾部的复读段，返回保留的前缀与丢弃的字符数。
 *
 * 为什么不用"按周期整块比对"：真实复读是**变体轮换**——
 *   `OK. Let me write. Go. Now.` / `OK. Let me write. Go. Producing.`
 * 两种变体周期相同但逐字不同，按整块比对只能剥掉其中一层，剩下的一层会残留成
 * 新的"复读"（实测剥完仍能命中，等于没剥）。
 *
 * 改为**按行反向游走**：复读的行必然重复出现，因此从末尾往前，只要还在
 * "重复行密集区"就继续；遇到连续 `maxGap` 行全新内容就停手。这个判据对变体
 * 免疫（变体之间共享大量行），也对正常推理免疫（正常推理的行几乎不重复）。
 *
 * 三道门保证不吃掉正常内容（在 2673 条真实思考原文上实测零误伤）：
 *   - 重复行数 ≥ `minRepeatHits`
 *   - 不同行的种类 ≥ `minDistinctLines`（防止"反复重复同一句"被当成整段复读）
 *   - 重复行占比 ≥ `minRepeatRatio`（防止长尾正常内容里的零星重复触发）
 */
export interface StripOptions {
	/** 允许连续多少行全新内容后停手。 */
	maxGap: number;
	/** 至少多少行是重复行才动手。 */
	minRepeatHits: number;
	/** 至少出现多少种不同的行才动手。 */
	minDistinctLines: number;
	/** 至少剥掉多少字符才动手；太短不值得改消息。 */
	minChars: number;
	/** 重复行占非空行的最低比例。 */
	minRepeatRatio: number;
}

export const DEFAULT_STRIP_OPTIONS: StripOptions = {
	maxGap: 4,
	minRepeatHits: 8,
	minDistinctLines: 4,
	minChars: 400,
	minRepeatRatio: 0.6,
};

export function stripLoopTail(
	text: string,
	options: Partial<StripOptions> = {},
): { kept: string; dropped: number } {
	const o = { ...DEFAULT_STRIP_OPTIONS, ...options };
	const lines: Array<{ text: string; start: number }> = [];
	let pos = 0;
	for (const raw of text.split("\n")) {
		lines.push({ text: raw.trim(), start: pos });
		pos += raw.length + 1;
	}

	const seen = new Map<string, number>();
	let repeatHits = 0;
	let nonEmpty = 0;
	let gap = 0;
	// 从末尾往前扫描；`cut` 始终指向"已确认属于复读区"的最左行。
	let cut = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].text;
		if (line === "") {
			cut = i;
			continue;
		}
		nonEmpty += 1;
		const previous = seen.get(line) ?? 0;
		if (previous >= 1) {
			repeatHits += 1;
			gap = 0;
		} else {
			gap += 1;
			if (gap > o.maxGap) break;
		}
		seen.set(line, previous + 1);
		cut = i;
	}

	const cutStart = cut < lines.length ? lines[cut].start : text.length;
	const dropped = text.length - cutStart;
	const ratio = nonEmpty > 0 ? repeatHits / nonEmpty : 0;
	if (
		repeatHits < o.minRepeatHits ||
		seen.size < o.minDistinctLines ||
		dropped < o.minChars ||
		ratio < o.minRepeatRatio
	) {
		return { kept: text, dropped: 0 };
	}
	return { kept: text.slice(0, cutStart), dropped };
}

/**
 * 综合剥离：行级剥离处理变体轮换，逐字剥离处理单行内复读，交替直到无进展。
 *
 * 两者是互补的：
 *   - 事故样本（`OK.` / `Let me write.` 交替成行）行级剥离能干净切断；
 *   - 单行复读（`OK. OK. OK. …`）行级剥离看不到重复行，但逐字剥离很精确。
 * 交替执行是因为剥掉一层后可能露出另一层（变体轮换的嵌套）。
 */
export function stripAllLoopTail(
	text: string,
	options: Partial<StripOptions> = {},
): { kept: string; dropped: number } {
	let current = text;
	let dropped = 0;
	for (let round = 0; round < 8; round++) {
		let progressed = false;

		const byLine = stripLoopTail(current, options);
		if (byLine.dropped > 0) {
			current = byLine.kept;
			dropped += byLine.dropped;
			progressed = true;
		}

		const hit = detectTailPeriod(current, { minRepeats: 4 });
		if (hit) {
			const byUnit = truncateLoopTail(current, hit);
			if (byUnit.dropped > 0) {
				current = byUnit.kept;
				dropped += byUnit.dropped;
				progressed = true;
			}
		}

		if (!progressed) break;
	}
	return { kept: current, dropped };
}

/**
 * 限制保留下来的前缀长度。
 *
 * 复读前的推理可能很长（事故里 4 万字符 ≈ 1.1 万 token）。全部回灌给下一个
 * 模型会白烧上下文，因此只保留最靠近复读点的一段 —— 那是对"接下来要做什么"
 * 最有信息量的部分。
 */
export function capKeptPrefix(
	kept: string,
	maxChars: number,
): { text: string; truncatedChars: number } {
	const trimmed = kept.replace(/\s+$/, "");
	if (trimmed.length <= maxChars) return { text: trimmed, truncatedChars: 0 };
	const dropped = trimmed.length - maxChars;
	return {
		text: `[…省略前 ${dropped} 字符重复推理…]\n${trimmed.slice(-maxChars)}`,
		truncatedChars: dropped,
	};
}
