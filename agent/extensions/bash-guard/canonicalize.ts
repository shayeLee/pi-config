/**
 * Bash Guard — filesystem canonicalization (the only fs-dependent slice).
 *
 * Kept in its own module so the fail-closed path semantics can be unit tested
 * with `node --test` without loading the Pi runtime (index.ts imports
 * `@earendil-works/pi-coding-agent`, which is not resolvable from the tests).
 * Must stay behaviourally identical to path-scope's canonicalization and to
 * sandbox-bash's root handling: all three share one path boundary.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * `fs.realpathSync.native` resolves `..` against the *real* parent of a symlinked
 * component, exactly like the kernel does when a command runs; the JS
 * implementation collapses `a/link/../b` to `a/b` and can therefore report a
 * path as something else — only the native form has the kernel's semantics, so
 * there is NO JS fallback: when native realpath is unavailable or fails, the
 * error propagates and every caller fails closed.
 */
function realpathFull(candidate: string): string {
	const native = (fs.realpathSync as { native?: (value: string) => string }).native;
	if (!native) {
		throw new Error("fs.realpathSync.native unavailable: cannot resolve paths with kernel semantics");
	}
	return native(candidate);
}

/**
 * Resolve symlinks for an existing path; for a not-yet-existing path, resolve the
 * nearest existing ancestor. Anything that cannot be resolved safely (broken
 * symlink, unreadable ancestor, native realpath failure) returns undefined so
 * the caller fails closed.
 */
export function canonicalizePath(input: string): string | undefined {
	// Keep `..` in an already-absolute input: realpath resolves it correctly.
	let candidate = path.isAbsolute(input) ? input : path.resolve(input);
	const missingSuffix: string[] = [];

	while (true) {
		try {
			return path.join(realpathFull(candidate), ...missingSuffix);
		} catch {
			try {
				fs.lstatSync(candidate);
				return undefined;
			} catch (error) {
				if (!isEnoent(error)) return undefined;
			}
		}
		const parent = path.dirname(candidate);
		if (parent === candidate) return undefined;
		missingSuffix.unshift(path.basename(candidate));
		candidate = parent;
	}
}
