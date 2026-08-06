/**
 * TPS (Tokens Per Second) Extension
 *
 * Tracks assistant output token rate during streaming.
 * Shows estimated ~TPS while streaming (throttled to 250ms),
 * then precise TPS on message_end using final usage.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHARS_PER_TOKEN = 4;
const THROTTLE_MS = 250;

export default function (pi: ExtensionAPI) {
	let firstDeltaAt: number | undefined;
	let deltaChars = 0;
	let lastRefreshAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function reset() {
		firstDeltaAt = undefined;
		deltaChars = 0;
		lastRefreshAt = 0;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function estimatedTPS(): number | undefined {
		if (firstDeltaAt === undefined) return undefined;
		const elapsed = Date.now() - firstDeltaAt;
		if (elapsed <= 0) return undefined;
		return Math.round((deltaChars / CHARS_PER_TOKEN) / (elapsed / 1000));
	}

	function showEstimated(ctx: ExtensionContext) {
		if (timer !== undefined) return; // already scheduled
		const now = Date.now();
		const delay = Math.max(0, THROTTLE_MS - (now - lastRefreshAt));
		timer = setTimeout(() => {
			timer = undefined;
			lastRefreshAt = Date.now();
			const tps = estimatedTPS();
			if (tps !== undefined && tps > 0) {
				ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", ` ~TPS ${tps} tok/s`));
			}
		}, delay);
	}

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		reset();
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const evt = event.assistantMessageEvent;
		if (evt.type !== "text_delta" && evt.type !== "thinking_delta" && evt.type !== "toolcall_delta") return;

		// All three delta types have a `delta: string` field
		const len = (evt as { delta: string }).delta.length;
		if (len <= 0) return;

		if (firstDeltaAt === undefined) {
			firstDeltaAt = Date.now();
		}

		deltaChars += len;
		showEstimated(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const theme = ctx.ui.theme;

		// Clear any pending throttled refresh
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}

		const outputTokens = event.message.usage?.output ?? 0;

		if (firstDeltaAt === undefined || outputTokens <= 0) {
			ctx.ui.setStatus("tps", theme.fg("dim", " TPS —"));
			reset();
			return;
		}

		const elapsedMs = Date.now() - firstDeltaAt;
		reset();

		if (elapsedMs <= 0) {
			ctx.ui.setStatus("tps", theme.fg("dim", " TPS —"));
			return;
		}

		const tps = Math.round(outputTokens / (elapsedMs / 1000));
		ctx.ui.setStatus("tps", theme.fg("dim", ` TPS ${tps} tok/s`));
	});
}
