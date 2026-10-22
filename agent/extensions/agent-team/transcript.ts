/** Versioned, append-only custom entries. Pi excludes these entries from model context.
 * This module is copied alongside agent-team/index.ts; it has no server dependency.
 */
import { randomUUID } from "node:crypto";

export class TranscriptJournal {
  private runs = new Map<string, { id: string; seq: number; message: number; open: boolean; lastPartial: number; liveRevision: number; partial?: unknown }>();
  constructor(private append: (type: string, data: unknown) => void, private emit: (type: string, data: unknown) => void) {}

  start(run: { id: string; agent: string; task: string; startedAt: number; model?: string; thinkingLevel?: string; backend?: string; canSteer?: boolean }) {
    const state = { id: randomUUID(), seq: 0, message: 0, open: false, lastPartial: 0, liveRevision: 0 };
    this.runs.set(run.id, state);
    this.write(run.id, "start", { runId: run.id, agent: run.agent, task: run.task, startedAt: run.startedAt, model: run.model, thinkingLevel: run.thinkingLevel, backend: run.backend, canSteer: run.canSteer });
  }

  private write(runId: string, kind: string, payload: unknown) {
    const state = this.runs.get(runId);
    if (!state) return;
    const record = { version: 1, id: state.id, seq: ++state.seq, timestamp: Date.now(), kind, payload };
    // A failed append must propagate: never publish an unsaved record as durable.
    this.append("agent-team:transcript", record);
    this.emit("agent-team:transcript", record);
  }

  event(runId: string, event: any) {
    const state = this.runs.get(runId);
    if (!state) return;
    if (event.type === "thinking_level_changed" && typeof event.level === "string") {
      this.write(runId, "configuration", { thinkingLevel: event.level });
    } else if (event.type === "message_start") {
      state.message++; state.open = true; state.lastPartial = 0;
      this.write(runId, "message", { key: state.message, message: event.message, complete: false });
    } else if (event.type === "message_update" && event.message) {
      state.partial = event.message;
      if (Date.now() - state.lastPartial >= 250) {
        state.lastPartial = Date.now();
        this.emit("agent-team:transcript-live", { id: state.id, key: state.message, message: event.message, revision: ++state.liveRevision });
      }
    } else if (event.type === "message_end" || event.type === "tool_result_end") {
      if (!state.open) state.message++;
      this.write(runId, "message", { key: state.message, message: event.message, complete: true });
      state.open = false; state.partial = undefined;
    } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      this.write(runId, event.type, event);
    }
  }

  /** Fleet run id of a transcript id (the UUID hosts address runs by), while the run is open. */
  runIdOf(transcriptId: string): string | undefined {
    for (const [runId, state] of this.runs) if (state.id === transcriptId) return runId;
    return undefined;
  }

  /** `source: "user"` marks a person's steer sent through the host, not the parent agent's. */
  steer(runId: string, text: string, source?: "user") {
    const id = randomUUID();
    this.write(runId, "input", { id, text, delivery: "submitted", ...(source ? { source } : {}) });
    return (ok: boolean) => this.write(runId, "input_status", { id, delivery: ok ? "submitted" : "failed" });
  }

  finish(runId: string, status: string, result: { endedAt?: number; model?: string; thinkingLevel?: string; errorMessage?: string }) {
    const state = this.runs.get(runId);
    if (state?.partial) this.write(runId, "message", { key: state.message, message: state.partial, complete: false });
    this.write(runId, "end", { status, endedAt: result.endedAt, model: result.model, thinkingLevel: result.thinkingLevel, errorMessage: result.errorMessage });
    this.runs.delete(runId);
  }
}
