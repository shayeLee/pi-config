import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";

/** This boundary emits the existing agent-team message vocabulary, not raw SDK messages. */
export type RunnerEvent = { type: string; [key: string]: any };
export type ClaudeRunConfig = {
  task: string;
  cwd: string;
  executable: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  permissionMode?: "dontAsk" | "acceptEdits" | "plan";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** agent-team control socket; steering lines arrive here like they do for Pi children. */
  controlSocket?: string;
  /** Skills Pi discovered for this cwd; each path is the skill's SKILL.md or single-file .md. */
  skills?: SkillRef[];
};
export type SkillRef = { name: string; path: string };
export type QueryHandle = AsyncIterable<SDKMessage> & { close(): void };
export type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

/** A failure whose message is safe and useful to show in the parent transcript. */
export class ClaudeRunError extends Error {}

import { subscriptionEnvironment } from "./environment.mjs";
export { subscriptionEnvironment } from "./environment.mjs";

/** The host returns the last reply as the run's result; a steered extra turn must not shrink it to a delta. */
const DELEGATION_NOTE = "Your last reply is returned to the agent that delegated this task as its whole result. "
  + "If more instructions arrive after you have answered, end with a reply that is complete on its own: "
  + "the earlier findings together with the change, not the change alone.";

/**
 * Pi's skills reach Claude as one local plugin named "pi", so they appear as pi:<name> and
 * never collide with Claude's own. Skill directories are symlinked, so their references and
 * scripts stay where they are. Returns the plugin root, which the caller removes afterwards.
 */
export function writeSkillPlugin(skills: SkillRef[] | undefined): string | undefined {
  if (!skills?.length) return undefined;
  const root = mkdtempSync(join(tmpdir(), "pi-claude-skills-"));
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pi", description: "Skills shared from Pi" }));
  mkdirSync(join(root, "skills"));
  for (const skill of skills) {
    // A skill name becomes a directory name: never let it climb out of the plugin.
    if (!/^[A-Za-z0-9][\w.-]*$/.test(skill.name) || !isAbsolute(skill.path)) continue;
    const target = join(root, "skills", skill.name);
    try {
      if (basename(skill.path) === "SKILL.md") symlinkSync(dirname(skill.path), target, "dir");
      else { mkdirSync(target); symlinkSync(skill.path, join(target, "SKILL.md")); }
    } catch { /* duplicate name or unreadable skill: skip it */ }
  }
  return root;
}

export function queryOptions(config: ClaudeRunConfig, abortController: AbortController, env = process.env, skillPlugin?: string): Options {
  if (!config.task?.trim() || !isAbsolute(config.cwd) || !isAbsolute(config.executable)) {
    throw new ClaudeRunError("Claude task, absolute cwd and absolute executable are required");
  }
  if (config.permissionMode && !["dontAsk", "acceptEdits", "plan"].includes(config.permissionMode)) {
    throw new ClaudeRunError("Unsupported Claude permission mode");
  }
  if (config.effort && !["low", "medium", "high", "xhigh", "max"].includes(config.effort)) {
    throw new ClaudeRunError("Unsupported Claude effort");
  }
  if (config.tools && (!Array.isArray(config.tools) || config.tools.some(t => typeof t !== "string" || !t.trim()))) {
    throw new ClaudeRunError("Claude tools must be non-empty native tool names");
  }
  if (config.skills && (!Array.isArray(config.skills) || config.skills.some(s => typeof s?.name !== "string" || typeof s?.path !== "string"))) {
    throw new ClaudeRunError("Claude skills must be {name, path} entries");
  }
  // Skills need the Skill tool; an explicit empty list still disables every built-in tool.
  const tools = config.tools ?? ["Read", "Glob", "Grep"];
  return {
    cwd: config.cwd,
    pathToClaudeCodeExecutable: config.executable,
    abortController,
    env: subscriptionEnvironment(env),
    // Claude's own settings apply as they do in Claude Code: ~/.claude/settings.json, the project's
    // .claude/settings.json and .claude/settings.local.json, with CLAUDE.md, AGENTS.md and Claude's MCP.
    settingSources: ["user", "project", "local"],
    skills: "all",
    ...(skillPlugin ? { plugins: [{ type: "local", path: skillPlugin, skipMcpDiscovery: true }] } : {}),
    persistSession: false,
    includePartialMessages: true,
    permissionMode: config.permissionMode ?? "dontAsk",
    tools: tools.length && !tools.includes("Skill") ? [...tools, "Skill"] : tools,
    disallowedTools: ["AskUserQuestion", "ExitPlanMode"],
    // The host delegates tool approval to this worker; preserve the requested arguments.
    canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
    onElicitation: async () => ({ action: "decline" }),
    onUserDialog: async () => ({ behavior: "cancelled" }),
    // The worker is the detached group leader; native SDK descendants stay in that group.
    spawnClaudeCodeProcess: options => spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true,
    }),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    systemPrompt: { type: "preset", preset: "claude_code",
      append: config.systemPrompt ? `${config.systemPrompt}\n\n${DELEGATION_NOTE}` : DELEGATION_NOTE } as const,
  };
}

