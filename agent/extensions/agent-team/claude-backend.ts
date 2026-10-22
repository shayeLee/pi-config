import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { subscriptionEnvironment } from "./claude-sdk/environment.mjs";

export type ClaudeRole = {
  backend?: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  thinkingLevel?: string;
  claudePermissionMode?: string;
  claudeEffort?: string;
};

export function agentBackend(agent: ClaudeRole): "pi" | "claude" {
  const backend = agent.backend ?? "pi";
  if (backend !== "pi" && backend !== "claude") throw new Error(`Unsupported subagent backend: ${backend}`);
  return backend;
}

export type ContextFile = { path: string; content: string };

/**
 * With project settings on, Claude Code itself loads AGENTS.md and CLAUDE.md from the cwd and
 * its ancestors. Only the rest of what Pi would load (its global agentDir file, AGENTS.override.md)
 * needs to be passed on, or Claude would read the same rules twice.
 */
export function contextClaudeLacks(contextFiles: ContextFile[], cwd: string) {
  return contextFiles.filter(({ path }) => {
    const native = /^(AGENTS|CLAUDE)\.md$/i.test(basename(path));
    const fromCwdOrAncestor = !relative(dirname(path), cwd).startsWith("..");
    return !(native && fromCwdOrAncestor);
  });
}

/** Rendered the way Pi renders project context for its own children. */
export function withProjectContext(systemPrompt: string, contextFiles: ContextFile[] = []) {
  if (contextFiles.length === 0) return systemPrompt;
  return [systemPrompt, "Project-specific instructions and guidelines:",
    ...contextFiles.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`)].join("\n\n");
}

export function claudeInvocation(agent: ClaudeRole, task: string, cwd: string, env = process.env,
  extras: { controlSocket?: string; contextFiles?: ContextFile[]; skills?: { name: string; path: string }[] } = {}) {
  if (agent.thinkingLevel) throw new Error("Claude roles use claudeEffort, not Pi thinking");
  const executable = env.PI_CLAUDE_EXECUTABLE ?? join(homedir(), ".local", "bin", "claude");
  if (!isAbsolute(executable)) throw new Error("PI_CLAUDE_EXECUTABLE must be an absolute path");
  return {
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), "claude-sdk", "worker.mjs")],
    env: subscriptionEnvironment(env),
    input: JSON.stringify({ task, cwd, executable, model: agent.model,
      systemPrompt: withProjectContext(agent.systemPrompt, contextClaudeLacks(extras.contextFiles ?? [], cwd)),
      tools: agent.tools, permissionMode: agent.claudePermissionMode, effort: agent.claudeEffort,
      controlSocket: extras.controlSocket, skills: extras.skills }),
  };
}

/** Independent global configuration; Pi Markdown overrides never apply to it. */
export function loadClaudeWorker(home = homedir()) {
  const filePath = join(home, ".pi", "agent", "claude-agents", "claude-worker.json");
  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const fail = (reason: string): never => { throw new Error(`Invalid Claude worker configuration: ${filePath}: ${reason}`); };
  let value: any;
  try { value = JSON.parse(raw); } catch { return fail("not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected a JSON object");
  const keys = new Set(["name", "description", "systemPrompt", "model", "tools", "permissionMode", "effort"]);
  const unknown = Object.keys(value).filter(key => !keys.has(key));
  if (unknown.length) return fail(`unknown field ${unknown.join(", ")}`);
  if (value.name !== "claude-worker") return fail(`name must be "claude-worker"`);
  if (typeof value.description !== "string" || !value.description.trim()) return fail("description must be a non-empty string");
  if (typeof value.systemPrompt !== "string" || !value.systemPrompt.trim()) return fail("systemPrompt must be a prompt file path");
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) return fail("model must be a non-empty string");
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool: unknown) => typeof tool !== "string" || !tool.trim()))) return fail("tools must be an array of tool names");
  if (value.permissionMode !== undefined && !["dontAsk", "acceptEdits", "plan"].includes(value.permissionMode)) return fail("permissionMode must be dontAsk, acceptEdits or plan");
  if (value.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(value.effort)) return fail("effort must be low, medium, high, xhigh or max");
  const promptPath = resolve(dirname(filePath), value.systemPrompt);
  let systemPrompt: string;
  try { systemPrompt = readFileSync(promptPath, "utf8"); }
  catch { throw new Error(`Cannot read Claude systemPrompt file: ${promptPath}`); }
  if (!systemPrompt.trim()) throw new Error(`Claude systemPrompt file is empty: ${promptPath}`);
  return { name: value.name as string, description: value.description as string, systemPrompt,
    backend: "claude", tools: value.tools as string[] | undefined, model: value.model as string | undefined,
    claudePermissionMode: value.permissionMode as string | undefined, claudeEffort: value.effort as string | undefined,
    source: "user" as const, filePath };
}
