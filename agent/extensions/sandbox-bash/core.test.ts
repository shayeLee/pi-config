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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildProfile,
	canonicalPath,
	escapeProfilePath,
	normalizeConfigPath,
	validateSandboxBashConfig,
} from "./core.ts";

describe("validateSandboxBashConfig", () => {
	it("accepts a full valid config", () => {
		const result = validateSandboxBashConfig({
			enabled: true,
			allowWrite: ["~/Downloads"],
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
	it("rejects non-string / empty allowWrite entries", () => {
		assert.ok("error" in validateSandboxBashConfig({ allowWrite: ["/a", 1] }));
		assert.ok("error" in validateSandboxBashConfig({ allowWrite: [""] }));
	});
	it("round-trips a config", () => {
		const result = validateSandboxBashConfig({ allowWrite: ["/a"] });
		if ("config" in result) {
			assert.deepStrictEqual(result.config.allowWrite, ["/a"]);
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

describe("buildProfile", () => {
	it("allows writes to cwd, /tmp, /private/tmp and the platform temp dir", () => {
		const profile = buildProfile("/real/cwd", []);
		assert.ok(profile.includes("(deny file-write*)"));
		assert.ok(profile.includes('/real/cwd"'));
		assert.ok(profile.includes('/tmp"'));
		assert.ok(profile.includes('/private/tmp"'));
		assert.ok(profile.includes(`${canonicalPath(tmpdir())}"`));
	});
	it("re-allows /dev/null and /dev/zero by literal", () => {
		const profile = buildProfile("/cwd", []);
		assert.ok(profile.includes('(literal "/dev/null")'));
		assert.ok(profile.includes('(literal "/dev/zero")'));
	});
	it("includes extra roots and expands ~ paths", () => {
		const profile = buildProfile("/cwd", ["~/Downloads"]);
		assert.ok(profile.includes(`${canonicalPath("~/Downloads")}"`));
	});
	it("does NOT restrict reads (方案 C: read is fully open)", () => {
		const profile = buildProfile("/cwd", []);
		assert.ok(!profile.includes("deny file-read"));
	});
	it("deduplicates canonicalized paths", () => {
		const profile = buildProfile("/cwd", ["/cwd"]);
		const occurrences = profile.split('/cwd"').length - 1;
		assert.equal(occurrences, 1, "cwd should appear once");
	});
});

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

describe("sandbox-exec integration (write isolation)", { skip: !existsSync(SANDBOX_EXEC) }, () => {
	it("allows writes under the project cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		try {
			const profile = buildProfile(root, []);
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
			const profile = buildProfile(root, []);
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

	it("denies writes outside the allowlist", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		const target = join(homedir(), "sb-denied-test.txt");
		try {
			const profile = buildProfile(root, []);
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

	it("allows reads anywhere (方案 C: read is open)", () => {
		const root = mkdtempSync(join(tmpdir(), "sb-cwd-"));
		try {
			const profile = buildProfile(root, []);
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
});