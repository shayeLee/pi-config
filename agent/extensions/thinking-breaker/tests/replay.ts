/**
 * thinking-breaker 回放测试。
 *
 * 用本机真实的思考原文日志（~/.pi/agent/thinking-breaker/*.thinking.jsonl）跑：
 *   1. 零误报回归 —— 6000+ 条真实思考在熔断阈值下不得命中（探针 A + 探针 B）；
 *   2. 真实事故提前拦截 —— 2026-09-17 的 35 万字符复读必须在前 5 万字符内命中，
 *      2026-09-18 报障样本必须在前 2 万字符内命中；
 *   3. 剥复读正确性 —— 剥掉后不再命中，且保留的前缀里没有复读；
 *   4. 单元用例 —— 逐字复读 / 模板化枚举 / 词表塌缩 / 窗口尺寸。
 *
 * 「有产出」样本的判定需要摘要账本（`*.jsonl`）：只有 `toolcallStart > 0 ||
 * textDeltaChars > 0` 才是对照组。thinking 日志与账本的 `ts` 可能相差 ~2.8 秒，
 * 因此先按 `${ts[0:19]}|provider|model}` 精确 join，再退回「同一 provider/model
 * 内最近的 ts（±5 秒）」。
 *
 * 用法: volta run node tests/replay.ts [--dir <日志目录>]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	TailWindow,
	capKeptPrefix,
	detectLineCollapse,
	detectTailPeriod,
	shouldBreak,
	shouldBreakCollapse,
	stripAllLoopTail,
} from "../detect.ts";

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const LOG_DIR =
	dirIndex >= 0 && args[dirIndex + 1]
		? args[dirIndex + 1]
		: join(homedir(), ".pi", "agent", "thinking-breaker");

interface ThinkingRow {
	provider?: string;
	model?: string;
	ts?: string;
	chars?: number;
	thinking?: string;
}

interface LedgerRow {
	ts?: string;
	provider?: string;
	model?: string;
	stream?: { toolcallStart?: number; textDeltaChars?: number };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
	} else {
		failures += 1;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/**
 * 熔断判定参数（与 index.ts 的 DEFAULT_CONFIG 对齐）。
 * 探针 A：周期 8..600，尾部窗口 6000，连续 ≥10 次。
 * 探针 B：尾部窗口 1500，非空行 ≥40，不同行 ≤12，重复行占比 ≥0.75。
 */
const ENFORCE = {
	minRepeats: 10,
	minChars: 20_000,
	maxPeriod: 600,
	windowChars: 6000,
	minPeriod: 8,
};
const TAIL_OPTS = {
	windowChars: ENFORCE.windowChars,
	maxPeriod: ENFORCE.maxPeriod,
	minPeriod: ENFORCE.minPeriod,
	minRepeats: ENFORCE.minRepeats,
};
const COLLAPSE = {
	windowChars: 1500,
	minLines: 40,
	maxDistinct: 12,
	minRepeatRatio: 0.75,
};
const COLLAPSE_ENFORCE = { minChars: ENFORCE.minChars, ...COLLAPSE };

/**
 * 与 index.ts 的 `tailWindowChars` 同式：共享缓冲区取两个探针需求的较大值。
 * 只按探针 A 定尺寸（`maxPeriod * 10`）时，用户把 `enforceMaxPeriod` 调小就会
 * 饿死探针 B；这里锁住「取较大值」这一行为。
 */
const tailWindowChars = (maxPeriod: number, collapseWindow: number) =>
	Math.max(maxPeriod * 10, collapseWindow);

// ---------------------------------------------------------------- 载入真实数据
const thinkingRows: ThinkingRow[] = [];
const ledgerRows: LedgerRow[] = [];
if (existsSync(LOG_DIR)) {
	for (const file of readdirSync(LOG_DIR)) {
		if (file.endsWith(".thinking.jsonl")) {
			for (const line of readFileSync(join(LOG_DIR, file), "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					thinkingRows.push(JSON.parse(line) as ThinkingRow);
				} catch {
					// 坏行跳过：日志是 append 的，可能被截断。
				}
			}
		} else if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) {
			for (const line of readFileSync(join(LOG_DIR, file), "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					ledgerRows.push(JSON.parse(line) as LedgerRow);
				} catch {
					// 坏行跳过。
				}
			}
		}
	}
}

/** 日志里超长原文被截断过（"…[截断 N 字符]"），回放时只看保留部分。 */
function fullText(row: ThinkingRow): string {
	const text = row.thinking ?? "";
	const cut = text.indexOf("…[截断");
	return cut >= 0 ? text.slice(0, cut) : text;
}

