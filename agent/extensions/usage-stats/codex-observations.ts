import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Observation {
	version: 1;
	account: string;
	plan: string;
	at: number;
	used: number;
	reset: number;
}
export type CalendarPeriod = "day" | "yesterday" | "week" | "month";
export interface ObservedTotal { points: number; intervals: number; unresolved: number }
export const identityHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const JITTER_MS = 120_000;
const MAX_GAP_MS = 24 * 3600_000;

/** Only the explicit account-wide weekly window is evidence, never a label or model limit. */
export function weeklyObservation(json: unknown, account: string, at: number): Observation | undefined {
	if (!json || typeof json !== "object") return;
	const root = json as Record<string, any>;
	if (typeof root.plan_type !== "string" || !root.plan_type.trim()) return;
	const candidates = [root.rate_limit?.primary_window, root.rate_limit?.secondary_window];
	const weekly = candidates.filter((w) => w && w.limit_window_seconds === 604800);
	if (weekly.length !== 1) return;
	const w = weekly[0];
	if (typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100) return;
	const reset = typeof w.reset_at === "number" ? w.reset_at * 1000
		: typeof w.reset_after_seconds === "number" ? at + w.reset_after_seconds * 1000 : NaN;
	if (!Number.isFinite(reset) || reset <= at || reset > at + 604800_000 + JITTER_MS) return;
	return { version: 1, account, plan: identityHash(root.plan_type.trim()), at, used: w.used_percent, reset };
}

export function isObservation(v: any): v is Observation {
	return v?.version === 1 && /^[a-f0-9]{64}$/.test(v.account) && /^[a-f0-9]{64}$/.test(v.plan)
		&& [v.at, v.used, v.reset].every((n) => typeof n === "number" && Number.isFinite(n))
		&& v.used >= 0 && v.used <= 100 && v.reset > v.at;
}

export function calendarBounds(now: Date): Record<CalendarPeriod, [number, number]> {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
	const week = new Date(today); week.setDate(today.getDate() - (today.getDay() + 6) % 7);
	return { day: [+today, +now], yesterday: [+yesterday, +today], week: [+week, +now],
		month: [+new Date(now.getFullYear(), now.getMonth(), 1), +now] };
}

/** High-water deltas are lower bounds. Never prorate an interval across a calendar boundary. */
export function observedTotals(samples: Observation[], account: string, plan: string, now: Date): Record<CalendarPeriod, ObservedTotal> {
	const bounds = calendarBounds(now);
	const totals = Object.fromEntries(Object.keys(bounds).map((p) => [p, { points: 0, intervals: 0, unresolved: 0 }])) as Record<CalendarPeriod, ObservedTotal>;
	const sorted = samples.filter((s) => isObservation(s) && s.account === account && s.at <= +now).sort((a, b) => a.at - b.at || a.used - b.used);
	const conflicts = new Set<number>();
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].at === sorted[i - 1].at && JSON.stringify(sorted[i]) !== JSON.stringify(sorted[i - 1])) conflicts.add(sorted[i].at);
	}
	let prev: Observation | undefined;
	let high = 0;
	let cycleReset = 0;
	for (const s of sorted) {
		if (conflicts.has(s.at)) continue;
		if (prev && s.at === prev.at && s.plan === prev.plan && s.reset === prev.reset && s.used === prev.used) continue;
		const sameCycle = prev && s.plan === prev.plan && Math.abs(s.reset - cycleReset) <= JITTER_MS && s.at < cycleReset;
		const valid = sameCycle && s.at > prev!.at && s.at - prev!.at <= MAX_GAP_MS
			&& s.used >= high - 0.5 && ![...conflicts].some((at) => at > prev!.at && at < s.at);
		const delta = valid ? Math.max(0, s.used - high) : 0;
		if (prev) {
			for (const p of Object.keys(bounds) as CalendarPeriod[]) {
				const [start, end] = bounds[p];
				if (s.at <= start || prev.at >= end) continue;
				if (valid && prev.at >= start && s.at <= end && s.plan === plan) {
					totals[p].points += delta; totals[p].intervals++;
				} else totals[p].unresolved++;
			}
		}
		if (!sameCycle) { high = s.used; cycleReset = s.reset; }
		else high = Math.max(high, s.used);
		prev = s;
	}
	return totals;
}

/** Each process owns one append-only private file; no shared read/modify/write race. */
export class ObservationLedger {
	private readonly name = `${process.pid}-${randomUUID()}.jsonl`;
	private queue: Promise<void> = Promise.resolve();
	private readonly directory: string;
	unavailable = false;
	constructor(directory: string) { this.directory = directory; }
	flush(): Promise<void> { return this.queue; }
	append(sample: Observation, signal?: AbortSignal): Promise<void> {
		this.queue = this.queue.then(async () => {
			if (signal?.aborted) return;
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			await chmod(this.directory, 0o700);
			const path = join(this.directory, this.name);
			if (signal?.aborted) return;
			await appendFile(path, JSON.stringify(sample) + "\n", { mode: 0o600 });
			await chmod(path, 0o600);
		}).catch(() => { this.unavailable = true; });
		return this.queue;
	}
	async read(now: Date): Promise<Observation[]> {
		await this.queue;
		const cutoff = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
		const samples: Observation[] = [];
		try {
			for (const name of await readdir(this.directory)) {
				if (!/^\d+-[a-f0-9-]+\.jsonl$/.test(name)) continue;
				try {
					for (const line of (await readFile(join(this.directory, name), "utf8")).split("\n")) {
						if (!line.trim()) continue;
						try { const s = JSON.parse(line); if (isObservation(s) && s.at >= cutoff) samples.push(s); else if (!isObservation(s)) this.unavailable = true; } catch { this.unavailable = true; }
					}
				} catch (error) { if ((error as { code?: string }).code !== "ENOENT") this.unavailable = true; }
			}
		} catch (error) { if ((error as { code?: string }).code !== "ENOENT") this.unavailable = true; }
		return samples;
	}
}

export function observationLines(totals?: Record<CalendarPeriod, ObservedTotal>, samples: Observation[] = []): string[] {
	const cell = (p: CalendarPeriod, label: string) => {
		const t = totals?.[p];
		return `${label} ${t?.intervals ? `${t.points.toFixed(2)} pp` : "数据不足"}${t?.unresolved ? ` (${t.unresolved} 归属不明)` : ""}`;
	};
	return [
		`Codex observed: ${cell("day", "今日")}  │  ${cell("yesterday", "昨日")}`,
		`Codex observed: ${cell("week", "本周")}  │  ${cell("month", "本月")}`,
		"观测下界 · 部分观测 · pp = 周额度百分比点；非完整账单",
		...(samples.length ? [`记录 首次 ${new Date(Math.min(...samples.map((s) => s.at))).toISOString()} · 最新 ${new Date(Math.max(...samples.map((s) => s.at))).toISOString()}`] : []),
	];
}
