/**
 * Shared pure logic for restricting the built-in file tools from sandbox-bash.json:
 *
 *   - denyRead:    gates the built-in read / grep / find / ls tools. The Seatbelt
 *                  profile already denies these paths for *bash*; this module gives
 *                  the built-in tools the same deny list, implemented in path-scope.
 *   - sensitive write protection: the pi config/credential files the write/edit
 *                  tools must never touch, regardless of cwd / extraRoots / approval.
 *
 * No Pi runtime import (Node built-ins + ./core for the sandbox-bash schema), so
 * everything here can be exercised offline with `node --test`.
 *
 * Path resolution matches the built-in file tools exactly (resolveToCwd), then
 * canonicalizes — see resolveLikeBuiltin / resolveToolTarget. Deny roots and
 * read targets are compared in canonical (symlink-resolved) form.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSandboxBashConfig, canonicalDenyRoots } from "./core.ts";

/** Built-in tools that read file content/metadata and are gated by denyRead. */
export const DENY_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Built-in tools that write/rewrite a file identified by a `path` input. */
export const WRITE_TOOLS = new Set(["write", "edit"]);
/**
 * Tools whose `path` input is a *recursive search root*: if the root either
 * lies inside a deny root or CONTAINS a deny root, the search must be blocked
 * (recursion would enter the sensitive root). read/ls only check the direct
 * target.
 */
export const SEARCH_TOOLS = new Set(["grep", "find"]);
/** Tools that default a missing `path` to the session cwd (like the built-ins). */
export const CWD_DEFAULT_TOOLS = new Set(["grep", "find", "ls"]);

/**
 * Pi config/credential files that must never be written by the write/edit
 * tools, independent of the session cwd. The sandbox-bash Seatbelt profile
 * denies the same files (via its `sensitiveFiles` argument), and path-scope
 * blocks the write/edit tools on them directly.
 */
export const SENSITIVE_FILE_NAMES = [
	"auth.json",
	"oauth.json",
	"trust.json",
	"settings.json",
	"models.json",
	"models-store.json",
	"path-scope.json",
	"sandbox-bash.json",
	"bash-guard.json",
] as const;

/**
 * Absolute paths of the sensitive config files, derived from the agent dir
 * (getAgentDir()) and, for the same basenames, its parent — both levels hold
 * pi config/credential files (e.g. ~/.pi/agent/settings.json and
 * ~/.pi/models.json).
 */
export function sensitiveWriteFiles(agentDir: string): string[] {
	const parent = path.dirname(agentDir);
	return SENSITIVE_FILE_NAMES.flatMap((name) => [
		path.join(agentDir, name),
		path.join(parent, name),
	]);
}

const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/** Mirrors the built-in tools' normalizePath() Windows shell path handling. */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * Resolve a built-in file tool's `path` input EXACTLY like the built-ins do
 * (resolveToCwd): collapse unicode spaces, strip a leading `@`, expand `~`,
 * decode file: URLs, then path.resolve() against the session cwd. Symlinks and
 * the filesystem are NOT touched here — the built-in tools resolve to an
 * absolute path string and open it, so the deny gate must judge the same
 * absolute form, then canonicalize (see resolveToolTarget).
 */
