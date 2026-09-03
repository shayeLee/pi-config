/**
 * Sandbox Bash — unit + integration tests.
 *
 * Run from this directory:
 *   volta run node --test core.test.ts
 *
 * Pure-logic tests run anywhere; the sandbox-exec integration tests skip when
 * /usr/bin/sandbox-exec is unavailable (non-macOS).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	absolutePath,
	buildProfile,
	canonicalDenyRoots,
	canonicalPath,
	escapeProfilePath,
	filterSensitiveRoots,
	normalizeConfigPath,
	validateSandboxBashConfig,
} from "./core.ts";

describe("validateSandboxBashConfig", () => {
	it("accepts a full valid config", () => {
		const result = validateSandboxBashConfig({
			enabled: true,
			allowWrite: ["~/Downloads"],
			denyRead: ["~/.ssh"],
		});
		assert.ok("config" in result);
	});
	it("accepts undefined (absent config)", () => {
		assert.ok("config" in validateSandboxBashConfig(undefined));
	});
	it("rejects non-object input", () => {
		for (const bad of [null, 42, "x", [1]]) {
			assert.ok("error" in validateSandboxBashConfig(bad), `reject ${JSON.stringify(bad)}`);
		}
	});
	it("rejects unknown keys", () => {
		assert.ok("error" in validateSandboxBashConfig({ bogus: 1 }));
	});
	it("rejects non-boolean enabled", () => {
		assert.ok("error" in validateSandboxBashConfig({ enabled: "x" }));
	});
	it("rejects non-string / empty allowWrite and denyRead entries", () => {
		assert.ok("error" in validateSandboxBashConfig({ allowWrite: ["/a", 1] }));
		assert.ok("error" in validateSandboxBashConfig({ allowWrite: [""] }));
		assert.ok("error" in validateSandboxBashConfig({ denyRead: ["/a", 1] }));
		assert.ok("error" in validateSandboxBashConfig({ denyRead: [""] }));
	});
	it("round-trips a config", () => {
		const result = validateSandboxBashConfig({ allowWrite: ["/a"], denyRead: ["/b"] });
		if ("config" in result) {
			assert.deepStrictEqual(result.config.allowWrite, ["/a"]);
			assert.deepStrictEqual(result.config.denyRead, ["/b"]);
		} else {
			assert.fail("expected valid config");
		}
	});
});

describe("escapeProfilePath", () => {
	it("escapes quotes and backslashes", () => {
		assert.equal(escapeProfilePath('a"b\\c'), 'a\\"b\\\\c');
	});
	it("strips control characters", () => {
		assert.ok(!escapeProfilePath("a\nb").includes("\n"));
	});
});

describe("normalizeConfigPath", () => {
	it("expands a leading ~", () => {
		const result = normalizeConfigPath("~/foo/bar");
		assert.ok(!result.startsWith("~"));
		assert.ok(result.endsWith("/foo/bar"));
	});
	it("leaves absolute paths alone", () => {
		assert.equal(normalizeConfigPath("/abs/path"), "/abs/path");
	});
});

describe("absolutePath", () => {
	it("resolves without resolving symlinks", () => {
		assert.equal(absolutePath("/var/folders"), "/var/folders");
	});
	it("expands ~ without realpath", () => {
		const raw = absolutePath("~/foo");
		assert.ok(!raw.startsWith("~"));
		assert.ok(raw.endsWith("/foo"));
	});
	it("anchors relative entries to the provided base, not process.cwd()", () => {
		assert.equal(absolutePath("./extra", "/srv/proj"), "/srv/proj/extra");
		assert.equal(absolutePath("../sibling", "/srv/proj"), "/srv/sibling");
	});
});

describe("filterSensitiveRoots", () => {
	it("drops exact, nested, `..`-detour and symlinked paths into a sensitive dir", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-filter-"));
		try {
			const secret = join(base, "secret");
			mkdirSync(secret);
			const link = join(base, "link");
			symlinkSync(secret, link);
			const allowed = join(base, "allowed");

			assert.deepEqual(filterSensitiveRoots([secret], [secret], base), []);
			assert.deepEqual(filterSensitiveRoots([join(secret, "auth.json")], [secret], base), []);
			assert.deepEqual(filterSensitiveRoots([join(base, "other/../secret")], [secret], base), []);
			// a symlink that points at the sensitive dir must not smuggle it in
			assert.deepEqual(filterSensitiveRoots([link], [secret], base), []);
			// ...and a sensitive dir given as a symlink must still filter its target
			assert.deepEqual(filterSensitiveRoots([secret], [link], base), []);
			// unrelated roots survive, including relative ones
			assert.deepEqual(filterSensitiveRoots([allowed, "./keep"], [secret], base), [allowed, "./keep"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("drops a root whose `..` only resolves through a symlink into a sensitive dir", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-detour-"));
		const secretParent = mkdtempSync(join(tmpdir(), "sb-secret-"));
		try {
			const secret = join(secretParent, "agent");
			mkdirSync(secret);
			const link = join(base, "link");
			symlinkSync(secret, link);
			// Kernel: link/.. == secretParent, so this is `secret` itself.
			// Lexical: it collapses to `base/agent`, which would be a different dir.
			const detour = `${link}/../agent`;

			assert.deepEqual(filterSensitiveRoots([detour], [secret], base), []);
			const profile = buildProfile(base, [detour], [], [secret]);
			const allows = [...profile.matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)].map((m) => m[1]);
			assert.ok(!allows.includes(join(base, "agent")), `lexical detour must not become a root: ${allows}`);
			assert.ok(!allows.includes(secret), `sensitive dir must not become a root: ${allows}`);
			assert.ok(!allows.includes(canonicalPath(secret) ?? ""), `realpath of the sensitive dir must not be a root: ${allows}`);
			assert.ok(profile.includes(`(deny file-write* (subpath "${secret}"))`), profile);
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(secretParent, { recursive: true, force: true });
		}
	});
	it("is a no-op when no sensitive dirs are configured", () => {
		assert.deepEqual(filterSensitiveRoots(["/a", "/b"], [], "/base"), ["/a", "/b"]);
	});
	it("drops a root that cannot be canonicalized at all (broken symlink) and keeps legitimate ones", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-badroot-"));
		try {
			const secret = join(base, "secret");
			mkdirSync(secret);
			symlinkSync(join(base, "missing"), join(base, "broken"));
			const good = join(base, "good");
			mkdirSync(good);
			const bad = `${base}/broken/newsub`;

			// The unresolvable root is dropped; legitimate roots (incl. relative)
			// survive.
			assert.deepEqual(filterSensitiveRoots([bad, good, "./keep"], [secret], base), [good, "./keep"]);

			const profile = buildProfile(base, [bad, good], [], [secret]);
			assert.ok(!profile.includes(`(allow file-write* (subpath "${base}/broken`), profile);
			assert.ok(profile.includes(`(allow file-write* (subpath "${base}")`), profile);
			assert.ok(profile.includes(`(allow file-write* (subpath "${good}")`), profile);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("drops a sensitive dir smuggled through a symlink with a not-yet-existing suffix", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-smuggle-"));
		try {
			const secret = join(base, "secret");
			mkdirSync(secret);
			const link = join(base, "link");
			symlinkSync(secret, link);
			// Lexically this looks like an unrelated dir under base; a write
			// through it would land inside the sensitive dir.
			assert.deepEqual(filterSensitiveRoots([`${link}/newsub`], [secret], base), []);
			const profile = buildProfile(base, [`${link}/newsub`], [], [secret]);
			assert.ok(!profile.includes(`(allow file-write* (subpath "${link}`), profile);
			assert.ok(!profile.includes(`(allow file-write* (subpath "${secret}"))`), profile);
			assert.ok(profile.includes(`(deny file-write* (subpath "${secret}"))`), profile);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("canonicalPath: kernel path semantics (regressions)", () => {
	it("resolves `..` against the real parent of a symlinked component, not lexically", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-kernel-"));
		const otherParent = mkdtempSync(join(tmpdir(), "sb-kernel-p-"));
		try {
			const real = join(otherParent, "real");
			mkdirSync(real);
			const link = join(base, "link");
			symlinkSync(real, link);
			// Kernel: link/.. === otherParent. A lexically-collapsing resolver
			// (JS realpath) would report `base/marker` instead. Expected uses the
			// realpath of otherParent (macOS /var -> /private/var etc.).
			assert.equal(canonicalPath(`${link}/../marker`, base), join(realpathSync(otherParent), "marker"));
			assert.notEqual(canonicalPath(`${link}/../marker`, base), join(base, "marker"));
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(otherParent, { recursive: true, force: true });
		}
	});

	it("fails closed when fs.realpathSync.native fails (no lexically-collapsing JS fallback)", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-native-"));
		try {
			const real = join(base, "real");
			mkdirSync(real);
			const native = realpathSync.native;
			assert.equal(typeof native, "function");
			(realpathSync as { native?: unknown }).native = () => {
				throw Object.assign(new Error("simulated native realpath failure"), { code: "EACCES" });
			};
			try {
				assert.equal(canonicalPath(real, base), undefined);
				assert.equal(canonicalPath(`${base}/real/newsub`, base), undefined);
			} finally {
				(realpathSync as { native?: unknown }).native = native;
			}
			assert.equal(canonicalPath(real, base), realpathSync(real));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("canonicalPath", () => {
	it("resolves a symlinked ancestor even when the suffix does not exist yet", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-canon-"));
		try {
			const real = join(base, "real");
			mkdirSync(real);
			const link = join(base, "link");
			symlinkSync(real, link);
			// A purely lexical fallback would return `${link}/newsub` here; the
			// resolved form is what the kernel actually hits on write.
			assert.equal(canonicalPath(`${link}/newsub`, base), join(realpathSync(real), "newsub"));
			// Plain non-existent paths under real dirs stay themselves (modulo
			// symlinked ancestors like /var -> /private/var on macOS).
			assert.equal(canonicalPath(join(base, "real/newsub"), base), join(realpathSync(real), "newsub"));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("fails closed on a broken symlink ancestor", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-canon-"));
		try {
			symlinkSync(join(base, "missing"), join(base, "broken"));
			assert.equal(canonicalPath(`${base}/broken/x`, base), undefined);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("buildProfile", () => {
	it("allows writes to cwd, /tmp, /private/tmp and the platform temp dir", () => {
		const profile = buildProfile("/real/cwd", [], []);
		assert.ok(profile.includes("(deny file-write*)"));
		assert.ok(profile.includes('/real/cwd"'));
		assert.ok(profile.includes('/tmp"'));
		assert.ok(profile.includes('/private/tmp"'));
		// temp dir listed under BOTH raw (/var/folders/…) and realpath
		assert.ok(profile.includes(`${tmpdir()}"`));
		assert.ok(profile.includes(`${canonicalPath(tmpdir())}"`));
	});
	it("re-allows /dev/null and /dev/zero by literal with file-write*", () => {
		const profile = buildProfile("/cwd", [], []);
		assert.ok(profile.includes('(allow file-write* (literal "/dev/null") (literal "/dev/zero"))'));
	});
	it("includes extra roots and expands ~ paths", () => {
		const profile = buildProfile("/cwd", ["~/Downloads"], []);
		assert.ok(profile.includes(`${canonicalPath("~/Downloads")}"`));
	});
	it("does NOT restrict reads when denyRead is empty", () => {
		const profile = buildProfile("/cwd", [], []);
		assert.ok(!profile.includes("deny file-read"));
	});
	it("denies reads of denyRead paths", () => {
		const profile = buildProfile("/cwd", [], ["/secret"]);
		assert.ok(profile.includes('(deny file-read* (subpath "/secret"'));
	});
	it("deduplicates canonicalized paths", () => {
		const profile = buildProfile("/cwd", ["/cwd"], []);
		const occurrences = profile.split('/cwd"').length - 1;
		assert.equal(occurrences, 1, "cwd should appear once");
	});
	it("ignores an unresolvable denyRead path", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-denybad-"));
		try {
			symlinkSync(join(base, "missing"), join(base, "broken"));
			const profile = buildProfile(base, [], [`${base}/broken/secret`]);
			assert.ok(!profile.includes(`(deny file-read* (subpath "${base}/broken/secret")`), profile);

			// ...while a resolvable denyRead entry still uses its canonical form.
			const goodProfile = buildProfile(base, [], [`${base}/plain`]);
			const expected = canonicalPath(`${base}/plain`, base);
			assert.ok(expected !== undefined);
			assert.ok(goodProfile.includes(`(deny file-read* (subpath "${expected}")`), goodProfile);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("anchors relative extra roots and denyRead entries to the session cwd", () => {
		const profile = buildProfile("/real/cwd", ["./extra", "../sibling"], ["secrets"]);
		assert.ok(profile.includes('(allow file-write* (subpath "/real/cwd/extra"'), profile);
		assert.ok(profile.includes('(allow file-write* (subpath "/real/sibling"'), profile);
		assert.ok(profile.includes('(deny file-read* (subpath "/real/cwd/secrets"'), profile);
	});
	it("never authorizes a sensitive root, but keeps an unrelated extra root", () => {
		const profile = buildProfile("/real/cwd", ["/Users/mz/.pi", "/Users/mz/.pi/agent/sessions", "/Users/mz/.volta"], [], ["/Users/mz/.pi/agent", "/Users/mz/.pi"]);
		assert.ok(!profile.includes('(allow file-write* (subpath "/Users/mz/.pi'), profile);
		assert.ok(profile.includes('(allow file-write* (subpath "/Users/mz/.volta"'), profile);
		assert.ok(profile.includes('(deny file-write* (subpath "/Users/mz/.pi"))'), profile);
	});
	it("denies sensitive dirs after the allows so a broad root cannot be written through", () => {
		const profile = buildProfile("/real/cwd", ["/Users/mz"], [], ["/Users/mz/.pi"]);
		assert.ok(profile.includes('(allow file-write* (subpath "/Users/mz")'), profile);
		const allowIndex = profile.lastIndexOf("(allow file-write*");
		const denyIndex = profile.indexOf('(deny file-write* (subpath "/Users/mz/.pi"))');
		assert.ok(denyIndex > allowIndex, "the sensitive deny must come after every allow");
	});
	it("keeps the project writable when cwd itself lives under a sensitive dir", () => {
		const profile = buildProfile("/Users/mz/.pi", ["/Users/mz/.pi"], [], ["/Users/mz/.pi/agent", "/Users/mz/.pi"]);
		assert.ok(profile.includes('(allow file-write* (subpath "/Users/mz/.pi")'), profile);
		assert.ok(!profile.includes("(deny file-write* (subpath"), profile);
	});
	it("still denies a sensitive dir inside a broad cwd when the cwd is not sensitive (cwd = ~)", () => {
		// cwd = `~` is NOT itself a sensitive dir: the project root merely happens
		// to contain it, so the credential dirs must stay denied.
		const profile = buildProfile("/Users/mz", [], [], ["/Users/mz/.pi/agent", "/Users/mz/.pi"]);
		assert.ok(profile.includes('(deny file-write* (subpath "/Users/mz/.pi/agent"))'), profile);
		assert.ok(profile.includes('(deny file-write* (subpath "/Users/mz/.pi"))'), profile);
	});
	it("cwd strictly inside a sensitive dir: keeps the project, drops covering broad roots, no blanket deny of the containing dir", () => {
		const broad = "/Users/mz/broad";
		const pi = join(broad, ".pi");
		const agent = join(pi, "agent");
		const cwd = join(agent, "sessions");
		const profile = buildProfile(cwd, [broad], [], [agent, pi]);
		const allows = [...profile.matchAll(/\(allow file-write\* \(subpath "([^"]+)"\)\)/g)].map((m) => m[1]);
		// the project subtree itself stays writable...
		assert.ok(allows.includes(cwd), allows.join(", "));
		// ...but the broad root that covers the containing sensitive dir is
		// dropped, so credentials next to (not inside) the cwd are unreachable.
		assert.ok(!allows.includes(broad), allows.join(", "));
		assert.ok(!allows.some((a) => a === agent || a === pi), allows.join(", "));
		// and the containing sensitive dirs are NOT denied (that would deny the
		// project too) — protection comes from the dropped broad root instead.
		assert.ok(!profile.includes(`(deny file-write* (subpath "${agent}"))`), profile);
		assert.ok(!profile.includes(`(deny file-write* (subpath "${pi}"))`), profile);
	});
	it("cwd strictly inside a sensitive dir without a broad root: unrelated extra roots survive", () => {
		const pi = "/Users/mz/broad/.pi";
		const agent = join(pi, "agent");
		const cwd = join(agent, "sessions");
		const profile = buildProfile(cwd, ["/Users/mz/.volta"], [], [agent, pi]);
		assert.ok(profile.includes('(allow file-write* (subpath "/Users/mz/.volta")'), profile);
		assert.ok(profile.includes(`(allow file-write* (subpath "${cwd}"`), profile);
	});
});

describe("buildProfile: sensitive config files + editable dirs", () => {
	it("denies exact sensitive config files (subpath, raw + canonical) after every allow", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-files-"));
		try {
			const agent = join(base, "agent");
			const auth = join(agent, "auth.json");
			mkdirSync(agent, { recursive: true });
			writeFileSync(auth, "{}");
			const cwd = join(base, "proj");
			const profile = buildProfile(cwd, [], [], [agent, base], [auth], [join(agent, "extensions")]);

			const canonicalAuth = canonicalPath(auth, cwd);
			assert.ok(canonicalAuth !== undefined);
			assert.ok(profile.includes(`(deny file-write* (subpath "${canonicalAuth}")`), profile);
			assert.ok(profile.includes(`(deny file-write* (subpath "${auth}")`), profile);

			const lastAllow = profile.lastIndexOf("(allow file-write*");
			assert.ok(lastAllow >= 0, "profile should contain allows");
			const denyIndex = profile.indexOf(`(deny file-write* (subpath "${canonicalAuth}")`);
			assert.ok(denyIndex > lastAllow, "sensitive-file deny must come after every allow");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keeps the file-level denies when the cwd lives inside the sensitive tree", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-files-"));
		try {
			const piDir = join(base, ".pi");
			const agent = join(piDir, "agent");
			mkdirSync(agent, { recursive: true });
			const auth = join(agent, "auth.json");
			writeFileSync(auth, "{}");
			const cwd = piDir;
			const profile = buildProfile(cwd, [], [], [agent, piDir], [auth], [join(agent, "extensions")]);

			// project stays writable; the sensitive agent directory is denied after
			// the cwd allow to prevent rename/unlink tricks around protected files.
			assert.ok(profile.includes(`(allow file-write* (subpath "${cwd}")`), profile);
			assert.ok(profile.includes(`(deny file-write* (subpath "${agent}")`), profile);
			assert.ok(!profile.includes(`(deny file-write* (subpath "${piDir}")`), profile);
			// ...but the config file itself must STILL be denied.
			const canonicalAuth = canonicalPath(auth, cwd);
			assert.ok(canonicalAuth !== undefined);
			assert.ok(profile.includes(`(deny file-write* (subpath "${canonicalAuth}")`), profile);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("re-allows an editable dir (extensions) AFTER the dir-level sensitive denies", () => {
		const base = mkdtempSync(join(tmpdir(), "sb-files-"));
		try {
			const agent = join(base, ".pi", "agent");
			const ext = join(agent, "extensions");
			mkdirSync(ext, { recursive: true });
			const piDir = join(base, ".pi");
			const cwd = join(base, "proj");
			const profile = buildProfile(cwd, [], [], [agent, piDir], [], [ext]);

			const agentDeny = profile.indexOf(`(deny file-write* (subpath "${agent}")`);
			const extAllow = profile.indexOf(`(allow file-write* (subpath "${ext}")`);
			assert.ok(agentDeny >= 0, profile);
			assert.ok(extAllow > agentDeny, `extensions allow must come after the dir deny: ${profile}`);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("escapes quote characters in sensitive-file deny paths", () => {
		const profile = buildProfile("/cwd", [], [], [], ["/weird\"path/auth.json"], []);
		assert.ok(profile.includes('(deny file-write* (subpath "/weird\\"path/auth.json")'), profile);
	});

	it("emits no file-level clauses when none are configured", () => {
		const profile = buildProfile("/cwd", [], []);
		assert.ok(!profile.includes("(deny file-write* (subpath \"/cwd/auth.json\")"), profile);
	});
});

describe("canonicalDenyRoots (shared per-entry isolation)", () => {
	it("skips a throwing entry and keeps the rest, deduplicated", () => {
		const skipped: string[] = [];
		const out = canonicalDenyRoots(
			["/good", "/bad", "/good"],
			(entry) => {
				if (entry === "/bad") throw new Error("illegal file: URL");
				return entry;
			},
			(entry) => skipped.push(entry),
		);
		assert.deepEqual(out, ["/good"]);
		assert.deepEqual(skipped, ["/bad"]);
	});
	it("skips unresolvable (undefined) entries without throwing", () => {
		const skipped: string[] = [];
		const out = canonicalDenyRoots(["/good", "/missing"], (entry) => entry === "/good" ? entry : undefined, (entry) => skipped.push(entry));
		assert.deepEqual(out, ["/good"]);
		assert.deepEqual(skipped, ["/missing"]);
	});
});

describe("buildProfile: cwd inside the sensitive tree (rename-trick hardening)", () => {
	function makePiTree() {
		const base = mkdtempSync(join(tmpdir(), "sb-rename-"));
		const piDir = join(base, ".pi");
		const agent = join(piDir, "agent");
		const ext = join(agent, "extensions");
		mkdirSync(ext, { recursive: true });
		const auth = join(agent, "auth.json");
		writeFileSync(auth, "{}");
		return { base, piDir, agent, ext, auth };
	}

	it("cwd == sensitive dir: child deny comes AFTER the cwd re-allow, extensions stay editable, files stay denied", () => {
		const { base, piDir, agent, ext, auth } = makePiTree();
		try {
			const profile = buildProfile(piDir, [], [], [agent, piDir], [auth], [ext]);
			const cwdAllow = profile.lastIndexOf(`(allow file-write* (subpath "${piDir}")`); // LAST: top allows already contain cwd; the re-allow is the trailing one
			const agentDeny = profile.indexOf(`(deny file-write* (subpath "${agent}")`);
			const extAllow = profile.indexOf(`(allow file-write* (subpath "${ext}")`);
			const canonicalAuth = canonicalPath(auth, piDir);
			assert.ok(canonicalAuth !== undefined);
			const fileDeny = profile.indexOf(`(deny file-write* (subpath "${canonicalAuth}")`);
			assert.ok(cwdAllow >= 0, profile);
			assert.ok(agentDeny >= 0, profile);
			assert.ok(extAllow >= 0, profile);
			assert.ok(fileDeny >= 0, profile);
			// The child dir deny must win over the trailing cwd allow (Seatbelt
			// last-match-wins); otherwise `mv agent agent.bak` re-opens the
			// credentials via the renamed path.
			assert.ok(agentDeny > cwdAllow, `agent deny must come after the cwd re-allow: ${profile}`);
			assert.ok(extAllow > agentDeny, `extensions allow must come after the child deny: ${profile}`);
			assert.ok(fileDeny > extAllow, `file deny must come after every allow: ${profile}`);
			// The cwd itself is never denied (the project stays writable).
			assert.ok(!profile.includes(`(deny file-write* (subpath "${piDir}")`), profile);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("cwd strictly inside: covering denies come BEFORE the cwd re-allow (project carved back out)", () => {
		const { base, piDir, agent } = makePiTree();
		const cwd = join(agent, "sessions");
		mkdirSync(cwd, { recursive: true });
		try {
			const auth = join(agent, "auth.json");
			const profile = buildProfile(cwd, [], [], [agent, piDir], [auth], [join(agent, "extensions")]);
			const cwdAllow = profile.lastIndexOf(`(allow file-write* (subpath "${cwd}")`); // LAST: re-allow after the covering denies
			const agentDeny = profile.indexOf(`(deny file-write* (subpath "${agent}")`);
			const piDeny = profile.indexOf(`(deny file-write* (subpath "${piDir}")`);
			assert.ok(cwdAllow >= 0, profile);
			assert.ok(agentDeny >= 0 && piDeny >= 0, profile);
			assert.ok(agentDeny < cwdAllow && piDeny < cwdAllow, `covering denies must precede the cwd re-allow: ${profile}`);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Nested sandboxing is refused (`sandbox_apply: Operation not permitted`) when the
 * tests themselves run inside an already-sandboxed shell — e.g. from a pi session
 * whose bash tool is wrapped by this very extension. Detect that and skip, so a
 * nested run does not report the write-isolation behaviour as broken.
 */