type Block = Record<string, any>;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const blocks = (value: unknown): Block[] => Array.isArray(value) ? value.filter(b => b && typeof b === "object") : [];
function content(value: unknown): Block[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return blocks(value).map(b => {
    if (b.type === "tool_use") return { type: "toolCall", id: b.id, name: b.name, arguments: b.input ?? {} };
    if (b.type === "image" && b.source?.type === "base64") return { type: "image", data: b.source.data, mimeType: b.source.media_type };
    return { ...b };
  });
}

/** One durable assistant record per API message ID, despite block-level SDK envelopes. */
export class ClaudeEventBridge {
  private seen = new Set<string>();
  private toolNames = new Map<string, string>();
  private toolResults = new Set<string>();
  private pending?: { id: string; message: Block; usage: Block };
  private partial?: Block;
  private finalText = "";
  private assistantError = false;
  private terminal?: { ok: boolean; subtype: string; detail: string; text: string };
  private echoes: string[] = [];
  private emit: (event: RunnerEvent) => void;
  constructor(emit: (event: RunnerEvent) => void) { this.emit = emit; }

  /**
   * A steer the session has taken. It is echoed as a user message at the next boundary
   * (tool results, where the CLI folds it in, or the end of the turn), never inside an
   * assistant message that is still streaming. The echo is how hosts mark a steer delivered.
   */
  queueEcho(text: string) { this.echoes.push(text); }
  private flushEchoes() {
    for (const text of this.echoes.splice(0)) this.message({ role: "user", content: text, timestamp: Date.now() });
  }

