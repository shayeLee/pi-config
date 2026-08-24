/**
 * Warp Notify Extension
 *
 * OSC 777 is emitted only in TUI mode. Other modes use Pi's UI notification
 * when one exists, and otherwise stay silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function osc777Field(value: string): string {
	// Reject C0/C1 controls (including BEL), ESC, ST (0x9c), and OSC field
	// separators so dynamic text cannot terminate or inject another notification.
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u001b;]/g, " ").replace(/\s+/g, " ").trim();
}

function notify(ctx: { mode: string; hasUI: boolean; ui: { notify(message: string, level: "info"): void } }, title: string, body: string): void {
	const safeTitle = osc777Field(title);
	const safeBody = osc777Field(body);
	if (ctx.mode === "tui") {
		process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
	} else if (ctx.hasUI) {
		ctx.ui.notify(`${safeTitle}: ${safeBody}`, "info");
	}
}

// Tool names are only a heuristic: an extension cannot tell from this event
// whether a tool really prompts. Keep the allowlist and conservative separators
// to avoid false positives such as "task" or "mask"; custom tools with opaque
// names may still be missed.
const INTERACTIVE_TOOLS = new Set(["question", "questionnaire", "ask", "ask_user", "confirm"]);

function isInteractiveTool(toolName: string): boolean {
	const name = toolName.toLowerCase();
	if (INTERACTIVE_TOOLS.has(name)) return true;
	return /(?:^|[_-])(question|ask|confirm)(?:$|[_-])/.test(name);
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		notify(ctx, "Pi", "任务完成，等待输入");
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (isInteractiveTool(event.toolName)) {
			notify(ctx, "Pi 需要你的输入", `模型正在请求：${event.toolName}，请返回 Warp 查看`);
		}
	});
}
