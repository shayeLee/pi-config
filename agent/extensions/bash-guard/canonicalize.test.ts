/**
 * Bash Guard — fail-closed canonicalization tests (real filesystem).
 *
 * Run from this directory:
 *   volta run node --test canonicalize.test.ts
 *
 * These test the fs-dependent slice extracted from index.ts (which itself
 * cannot be imported in tests without the Pi runtime). The semantics must
 * stay identical to path-scope's canonicalization and to sandbox-bash's
 * `canonicalPath`: one shared path boundary.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePath } from "./canonicalize.ts";

describe("canonicalizePath", () => {
	it("resolves `..` against the real parent of a symlinked component (kernel semantics)", () => {
		const base = mkdtempSync(join(tmpdir(), "bg-kernel-"));
		const otherParent = mkdtempSync(join(tmpdir(), "bg-kernel-p-"));
		try {
			const real = join(otherParent, "real");
			mkdirSync(real);
			const link = join(base, "link");
			symlinkSync(real, link);
			// Kernel: link/.. === otherParent. A lexically-collapsing resolver
			// (JS realpath) would report `base/marker` instead. Expected uses the
			// realpath of otherParent (macOS /var -> /private/var etc.).
			assert.equal(canonicalizePath(`${link}/../marker`), join(realpathSync(otherParent), "marker"));
			assert.notEqual(canonicalizePath(`${link}/../marker`), join(base, "marker"));
			// A missing suffix under an existing symlinked dir resolves through it.
			assert.equal(canonicalizePath(`${link}/newsub`), join(realpathSync(real), "newsub"));
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(otherParent, { recursive: true, force: true });
		}
	});

	it("fails closed on a broken symlink (returns undefined, not a lexical guess)", () => {
		const base = mkdtempSync(join(tmpdir(), "bg-broken-"));
		try {
			symlinkSync(join(base, "missing"), join(base, "broken"));
			assert.equal(canonicalizePath(`${base}/broken/secret`), undefined);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("fails closed when fs.realpathSync.native fails (no JS realpath fallback)", () => {
		const base = mkdtempSync(join(tmpdir(), "bg-native-"));
		try {
			const real = join(base, "real");
			mkdirSync(real);
			const native = realpathSync.native;
			assert.equal(typeof native, "function");
			(realpathSync as { native?: unknown }).native = () => {
				throw Object.assign(new Error("simulated native realpath failure"), { code: "EACCES" });
			};
			try {
				assert.equal(canonicalizePath(real), undefined);
				assert.equal(canonicalizePath(`${base}/real/newsub`), undefined);
			} finally {
				(realpathSync as { native?: unknown }).native = native;
			}
			// restored: normal resolution works again
			assert.equal(canonicalizePath(real), realpathSync(real));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
