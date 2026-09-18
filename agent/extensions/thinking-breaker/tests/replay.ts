/**
 * thinking-breaker 回放测试。
 *
 * 用本机真实的思考原文日志（~/.pi/agent/thinking-breaker/*.thinking.jsonl）跑：
 *   1. 零误报回归 —— 5000+ 条真实思考在熔断阈值下不得命中；
 *   2. 真实事故提前拦截 —— 2026-09-17 的 35 万字符复读必须在前 5 万字符内命中；
 *   3. 剥复读正确性 —— 剥掉后不再命中，且保留的前缀里没有复读。
 *
 * 用法: volta run node tests/replay.ts [--dir <日志目录>]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	TailWindow,
	capKeptPrefix,
	detectTailPeriod,
	shouldBreak,
	stripAllLoopTail,
} from "../detect.ts";

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const LOG_DIR =
	dirIndex >= 0 && args[dirIndex + 1]
		? args[dirIndex + 1]
		: join(homedir(), ".pi", "agent", "thinking-breaker");

interface ThinkingRow {
	model?: string;
	ts?: string;
	chars?: number;
	thinking?: string;
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

const ENFORCE = { minRepeats: 10, minChars: 20_000, maxPeriod: 200, windowChars: 2000 };

// ---------------------------------------------------------------- 载入真实数据
const rows: ThinkingRow[] = [];
if (existsSync(LOG_DIR)) {
	for (const file of readdirSync(LOG_DIR)) {
		if (!file.endsWith(".thinking.jsonl")) continue;
		for (const line of readFileSync(join(LOG_DIR, file), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line) as ThinkingRow);
			} catch {
				// 坏行跳过：日志是 append 的，可能被截断。
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

console.log(`thinking-breaker 回放测试`);
console.log(`日志目录: ${LOG_DIR}`);
console.log(`样本: ${rows.length} 条思考原文\n`);

if (rows.length === 0) {
	console.log("⚠ 没有可回放的样本（日志已被 purge 或目录不存在）。");
	console.log("  跳过误报回归；真实事故用例需要 2026-09-17 的日志。");
} else {
	// -------------------------------------------------- 1) 零误报回归
	console.log("[1] 零误报回归：真实思考在熔断阈值下不得命中");
	const falsePositives: string[] = [];
	for (const row of rows) {
		const text = fullText(row);
		const hit = shouldBreak(text, text.length, ENFORCE);
		if (hit) falsePositives.push(`${row.model} ${row.ts} repeats=${hit.hit.repeats}`);
	}
	// 已知的真实复读样本本就该命中，从误报里排除。
	// 2026-09-16/17/18 共 4 条 workbuddy/deepseek-v4.1-flash 事故。
	const known = falsePositives.filter((line) => !line.includes("deepseek-v4.1-flash"));
	check(
		`无非复读模型被误伤（${rows.length} 条中 ${falsePositives.length} 条命中，全部属于已知复读模型）`,
		known.length === 0,
		known.slice(0, 3).join(" | "),
	);
	check(
		`命中样本数 ≤ 已知的 4 条`,
		falsePositives.length <= 4,
		`实际 ${falsePositives.length}`,
	);

	// -------------------------------------------------- 2) 真实事故提前拦截
	console.log("\n[2] 真实事故：35 万字符复读必须在前 5 万字符内被拦住");
	const incident = rows.find((row) => (row.chars ?? 0) > 300_000);
	if (!incident) {
		console.log("  ⚠ 未找到事故样本（需要 2026-09-17 的日志），跳过");
	} else {
		const text = fullText(incident);
		let firstHit: number | null = null;
		for (let cut = ENFORCE.minChars; cut <= text.length; cut += 500) {
			if (shouldBreak(text.slice(0, cut), cut, ENFORCE)) {
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
			detectTailPeriod(stripped.kept, { minRepeats: 10 }) === null,
		);
		const capped = capKeptPrefix(stripped.kept, 4000);
		check(`前缀被限制到 ${capped.text.length} 字符`, capped.text.length <= 4100);
		check(
			"限制后的前缀里没有复读单元",
			!capped.text.includes("Let me write.\n\nGo.\n\nNow.\n\nOK.\n\nLet me write."),
		);
	}
}

// ---------------------------------------------------------------- 4) 单元用例
console.log("\n[4] 单元用例");

// 逐字复读：100 次 "OK. " 必须命中，且剥完只剩前缀。
const verbatim = "分析完成，接下来写入文件。\n" + "OK. ".repeat(100);
const verbatimHit = detectTailPeriod(verbatim, { minRepeats: 10 });
check("逐字复读命中", verbatimHit !== null && verbatimHit.period === 4);
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
	"模板化枚举不误报",
	detectTailPeriod(enumeration, { minRepeats: 10 }) === null,
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
check("TailWindow 尾部仍可检测", detectTailPeriod(win.tail, { minRepeats: 10 }) !== null);

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

console.log(
	failures === 0
		? "\n全部通过 ✅"
		: `\n${failures} 个用例失败 ❌`,
);
process.exit(failures === 0 ? 0 : 1);