  private message(message: Block) { this.emit({ type: "message_end", message }); }
  flush() {
    if (!this.pending) return;
    const { message, usage } = this.pending;
    const input = number(usage.input_tokens), output = number(usage.output_tokens);
    const cacheRead = number(usage.cache_read_input_tokens), cacheWrite = number(usage.cache_creation_input_tokens);
    // Dollar cost is intentionally absent: SDK estimates are not subscription charges.
    message.usage = { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
    this.message(message);
    this.finalText = message.content.filter((b: Block) => b.type === "text").map((b: Block) => b.text).join("\n");
    this.pending = undefined;
    this.partial = undefined;
  }

  accept(raw: SDKMessage) {
    const m = raw as unknown as Block;
    // Nested Claude agents are represented by their parent's Agent tool result for now.
    if (m.parent_tool_use_id) return;
    if (typeof m.uuid === "string") {
      if (this.seen.has(m.uuid)) return;
      this.seen.add(m.uuid);
    }
    if (m.type === "stream_event") {
      const e = m.event;
      if (e?.type === "message_start") {
        this.flush();
        this.partial = { role: "assistant", content: [], model: e.message?.model, provider: "anthropic", timestamp: Date.now() };
        this.emit({ type: "message_start", message: structuredClone(this.partial) });
      } else if (this.partial && Number.isSafeInteger(e?.index) && e.index >= 0 && e.index < 1024) {
        if (e.type === "content_block_start") this.partial.content[e.index] = content([e.content_block])[0];
        const block = this.partial.content[e.index];
        let delta: RunnerEvent | undefined;
        if (block && e.type === "content_block_delta") {
          if (e.delta?.type === "text_delta") {
            block.text = (block.text ?? "") + e.delta.text;
            delta = { type: "text_delta", contentIndex: e.index, delta: e.delta.text };
          } else if (e.delta?.type === "thinking_delta") {
            block.thinking = (block.thinking ?? "") + e.delta.thinking;
            delta = { type: "thinking_delta", contentIndex: e.index, delta: e.delta.thinking };
          }
        }
        this.emit({ type: "message_update", message: structuredClone(this.partial), assistantMessageEvent: delta });
      }
      return;
    }
    if (m.type === "assistant") {
      const source = m.message;
      if (!source || typeof source.id !== "string") throw new Error("Malformed Claude assistant message");
      if (this.pending?.id !== source.id) {
        this.flush();
        const message = { role: "assistant", content: [] as Block[], model: source.model, provider: "anthropic",
          timestamp: Date.now(), stopReason: "stop", sourceMessageId: source.id };
        this.pending = { id: source.id, message, usage: {} };
        if (!this.partial) this.emit({ type: "message_start", message: structuredClone(message) });
      }
      const pending = this.pending!;
      for (const [key, value] of Object.entries(source.usage ?? {})) {
        pending.usage[key] = Math.max(number(pending.usage[key]), number(value));
      }
      const additions = content(source.content);
      pending.message.content.push(...additions);
      if (m.error) { this.assistantError = true; pending.message.stopReason = "error"; }
      this.emit({ type: "message_update", message: structuredClone(pending.message) });
      for (const block of additions) {
        if (block.type === "toolCall" && typeof block.id === "string" && !this.toolNames.has(block.id)) {
          this.toolNames.set(block.id, block.name);
          this.emit({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
        }
      }
      return;
    }
    if (m.type === "user") {
      this.flush();
      for (const block of blocks(m.message?.content)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string" || this.toolResults.has(block.tool_use_id)) continue;
        this.toolResults.add(block.tool_use_id);
        const toolName = this.toolNames.get(block.tool_use_id) ?? "tool";
        const result = { content: content(block.content), details: m.tool_use_result };
        this.emit({ type: "tool_execution_end", toolCallId: block.tool_use_id, toolName, result, isError: !!block.is_error });
        this.message({ role: "toolResult", toolCallId: block.tool_use_id, toolName, ...result, isError: !!block.is_error, timestamp: Date.now() });
      }
      this.flushEchoes();
      return;
    }
    if (m.type === "result") {
      this.flush();
      this.flushEchoes();
      // Steering can add turns; each ends with a result and the last one decides the run.
      const text = typeof m.result === "string" ? m.result : "";
      const errors = Array.isArray(m.errors) ? m.errors.filter((e: unknown) => typeof e === "string") : [];
      this.terminal = { ok: m.subtype === "success" && m.is_error === false && !!text.trim() && !this.assistantError,
        subtype: typeof m.subtype === "string" ? m.subtype : "unknown", detail: (text.trim() || errors[0] || "").trim(), text };
      this.assistantError = false;
    }
  }

  finish(): void {
    this.flush();
    if (!this.terminal) throw new ClaudeRunError("Claude ended without a result");
    if (!this.terminal.ok) {
      // CLI-reported result text (usage limits, login prompts) is what the user needs to act on.
      const detail = this.terminal.detail.length > 300 ? `${this.terminal.detail.slice(0, 300)}…` : this.terminal.detail;
      throw new ClaudeRunError(`Claude run failed (${this.terminal.subtype})${detail ? `: ${detail}` : ""}`);
    }
    // Some SDK responses contain result text without an assistant envelope.
    if (this.terminal.text !== this.finalText) {
      this.message({ role: "assistant", content: [{ type: "text", text: this.terminal.text }], timestamp: Date.now(), stopReason: "stop" });
    }
  }
}

/**
 * Prompt stream for one run: the task first, then steering messages. It stays open until
 * every message sent has been answered by a result, so a steer is never cut off mid-run.
 */
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private pending = new Set<string>();
  private wake?: () => void;
  private closed = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleMs: number;
  private yielded = 0;
  onClose?: () => void;
  /** Called with each steer's text when the SDK takes it (not for the task itself). */
  onTaken?: (text: string) => void;
  constructor(idleMs = 15_000) { this.idleMs = idleMs; }

  /** Returns false once the run is finishing; a late steer is a no-op, as for Pi children. */
  push(text: string, priority?: "next" | "later"): boolean {
    if (this.closed) return false;
    const uuid = randomUUID();
    this.pending.add(uuid);
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage["uuid"], ...(priority ? { priority } : {}) });
    this.wake?.();
    return true;
  }