// ---------------------------------------------------------------- 账本 join

/** 按 `${ts[0:19]}|provider|model}` 建精确索引，并保留同键全部候选（便于就近回退）。 */
const ledgerByModel = new Map<string, Array<{ t: number; row: LedgerRow }>>();
const ledgerExact = new Map<string, LedgerRow>();
for (const row of ledgerRows) {
	if (!row.ts || !Number.isFinite(Date.parse(row.ts))) continue;
	const key = `${row.ts.slice(0, 19)}|${row.provider ?? "?"}|${row.model ?? "?"}`;
	if (!ledgerExact.has(key)) ledgerExact.set(key, row);
	const group = `${row.provider ?? "?"}|${row.model ?? "?"}`;
	const list = ledgerByModel.get(group) ?? [];
	list.push({ t: Date.parse(row.ts), row });
	ledgerByModel.set(group, list);
}

/**
 * 把 thinking 行 join 到账本行：先精确 key，再退回「同 provider/model 内最近
 * 且相差 ≤5 秒」。找不到匹配就返回 undefined（无法分类 → 跳过，不算误报）。
 */
function findLedger(row: ThinkingRow): LedgerRow | undefined {
	if (!row.ts) return undefined;
	const provider = row.provider ?? "?";
	const model = row.model ?? "?";
	const exact = ledgerExact.get(`${row.ts.slice(0, 19)}|${provider}|${model}`);
	if (exact) return exact;
	const list = ledgerByModel.get(`${provider}|${model}`);
	if (!list) return undefined;
	const t = Date.parse(row.ts);
	if (!Number.isFinite(t)) return undefined;
	let best: { t: number; row: LedgerRow } | undefined;
	let bestDelta = Infinity;
	for (const entry of list) {
		const delta = Math.abs(entry.t - t);
		if (delta < bestDelta) {
			bestDelta = delta;
			best = entry;
		}
	}
	return best && bestDelta <= 5000 ? best.row : undefined;
}

/** 「有产出」= 真的吐出过工具调用或正文；只有这类样本才是零误报对照组的成员。 */
function isProductive(row: LedgerRow): boolean | undefined {
	const stream = row.stream;
	if (!stream) return undefined;
	if (typeof stream.toolcallStart !== "number" && typeof stream.textDeltaChars !== "number") {
		return undefined;
	}
	return (stream.toolcallStart ?? 0) > 0 || (stream.textDeltaChars ?? 0) > 0;
}

console.log(`thinking-breaker 回放测试`);
console.log(`日志目录: ${LOG_DIR}`);
console.log(`样本: ${thinkingRows.length} 条思考原文 · 账本: ${ledgerRows.length} 行\n`);

