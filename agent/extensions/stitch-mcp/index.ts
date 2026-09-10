import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";

const ENDPOINT = new URL("https://stitch.googleapis.com/mcp");
const API_KEY_ENV = "STITCH_API_KEY";
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 600_000;
const TOOL_PREFIX = "stitch_";

// Stitch currently returns output schemas whose local $refs are not always
// self-contained. Pi validates arguments before dispatching, so SDK-side
// validation of server-advertised output schemas is intentionally skipped.
const permissiveJsonSchemaValidator = {
  getValidator: <T>() => (input: unknown) => ({
    valid: true as const,
    data: input as T,
    errorMessage: undefined,
  }),
};

function apiKey(): string | undefined {
  return process.env[API_KEY_ENV]?.trim() || undefined;
}

function callTimeout(): number {
  const value = Number(process.env.STITCH_MCP_TIMEOUT_MS ?? DEFAULT_CALL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CALL_TIMEOUT_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolName(name: string): string {
  return `${TOOL_PREFIX}${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * MCP tools publish regular JSON Schema. Pi accepts it, but provider-specific
 * x-* annotations and local $defs add noise and are not needed for invocation.
 */
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const root = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  const defs = root.$defs && typeof root.$defs === "object"
    ? root.$defs as Record<string, unknown>
    : {};

  const visit = (value: unknown, resolving: string[] = []): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, resolving));
    if (!value || typeof value !== "object") return value;

    const node = value as Record<string, unknown>;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
      const name = node.$ref.slice("#/$defs/".length);
      const target = defs[name];
      const rest = { ...node };
      delete rest.$ref;
      if (!target || resolving.includes(name)) {
        return { type: "object", additionalProperties: true, ...visit(rest, resolving) };
      }
      const resolved = visit(target, [...resolving, name]);
      return { ...(resolved as Record<string, unknown>), ...(visit(rest, resolving) as Record<string, unknown>) };
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (
        key === "$schema" ||
        key === "$id" ||
        key === "$defs" ||
        key === "$comment" ||
        key.startsWith("x-")
      ) continue;
      output[key] = visit(child, resolving);
    }
    return output;
  };

  const sanitized = visit(root) as Record<string, unknown>;
  return sanitized.type ? sanitized : { type: "object", ...sanitized };
}

function summarizeDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 240);
}

function toPiResult(result: {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}) {
  const text: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      text.push(item.text);
    } else if (item.type === "image" && typeof item.data === "string") {
      images.push({
        type: "image",
        data: item.data,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
      });
    } else if (typeof item.type === "string") {
      text.push(`[Stitch returned unsupported ${item.type} content]`);
    }
  }

  if (result.structuredContent !== undefined) {
    text.push(JSON.stringify(result.structuredContent, null, 2));
  }

  const truncation = truncateHead(text.join("\n\n") || "[Stitch returned no content]", {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const output = truncation.truncated
    ? `${truncation.content}\n\n[Stitch output truncated to ${DEFAULT_MAX_BYTES / 1024}KB or ${DEFAULT_MAX_LINES} lines.]`
    : truncation.content;

  if (result.isError) throw new Error(output);

  return {
    content: [{ type: "text" as const, text: output }, ...images],
    details: { truncated: truncation.truncated },
  };
}

export default function (pi: ExtensionAPI) {
  let clientPromise: Promise<Client> | undefined;
  const registeredTools = new Set<string>();

  const connect = async (): Promise<Client> => {
    const key = apiKey();
    if (!key) throw new Error(`${API_KEY_ENV} is not set`);

    const transport = new StreamableHTTPClientTransport(ENDPOINT, {
      requestInit: { headers: { "X-Goog-Api-Key": key } },
    });
    const client = new Client(
      { name: "pi-stitch-mcp", version: "0.1.0" },
      { capabilities: {}, jsonSchemaValidator: permissiveJsonSchemaValidator },
    );

    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  };

  const getClient = (): Promise<Client> => {
    if (!clientPromise) {
      clientPromise = connect().catch((error) => {
        clientPromise = undefined;
        throw error;
      });
    }
    return clientPromise;
  };

  const registerTool = (remoteTool: Tool) => {
    const localName = toolName(remoteTool.name);
    if (registeredTools.has(localName)) return;
    registeredTools.add(localName);

    const description = summarizeDescription(remoteTool.description ?? remoteTool.name);
    const destructive = remoteTool.annotations?.destructiveHint === true;

    pi.registerTool({
      name: localName,
      label: `Stitch: ${remoteTool.annotations?.title ?? remoteTool.name}`,
      description: `Google Stitch MCP — ${description}`,
      promptSnippet: `Use Google Stitch to ${description}`,
      promptGuidelines: [
        `Use ${localName} only for Google Stitch projects and designs.`,
        ...(destructive
          ? [`${localName} can modify or delete remote Stitch data; confirm the intended action and target first.`]
          : []),
      ],
      parameters: sanitizeSchema(remoteTool.inputSchema) as TSchema,
      constrainedSampling: false,
      executionMode: destructive ? "sequential" : "parallel",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (destructive && ctx.hasUI) {
          const approved = await ctx.ui.confirm(
            "Google Stitch 修改确认",
            `允许执行 Stitch 操作 “${remoteTool.name}” 吗？它可能会修改或删除远程设计数据。`,
            { signal },
          );
          if (!approved) throw new Error("Stitch operation cancelled by user");
        }

        try {
          // Do not use client.callTool(): Stitch declares outputSchema for its
          // tools, while some responses omit structuredContent.
          const result = await getClient().then((client) => client.request(
            {
              method: "tools/call",
              params: { name: remoteTool.name, arguments: params },
            },
            CallToolResultSchema,
            { timeout: callTimeout(), resetTimeoutOnProgress: true, signal },
          ));
          return toPiResult(result);
        } catch (error) {
          clientPromise = undefined;
          throw new Error(`Stitch MCP ${remoteTool.name} failed: ${errorMessage(error)}`);
        }
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!apiKey()) {
      ctx.ui.notify(`Stitch MCP 未启用：请设置环境变量 ${API_KEY_ENV}，然后执行 /reload。`, "warning");
      return;
    }

    try {
      const client = await getClient();
      const { tools } = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      for (const remoteTool of tools) registerTool(remoteTool);
      ctx.ui.notify(`Stitch MCP 已加载 ${tools.length} 个工具。`, "info");
    } catch (error) {
      ctx.ui.notify(`Stitch MCP 加载失败：${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    const existing = clientPromise;
    clientPromise = undefined;
    registeredTools.clear();
    if (!existing) return;
    try {
      await (await existing).close();
    } catch {
      // Closing a failed or already closed Streamable HTTP client is harmless.
    }
  });
}
