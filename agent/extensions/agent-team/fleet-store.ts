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

/** In-flight assistant text/thinking assembled from message_update deltas. */
export interface FleetStreamingPart {
	type: "text" | "thinking";
	text: string;
	truncated?: boolean;
}

/** One live-streaming event pushed to the Web UI over SSE. */
export type FleetStreamingDelta =
	| { index: number; type: "text" | "thinking"; text: string; replace?: boolean }
	| { toolCallId: string; toolName: string; text: string; replace?: boolean };

export interface FleetRun {
	id: string;
	mode: "single" | "parallel" | "chain";
	agent: string;
	task: string;
	messages: Message[];
	/** Transient tool output for the live Web UI; terminal messages remain the durable transcript. */
	toolUpdates: Record<string, FleetToolUpdate>;
	/** Transient in-flight assistant text/thinking. Never persisted; cleared on message_end. */
	streamingParts: FleetStreamingPart[];
	/** Bumped on message_start/message_end so the Web UI knows when to reset its live streaming layer. */
	streamingReset: number;
	/** Unpushed streaming deltas; drained by the Web UI over SSE. */
	streamingDeltas: FleetStreamingDelta[];
	usage: FleetUsage;
	model?: string;
	thinkingLevel?: string;
	/** Agent scope the run came from; restored runs may not know it. */
	agentSource?: "user" | "project" | "unknown";
	status: FleetRunStatus;
	stopping?: boolean;
	startedAt: number;
	endedAt?: number;
	/**
	 * True only for runs started in this session. Restored history has no live
	 * process behind it, and its `id` is re-assigned on restore, so it must never
	 * satisfy a runId lookup — an old transcript's runId would otherwise resolve
	 * to an unrelated run whose id happens to collide.
	 */
	live: boolean;
	/**
	 * Bumped only on semantic (durable) changes. The TUI caches rendered rows by
	 * run identity + this revision, so streaming deltas never invalidate them.
	 */
	revision: number;
	stop: () => boolean;
}

export type RestoredFleetRun = Omit<FleetRun, "id" | "stop" | "status" | "toolUpdates" | "streamingParts" | "streamingReset" | "streamingDeltas" | "live" | "revision"> & {
	status: Exclude<FleetRunStatus, "running">;
	toolUpdates?: Record<string, FleetToolUpdate>;
};

/**
 * Single-entry memo keyed by a caller-built string.
 *
 * Rendering runs on the interactive path, and the TUI repaints far more often
 * than durable run state changes. The live transcript row and the overlay's
 * transcript builder are both expensive, so they cache their last result and
 * rebuild only when the key changes. `clear()` drops the entry so a theme change
 * cannot serve stale ANSI-styled lines.
 */
export class RevisionCache<T> {
	private entry?: { key: string; value: T };

	get(key: string, build: () => T): T {
		if (!this.entry || this.entry.key !== key) {
			this.entry = { key, value: build() };
		}
		return this.entry.value;
	}

	clear(): void {
		this.entry = undefined;
	}
}

/**
 * Cache key for one live subagent row.
 *
 * A row displays a fixed set of run ids. Its rendered content only changes when
 * one of *those* runs changes semantically, so the key is built from exactly
 * those runs' `revision` counters. A pruned/cleared run keys as "x" so losing it
 * also rebuilds. Keying per-run (instead of on a global store counter) means an
 * unrelated run's durable change never rebuilds an already-finished row, and
 * per-token streaming deltas — which never bump `revision` — never rebuild it
 * either.
 */
export function liveRowRevisionKey(runs: readonly FleetRun[], runIds: readonly string[]): string {
	const byId = new Map(runs.map((run) => [run.id, run] as const));
	return runIds.map((id) => `${id}:${byId.get(id)?.revision ?? "x"}`).join(",");
}

/**
 * Cache key for the overlay's transcript of one run: run identity + that run's
 * own semantic revision + width. Scrolling and the 1s ticker keep the same key
 * (a cache hit); a durable change to this run, a resize, or switching to another
 * run changes it. Another run's activity does not.
 */
export function conversationCacheKey(run: FleetRun, width: number): string {
	return `${run.id}:${run.revision}:${width}`;
}