if (thinkingRows.length === 0) {
	console.log("⚠ 没有可回放的样本（日志已被 purge 或目录不存在）。");
	console.log("  跳过误报回归；真实事故用例需要 2026-09-17 的日志。");
} else {
	// -------------------------------------------------- 1) 零误报回归
	console.log("[1] 零误报回归：真实思考在熔断阈值下不得命中");
	const falsePositives: string[] = [];
	for (const row of thinkingRows) {
		const text = fullText(row);
		const hit = shouldBreak(text.slice(-ENFORCE.windowChars), text.length, ENFORCE);
		if (hit) falsePositives.push(`${row.model} ${row.ts} repeats=${hit.hit.repeats}`);
	}
	// 已知的真实复读样本本就该命中，从误报里排除。
	// 2026-09-16/17/18 共 5 条 workbuddy/deepseek-v4.1-flash 事故。
	const known = falsePositives.filter((line) => !line.includes("deepseek-v4.1-flash"));
	check(
		`探针 A：无非复读模型被误伤（${thinkingRows.length} 条中 ${falsePositives.length} 条命中，全部属于已知复读模型）`,
		known.length === 0,
		known.slice(0, 3).join(" | "),
	);
	check(
		`探针 A：命中样本数 ≤ 已知的 5 条`,
		falsePositives.length <= 5,
		`实际 ${falsePositives.length}`,
	);

	// 探针 B（词表塌缩）在有产出样本上必须零误报 —— full-text 与流式前缀扫描都要过。
	const productiveSamples: ThinkingRow[] = [];
	for (const row of thinkingRows) {
		const ledger = findLedger(row);
		if (!ledger) continue;
		if (isProductive(ledger) === true) productiveSamples.push(row);
	}
	const collapseFullText: string[] = [];
	const collapseStreaming: string[] = [];
	for (const row of productiveSamples) {
		const text = fullText(row);
		const full = detectLineCollapse(text, COLLAPSE);
		if (full) collapseFullText.push(`${row.model} ${row.ts} distinct=${full.distinct}`);
		for (let cut = ENFORCE.minChars; cut <= text.length; cut += 250) {
			const hit = shouldBreakCollapse(text.slice(0, cut).slice(-COLLAPSE.windowChars), cut, COLLAPSE_ENFORCE);
			if (hit) {
				collapseStreaming.push(`${row.model} ${row.ts} cut=${cut} distinct=${hit.hit.distinct}`);
				break;
			}
		}
	}
	check(
		`探针 B：有产出样本全篇零误报（${productiveSamples.length} 条对照组）`,
		collapseFullText.length === 0,
		collapseFullText.slice(0, 3).join(" | "),
	);
	check(
		`探针 B：有产出样本流式前缀（步进 250）零误报`,
		collapseStreaming.length === 0,
		collapseStreaming.slice(0, 3).join(" | "),
	);

	// -------------------------------------------------- 2) 真实事故提前拦截
	console.log("\n[2] 真实事故：35 万字符复读必须在前 5 万字符内被拦住");
	const incident = thinkingRows.find((row) => (row.chars ?? 0) > 300_000);
	if (!incident) {
		console.log("  ⚠ 未找到事故样本（需要 2026-09-17 的日志），跳过");
	} else {
		const text = fullText(incident);
		let firstHit: number | null = null;
		for (let cut = ENFORCE.minChars; cut <= text.length; cut += 250) {
			if (shouldBreak(text.slice(0, cut).slice(-ENFORCE.windowChars), cut, ENFORCE)) {
				firstHit = cut;
				break;
			}
		}
		check(
			`在 ${firstHit ?? "未"} 字符处命中（原文 ${text.length} 字符，最终烧到 ${incident.chars} 字符）`,
			firstHit !== null && firstHit <= 50_000,
			firstHit === null ? "完全没命中" : `过晚: ${firstHit}`,
		);
		if (firstHit !== null) {
			const saved = (incident.chars ?? text.length) - firstHit;
			check(
				`可提前省下 ${saved} 字符（≈ ${Math.round(saved / 4)} token）`,
				saved > 100_000,
			);
		}

		// ---------------------------------------------- 3) 剥复读正确性
		console.log("\n[3] 剥复读：剥掉后不再命中，保留的前缀不含复读");
		const stripped = stripAllLoopTail(text);
			check(`剥掉了 ${stripped.dropped} 字符`, stripped.dropped > 100_000);
		check(`保留了 ${stripped.kept.length} 字符真实推理`, stripped.kept.length > 1000);
		check(
			"剥完后不再命中尾部周期",
			detectTailPeriod(stripped.kept, TAIL_OPTS) === null,
		);
		const capped = capKeptPrefix(stripped.kept, 4000);
		check(`前缀被限制到 ${capped.text.length} 字符`, capped.text.length <= 4100);
		check(
			"限制后的前缀里没有复读单元",
			!capped.text.includes("Let me write.\n\nGo.\n\nNow.\n\nOK.\n\nLet me write."),
		);
	}

	// -------------------------------------------------- 5) 报障样本
	console.log("\n[5] 报障样本（2026-09-18T13:05:45.333Z）：新配置必须在前 2 万字符内命中");
	const reported = thinkingRows.find((row) => (row.ts ?? "").startsWith("2026-09-18T13:05:45.333"));
	if (!reported) {
		console.log("  ⚠ 未找到报障样本（日志已被 purge），跳过");
	} else {
		const text = fullText(reported);
		// 旧配置（maxPeriod=200 / window 2000）在该样本上结构性失明 —— 复读单元 405 字符。
		const oldCfg = { minRepeats: 10, minChars: 20_000, maxPeriod: 200, windowChars: 2000 };
		let oldHit: number | null = null;
		for (let cut = oldCfg.minChars; cut <= text.length; cut += 250) {
			if (shouldBreak(text.slice(0, cut).slice(-oldCfg.windowChars), cut, oldCfg)) {
				oldHit = cut;
				break;
			}
		}
		check(
			`旧配置（maxPeriod=200）在整篇 ${text.length} 字符上从不命中（复读单元 405）`,
			oldHit === null,
			`旧配置在 ${oldHit} 处误命中`,
		);

		let firstA: number | null = null;
		let period: number | null = null;
		for (let cut = ENFORCE.minChars; cut <= text.length; cut += 250) {
			const hit = shouldBreak(text.slice(0, cut).slice(-ENFORCE.windowChars), cut, ENFORCE);
			if (hit) {
				firstA = cut;
				period = hit.hit.period;
				break;
			}
		}
		check(
			`新配置探针 A 在 ${firstA ?? "未"} 字符处命中（单元 ${period ?? "?"} 字符）`,
			firstA !== null && firstA <= 20_000,
			firstA === null ? "完全没命中" : `过晚: ${firstA}`,
		);

		let firstB: number | null = null;
		for (let cut = ENFORCE.minChars; cut <= text.length; cut += 250) {
			const hit = shouldBreakCollapse(
				text.slice(0, cut).slice(-COLLAPSE.windowChars),
				cut,
				COLLAPSE_ENFORCE,
			);
			if (hit) {
				firstB = cut;
				break;
			}
		}
		check(
			`新配置探针 B 在 ${firstB ?? "未"} 字符处命中（≤ 20000）`,
			firstB !== null && firstB <= 20_000,
			firstB === null ? "完全没命中" : `过晚: ${firstB}`,
		);

		const stripped = stripAllLoopTail(text);
		const afterA = detectTailPeriod(stripped.kept, TAIL_OPTS);
		const afterB = detectLineCollapse(stripped.kept, COLLAPSE);
		check(
			`剥离 ${stripped.dropped} 字符后两个探针都不再命中（保留 ${stripped.kept.length}）`,
			afterA === null && afterB === null,
			`afterA=${afterA ? "HIT" : "null"} afterB=${afterB ? "HIT" : "null"}`,
		);
	}
}

