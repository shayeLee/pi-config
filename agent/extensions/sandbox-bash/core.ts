/**
 * Sandbox Bash — pure core logic (profile generation, no Pi/spawn dependency).
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested with `node --test` without loading the Pi runtime. The extension entry
 * point (index.ts) imports from this module.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface SandboxBashConfig {
	enabled?: boolean;
	allowWrite?: string[];
}

export type ConfigValidation =
	| { config: SandboxBashConfig }
	| { error: string };

/** Pure schema validation. */
export function validateSandboxBashConfig(value: unknown): ConfigValidation {
	if (value === undefined) return { config: {} };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { error: "expected a JSON object" };
	}

	const allowedKeys = new Set(["enabled", "allowWrite"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) return { error: `unknown property ${JSON.stringify(key)}` };
	}

	const candidate = value as Record<string, unknown>;
	if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
		return { error: "enabled must be a boolean" };
	}
	const arr = candidate.allowWrite;
	if (arr !== undefined && (!Array.isArray(arr) || !arr.every((s) => typeof s === "string" && s.trim().length > 0))) {
		return { error: "allowWrite must be an array of non-empty strings" };
	}

	const config: SandboxBashConfig = {};
	if (candidate.enabled !== undefined) config.enabled = candidate.enabled as boolean;
	if (candidate.allowWrite !== undefined) config.allowWrite = candidate.allowWrite as string[];
	return { config };
}

/**
 * Escape a path for inclusion inside a double-quoted Seatbelt profile literal.
 * Rejects control characters that could terminate the string and inject extra
 * profile clauses.
 */
export function escapeProfilePath(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/[\u0000-\u001f]/g, " ");
}

/** Expand a `~/`-style config path to an absolute path. */
export function normalizeConfigPath(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return trimmed;
}

/** Resolve a config path to a canonical form (symlinks resolved best-effort). */
export function canonicalPath(value: string): string | undefined {
	const expanded = normalizeConfigPath(value);
	const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

/** realpath, falling back to the input when it cannot be resolved. */
function realpathOrSelf(value: string): string {
	try {
		return realpathSync(value);
	} catch {
		return value;
	}
}

/**
 * Build a Seatbelt profile that restricts WRITE only:
 *   - write: deny everything, then allow only the authorized roots, plus the
 *            /dev/null and /dev/zero device nodes (git and most tools need
 *            them; devfs nodes must be re-allowed by `literal`, not `subpath`).
 *   - read / exec / network: allowed (allow default).
 *
 * Authorized write roots = cwd + extraRoots (path-scope roots) + /tmp +
 * /private/tmp + the platform temp dir (os.tmpdir(), e.g. /var/folders on
 * macOS, which differs from /tmp).
 */
export function buildProfile(cwd: string, extraRoots: string[]): string {
	const tempDir = tmpdir();
	const authorized = [
		canonicalPath(cwd),
		"/tmp",
		"/private/tmp",
		// Seatbelt subpath matches literally without resolving symlinks, so the
		// temp dir must be listed under BOTH its raw path (/var/folders/…) and
		// its realpath (/private/var/folders/…), like /tmp and /private/tmp.
		tempDir,
		realpathOrSelf(tempDir),
		...extraRoots.map((entry) => canonicalPath(entry)),
	].filter((p): p is string => Boolean(p));
	const unique = [...new Set(authorized)];

	const parts: string[] = [
		"(version 1)",
		"(allow default)",
		// writes: allowlist only
		"(deny file-write*)",
		// device nodes: deny file-write* would also block /dev/null, which breaks
		// git and countless tools. Devfs nodes must be re-allowed by literal
		// (subpath cannot match them) and with file-write-data (not file-write*).
		'(allow file-write-data (literal "/dev/null") (literal "/dev/zero"))',
		...unique.map((p) => `(allow file-write* (subpath "${escapeProfilePath(p)}"))`),
	];
	return parts.join("");
}