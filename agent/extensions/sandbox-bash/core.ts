/**
 * Sandbox Bash — pure core logic (profile generation, no Pi/spawn dependency).
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested with `node --test` without loading the Pi runtime. The extension entry
 * point (index.ts) imports from this module.
 */

import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SandboxBashConfig {
	enabled?: boolean;
	allowWrite?: string[];
	denyRead?: string[];
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

	const allowedKeys = new Set(["enabled", "allowWrite", "denyRead"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) return { error: `unknown property ${JSON.stringify(key)}` };
	}

	const candidate = value as Record<string, unknown>;
	if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
		return { error: "enabled must be a boolean" };
	}
	for (const field of ["allowWrite", "denyRead"] as const) {
		const arr = candidate[field];
		if (arr !== undefined && (!Array.isArray(arr) || !arr.every((s) => typeof s === "string" && s.trim().length > 0))) {
			return { error: `${field} must be an array of non-empty strings` };
		}
	}

	const config: SandboxBashConfig = {};
	if (candidate.enabled !== undefined) config.enabled = candidate.enabled as boolean;
	if (candidate.allowWrite !== undefined) config.allowWrite = candidate.allowWrite as string[];
	if (candidate.denyRead !== undefined) config.denyRead = candidate.denyRead as string[];
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

