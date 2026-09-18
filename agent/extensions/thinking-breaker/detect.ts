/**
 * thinking-breaker — 复读检测的纯函数层。
 *
 * 这一层刻意不依赖 pi 的任何 API：它是熔断决策的唯一依据，必须能被离线回放
 * 测试直接调用（tests/replay.ts 用真实思考原文跑零误报回归）。
 *
 * 判定纪律：
 *   - 只看**尾部**：周期复读（探针 A）或词表塌缩（探针 B）。模板化枚举
 *     （"第 1 项…第 2 项…"）会污染全篇词频统计，但既无尾部周期，也不同行数
 *     塌缩（实测 200 行枚举 distinct=54 > 12），两个探针都不误报。
 *   - 窗口内容只取自 provider 给出的 `partial`（权威全文），**不拼接 `delta`**。
 *     拼接 delta 在累计模式下凭空造出复读，因此这个歧义从根上消除。
 *
 * 2026-09-18 事故复盘（本层参数由此重定）：
 *   - 报障样本的复读单元长度是 **405 字符**（9 个短句变体轮换），而旧的
 *     `maxPeriod = 200` 让 `detectTailPeriod` 对这类复读恒返回 null —— 这就是
 *     熔断失效的根因。`maxPeriod` 放宽到 600 后同一样本在 9000 字符处即可命中。
 *   - 另有一类复读**没有精确周期**（行序随机），周期探针结构性失明；但尾部
 *     窗口的"不同行数"会塌缩（distinct ≤ 12），由 `detectLineCollapse` 覆盖。
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
	/**
	 * 单元长度下限。`period < minPeriod` 的候选一律视为未命中：
	 * p=1..7 的"周期"极易由格式噪声（标点、缩进）偶然满足，单元长度 ≥ 8
	 * 才像"一句话在重复"。逐字复读（`OK. OK. OK.` p=4）不归探针 A 负责，
	 * 它由剥离阶段的行级/逐字判据处理，且此类文本行级塌缩极强（探针 B 会命中）。
	 */
	minPeriod: number;
	/** 少于这个次数不算复读。 */
	minRepeats: number;
}