// ---------------------------------------------------------------- 4) 单元用例
console.log("\n[4] 单元用例");

// 逐字复读：100 次 "OK. " 必须命中。p=4 < minPeriod=8，探针 A 现在报的是对齐后的
// p=8；逐字复读的「精确单元长度」需要显式放宽 minPeriod 才能观测到。
const verbatim = "分析完成，接下来写入文件。\n" + "OK. ".repeat(100);
const verbatimHit = detectTailPeriod(verbatim, { minRepeats: 10 });
check("逐字复读命中（探针 A 默认参数）", verbatimHit !== null, JSON.stringify(verbatimHit));
const verbatimP4 = detectTailPeriod(verbatim, { minRepeats: 10, minPeriod: 1 });
check(
	"逐字复读在 minPeriod:1 下报出精确单元 p=4（保留原用例意图）",
	verbatimP4?.period === 4,
	JSON.stringify(verbatimP4),
);
const verbatimStripped = stripAllLoopTail(verbatim);
check(
	"逐字复读被剥干净",
	!verbatimStripped.kept.includes("OK. OK."),
	`kept=${JSON.stringify(verbatimStripped.kept)}`,
);

// 模板化枚举：绝不能被当成复读（这是全篇词频方案会误报的典型）。
const enumeration = Array.from(
	{ length: 200 },
	(_, i) => `第 ${i + 1} 项：检查模块 ${i + 1} 的边界条件是否覆盖。`,
).join("\n");
check(
	"模板化枚举不误报（探针 A）",
	detectTailPeriod(enumeration, TAIL_OPTS) === null,
);
check(
	"模板化枚举不误报（探针 B）",
	detectLineCollapse(enumeration, COLLAPSE) === null,
);

// 短思考即使复读也不动手。
const shortLoop = "OK. ".repeat(50);
check(
	"短思考不触发（minChars 门禁）",
	shouldBreak(shortLoop, shortLoop.length, ENFORCE) === null,
);

// 长复读必须命中。
const longLoop = "分析完成。\n" + "OK. Let me write. Go. ".repeat(2000);
check(
	"长复读且可信时熔断",
	shouldBreak(longLoop, longLoop.length, ENFORCE) !== null,
);

// TailWindow 直接用 provider 的权威全文刷新，窗口裁剪不改变检测结论。
const win = new TailWindow(2000);
for (let i = 0; i < 5000; i++) win.update("OK. ".repeat(i + 1));
check("TailWindow 只保留尾部窗口", win.tail.length <= 2000);
check("TailWindow 记录权威总长度", win.totalChars === 20_000);
check("TailWindow 尾部仍可检测", detectTailPeriod(win.tail, TAIL_OPTS) !== null);