export function resolveLikeBuiltin(input: string, cwd: string): string {
	let normalized = input;
	normalized = normalized.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (process.platform === "win32") normalized = normalizeWindowsShellPath(normalized);
	const home = os.homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return path.join(home, normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
	return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

/**
 * Resolve a symlinked ancestor even when the suffix does not exist yet; for a
 * not-yet-existing path the nearest existing ancestor is resolved and the
 * missing suffix appended. An existing but unresolvable path (broken symlink,
 * unreadable ancestor, realpath failure) returns undefined — callers must fail
 * closed rather than guess. A purely lexical fallback would let
 * `link/newsub` (link -> a deny root) evade a deny, so no fallback is used.
 */
export function canonicalizePath(input: string): string | undefined {
	const resolved = path.resolve(input);
	let candidate = resolved;
	const missingSuffix: string[] = [];

	while (true) {
		try {
			const canonical = fs.realpathSync(candidate);
			return path.join(canonical, ...missingSuffix);
		} catch {
			try {
				fs.lstatSync(candidate);
				return undefined;
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
					return undefined;
				}
			}
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) return undefined;
		missingSuffix.unshift(path.basename(candidate));
		candidate = parent;
	}
}

/**
 * Resolve a built-in file tool path input (resolveToCwd semantics) and then
 * canonicalize it. undefined means the target cannot be canonicalized; the
 * optional denyRead blacklist does not make that unrelated target unreadable.
 */
export function resolveToolTarget(input: string, cwd: string): string | undefined {
	return canonicalizePath(resolveLikeBuiltin(input, cwd));
}

/**
 * Canonical denyRead roots for the built-in tools, with per-entry isolation.
 * Each entry is resolved exactly like the built-ins (resolveToCwd) and then
 * canonicalized; an illegal file: URL (fileURLToPath throws), an
 * unresolvable/broken entry, or a canonicalize throw is skipped via the
 * shared canonicalDenyRoots helper and optionally reported — it never throws
 * and never drops the other entries. Resolution itself stays built-in
 * specific (it must mirror resolveToCwd); only the failure handling is
 * shared with the Seatbelt side, so coverage never shifts when reused.
 */
export function canonicalizeDenyEntries(
	entries: string[],
	cwd: string,
	onSkip?: (entry: string, reason: string) => void,
): string[] {
	return canonicalDenyRoots(
		entries,
		(entry) => canonicalizePath(resolveLikeBuiltin(entry, cwd)),
		onSkip,
	);
}

function isEnoentCode(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Dangling-symlink-aware canonicalization for write/edit protection.
 *
 * canonicalizePath returns undefined for an existing symlink whose target
 * does not exist yet (e.g. /tmp/link -> <sensitive>/auth.json where
 * auth.json is missing): realpath fails and lstat succeeds, so the caller
 * fails closed to undefined. For the optional denyRead blacklist that
 * undefined means "not denied" (correct — fail open for a blacklist), but
 * for sensitive write protection it would be a bypass: a write through the
 * dangling link lands in the sensitive file, yet the exact-match check sees
 * undefined and allows it.
 *
 * This follows a final (or intermediate) dangling symlink via readlink and
 * then canonicalizes the link target plus any missing suffix, so a dangling
 * link to a not-yet-existing sensitive config file still resolves to that
 * file. Only lstat/readlink/realpath are used — file contents are never
 * read. Non-symlink unresolvable paths still return undefined.
 */
export function canonicalizeForWriteTarget(inputAbsolute: string): string | undefined {
	let candidate = path.resolve(inputAbsolute);
	const missingSuffix: string[] = [];
	const seen = new Set<string>();
	for (let iter = 0; iter < 100; iter++) {
		try {
			return path.join(fs.realpathSync(candidate), ...missingSuffix);
		} catch {
			// fall through to lstat/readlink handling below
		}
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(candidate);
		} catch (error) {
			if (!isEnoentCode(error)) return undefined;
			const parent = path.dirname(candidate);
			if (parent === candidate) return undefined;
			missingSuffix.unshift(path.basename(candidate));
			candidate = parent;
			continue;
		}
		// Exists but realpath failed: only a symlink can be followed safely.
		if (!stat.isSymbolicLink()) return undefined;
		if (seen.has(candidate)) return undefined;
		seen.add(candidate);
		let link: string;
		try {
			link = fs.readlinkSync(candidate);
		} catch {
			return undefined;
		}
		candidate = path.resolve(path.dirname(candidate), link);
	}
	return undefined;
}

/**
 * Absolute sensitive write forms derived from the agent dir (and its parent).
 * The input agent dir is forced absolute via path.resolve so a relative
 * getAgentDir() can never silently derive the wrong directory; both the raw
 * absolute form and the canonical form are kept so symlinked agent-dir
 * spellings match. No file contents are read.
 */
export function buildSensitiveWriteForms(agentDir: string): string[] {
	const absoluteAgentDir = path.resolve(agentDir);
	return [...new Set(
		sensitiveWriteFiles(absoluteAgentDir).flatMap((file) => {
			const forms = [file];
			try {
				const canonical = canonicalizePath(file);
				if (canonical && canonical !== file) forms.push(canonical);
			} catch {
				// Ignore per-file failures: one unresolvable file must not drop the rest.
			}
			try {
				const danglingAware = canonicalizeForWriteTarget(file);
				if (danglingAware && !forms.includes(danglingAware)) forms.push(danglingAware);
			} catch {
				// Same per-file isolation as above.
			}
			return forms;
		}),
	)];
}

/**
 * Total (never-throwing) sensitive write check for a built-in write/edit
 * `path` input. Resolves exactly like the built-ins, then uses the
 * dangling-aware canonicalization so a symlink to a not-yet-existing
 * sensitive config file still matches. Returns false (not sensitive) for any
 * unresolvable/illegal input instead of throwing.
 */
export function isSensitiveWriteTarget(input: string, cwd: string, agentDir: string): boolean {
	try {
		const resolved = resolveLikeBuiltin(input, cwd);
		const target = canonicalizeForWriteTarget(resolved);
		if (target === undefined) return false;
		const forms = buildSensitiveWriteForms(agentDir);
		return forms.includes(target);
	} catch {
		return false;
	}
}

/** True when `target` equals `root` or lives under it (both absolute/canonical). */
export function isPathCoveredBy(target: string, root: string): boolean {
	if (target === root) return true;
	const rel = path.relative(root, target);
	return rel.length > 0 && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !path.isAbsolute(rel);
}

export type SandboxBashStatus = "absent" | "valid" | "invalid";

export interface SandboxBashReadResult {
	status: SandboxBashStatus;
	/** Present when invalid: why the denyRead list cannot be trusted. */
	reason?: string;
	/** Present when valid: the configured denyRead entries (raw, as in the file). */
	denyRead?: string[];
}

/**
 * Read + validate the USER-level sandbox-bash.json with the exact same schema
 * the sandbox extension uses (validateSandboxBashConfig). A file that exists
 * but cannot be read or parsed is "invalid". Since denyRead is an opt-in
 * blacklist, invalid configuration is treated as no denyRead; the caller may
 * warn, but must preserve the default read behavior.
 */
export function readSandboxBashConfig(filePath: string): SandboxBashReadResult {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { status: "absent" };
		}
		return { status: "invalid", reason: `cannot read file (${String(error)})` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { status: "invalid", reason: `invalid JSON (${String(error)})` };
	}

	const validation = validateSandboxBashConfig(parsed);
	if ("error" in validation) return { status: "invalid", reason: validation.error };
	return { status: "valid", denyRead: validation.config.denyRead ?? [] };
}