/** Absolute + normalized, symlinks untouched. `base` anchors relative entries. */
function absoluteForm(value: string, base: string): string {
	const expanded = normalizeConfigPath(value);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/**
 * Absolute path that KEEPS `..` segments: `path.resolve` collapses `a/link/../b`
 * to `a/b` lexically, while the filesystem resolves `..` against the real
 * directory behind `link`. Canonicalization must use this form so a root written
 * with a `..` after a symlink cannot silently become some other directory.
 */
function anchorKeepDotDot(value: string, base: string): string {
	const expanded = normalizeConfigPath(value);
	const joined = isAbsolute(expanded) ? expanded : `${base}/${expanded}`;
	const segments = joined.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
	return `${joined.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

/**
 * `realpathSync.native` resolves `..` against the *real* parent of a symlinked
 * component, like the kernel does when a command runs; the JS implementation
 * collapses `a/link/../b` to `a/b`, which can silently turn a configured root
 * into a different directory. Only the native form has the kernel's semantics,
 * so there is NO JS fallback: when native realpath is unavailable or fails,
 * the error propagates and every caller fails closed.
 */
function realpathFull(candidate: string): string {
	const native = (realpathSync as { native?: (value: string) => string }).native;
	if (!native) {
		throw new Error("fs.realpathSync.native unavailable: cannot resolve paths with kernel semantics");
	}
	return native(candidate);
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Resolve a config path to a canonical form (symlinks resolved best-effort).
 * Relative entries are anchored to `base` — pass the session cwd so a root or a
 * denyRead path can never silently resolve against whatever directory pi was
 * launched in (that would authorize/deny an unintended path).
 *
 * For a not-yet-existing path, the nearest existing ancestor is resolved and the
 * missing suffix appended — the same contract as path-scope and bash-guard. A
 * purely lexical fallback would be wrong: `link/newsub` (link -> ~/.pi/agent)
 * lexically looks harmless, but a write through it lands inside the sensitive
 * dir, so filterSensitiveRoots must see the resolved form. An existing but
 * unresolvable component (broken symlink, unreadable ancestor) fails closed.
 */
export function canonicalPath(value: string, base: string = process.cwd()): string | undefined {
	const candidate0 = anchorKeepDotDot(value, base);
	let candidate = candidate0;
	const missingSuffix: string[] = [];

	while (true) {
		try {
			return join(realpathFull(candidate), ...missingSuffix);
		} catch {
			try {
				// Exists but cannot be resolved (broken symlink, unreadable): fail closed.
				lstatSync(candidate);
				return undefined;
			} catch (error) {
				if (!isEnoent(error)) return undefined;
			}
		}
		const parent = dirname(candidate);
		if (parent === candidate) return undefined;
		missingSuffix.unshift(basename(candidate));
		candidate = parent;
	}
}

/** realpath, falling back to the input when it cannot be resolved. */
function realpathOrSelf(value: string): string {
	try {
		return realpathFull(value);
	} catch {
		return value;
	}
}

/** Absolute path without resolving symlinks (raw/literal form). */
export function absolutePath(value: string, base: string = process.cwd()): string {
	return absoluteForm(value, base);
}

/** True when `candidate` equals or lives under `root`. */
function isCoveredBy(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const rel = relative(root, candidate);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Raw + symlink-resolved forms of the configured sensitive directories. */
function sensitiveForms(sensitiveDirs: string[], base: string): string[] {
	return [...new Set(
		sensitiveDirs.flatMap((dir) => [absoluteForm(dir, base), canonicalPath(dir, base) ?? ""]).filter(Boolean),
	)];
}

/**
 * Drop config roots that reach a sensitive directory (pi's agent dir / `~/.pi`,
 * which hold credentials and extension code).
 *
 * Both the raw and the symlink-resolved form are tested, so `~/.pi/../.pi`,
 * `some/dir -> ~/.pi` and `~/.volta/../.pi` cannot smuggle a sensitive
 * directory back in as an authorized write root.
 */
export function filterSensitiveRoots(entries: string[], sensitiveDirs: string[], base: string): string[] {
	if (sensitiveDirs.length === 0) return [...entries];
	const sensitive = sensitiveForms(sensitiveDirs, base);
	return entries.filter((entry) => {
		const canonical = canonicalPath(entry, base);
		// Fail closed: an entry that cannot be canonicalized (broken symlink,
		// unreadable ancestor) is dropped. Keeping it on its raw form alone would
		// authorize a path whose kernel-resolved form nobody has verified.
		if (canonical === undefined) return false;
		const forms = [absoluteForm(entry, base), anchorKeepDotDot(entry, base), canonical];
		return ![...new Set(forms)].some((form) => sensitive.some((root) => isCoveredBy(form, root)));
	});
}

/**
 * Build a Seatbelt profile that restricts WRITE (and, optionally, sensitive
 * READS via denyRead):
 *   - write: deny everything, then allow only the authorized roots, plus the
 *            /dev/null and /dev/zero device nodes (git and most tools need
 *            them; devfs nodes must be re-allowed by `literal`, not `subpath`).
 *   - read:  allowed by default (allow default), except the denyRead paths
 *            which are denied entirely (data + metadata).
 *   - exec / network: allowed.
 *
 * Authorized write roots = cwd + extraRoots (path-scope roots) + /tmp +
 * /private/tmp + the platform temp dir (os.tmpdir(), e.g. /var/folders on
 * macOS, which differs from /tmp). Relative extraRoots/denyRead entries are
 * anchored to `cwd`, not to the directory pi was launched in.
 *
 * `sensitiveDirs` (e.g. `~/.pi/agent`, `~/.pi`) are never authorized, even when
 * they appear in extraRoots, and are additionally denied *after* the allows so a
 * broad root (e.g. `~`) cannot write through them. When the cwd itself lives
 * under a sensitive dir (pi started inside it, e.g. this very config repo), the
 * project must stay writable, so the sensitive dirs are classified instead of
 * blanket-skipping the denies:
 *   - inside the cwd subtree (incl. cwd itself): part of the project — kept
 *     writable, not denied;
 *   - strictly containing the cwd: a `deny` would also deny the project, so no
 *     deny is emitted and instead every root that COVERS such a dir is dropped —
 *     without its allow, nothing outside the cwd subtree of that dir is
 *     reachable, so credentials next to (not inside) the cwd stay protected;
 *   - disjoint from the cwd: denied after the allows as usual.
 */
export function buildProfile(
	cwd: string,
	extraRoots: string[],
	denyRead: string[],
	sensitiveDirs: string[] = [],
): string {
	const tempDir = tmpdir();
	const sensitive = sensitiveForms(sensitiveDirs, cwd);
	const cwdForms = [absolutePath(cwd, cwd), canonicalPath(cwd, cwd) ?? ""].filter(Boolean);
	const cwdProtected = cwdForms.some((form) => sensitive.some((root) => isCoveredBy(form, root)));

	const projectSensitive: string[] = [];
	const coveringSensitive: string[] = [];
	const externalSensitive: string[] = [];
	for (const dir of sensitive) {
		if (!cwdProtected) {
			// The project is unrelated to the sensitive tree: deny every form, even
			// one that merely sits inside a broad cwd (e.g. cwd = `~`).
			externalSensitive.push(dir);
		} else if (cwdForms.some((form) => isCoveredBy(dir, form))) {
			projectSensitive.push(dir);
		} else if (cwdForms.some((form) => isCoveredBy(form, dir))) {
			coveringSensitive.push(dir);
		} else {
			externalSensitive.push(dir);
		}
	}

	// filterSensitiveRoots drops roots that reach INTO a sensitive dir; this drop
	// handles the complementary case: a broad root that CONTAINS a sensitive dir
	// which in turn contains the cwd. Such a root must go, because that sensitive
	// dir cannot be denied without also denying the project (see classification).
	const safeExtraRoots = filterSensitiveRoots(extraRoots, sensitiveDirs, cwd).filter((entry) => {
		if (coveringSensitive.length === 0) return true;
		const forms = [
			absolutePath(entry, cwd),
			anchorKeepDotDot(entry, cwd),
			canonicalPath(entry, cwd) ?? "",
		].filter(Boolean);
		return !forms.some((form) => coveringSensitive.some((dir) => isCoveredBy(dir, form)));
	});
	const authorized = [
		// Both the raw path and its realpath are listed. Directory symlinks
		// (e.g. /var -> /private/var) are NOT resolved during matching, so the
		// raw form is required; file symlinks ARE resolved (a write through a
		// symlink to outside an authorized root is denied — verified).
		absolutePath(cwd, cwd),
		canonicalPath(cwd, cwd),
		"/tmp",
		"/private/tmp",
		tempDir,
		realpathOrSelf(tempDir),
		...safeExtraRoots.flatMap((entry) => [absolutePath(entry, cwd), canonicalPath(entry, cwd)]),
	].filter((p): p is string => Boolean(p));
	const unique = [...new Set(authorized)];

	const parts: string[] = [
		"(version 1)",
		"(allow default)",
		// writes: allowlist only
		"(deny file-write*)",
		// device nodes: deny file-write* would also block /dev/null, which breaks
		// git and countless tools. Devfs nodes must be re-allowed by literal
		// (subpath cannot match them). file-write* (not just file-write-data)
		// covers >> / touch / chmod variants; devfs nodes cannot be unlinked by
		// non-root, so the wider grant is safe.
		'(allow file-write* (literal "/dev/null") (literal "/dev/zero"))',
		...unique.map((p) => `(allow file-write* (subpath "${escapeProfilePath(p)}"))`),
		// sensitive dirs: denied after the allows, so an authorized root that merely
		// *contains* them (e.g. `~`) still cannot be written through. Only the forms
		// disjoint from the project cwd are denied; the others are handled by the
		// classification above (kept writable / covering roots dropped).
		...externalSensitive.map((p) => `(deny file-write* (subpath "${escapeProfilePath(p)}"))`),
		// optional sensitive-read denylist (last, so it wins over everything).
		// Fail closed: an entry that cannot be canonicalized (broken symlink,
		// unreadable ancestor) still denies its anchored literal form — silently
		// dropping the deny would make the path readable instead.
		...denyRead
			.map((entry) => canonicalPath(entry, cwd) ?? anchorKeepDotDot(entry, cwd))
			.map((p) => `(deny file-read* (subpath "${escapeProfilePath(p)}"))`),
	];
	return parts.join("");
}