// 窗口内容取自 partial：累计/增量不再影响判定（回归 2026-09-18 误杀）。
// 该事故里 delta 累加与 partial 曾出现 99 字符偏差，旧 DeltaGuard 因此否决了
// 本条消息的熔断资格；新窗口不依赖 delta，同样的文本必须能命中。
const incidentLike = "让我检查一下这个问题的细节。\n" + "OK. Let me write. Go. ".repeat(1500);
const incidentWin = new TailWindow(2000);
incidentWin.update(incidentLike);
check(
	"窗口取自 partial，不受 delta 计数偏差影响",
	shouldBreak(incidentWin.tail, incidentWin.totalChars, ENFORCE) !== null,
);

// ---------------------------------------------- 6) 词表塌缩（探针 B）单元用例
console.log("\n[6] 词表塌缩（探针 B）单元用例");

/** 塌缩形状：~10 种短句的用户，顺序伪随机（无任何精确周期，探针 A 必然失明）。 */
function collapseShapedLoop(count: number, seed = 12345): string {
	const vocab = [
		"OK.",
		"Let me go.",
		"Now.",
		"Let me write.",
		"Let me read.",
		"Let me do it.",
		"Let me issue.",
		"Let me execute.",
		"Go.",
		"Done.",
	];
	const out: string[] = [];
	let s = seed;
	for (let i = 0; i < count; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		out.push(vocab[s % vocab.length]);
	}
	return out.join("\n\n");
}

const collapsePrefix = Array.from(
	{ length: 400 },
	(_, i) => `第 ${i + 1} 步分析：检查模块 ${i + 1} 的边界条件，确认与上游契约一致。`,
).join("\n\n");
const collapseText = `${collapsePrefix}\n\n${collapseShapedLoop(3000)}`;
check(
	"塌缩形状不触发探针 A（无精确周期）",
	shouldBreak(collapseText.slice(-ENFORCE.windowChars), collapseText.length, ENFORCE) === null,
);
const collapseHit = detectLineCollapse(collapseText, COLLAPSE);
check(
	"塌缩形状被探针 B 命中",
	collapseHit !== null && collapseHit.distinct <= COLLAPSE.maxDistinct,
	JSON.stringify(collapseHit),
);
const collapseStripped = stripAllLoopTail(collapseText);
check(
	`塌缩形状被剥掉 ${collapseStripped.dropped} 字符`,
	collapseStripped.dropped > 0 && collapseStripped.kept.length > 0,
);
check(
	"剥离后保留文本不再触发任一探针",
	detectTailPeriod(collapseStripped.kept, TAIL_OPTS) === null &&
		detectLineCollapse(collapseStripped.kept, COLLAPSE) === null,
);

// 缓冲区尺寸：探针 B 与探针 A 共享一个 TailWindow。若缓冲区只按探针 A 的
// `maxPeriod * 10` 定尺寸，用户把 maxPeriod 调小（100 → 1000 字符）就会饿死
// 探针 B（它需要 1500 字符窗口）。缓冲区取二者较大值即解耦。
//
// 这里的复读行约 31 字符/行：1000 字符窗口里攒不够 40 个非空行，1500 字符才够，
// 因此这个样本能真正区分 1000 与 1500 两种尺寸。
function wrappedCollapseLoop(count: number, seed = 99): string {
	const vocab = [
		"Let me check the module boundary.",
		"Now I will write the patch.",
		"OK I will read it once more.",
		"Let me continue to the next step.",
		"I should produce the change.",
		"Done, I will write the answer.",
	];
	const out: string[] = [];
	let s = seed;
	for (let i = 0; i < count; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		out.push(vocab[s % vocab.length]);
	}
	return out.join("\n");
}

const starvationText = `${collapsePrefix}\n\n${wrappedCollapseLoop(4000)}\n`;
check(
	"缓冲区取较大值：max(100*10, 1500) = 1500",
	tailWindowChars(100, 1500) === 1500,
	String(tailWindowChars(100, 1500)),
);
check(
	"调小 maxPeriod 后探针 B 仍能命中（缓冲区不饿死它）",
	shouldBreakCollapse(
		starvationText.slice(-tailWindowChars(100, 1500)),
		starvationText.length,
		COLLAPSE_ENFORCE,
	) !== null,
);
check(
	"反例：只按 maxPeriod*10=1000 定尺寸时会饿死探针 B（锁住此回归）",
	shouldBreakCollapse(
		starvationText.slice(-(100 * 10)),
		starvationText.length,
		COLLAPSE_ENFORCE,
	) === null,
);

console.log(
	failures === 0
		? "\n全部通过 ✅"
		: `\n${failures} 个用例失败 ❌`,
);
process.exit(failures === 0 ? 0 : 1);