type FleetListener = () => void;

/**
 * How a FleetStore change is classified for the TUI channel.
 *
 * `delta` is transient streaming output (assistant text/thinking and partial
 * tool output): the Web UI consumes it, but it is invisible to the TUI's durable
 * view, so it must not trigger a repaint or invalidate a cached row.
 * `semantic` is a durable change (message boundary, tool start/end, run
 * lifecycle) that the TUI must reflect immediately.
 */
export type FleetTouchKind = "semantic" | "delta";

/**
 * Observable state container for the Fleet run list. The data-flow layer adds
 * runs and mutates their state; the presentation layer subscribes and is
 * notified on every change. Stop is an explicit control port: the UI requests
 * it, the run's stop callback (owned by the data-flow layer) performs it.
 */
export class FleetStore {
	private runs: FleetRun[] = [];
	private listeners = new Set<FleetListener>();
	private tuiListeners = new Set<FleetListener>();
	private nextId = 1;

	add(run: Omit<FleetRun, "id" | "status" | "startedAt" | "streamingParts" | "streamingReset" | "streamingDeltas" | "live" | "revision">): FleetRun {
		const entry: FleetRun = {
			...run,
			streamingParts: [],
			streamingReset: 0,
			streamingDeltas: [],
			revision: 0,
			id: String(this.nextId++),
			status: "running",
			startedAt: Date.now(),
			live: true,
		};
		this.runs.push(entry);
		this.prune();
		this.notifyAll();
		return entry;
	}

	restore(runs: RestoredFleetRun[]): void {
		const activeRuns = this.runs.filter((run) => run.status === "running");
		const restoredRuns: FleetRun[] = runs.slice(-32).map((run) => ({
			...run,
			id: String(this.nextId++),
			toolUpdates: run.toolUpdates ?? {},
			streamingParts: [],
			streamingReset: 0,
			streamingDeltas: [],
			revision: 0,
			// Restored runs have no live process; see the `live` field docs.
			live: false,
			stop: () => false,
		}));
		this.runs = [...restoredRuns, ...activeRuns];
		this.prune();
		this.notifyAll();
	}

	touch(kind: FleetTouchKind = "semantic", run?: FleetRun): void {
		// The Web UI needs every delta to drive its live streaming layer, so its
		// listeners are notified unconditionally. The TUI renders durable state only
		// and is therefore woken on semantic changes alone.
		this.notify();
		if (kind === "delta") return;
		if (run) {
			run.revision++;
		} else {
			// Rare compatibility path: a semantic touch naming no run. The TUI caches
			// rows by per-run revision, so without bumping something they would serve
			// stale content. Bump every current run (the store is capped at 32);
			// production callers pass the run so unrelated rows are not invalidated.
			for (const current of this.runs) current.revision++;
		}
		this.notifyTui();
	}

	finish(run: FleetRun, status: Exclude<FleetRunStatus, "running">): void {
		if (run.status !== "running") return;
		run.status = status;
		run.stopping = false;
		run.endedAt = Date.now();
		// Bump the streaming reset so the Web UI fetches the final snapshot
		// (status badge / timeline) even when no further message boundary fires.
		run.streamingDeltas = [];
		run.streamingReset++;
		run.revision++;
		this.notifyAll();
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
		run.streamingDeltas = [];
		run.streamingReset++;
		run.revision++;
		this.notifyAll();
	}

	list(): readonly FleetRun[] {
		return this.runs;
	}

	clear(): void {
		this.runs = [];
		this.notifyAll();
	}

	subscribe(listener: FleetListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Subscribe to semantic changes only. The TUI renders durable state (status,
	 * usage, transcript), so per-token streaming deltas must not trigger a repaint
	 * or invalidate a cached row; the Web UI keeps using `subscribe` for every
	 * delta.
	 */
	subscribeTui(listener: FleetListener): () => void {
		this.tuiListeners.add(listener);
		return () => this.tuiListeners.delete(listener);
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

	private notifyTui(): void {
		for (const listener of this.tuiListeners) listener();
	}

	private notifyAll(): void {
		this.notify();
		this.notifyTui();
	}
}