function sandboxExecUsable(): boolean {
	if (!existsSync(SANDBOX_EXEC)) return false;
	const probe = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "true"], { encoding: "utf8" });
	return probe.status === 0;
}

const SANDBOX_SKIP = sandboxExecUsable()
	? false
	: "sandbox-exec unavailable (non-macOS) or nested sandboxing refused (this shell is already sandboxed)";

describe("sandbox-exec integration (write isolation)", { skip: SANDBOX_SKIP }, () => {
	it("allows writes to a configured extra root (path-scope extraRoots)", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		const extra = mkdtempSync(join(tmpdir(), "sb-extra-"));
		try {
			const profile = buildProfile(root, [extra], []);
			const target = join(extra, "allowed.txt");
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo ok > "${target}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(existsSync(target));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(extra, { recursive: true, force: true });
		}
	});

	it("resolves a cwd-relative extra root against the session cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		mkdirSync(join(root, "cache"));
		try {
			const profile = buildProfile(root, ["./cache"], []);
			const target = join(root, "cache", "written.txt");
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo ok > "${target}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(existsSync(target));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("denies a sensitive dir even when a broader authorized root contains it", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		const broad = mkdtempSync(join(tmpdir(), "sb-broad-"));
		const sensitive = join(broad, ".pi");
		mkdirSync(sensitive);
		try {
			const profile = buildProfile(root, [broad], [], [sensitive]);
			const inside = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo ok > "${join(broad, "work.txt")}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(inside.status, 0, `write inside the broad root should pass: ${inside.stderr}`);

			const denied = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo no > "${join(sensitive, "auth.json")}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.notEqual(denied.status, 0, "write into the sensitive dir should have failed");
			assert.ok(/Operation not permitted/i.test(denied.stderr), denied.stderr);
			assert.ok(!existsSync(join(sensitive, "auth.json")));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(broad, { recursive: true, force: true });
		}
	});

	it("allows writes under the project cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		try {
			const profile = buildProfile(root, [], []);
			const target = join(root, "allowed.txt");
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo ok > "${target}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(existsSync(target));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows writing to /dev/null (git and most tools depend on it)", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		try {
			const profile = buildProfile(root, [], []);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", 'echo hi > /dev/null'],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("covers >> and touch variants on /dev/null", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		try {
			const profile = buildProfile(root, [], []);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", 'echo hi >> /dev/null && touch /dev/null'],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("denies writes outside the allowlist", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		const target = join(homedir(), "sb-denied-test.txt");
		try {
			const profile = buildProfile(root, [], []);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo no > "${target}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "write should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
			assert.ok(!existsSync(target));
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(target, { force: true });
		}
	});

	it("allows reads anywhere when denyRead is empty", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		try {
			const profile = buildProfile(root, [], []);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", "cat /etc/hosts"],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("denies reads of a denyRead path", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		const secret = mkdtempSync(join(tmpdir(), "sb-secret-"));
		const secretFile = join(secret, "secret.txt");
		writeFileSync(secretFile, "top secret");
		try {
			const profile = buildProfile(root, [], [secret]);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `cat "${secretFile}"`],
				{ cwd: root, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "read should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(secret, { recursive: true, force: true });
		}
	});
});

