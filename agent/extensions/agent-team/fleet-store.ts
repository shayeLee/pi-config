/**
 * Neutral Fleet state container shared by the data-flow layer (index.ts) and
 * the presentation layer (fleet-view.ts / fleet-web.ts).
 *
 * This module is the two layers' contract: it imports nothing from either
 * layer, only the pi-ai Message type. The data-flow layer publishes run state
 * and events here; the presentation layer subscribes to it for read-only
 * display and sends explicit control operations (stop) back through it.
 */

import type { Message } from "@earendil-works/pi-ai";

export type FleetRunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface FleetUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface FleetToolUpdate {
	toolName: string;
	phase: "streaming" | "completed";
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	contentTruncated?: boolean;
	actualDiffTruncated?: boolean;
	actualDiff?: string;
}

export interface FleetRun {
	id: string;
	mode: "single" | "parallel" | "chain";
	agent: string;
	task: string;
	messages: Message[];
	/** Transient tool output for the live Web UI; terminal messages remain the durable transcript. */
	toolUpdates: Record<string, FleetToolUpdate>;
	usage: FleetUsage;
	model?: string;
	status: FleetRunStatus;
	stopping?: boolean;
	startedAt: number;
	endedAt?: number;
	stop: () => boolean;
}

export type RestoredFleetRun = Omit<FleetRun, "id" | "stop" | "status" | "toolUpdates"> & {
	status: Exclude<FleetRunStatus, "running">;
	toolUpdates?: Record<string, FleetToolUpdate>;
};

type FleetListener = () => void;

/**
 * Observable state container for the Fleet run list. The data-flow layer adds
 * runs and mutates their state; the presentation layer subscribes and is
 * notified on every change. Stop is an explicit control port: the UI requests
 * it, the run's stop callback (owned by the data-flow layer) performs it.
 */
export class FleetStore {
	private runs: FleetRun[] = [];
	private listeners = new Set<FleetListener>();
	private nextId = 1;

	add(run: Omit<FleetRun, "id" | "status" | "startedAt">): FleetRun {
		const entry: FleetRun = {
			...run,
			id: String(this.nextId++),
			status: "running",
			startedAt: Date.now(),
		};
		this.runs.push(entry);
		this.prune();
		this.notify();
		return entry;
	}

	restore(runs: RestoredFleetRun[]): void {
		const activeRuns = this.runs.filter((run) => run.status === "running");
		const restoredRuns: FleetRun[] = runs.slice(-32).map((run) => ({
			...run,
			id: String(this.nextId++),
			toolUpdates: run.toolUpdates ?? {},
			stop: () => false,
		}));
		this.runs = [...restoredRuns, ...activeRuns];
		this.prune();
		this.notify();
	}

	touch(): void {
		this.notify();
	}

	finish(run: FleetRun, status: Exclude<FleetRunStatus, "running">): void {
		if (run.status !== "running") return;
		run.status = status;
		run.stopping = false;
		run.endedAt = Date.now();
		this.notify();
	}

	stop(id: string): boolean {
		const run = this.runs.find((item) => item.id === id);
		if (!run || run.status !== "running") return false;
		const stopped = run.stop();
		if (stopped) this.markStopping(run);
		return stopped;
	}

	markStopping(run: FleetRun): void {
		if (run.status !== "running" || run.stopping) return;
		run.stopping = true;
		this.notify();
	}

	list(): readonly FleetRun[] {
		return this.runs;
	}

	clear(): void {
		this.runs = [];
		this.notify();
	}

	subscribe(listener: FleetListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private prune(): void {
		if (this.runs.length <= 32) return;
		const completed = this.runs.filter((run) => run.status !== "running");
		while (this.runs.length > 32 && completed.length > 0) {
			const oldest = completed.shift();
			if (!oldest) break;
			this.runs = this.runs.filter((run) => run !== oldest);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
