/**
 * Background subagent run registry (data-flow layer).
 *
 * Tracks subagent runs started with `background: true`. A run is registered as
 * soon as its subprocess exists, so the main agent can inspect status, read the
 * transcript, or stop it while it is still running.
 *
 * Layering: this module belongs to the data-flow layer and imports nothing from
 * the presentation layer or the neutral FleetStore contract. It stores run
 * handles only; the Fleet view keeps reading live state through FleetStore, so
 * background runs show up there exactly like foreground ones.
 */

export type BackgroundRunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

/**
 * Live view of a running subagent. The data-flow layer hands over the mutable
 * result object it keeps appending messages to, which lets `subagent_logs` read
 * progress without waiting for the run to settle.
 */
export interface BackgroundLiveView {
	messages: unknown[];
}

export interface BackgroundRunRecord<TResult> {
	runId: string;
	agent: string;
	mode: "single" | "parallel" | "chain";
	task: string;
	status: BackgroundRunStatus;
	startedAt: number;
	endedAt?: number;
	/** Agent scope this run was discovered with; needed to rebuild tool details. */
	agentScope: "user" | "project" | "both";
	/** Project agents dir discovered for this run; null when none was found. */
	projectAgentsDir: string | null;
	/** Populated once the run settles. */
	result?: TResult;
	/**
	 * Resolves when the run settles. Owned by this registry (not by the caller),
	 * so `settle()` is the single place that both records the outcome and wakes
	 * anything waiting on it.
	 */
	settled: Promise<TResult>;
	/** Requests termination through the FleetStore control port. */
	stop: () => boolean;
	/** Live transcript handle, present from registration until the run settles. */
	live?: BackgroundLiveView;
	/**
	 * Cached one-line summary of the run's latest words, refreshed by the data-flow
	 * layer on semantic events. Wait progress reads this instead of scanning the
	 * live transcript on every tick.
	 */
	progressSummary?: () => string;
	/** Control channel for steering a running subagent (B-s stage). */
	controlSocketPath?: string;
	/**
	 * Set once a caller has collected this run's result through `subagent_wait`.
	 * Uncollected runs stay in the no-argument wait set so a result is never
	 * silently dropped just because the caller omitted the runId.
	 */
	collected?: boolean;
	/**
	 * Set once the "a result is waiting to be collected" reminder has been sent.
	 * Prevents re-notifying about the same run on every subsequent settle.
	 */
	notified?: boolean;
}

export class BackgroundRunRegistry<TResult> {
	private readonly runs = new Map<string, BackgroundRunRecord<TResult>>();
	private readonly settleResolvers = new Map<string, (value: TResult) => void>();

	constructor(private readonly maxRuns = 16) {}

	/**
	 * Register a run and return it with a `settled` promise this registry
	 * controls, so `settle()` always wakes waiters exactly once.
	 */
	register(record: Omit<BackgroundRunRecord<TResult>, "settled">): BackgroundRunRecord<TResult> {
		let resolveSettled: (value: TResult) => void = () => {};
		const settled = new Promise<TResult>((resolve) => {
			resolveSettled = resolve;
		});
		const entry: BackgroundRunRecord<TResult> = { ...record, settled };
		this.settleResolvers.set(entry.runId, resolveSettled);
		this.runs.set(entry.runId, entry);
		this.prune();
		return entry;
	}

	get(runId: string): BackgroundRunRecord<TResult> | undefined {
		return this.runs.get(runId);
	}

	/**
	 * Runs a no-argument `subagent_wait` should act on: still running, or settled
	 * but whose result has not been handed to a caller yet.
	 */
	outstanding(): BackgroundRunRecord<TResult>[] {
		return this.list().filter((record) => record.status === "running" || !record.collected);
	}

	/** Mark a run's result as delivered so it leaves the outstanding set. */
	markCollected(runId: string): void {
		const record = this.runs.get(runId);
		if (record) record.collected = true;
	}

	/**
	 * Settled runs whose result the agent has neither collected nor been reminded
	 * about. This is the set worth waking the agent for: a run it is still waiting
	 * on, or one it already collected, needs no notification.
	 */
	needsReminder(): BackgroundRunRecord<TResult>[] {
		return this.list().filter((record) => record.status !== "running" && !record.collected && !record.notified);
	}

	/** Mark a run as reminded so it is not reported again. */
	markNotified(runId: string): void {
		const record = this.runs.get(runId);
		if (record) record.notified = true;
	}

	list(): BackgroundRunRecord<TResult>[] {
		return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	/**
	 * Mark a run as settled. `status` is supplied by the caller because only the
	 * data-flow layer can tell "stopped" from "failed" from "completed".
	 *
	 * `result` is optional for the failure path, where no result object exists;
	 * waiters are woken with the last known value so they never hang.
	 */
	settle(runId: string, result: TResult | undefined, status: Exclude<BackgroundRunStatus, "running">): void {
		const record = this.runs.get(runId);
		if (!record) return;
		record.result = result;
		record.status = status;
		record.endedAt = Date.now();
		// Keep the transcript reachable through `result` only; drop the live handle
		// so a settled run cannot be mistaken for a running one.
		record.live = undefined;
		record.progressSummary = undefined;
		const resolve = this.settleResolvers.get(runId);
		if (resolve) {
			this.settleResolvers.delete(runId);
			resolve(result as TResult);
		}
	}

	clear(): void {
		this.runs.clear();
		this.settleResolvers.clear();
	}

	/** Drop the oldest finished runs once the cap is exceeded; running runs are never pruned. */
	private prune(): void {
		if (this.runs.size <= this.maxRuns) return;
		const finished = this.list().filter((record) => record.status !== "running");
		while (this.runs.size > this.maxRuns && finished.length > 0) {
			const oldest = finished.shift();
			if (!oldest) break;
			this.runs.delete(oldest.runId);
			this.settleResolvers.delete(oldest.runId);
		}
	}
}