export const DEFAULT_TAIL_OPTIONS: TailDetectOptions = {
	windowChars: 2000,
	maxPeriod: 200,
	minPeriod: 8,
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
	const { windowChars, maxPeriod, minPeriod, minRepeats } = {
		...DEFAULT_TAIL_OPTIONS,
		...options,
	};
	if (text.length < 60) return null;
	const tail = text.length > windowChars ? text.slice(-windowChars) : text;
	const limit = Math.min(maxPeriod, Math.floor(tail.length / 2));
	let best: TailPeriod | null = null;
	// 从 minPeriod 起步（而不是事后过滤最佳候选）：短周期被跳过，更大的周期
	// 仍然能在同一轮里胜出。否则 p=1..7 的噪声会先把名额占掉。
	for (let period = Math.max(1, minPeriod); period <= limit; period++) {
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

/** 尾部窗口词表塌缩的检测结果。 */
export interface CollapseHit {
	/** 窗口内的非空行数 */
	lines: number;
	/** 不同行的种类数 */
	distinct: number;
	/** 出现 ≥2 次的行在非空行中的占比 */
	repeatRatio: number;
}

export interface CollapseOptions {
	/** 只看末尾这么多字符 */
	windowChars: number;
	/** 非空行数下限（太少不足以判断塌缩） */
	minLines: number;
	/** 不同行数上限 */
	maxDistinct: number;
	/** 重复行（出现 >=2 次）占非空行的最低比例 */
	minRepeatRatio: number;
}

export const DEFAULT_COLLAPSE_OPTIONS: CollapseOptions = {
	windowChars: 1500,
	minLines: 40,
	maxDistinct: 12,
	minRepeatRatio: 0.75,
};

/**
 * 尾部窗口的**词表塌缩**检测 —— 覆盖没有精确周期的复读。
 *
 * 事故里有一类复读：同一批短句反复出现，但**顺序不规则**，因此不存在任何精确
 * 周期，`detectTailPeriod` 对它必然失明。可判据不是周期，而是"不同行的种类数"：
 * 末尾窗口里非空行有 40+ 行，不同值却只有个位数到十几个。
 *
 * 三道门缺一不可：
 *   - 非空行数 ≥ `minLines`（行太少，distinct 天然就小，判断不了）
 *   - 不同行数 ≤ `maxDistinct`
 *   - 重复行占比 ≥ `minRepeatRatio`（防止"只是碰巧行种类少"）
 *
 * 空白行先 `trim` 再剔除：整段换行是格式噪声，不是复读证据。
 * 复杂度 O(windowChars)，但调用方仍需节流（沿用 `enforceCheckIntervalMs`）。
 */
export function detectLineCollapse(
	text: string,
	options: Partial<CollapseOptions> = {},
): CollapseHit | null {
	const { windowChars, minLines, maxDistinct, minRepeatRatio } = {
		...DEFAULT_COLLAPSE_OPTIONS,
		...options,
	};
	const tail = text.length > windowChars ? text.slice(-windowChars) : text;
	const counts = new Map<string, number>();
	let lines = 0;
	for (const raw of tail.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		lines += 1;
		counts.set(line, (counts.get(line) ?? 0) + 1);
	}
	if (lines < minLines) return null;
	let repeated = 0;
	for (const count of counts.values()) if (count >= 2) repeated += count;
	const repeatRatio = repeated / lines;
	if (counts.size > maxDistinct || repeatRatio < minRepeatRatio) return null;
	return { lines, distinct: counts.size, repeatRatio };
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
	options: {
		minRepeats: number;
		minChars: number;
		maxPeriod: number;
		windowChars: number;
		minPeriod?: number;
	},
): BreakDecision | null {
	if (producedChars < options.minChars) return null;
	const hit = detectTailPeriod(tailText, {
		windowChars: options.windowChars,
		maxPeriod: options.maxPeriod,
		minRepeats: options.minRepeats,
		minPeriod: options.minPeriod ?? DEFAULT_TAIL_OPTIONS.minPeriod,
	});
	if (!hit) return null;
	return { hit, chars: producedChars };
}

export interface CollapseBreakDecision {
	hit: CollapseHit;
	/** 触发时已经产出的思考字符数 */
	chars: number;
}

/**
 * 熔断判定（探针 B）：把"词表塌缩"翻译成"要不要动手"。
 *
 * 与 `shouldBreak` 对称：只在思考长度达到 `minChars` 后才认为证据充分。
 * 两个探针由调用方并联（命中任一即熔断）。
 */
export function shouldBreakCollapse(
	tailText: string,
	producedChars: number,
	options: {
		minChars: number;
		windowChars: number;
		minLines: number;
		maxDistinct: number;
		minRepeatRatio: number;
	},
): CollapseBreakDecision | null {
	if (producedChars < options.minChars) return null;
	const hit = detectLineCollapse(tailText, {
		windowChars: options.windowChars,
		minLines: options.minLines,
		maxDistinct: options.maxDistinct,
		minRepeatRatio: options.minRepeatRatio,
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
 * 也**不用**旧的"连续 `maxGap` 行全新内容即停手"游走：真实复读的行种类有
 * 9–16 种，反向游走时每遇到一行尚未见过的变体就累计 gap，第 `maxGap + 1` 种
 * 变体就把自己截断。报障样本实测 maxGap=4 → dropped=0（完全剥不掉），
 * maxGap=8 → 直接剥掉 20 万字符（把 4200 字符的真实前缀也剥光）——没有可用档位。
 *
 * 新判据与探针 B 同源：从末尾反向累积非空行，**不同行数一旦超过 `maxDistinct`
 * 就停**；该区间即复读区，从它的起始行剥到末尾。因此"命中即能剥"。
 *
 * 三道门保证不吃掉正常内容（5965 条真实有产出样本实测仅 2 条受影响，且都只切掉
 * 末尾 798–1218 字符的复读噪声）：
 *   - 非空行数 ≥ `minLines`
 *   - 重复行占比 ≥ `minRepeatRatio`
 *   - 剥掉字符数 ≥ `minChars`
 */
export interface StripOptions {
	/** 复读区内允许出现多少种不同的行。 */
	maxDistinct: number;
	/** 至少累积多少非空行才动手。 */
	minLines: number;
	/** 重复行占非空行的最低比例。 */
	minRepeatRatio: number;
	/** 至少剥掉多少字符才动手；太短不值得改消息。 */
	minChars: number;
}

export const DEFAULT_STRIP_OPTIONS: StripOptions = {
	maxDistinct: 12,
	minLines: 20,
	minRepeatRatio: 0.75,
	minChars: 200,
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
	let nonEmpty = 0;
	let repeatHits = 0;
	// 从末尾往前累积非空行；`cut` 指向"已确认属于复读区"的最左行。
	let cut = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].text;
		if (line === "") continue;
		const previous = seen.get(line) ?? 0;
		// 再加一行新的不同值就会超出预算 → 复读区到此为止。
		if (previous === 0 && seen.size >= o.maxDistinct) break;
		seen.set(line, previous + 1);
		if (previous >= 1) repeatHits += 1;
		nonEmpty += 1;
		cut = i;
	}

	const cutStart = cut < lines.length ? lines[cut].start : text.length;
	const dropped = text.length - cutStart;
	const ratio = nonEmpty > 0 ? repeatHits / nonEmpty : 0;
	if (nonEmpty < o.minLines || ratio < o.minRepeatRatio || dropped < o.minChars) {
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