export interface ReadDenyInput {
	toolName: string;
	/** Canonical target (search root for grep/find). undefined => uncanonicalizable. */
	target: string | undefined;
	/** Canonical deny roots: exact files or directories, symlinks resolved. */
	denyRoots: string[];
	/** Kept for call-site/test compatibility; invalid config means no denyRead. */
	configBroken: boolean;
	configReason?: string;
}

export type ReadDenyDecision = { block: true; reason: string } | { block: false };

/**
 * Decide whether a built-in read tool call must be blocked by denyRead.
 *
 * Precedence: denyRead beats everything else (cwd / extraRoots / session
 * approval) — the caller invokes this BEFORE the path-scope boundary checks.
 *
 *   - invalid/unreadable sandbox-bash.json  -> treat denyRead as absent. Reads
 *     are allowed by default; denyRead is an opt-in blacklist, not a default
 *     read restriction.
 *   - read/ls: block when the DIRECT target is at/under a deny root;
 *   - grep/find: additionally block when the search root CONTAINS a deny root
 *     (recursion would descend into it) — i.e. a search root that is an
 *     ancestor of a deny root is refused;
 *   - a target that cannot be canonicalized fails closed (blocked).
 */
export function evaluateReadDeny(input: ReadDenyInput): ReadDenyDecision {
	const target = input.target;
	// denyRead is an opt-in blacklist. If the optional config cannot be read,
	// there is no usable blacklist to apply; preserve the default read behavior
	// and let path-scope's ordinary extraRoots/boundary rules decide access.
	if (!DENY_READ_TOOLS.has(input.toolName)) return { block: false };
	if (input.denyRoots.length === 0 || target === undefined) return { block: false };
	if (input.denyRoots.some((root) => isPathCoveredBy(target, root))) {
		return { block: true, reason: `目标路径位于 denyRead 范围内，已拦截 ${input.toolName}: ${target}` };
	}
	if (SEARCH_TOOLS.has(input.toolName) && input.denyRoots.some((root) => isPathCoveredBy(root, target))) {
		return { block: true, reason: `搜索根包含 denyRead 路径（递归搜索会进入敏感根），已拦截 ${input.toolName}: ${target}` };
	}
	return { block: false };
}