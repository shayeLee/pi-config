/**
 * Subagent control channel (B-s stage).
 *
 * Injected into every subagent process with `-e <this file>`. It opens a local
 * socket and turns incoming commands into user messages for the running
 * subagent, which is what lets the main agent steer a subagent mid-run.
 *
 * Why `--mode json` and not RPC:
 *   JSON mode keeps `ctx.hasUI === false`, so extension dialogs stay inert
 *   no-ops. In RPC mode `hasUI` is true and a dialog request with no client
 *   response makes the process exit 0 during startup (the event loop drains and
 *   fires `beforeExit`), which is a silent failure that is very hard to debug.
 *
 * Delivery semantics: `steer` is delivered at the next turn boundary (after the
 * current assistant turn finishes its tool calls, before the next LLM call), NOT
 * as an immediate interrupt. Use process termination for an immediate stop.
 *
 * Startup gate: the socket is listening from `session_start`, but CLI's own task
 * prompt is not submitted until every extension's `session_start` handler has
 * settled (`prompt(initialMessage)` in print mode). A command arriving in that
 * window would find the session idle, so `deliverAs` would be ignored and the
 * steer would start a turn of its own — and the CLI's task prompt would then
 * fail with "Agent is already processing", killing the run before it produced
 * anything. Commands are therefore buffered until the first `agent_start`
 * proves the task turn owns the session, then flushed in arrival order.
 *
 * This file is plain JavaScript on purpose: it is loaded by the child `pi`
 * process through the extension loader without a build step.
 */

import * as net from "node:net";

export default function (pi) {
	const socketPath = process.env.SUBAGENT_CONTROL_SOCKET;
	let server = null;
	let taskTurnStarted = false;
	/** Commands that arrived before the task turn claimed the session. */
	const pendingCommands = [];

	const closeServer = () => {
		if (!server) return;
		try {
			server.close();
		} catch {
			/* already closed */
		}
		server = null;
	};

	const deliver = (command) => {
		const deliverAs = command.type === "followUp" ? "followUp" : "steer";
		try {
			pi.sendUserMessage(command.message, { deliverAs });
		} catch {
			// The session may already be disposed (subagent finished). A late
			// steer is a no-op, not an error the caller needs to handle.
		}
	};

	const flushPending = () => {
		const queued = pendingCommands.splice(0);
		for (const command of queued) deliver(command);
	};

	// The task turn is now in flight, so `deliverAs` takes effect and a steer
	// queues behind the current turn instead of starting one of its own.
	pi.on("agent_start", () => {
		if (taskTurnStarted) return;
		taskTurnStarted = true;
		flushPending();
	});

	// A listening `net.Server` keeps the Node event loop alive. Without this the
	// subagent would never exit and the parent's await on the subprocess would
	// hang forever. Close the listener as soon as the agent settles.
	pi.on("agent_settled", closeServer);
	// Session-scoped cleanup: the socket belongs to the session, not the process.
	pi.on("session_shutdown", closeServer);

	pi.on("session_start", async (_event, ctx) => {
		if (!socketPath) return;

		server = net.createServer((conn) => {
			let buffer = "";
			conn.on("data", (chunk) => {
				buffer += chunk.toString();
				let index;
				while ((index = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (!line.trim()) continue;
					let command;
					try {
						command = JSON.parse(line);
					} catch {
						continue;
					}
					if (!command || typeof command.message !== "string" || !command.message) continue;
					if (!taskTurnStarted) {
						// Buffer until the task turn starts; see the startup gate notes above.
						pendingCommands.push(command);
						continue;
					}
					deliver(command);
				}
			});
			conn.on("error", () => {
				/* client went away; nothing to clean up */
			});
		});

		server.on("error", () => {
			// Binding can fail if a stale socket file exists; the parent treats a
			// missing control channel as "steering unavailable" rather than an error.
		});

		server.listen(socketPath);
	});
}