describe("sandbox-exec: sensitive config file write protection", { skip: SANDBOX_SKIP }, () => {
	function makeAgentTree(): { base: string; piDir: string; agent: string; auth: string; ext: string } {
		const base = mkdtempSync(join(tmpdir(), "sb-cfg-"));
		const piDir = join(base, ".pi");
		const agent = join(piDir, "agent");
		const ext = join(agent, "extensions");
		mkdirSync(ext, { recursive: true });
		const auth = join(agent, "auth.json");
		writeFileSync(auth, "{}");
		return { base, piDir, agent, auth, ext };
	}

	it("denies writes to a sensitive config file when the cwd is inside the sensitive tree", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		try {
			const profile = buildProfile(piDir, [], [], [agent, piDir], [auth], [ext]);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo leaked > "${auth}"`],
				{ cwd: piDir, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "write into the sensitive file should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
			assert.equal(readFileSync(auth, "utf8"), "{}");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("blocks deleting (unlink) a sensitive config file even inside the sensitive tree", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		try {
			const profile = buildProfile(piDir, [], [], [agent, piDir], [auth], [ext]);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `rm "${auth}"`],
				{ cwd: piDir, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "unlink of the sensitive file should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
			assert.ok(existsSync(auth), "the file must still exist");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("blocks CREATING a not-yet-existing sensitive config file inside the sensitive tree", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		rmSync(auth, { force: true });
		try {
			const profile = buildProfile(piDir, [], [], [agent, piDir], [auth], [ext]);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo new > "${auth}"`],
				{ cwd: piDir, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "creating the sensitive file should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
			assert.ok(!existsSync(auth));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("allows editing extension source under the agent dir from an outside cwd", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		const cwd = join(base, "proj");
		mkdirSync(cwd, { recursive: true });
		try {
			const profile = buildProfile(cwd, [], [], [agent, piDir], [auth], [ext]);
			const target = join(ext, "new-extension.ts");
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo 'export default function(){}' > "${target}"`],
				{ cwd, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(existsSync(target));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("still denies writes to a sensitive config file from an outside cwd", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		const cwd = join(base, "proj");
		mkdirSync(cwd, { recursive: true });
		try {
			const profile = buildProfile(cwd, [], [], [agent, piDir], [auth], [ext]);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo no > "${auth}"`],
				{ cwd, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "write into the sensitive file should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
			assert.equal(readFileSync(auth, "utf8"), "{}");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("still denies other files under the agent dir from an outside cwd (dir-level deny intact)", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		const cwd = join(base, "proj");
		mkdirSync(cwd, { recursive: true });
		try {
			const profile = buildProfile(cwd, [], [], [agent, piDir], [auth], [ext]);
			const sessions = join(agent, "sessions.jsonl");
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo hi > "${sessions}"`],
				{ cwd, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "write under the agent dir should have failed");
			assert.ok(/Operation not permitted/i.test(result.stderr), result.stderr);
			assert.ok(!existsSync(sessions));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("sandbox-exec: rename-trick hardening (cwd inside sensitive tree)", { skip: SANDBOX_SKIP }, () => {
	function makeAgentTree(): { base: string; piDir: string; agent: string; auth: string; ext: string } {
		const base = mkdtempSync(join(tmpdir(), "sb-rename-"));
		const piDir = join(base, ".pi");
		const agent = join(piDir, "agent");
		const ext = join(agent, "extensions");
		mkdirSync(ext, { recursive: true });
		const auth = join(agent, "auth.json");
		writeFileSync(auth, "{}");
		return { base, piDir, agent, auth, ext };
	}

	it("blocks renaming the sensitive child dir when cwd == the sensitive dir", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		try {
			const profile = buildProfile(piDir, [], [], [agent, piDir], [auth], [ext]);
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", "mv agent agent.bak"],
				{ cwd: piDir, encoding: "utf8" },
			);
			assert.notEqual(result.status, 0, "renaming the protected child dir should have failed");
			assert.ok(existsSync(agent), "the agent dir must still exist");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keeps extension source editable when cwd == the sensitive dir", () => {
		const { base, piDir, agent, auth, ext } = makeAgentTree();
		try {
			const profile = buildProfile(piDir, [], [], [agent, piDir], [auth], [ext]);
			const target = join(ext, "tweak.ts");
			const result = spawnSync(
				SANDBOX_EXEC,
				["-p", profile, "bash", "-c", `echo 'export default 1' > "${target}"`],
				{ cwd: piDir, encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
			assert.ok(existsSync(target));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