  /**
   * Work on a turn means the idle fallback must not end the input. Bookkeeping the CLI sends
   * around every turn (command_lifecycle queued/completed, post_turn_summary, rate limits)
   * is not work, or a send the CLI never runs would keep the run alive forever.
   */
  activity(message?: Block) {
    const working = !message || ["assistant", "user", "stream_event"].includes(message.type)
      || (message.type === "command_lifecycle" && message.state === "started");
    if (!working) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  settle(result: Block) {
    const consumed: unknown[] | undefined = Array.isArray(result.user_message_uuids) ? result.user_message_uuids
      : typeof result.user_message_uuid === "string" ? [result.user_message_uuid] : undefined;
    const queued = typeof result.queued_turn_count === "number" ? result.queued_turn_count : 0;
    if (consumed) {
      for (const id of consumed) if (typeof id === "string") this.pending.delete(id);
    } else if (queued === 0) {
      this.pending.clear(); // Older CLIs echo no uuids.
    }
    if (this.pending.size === 0 && queued === 0) return this.close();
    // A send the CLI never answers must not keep the run alive forever.
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.activity();
    this.wake?.();
    this.onClose?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        if (this.yielded++ > 0 && typeof next.message.content === "string") this.onTaken?.(next.message.content);
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/** Same line protocol as control-ext.js: {"type":"steer"|"followUp","message":"..."}. */
export function listenForSteering(socketPath: string, channel: InputChannel): Server {
  const server = createServer(conn => {
    let buffer = "";
    conn.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) { conn.destroy(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let command: Block;
        try { command = JSON.parse(line); } catch { continue; }
        if (!command || typeof command.message !== "string" || !command.message.trim()) continue;
        // steer folds into the running turn between tool rounds; followUp waits for the turn to end.
        channel.push(command.message, command.type === "followUp" ? "later" : "next");
      }
    });
    conn.on("error", () => {});
  });
  // A bind failure leaves the run unsteerable; the parent reports that when a steer fails.
  server.on("error", () => {});
  server.listen(socketPath);
  return server;
}

/** Injectable SDK boundary: offline tests never import or call the real query implementation. */
export async function runClaude(config: ClaudeRunConfig, query: QueryFactory, emit: (event: RunnerEvent) => void,
  controller = new AbortController(), env = process.env): Promise<number> {
  let handle: QueryHandle | undefined;
  let server: Server | undefined;
  let skillPlugin: string | undefined;
  let stage = "startup";
  let failure: string | undefined;
  const bridge = new ClaudeEventBridge(emit);
  const input = new InputChannel();
  input.onClose = () => server?.close();
  input.onTaken = text => bridge.queueEcho(text);
  let code = 1;
  const cancel = () => { input.close(); try { handle?.close(); } catch { /* teardown will report failure */ } };
  controller.signal.addEventListener("abort", cancel, { once: true });
  try {
    skillPlugin = writeSkillPlugin(config.skills);
    const options = queryOptions(config, controller, env, skillPlugin);
    if (controller.signal.aborted) throw new Error("Cancelled before startup");
    input.push(config.task);
    handle = query({ prompt: input, options });
    if (config.controlSocket) server = listenForSteering(config.controlSocket, input);
    emit({ type: "message_end", message: { role: "user", content: `Task: ${config.task}`, timestamp: Date.now() } });
    stage = "stream";
    for await (const message of handle) {
      if (controller.signal.aborted) break;
      const m = message as unknown as Block;
      input.activity(m);
      bridge.accept(message);
      if (m.type === "result" && !m.parent_tool_use_id) input.settle(m);
    }
    if (!controller.signal.aborted) { bridge.finish(); code = 0; }
  } catch (error) {
    // Raw SDK errors may carry environment details; only vetted messages reach the transcript.
    if (error instanceof ClaudeRunError) failure = error.message;
    code = 1;
  } finally {
    input.close();
    server?.close();
    try { bridge.flush(); } catch { code = 1; }
    try { handle?.close(); } catch { code = 1; stage = "cleanup"; }
    controller.signal.removeEventListener("abort", cancel);
    // Removes the symlinks only, never the skills they point to.
    if (skillPlugin) rmSync(skillPlugin, { recursive: true, force: true });
  }
  if (controller.signal.aborted) code = 130;
  emit({ type: "claude_run_result", status: code === 0 ? "completed" : code === 130 ? "stopped" : "failed",
    ...(code === 1 ? { errorMessage: failure ?? `Claude SDK ${stage} failed; verify the executable, subscription login, permissions and quota manually.` } : {}) });
  return code;
}
