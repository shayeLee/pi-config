/**
 * Path Scope Extension (permission gate)
 *
 * Covers the built-in file tools: read / write / edit / grep / find / ls.
 *
 *   - Path inside the project working directory  -> allowed (no prompt)
 *   - Path outside the project                     -> ask the user to allow;
 *                                                      denied if declined
 *   - bash is intentionally NOT restricted here: it is handled by the
 *     separate `sandbox` extension (OS-level sandbox-exec), to avoid overlap.
 *
 * Once a path is approved, it stays approved for the rest of the session.
 *
 * Controls (environment variables):
 *   PATH_SCOPE=0                 -> disable this extension entirely
 *   PATH_SCOPE_EXTRA=/abs/a,/abs/b  -> additional roots treated as "inside"
 *   PATH_SCOPE_NOUI=allow        -> in non-interactive mode, allow out-of-project
 *                                   paths without prompting (default: deny)
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isEnabled(): boolean {
	return process.env.PATH_SCOPE !== "0";
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function resolveTarget(cwd: string, p: string): string {
	const expanded = expandHome(p.trim());
	if (path.isAbsolute(expanded)) return path.normalize(expanded);
	return path.resolve(cwd, expanded);
}

function insideAny(roots: string[], target: string): boolean {
	for (const root of roots) {
		const rel = path.relative(root, target);
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
	}
	return false;
}

function extraRoots(): string[] {
	const raw = process.env.PATH_SCOPE_EXTRA;
	return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// Paths approved for the current session (keyed by resolved target).
const approved = new Set<string>();

export default function (pi: ExtensionAPI) {
	if (!isEnabled()) return;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") return undefined;

		const raw = (event.input as { path?: unknown }).path;
		if (typeof raw !== "string" || !raw.trim()) return undefined;

		const root = ctx.cwd;
		const target = resolveTarget(root, raw);
		const roots = [root, ...extraRoots()];

		// Inside the project -> allow.
		if (insideAny(roots, target)) return undefined;

		// Already approved this session -> allow.
		if (approved.has(target)) return undefined;

		const kind = event.toolName === "read" || event.toolName === "grep" || event.toolName === "ls"
			? "读取"
			: "访问/写入";
		const relative = path.relative(root, target).replace(/^\.\.+[/\\]?/, "");

		// Non-interactive: deny by default, unless explicitly allowed.
		if (!ctx.hasUI) {
			if (process.env.PATH_SCOPE_NOUI === "allow") {
				approved.add(target);
				return undefined;
			}
			return { block: true, reason: `项目外路径，无交互环境默认拒绝${kind}: ${target}` };
		}

		const ok = await ctx.ui.confirm(
			`${event.toolName} 想要${kind}项目之外的路径:\n\n  ${target}\n\n（相对项目: ${relative || "(同根)"}）\n\n允许吗？`,
			root,
		);
		if (ok) {
			approved.add(target);
			return undefined;
		}
		return { block: true, reason: `用户拒绝${kind}项目外路径: ${target}` };
	});
}
