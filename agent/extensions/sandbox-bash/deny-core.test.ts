/**
 * deny-core — offline unit tests for the built-in file tool restrictions
 * (denyRead gate + sensitive config file write protection).
 *
 * Run from this directory:
 *   volta run node --test deny-core.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CWD_DEFAULT_TOOLS,
	DENY_READ_TOOLS,
	SEARCH_TOOLS,
	SENSITIVE_FILE_NAMES,
	WRITE_TOOLS,
	buildSensitiveWriteForms,
	canonicalizeDenyEntries,
	canonicalizeForWriteTarget,
	canonicalizePath,
	evaluateReadDeny,
	isPathCoveredBy,
	isSensitiveWriteTarget,
	readSandboxBashConfig,
	resolveLikeBuiltin,
	resolveToolTarget,
	sensitiveWriteFiles,
	type ReadDenyInput,
} from "./deny-core.ts";

describe("tool families", () => {
	it("exposes the expected built-in tool groupings", () => {
		assert.deepEqual([...DENY_READ_TOOLS].sort(), ["find", "grep", "ls", "read"]);
		assert.deepEqual([...WRITE_TOOLS].sort(), ["edit", "write"]);
		assert.deepEqual([...SEARCH_TOOLS].sort(), ["find", "grep"]);
		assert.deepEqual([...CWD_DEFAULT_TOOLS].sort(), ["find", "grep", "ls"]);
	});
});

describe("SENSITIVE_FILE_NAMES / sensitiveWriteFiles", () => {
	it("covers every required config/credential file name", () => {
		for (const name of [
			"auth.json", "oauth.json", "trust.json", "settings.json", "models.json",
			"models-store.json", "path-scope.json", "sandbox-bash.json", "bash-guard.json",
		]) {
			assert.ok(SENSITIVE_FILE_NAMES.includes(name as (typeof SENSITIVE_FILE_NAMES)[number]), name);
		}
	});
	it("derives absolute agent-dir paths and parent-dir paths from getAgentDir()", () => {
		const files = sensitiveWriteFiles("/Users/mz/.pi/agent");
		assert.ok(files.includes("/Users/mz/.pi/agent/auth.json"));
		assert.ok(files.includes("/Users/mz/.pi/agent/path-scope.json"));
		assert.ok(files.includes("/Users/mz/.pi/models.json"));
		assert.ok(files.includes("/Users/mz/.pi/settings.json"));
		assert.equal(files.length, SENSITIVE_FILE_NAMES.length * 2);
		assert.ok(files.every((f) => typeof f === "string" && f.startsWith("/")));
	});
});

describe("isPathCoveredBy", () => {
	it("covers equal, nested and detached cases", () => {
		assert.ok(isPathCoveredBy("/a/b", "/a"));
		assert.ok(isPathCoveredBy("/a", "/a"));
		assert.ok(!isPathCoveredBy("/ab", "/a"));
		assert.ok(!isPathCoveredBy("/a", "/a/b"));
		assert.ok(!isPathCoveredBy("/other", "/a"));
	});
});

describe("resolveLikeBuiltin (resolveToCwd parity)", () => {
	const cwd = "/srv/proj";

	it("anchors relative paths to the cwd and normalizes separators", () => {
		assert.equal(resolveLikeBuiltin("./x/../y.txt", cwd), "/srv/proj/y.txt");
		assert.equal(resolveLikeBuiltin("../y.txt", cwd), "/srv/y.txt");
		assert.equal(resolveLikeBuiltin("sub/dir", cwd), "/srv/proj/sub/dir");
	});
	it("keeps absolute paths absolute (lexically normalized, symlinks untouched)", () => {
		assert.equal(resolveLikeBuiltin("/usr/local/../bin", cwd), "/usr/bin");
		assert.equal(resolveLikeBuiltin("@/abs/x", cwd), "/abs/x");
	});
	it("expands ~ and ~/ like the built-ins", () => {
		assert.equal(resolveLikeBuiltin("~", cwd), homedir());
		assert.equal(resolveLikeBuiltin("~/x", cwd), join(homedir(), "x"));
		// ~user is NOT expanded by the built-ins either.
		assert.equal(resolveLikeBuiltin("~other/x", cwd), join(cwd, "~other", "x"));
	});
	it("strips a leading @ (built-in stripAtPrefix)", () => {
		assert.equal(resolveLikeBuiltin("@README.md", cwd), join(cwd, "README.md"));
	});
	it("collapses unicode spaces to a plain space (built-in normalizeUnicodeSpaces)", () => {
		assert.equal(resolveLikeBuiltin("a\u00a0b", cwd), join(cwd, "a b"));
		assert.equal(resolveLikeBuiltin("c\u2003d", cwd), join(cwd, "c d"));
	});
	it("does NOT trim the input (the built-in passes the raw string)", () => {
		assert.equal(resolveLikeBuiltin("x ", cwd), join(cwd, "x "));
	});
	it("decodes file: URLs like the built-ins", () => {
		const result = resolveLikeBuiltin("file:///etc/hosts", cwd);
		assert.equal(result, "/etc/hosts");
	});
});

describe("canonicalizePath / resolveToolTarget", () => {
	it("resolves symlinked ancestors and appends the missing suffix", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-canon-"));
		try {
			const real = join(base, "real");
			mkdirSync(real);
			const link = join(base, "link");
			symlinkSync(real, link);
			// canonicalizePath resolves the FULL chain (macOS /var -> /private/var).
			assert.equal(canonicalizePath(`${link}/newsub`), join(realpathSync(real), "newsub"));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("fails closed on a broken symlink ancestor", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-canon-"));
		try {
			symlinkSync(join(base, "missing"), join(base, "broken"));
			assert.equal(canonicalizePath(`${base}/broken/x`), undefined);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("readSandboxBashConfig", () => {
	it("returns absent when the file does not exist", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-cfg-"));
		try {
			assert.equal(readSandboxBashConfig(join(base, "nope.json")).status, "absent");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("returns valid + denyRead for a well-formed config", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-cfg-"));
		try {
			const file = join(base, "sandbox-bash.json");
			writeFileSync(file, JSON.stringify({ enabled: true, denyRead: ["~/.ssh", "~/.aws"] }));
			const result = readSandboxBashConfig(file);
			assert.equal(result.status, "valid");
			assert.deepEqual(result.denyRead, ["~/.ssh", "~/.aws"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("is valid without denyRead (empty deny list)", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-cfg-"));
		try {
			const file = join(base, "sandbox-bash.json");
			writeFileSync(file, JSON.stringify({ allowWrite: ["/tmp"] }));
			const result = readSandboxBashConfig(file);
			assert.equal(result.status, "valid");
			assert.deepEqual(result.denyRead, []);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("flags invalid JSON, unknown keys and malformed denyRead as invalid", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-cfg-"));
		try {
			const file = join(base, "sandbox-bash.json");
			writeFileSync(file, "{ not json");
			assert.equal(readSandboxBashConfig(file).status, "invalid");

			writeFileSync(file, JSON.stringify({ bogus: 1 }));
			assert.equal(readSandboxBashConfig(file).status, "invalid");

			writeFileSync(file, JSON.stringify({ denyRead: ["/ok", 42] }));
			assert.equal(readSandboxBashConfig(file).status, "invalid");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("treats an unreadable path (non-ENOENT error) as invalid, never as absent", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-cfg-"));
		try {
			const blocker = join(base, "blocker");
			writeFileSync(blocker, "x");
			// parent component is a regular file -> ENOTDIR, definitely not ENOENT.
			const result = readSandboxBashConfig(join(blocker, "sandbox-bash.json"));
			assert.equal(result.status, "invalid");
			assert.match(result.reason ?? "", /cannot read file/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("treats an unreadable file (mode 000) as invalid when running unprivileged", (t) => {
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			t.skip("running as root: mode bits do not block reads");
			return;
		}
		const base = mkdtempSync(join(tmpdir(), "dc-cfg-"));
		try {
			const file = join(base, "sandbox-bash.json");
			writeFileSync(file, JSON.stringify({ denyRead: ["/x"] }));
			chmodSync(file, 0o000);
			let threw = false;
			try {
				readSandboxBashConfig(file);
			} catch {
				threw = true;
			}
			// readFileSync is wrapped: it must return invalid, not throw.
			assert.equal(threw, false);
			assert.equal(readSandboxBashConfig(file).status, "invalid");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("evaluateReadDeny", () => {
	const base: ReadDenyInput = {
		toolName: "read",
		target: "/Users/mz/.ssh/config",
		denyRoots: ["/Users/mz/.ssh"],
		configBroken: false,
	};

	it("does not gate tools outside the read family", () => {
		for (const tool of ["write", "edit", "bash", "powershell"]) {
			assert.deepEqual(evaluateReadDeny({ ...base, toolName: tool }), { block: false });
		}
	});
	it("allows when there are no deny roots", () => {
		assert.deepEqual(evaluateReadDeny({ ...base, denyRoots: [] }), { block: false });
	});
	it("blocks when the direct target is at/under a deny root (read/ls)", () => {
		for (const tool of ["read", "ls"]) {
			const result = evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz/.ssh/known_hosts" });
			assert.equal(result.block, true);
			const exact = evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz/.ssh" });
			assert.equal(exact.block, true);
			assert.match((exact as { reason: string }).reason, /denyRead/);
		}
	});
	it("allows disjoint targets for read/ls", () => {
		for (const tool of ["read", "ls"]) {
			assert.deepEqual(
				evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz/.ssh-backup/x" }),
				{ block: false },
			);
			assert.deepEqual(
				evaluateReadDeny({ ...base, toolName: tool, target: "/var/log/a.txt" }),
				{ block: false },
			);
		}
	});
	it("supports exact-file denies", () => {
		const result = evaluateReadDeny({
			...base,
			denyRoots: ["/Users/mz/.ssh/id_rsa"],
			target: "/Users/mz/.ssh/id_rsa",
		});
		assert.equal(result.block, true);
		// sibling files under the same dir are NOT covered by an exact-file deny.
		assert.deepEqual(
			evaluateReadDeny({ ...base, denyRoots: ["/Users/mz/.ssh/id_rsa"], target: "/Users/mz/.ssh/config" }),
			{ block: false },
		);
	});
	it("does not let an uncanonicalizable target affect default reads", () => {
		const result = evaluateReadDeny({ ...base, target: undefined });
		assert.deepEqual(result, { block: false });
	});
	it("grep/find: blocks a search root that CONTAINS a deny root (ancestor)", () => {
		for (const tool of ["grep", "find"]) {
			const result = evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz" });
			assert.equal(result.block, true, tool);
			assert.match((result as { reason: string }).reason, /递归搜索|敏感根/);
		}
	});
	it("grep/find: blocks a search root AT/UNDER a deny root", () => {
		for (const tool of ["grep", "find"]) {
			assert.equal(evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz/.ssh/nested" }).block, true);
			assert.equal(evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz/.ssh" }).block, true);
		}
	});
	it("grep/find: allows disjoint search roots", () => {
		for (const tool of ["grep", "find"]) {
			assert.deepEqual(
				evaluateReadDeny({ ...base, toolName: tool, target: "/Users/mz/workspace" }),
				{ block: false },
			);
		}
	});
	it("a file deny does NOT turn an unrelated parent-dir search into a block (only the file itself is denied)", () => {
		// deny root is the FILE ~/.ssh/id_rsa; searching ~/.ssh recurses into it —
		// wait: searching ~/.ssh CONTAINS the deny file, so the ancestor rule blocks.
		const result = evaluateReadDeny({
			toolName: "grep",
			target: "/Users/mz/.ssh",
			denyRoots: ["/Users/mz/.ssh/id_rsa"],
			configBroken: false,
		});
		assert.equal(result.block, true);
	});
	it("invalid/unreadable sandbox-bash.json leaves default reads allowed", () => {
		for (const tool of ["read", "ls", "grep", "find"]) {
			const result = evaluateReadDeny({
				toolName: tool,
				target: "/Users/mz/anything.txt",
				denyRoots: [],
				configBroken: true,
				configReason: "invalid JSON (SyntaxError)",
			});
			assert.deepEqual(result, { block: false }, tool);
		}
	});
});

describe("deny read flow: builtin-style resolution + canonicalize (real fs)", () => {
	function fsBase(): string {
		const base = mkdtempSync(join(tmpdir(), "dc-flow-"));
		const secret = join(base, "secret");
		mkdirSync(secret);
		writeFileSync(join(secret, "data.txt"), "x");
		symlinkSync(secret, join(base, "alias"));
		return base;
	}

	it("blocks a symlink spelling of a denied path", () => {
		const base = fsBase();
		try {
			const root = canonicalizePath(join(base, "secret"));
			assert.ok(root !== undefined);
			// direct target via the symlinked alias resolves to the deny root.
			const target = resolveToolTarget(join(base, "alias", "data.txt"), base);
			assert.equal(target, join(root, "data.txt"));
			assert.equal(evaluateReadDeny({ toolName: "read", target, denyRoots: [root], configBroken: false }).block, true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("blocks a `..` detour that resolves into the deny root", () => {
		const base = fsBase();
		try {
			const root = canonicalizePath(join(base, "secret"));
			assert.ok(root !== undefined);
			const detour = resolveToolTarget(join(base, "other", "..", "secret", "data.txt"), base);
			assert.equal(detour, join(root, "data.txt"));
			assert.equal(evaluateReadDeny({ toolName: "read", target: detour, denyRoots: [root], configBroken: false }).block, true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("grep/find default a missing path to the cwd (deny ancestor rule fires)", () => {
		const base = fsBase();
		try {
			const root = canonicalizePath(join(base, "secret"));
			assert.ok(root !== undefined);
			// searching cwd (= base) contains the deny root -> ancestor rule blocks.
			const target = resolveToolTarget(".", base);
			assert.equal(target, canonicalizePath(base));
			assert.equal(
				evaluateReadDeny({ toolName: "grep", target, denyRoots: [root], configBroken: false }).block,
				true,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("read of a broken-symlink target is not affected by denyRead", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-flow-"));
		try {
			symlinkSync(join(base, "missing"), join(base, "broken"));
			const target = resolveToolTarget(join(base, "broken", "x"), base);
			assert.equal(target, undefined);
			assert.equal(
				evaluateReadDeny({ toolName: "read", target, denyRoots: [join(base, "secret")], configBroken: false }).block,
				false,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("relative deny roots are anchored to the session cwd like the Seatbelt side", () => {
		const base = fsBase();
		try {
			const root = canonicalizePath(join(base, "secret"));
			assert.ok(root !== undefined);
			// deny entry "secret" anchored at base, canonicalized with the same helper.
			const denyRoot = canonicalizePath(resolveLikeBuiltin("secret", base));
			assert.equal(denyRoot, root);
			const target = resolveToolTarget("secret/data.txt", base);
			assert.equal(
				evaluateReadDeny({ toolName: "read", target, denyRoots: [denyRoot ?? "secret"], configBroken: false }).block,
				true,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("canonicalizeDenyEntries (per-entry isolation, shared handling)", () => {
	it("skips an illegal file: URL entry without throwing and keeps the valid ones", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-deny-"));
		try {
			const good = join(base, "secret");
			mkdirSync(good);
			const skipped: Array<[string, string]> = [];
			const roots = canonicalizeDenyEntries(["file://%zz", good, "file://[invalid"], base, (entry, reason) =>
				skipped.push([entry, reason]),
			);
			// fileURLToPath throws on these inputs; the shared helper must isolate
			// the failure per entry instead of letting the tool_call handler throw.
			assert.equal(roots.length, 1);
			assert.equal(roots[0], canonicalizePath(good));
			assert.equal(skipped.length, 2);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("skips an unresolvable (broken-symlink) entry without affecting other reads", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-deny-"));
		try {
			const good = join(base, "good");
			mkdirSync(good);
			symlinkSync(join(base, "missing"), join(base, "broken"));
			const skipped: string[] = [];
			const roots = canonicalizeDenyEntries([`${base}/broken/x`, good], base, (entry) => skipped.push(entry));
			assert.deepEqual(roots, [canonicalizePath(good)]);
			assert.deepEqual(skipped, [`${base}/broken/x`]);
			// The surviving root still gates its subtree (extraRoots flow untouched).
			const target = resolveToolTarget(join(good, "f.txt"), base);
			assert.equal(evaluateReadDeny({ toolName: "read", target, denyRoots: roots, configBroken: false }).block, true);
			const other = resolveToolTarget(join(base, "elsewhere.txt"), base);
			assert.deepEqual(evaluateReadDeny({ toolName: "read", target: other, denyRoots: roots, configBroken: false }), { block: false });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
	it("never throws: even a throwing onSkip reporter is contained", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-deny-"));
		try {
			const roots = canonicalizeDenyEntries(["file://%zz"], base, () => {
				throw new Error("reporter boom");
			});
			assert.deepEqual(roots, []);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("sensitive write protection with dangling symlinks (enabled:false must still block)", () => {
	function agentTree(missingAuth: boolean): { base: string; agent: string; auth: string; link: string } {
		const base = mkdtempSync(join(tmpdir(), "dc-sens-"));
		const agent = join(base, ".pi", "agent");
		mkdirSync(agent, { recursive: true });
		const auth = join(agent, "auth.json");
		if (!missingAuth) writeFileSync(auth, "{}");
		const link = join(base, "link-auth.json");
		symlinkSync(auth, link);
		if (missingAuth) rmSync(auth, { force: true });
		return { base, agent, auth, link };
	}

	it("canonicalizePath alone misses a dangling symlink; the write-aware form still resolves it", () => {
		const { base, auth, link } = agentTree(true);
		try {
			assert.equal(canonicalizePath(link), undefined);
			assert.equal(canonicalizeForWriteTarget(link), canonicalizeForWriteTarget(auth));
			assert.ok((canonicalizeForWriteTarget(auth) ?? "").endsWith("auth.json"));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("blocks a dangling symlink to a not-yet-existing sensitive config file", () => {
		const { base, agent, link } = agentTree(true);
		try {
			// The check is cwd-independent and runs before the enabled flag, so it
			// must hold even when path-scope is disabled: assert the pure helper
			// (the handler calls it before isEnabled) blocks the dangling link.
			assert.equal(isSensitiveWriteTarget(link, base, agent), true);
			assert.equal(isSensitiveWriteTarget(link, "/tmp", agent), true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("blocks the direct path and a symlink to an existing sensitive file", () => {
		const { base, agent, auth, link } = agentTree(false);
		try {
			assert.equal(isSensitiveWriteTarget(auth, base, agent), true);
			assert.equal(isSensitiveWriteTarget(link, base, agent), true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("does not block unrelated dangling symlinks and never throws on illegal input", () => {
		const { base, agent } = agentTree(true);
		try {
			const other = join(base, "other-link");
			symlinkSync(join(base, "nowhere.json"), other);
			assert.equal(isSensitiveWriteTarget(other, base, agent), false);
			assert.equal(isSensitiveWriteTarget("file://%zz", base, agent), false);
			assert.equal(isSensitiveWriteTarget("", base, agent), false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("derives absolute agent-dir forms (raw + canonical) without reading contents", () => {
		const base = mkdtempSync(join(tmpdir(), "dc-sens-"));
		try {
			const agent = join(base, ".pi", "agent");
			mkdirSync(agent, { recursive: true });
			const forms = buildSensitiveWriteForms(agent);
			assert.ok(forms.includes(join(agent, "auth.json")));
			assert.ok(forms.includes(join(dirname(agent), "models.json")));
			assert.ok(forms.every((f) => f.startsWith("/")));
			// A symlinked agent-dir spelling resolves to the same canonical form.
			const alias = join(base, "agent-alias");
			symlinkSync(agent, alias);
			const aliasForms = buildSensitiveWriteForms(alias);
			const canonicalAuth = canonicalizePath(join(agent, "auth.json"));
			assert.ok(canonicalAuth !== undefined);
			assert.ok(aliasForms.includes(canonicalAuth), aliasForms.join(","));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
