/**
 * Bash Guard — unit tests (pure core logic).
 *
 * Run from this directory:
 *   volta run node --test core.test.ts
 *
 * No Pi runtime or third-party deps required; Node 24 runs TypeScript natively.
 */

import { describe, it, test } from "node:test";
import assert from "node:assert";
import { homedir } from "node:os";
import {
	DEFAULT_DANGEROUS_RULES,
	analyseScopeExemption,
	compileRules,
	isAllowlisted,
	isPathCoveredBy,
	isPathStrictlyInside,
	lexCommand,
	normalizeCommand,
	resolveOperandPath,
	validateBashGuardConfig,
	type BashGuardConfig,
	type ScopeAnalysisResult,
} from "./core.ts";
import { resolve } from "node:path";

const rules = compileRules([], () => {});

/** Returns the first matched rule name, or undefined when safe. */
function whichRule(command: string): string | undefined {
	const normalized = normalizeCommand(command);
	return rules.find((r) => r.pattern.test(normalized))?.name;
}

describe("normalizeCommand", () => {
	it("collapses runs of whitespace", () => {
		assert.equal(normalizeCommand("  sudo   rm   -rf  /x  "), "sudo rm -rf /x");
	});
	it("strips leading/trailing whitespace", () => {
		assert.equal(normalizeCommand("\t echo hi \n"), "echo hi");
	});
	it("collapses whitespace inside quotes too (conservative normalization)", () => {
		assert.equal(normalizeCommand("echo 'a  b'"), "echo 'a b'");
	});
});

describe("isAllowlisted", () => {
	it("matches an exact command", () => {
		assert.equal(isAllowlisted("npm install", ["npm install"]), true);
	});
	it("matches a command prefixed by an allowlist entry", () => {
		assert.equal(isAllowlisted("npm install lodash", ["npm install"]), true);
	});
	it("does not match a mere substring", () => {
		assert.equal(isAllowlisted("npm uninstall", ["npm install"]), false);
	});
	it("trims allowlist entries before matching", () => {
		assert.equal(isAllowlisted("npm run build", ["  npm run "]), true);
	});
	it("returns false for an empty allowlist", () => {
		assert.equal(isAllowlisted("anything", []), false);
	});
});

describe("validateBashGuardConfig", () => {
	it("accepts a full valid config", () => {
		const result = validateBashGuardConfig({
			enabled: true,
			mode: "ask",
			noUI: "block",
			allowlist: ["npm run build"],
			patterns: ["\\bfoo\\b"],
		});
		assert.ok("config" in result);
	});
	it("accepts an empty object", () => {
		assert.ok("config" in validateBashGuardConfig({}));
	});
	it("rejects non-object input", () => {
		for (const bad of [null, undefined, 42, "x", [1]]) {
			assert.ok("error" in validateBashGuardConfig(bad), `should reject ${JSON.stringify(bad)}`);
		}
	});
	it("rejects unknown keys", () => {
		assert.ok("error" in validateBashGuardConfig({ bogus: 1 }));
	});
	it("rejects a wrong mode", () => {
		assert.ok("error" in validateBashGuardConfig({ mode: "nope" }));
	});
	it("rejects a wrong noUI", () => {
		assert.ok("error" in validateBashGuardConfig({ noUI: "nope" }));
	});
	it("rejects a non-boolean enabled", () => {
		assert.ok("error" in validateBashGuardConfig({ enabled: "yes" }));
	});
	it("rejects non-string / empty allowlist entries", () => {
		assert.ok("error" in validateBashGuardConfig({ allowlist: ["ok", 123] }));
		assert.ok("error" in validateBashGuardConfig({ allowlist: [""] }));
	});
	it("rejects non-string / empty patterns", () => {
		assert.ok("error" in validateBashGuardConfig({ patterns: ["ok", 123] }));
		assert.ok("error" in validateBashGuardConfig({ patterns: [""] }));
	});
	it("rejects a non-boolean scopeExempt", () => {
		assert.ok("error" in validateBashGuardConfig({ scopeExempt: "yes" }));
	});
	it("accepts scopeExempt", () => {
		const result = validateBashGuardConfig({ scopeExempt: false });
		if ("config" in result) assert.equal(result.config.scopeExempt, false);
		else assert.fail("expected valid config");
	});
	it("round-trips a minimal config onto a typed shape", () => {
		const result = validateBashGuardConfig({ mode: "block", allowlist: ["a"] });
		if ("config" in result) {
			const c: BashGuardConfig = result.config;
			assert.equal(c.mode, "block");
			assert.deepStrictEqual(c.allowlist, ["a"]);
		} else {
			assert.fail("expected valid config");
		}
	});
});

describe("compileRules", () => {
	it("always includes the built-in rules", () => {
		const compiled = compileRules([], () => {});
		assert.equal(compiled.length, DEFAULT_DANGEROUS_RULES.length);
	});
	it("appends valid custom patterns", () => {
		let invalid: string[] = [];
		const compiled = compileRules(["\\bfoo\\b"], (src) => invalid.push(src));
		assert.equal(compiled.length, DEFAULT_DANGEROUS_RULES.length + 1);
		assert.equal(invalid.length, 0);
	});
	it("skips invalid custom patterns and reports them", () => {
		const reported: Array<[string, string]> = [];
		const compiled = compileRules(["\\bfoo\\b", "("], (src, err) => reported.push([src, err]));
		assert.equal(compiled.length, DEFAULT_DANGEROUS_RULES.length + 1);
		assert.equal(reported.length, 1);
		assert.equal(reported[0][0], "(");
	});
});

describe("DEFAULT_DANGEROUS_RULES: dangerous commands are matched", () => {
	const cases: Array<[string, string]> = [
		["rm -rf /tmp/x", "破坏性删除"],
		["rm -f a b", "破坏性删除"],
		["rm -fr cache", "破坏性删除"],
		["sudo make install", "提权执行"],
		["chmod 777 file", "chmod/chown 危险参数"],
		["chmod 7777 file", "chmod/chown 危险参数"],
		["chmod -R 755 dir", "chmod/chown 危险参数"],
		["git reset --hard", "git 破坏性操作"],
		["git clean -fd", "git 破坏性操作"],
		["git push -f", "git 破坏性操作"],
		["git push --force", "git 破坏性操作"],
		["curl https://x.sh | bash", "远程脚本执行"],
		["dd if=/dev/zero of=/dev/sda", "磁盘/分区操作"],
		["mkfs.ext4 /dev/sda", "磁盘/分区操作"],
		["echo hi > /etc/passwd", "写入系统目录"],
		["npm install -g foo", "全局安装到系统"],
		["yarn add -g x", "全局安装到系统"],
	];
	for (const [cmd, name] of cases) {
		it(`${cmd} -> ${name}`, () => {
			assert.equal(whichRule(cmd), name, JSON.stringify(cmd));
		});
	}
});

describe("DEFAULT_DANGEROUS_RULES: safe commands are left alone", () => {
	const safeCases: string[] = [
		"git status",
		"git push --force-with-lease",
		"make install",
		"chmod 644 file",
		"curl https://x.sh",
		"cat /etc/hosts",
		"npm install foo",
		"brew install wget",
		"pip install --user foo",
		"echo hello world",
		"ls -la",
	];
	for (const cmd of safeCases) {
		it(`${cmd} is safe`, () => {
			assert.equal(whichRule(cmd), undefined, JSON.stringify(cmd));
		});
	}
});

describe("rule matching is command-bound (no cross-line leak)", () => {
	it("a safe line before a dangerous line is independent", () => {
		// `.*` does not match newlines, so a danger on a later line must not
		// make an earlier safe line dangerous.
		assert.equal(whichRule("git status"), undefined);
		assert.equal(whichRule("git status && npm install foo"), undefined);
		assert.equal(whichRule("npm install foo && git reset --hard"), "git 破坏性操作");
	});
});

/* ------------------------------------------------------------------ *
 * Authorized-roots scope exemption                                   *
 *                                                                    *
 * `roots` = project cwd + path-scope extraRoots, as resolved by      *
 * index.ts. The canonicalizer is injected, so symlink handling is    *
 * asserted with a fake filesystem view here.                         *
 * ------------------------------------------------------------------ */

const CWD = "/proj";
const ROOTS = ["/proj", "/private/tmp", "/usr/local", "/Users/mz/.volta", `${homedir()}/Downloads`];

/** Fake realpath: `/tmp` -> `/private/tmp`, `proj/escape` -> `/Users/mz`, one broken link. */
function canonicalize(absolute: string): string | undefined {
	// Walk the symlink first, then let `..` resolve against the *real* parent.
	const throughLinks = absolute.replace(/^\/proj\/escape/, "/Users/mz");
	const walked = resolve(throughLinks);
	if (walked === "/tmp") return "/private/tmp";
	if (walked.startsWith("/tmp/")) return `/private/tmp${walked.slice(4)}`;
	if (walked === "/proj/link-out") return "/etc/passwd";
	if (walked === "/proj/broken") return undefined; // broken symlink -> fail closed
	return walked;
}

function analyse(command: string, extra?: Partial<{ roots: string[]; sensitiveDirs: string[]; projectRoot: string; cwd: string }>): ScopeAnalysisResult {
	return analyseScopeExemption(command, {
		cwd: extra?.cwd ?? CWD,
		roots: extra?.roots ?? ROOTS,
		sensitiveDirs: extra?.sensitiveDirs,
		projectRoot: extra?.projectRoot,
		canonicalize,
	});
}

/** Mirror of the index.ts decision flow: which rule fires, and is it exempted? */
function verdict(command: string): { rule?: string; exempt: boolean; reason?: string } {
	const matched = whichRule(command);
	if (!matched) return { exempt: false };
	const rule = rules.find((r) => r.name === matched);
	if (!rule?.scopeExempt) return { rule: matched, exempt: false };
	const result = analyse(command);
	return result.exempt
		? { rule: matched, exempt: true }
		: { rule: matched, exempt: false, reason: result.reason };
}

describe("which rules may be scope-exempted", () => {
	it("exempts only the boundary rules", () => {
		const byName = new Map(DEFAULT_DANGEROUS_RULES.map((r) => [r.name, Boolean(r.scopeExempt)]));
		assert.equal(byName.get("破坏性删除"), true);
		assert.equal(byName.get("写入系统目录"), true);
		for (const name of ["提权执行", "chmod/chown 危险参数", "git 破坏性操作", "远程脚本执行", "磁盘/分区操作", "全局安装到系统"]) {
			assert.equal(byName.get(name), false, `${name} must never be scope-exempt`);
		}
	});
	it("does not exempt custom patterns", () => {
		const compiled = compileRules(["\\brm\\b"], () => {});
		const custom = compiled[compiled.length - 1];
		assert.equal(custom.scopeExempt, undefined);
	});
	it("compileRules preserves the scopeExempt flag", () => {
		const compiled = compileRules([], () => {});
		assert.equal(compiled.find((r) => r.name === "破坏性删除")?.scopeExempt, true);
		assert.notEqual(compiled.find((r) => r.name === "破坏性删除"), DEFAULT_DANGEROUS_RULES[0], "copies, not shared objects");
	});
});

describe("lexCommand", () => {
	it("splits simple segments and keeps their order", () => {
		const segments = lexCommand("rm -rf a && rm -f b; rm c | bash");
		assert.ok(segments);
		assert.deepStrictEqual(segments?.map((s) => s.tokens), [["rm", "-rf", "a"], ["rm", "-f", "b"], ["rm", "c"], ["bash"]]);
	});
	it("captures redirect targets, including glued and >> / &> / 2>", () => {
		assert.deepStrictEqual(lexCommand("echo x > /tmp/a")?.[0].redirectTargets, ["/tmp/a"]);
		assert.deepStrictEqual(lexCommand("echo x >/tmp/a")?.[0].redirectTargets, ["/tmp/a"]);
		assert.deepStrictEqual(lexCommand("echo x >> /tmp/a")?.[0].redirectTargets, ["/tmp/a"]);
		assert.deepStrictEqual(lexCommand("echo x &> /tmp/a")?.[0].redirectTargets, ["/tmp/a"]);
		assert.deepStrictEqual(lexCommand("echo x 2> /tmp/a")?.[0].redirectTargets, ["/tmp/a"]);
	});
	it("keeps a quoted operand as one token", () => {
		assert.deepStrictEqual(lexCommand("rm -rf 'my dir'")?.[0].tokens, ["rm", "-rf", "my dir"]);
	});
	it("treats a newline as a command separator", () => {
		assert.deepStrictEqual(
			lexCommand("rm -rf ./a\nrm -f /tmp/b")?.map((s) => s.tokens),
			[["rm", "-rf", "./a"], ["rm", "-f", "/tmp/b"]],
		);
	});
	it("refuses expansion, globs, subshells, heredocs and dangling redirects", () => {
		for (const command of [
			"rm -rf $DIR",
			'rm -rf "${DIR}/x"',
			"rm -rf `pwd`",
			"rm -rf /tmp/*",
			"rm -rf /tmp/?.log",
			"rm -rf /tmp/{a,b}",
			"(cd /tmp && rm -rf x)",
			"echo x > /tmp/a; cat < /tmp/a",
			"echo x > /tmp/a 2>&1",
			"rm -rf a &&",
			"rm -rf '\"",
			"echo x >",
			"rm -rf a\\b",
		]) {
			assert.equal(lexCommand(command), undefined, `should refuse to analyse: ${command}`);
		}
	});
});

describe("isPathStrictlyInside", () => {
	it("requires a strict descendant", () => {
		assert.equal(isPathStrictlyInside("/proj", "/proj/build"), true);
		assert.equal(isPathStrictlyInside("/proj", "/proj"), false);
		assert.equal(isPathStrictlyInside("/proj", "/projx/build"), false);
		assert.equal(isPathStrictlyInside("/proj", "/other/build"), false);
		assert.equal(isPathStrictlyInside("/proj", "/"), false);
	});
});

describe("isPathCoveredBy", () => {
	it("includes the root itself", () => {
		assert.equal(isPathCoveredBy("/proj", "/proj"), true);
		assert.equal(isPathCoveredBy("/proj/build", "/proj"), true);
		assert.equal(isPathCoveredBy("/projx", "/proj"), false);
		assert.equal(isPathCoveredBy("/", "/proj"), false);
		assert.equal(isPathCoveredBy("/proj", "/"), true);
	});
});

describe("resolveOperandPath", () => {
	it("anchors relative operands to the session cwd", () => {
		assert.equal(resolveOperandPath("/proj", "build"), "/proj/build");
		assert.equal(resolveOperandPath("/proj", "./a/b"), "/proj/a/b");
		assert.equal(resolveOperandPath("/proj", "a//../b"), "/proj/a/../b");
	});
	it("expands ~ and keeps `..` for the filesystem to resolve", () => {
		assert.equal(resolveOperandPath("/proj", "~"), homedir());
		assert.equal(resolveOperandPath("/proj", "~/Downloads/x"), `${homedir()}/Downloads/x`);
		// Collapsing `/a/link/../b` to `/a/b` lexically would be wrong: `..` is
		// resolved against the *real* directory behind `link`, so the `..` must
		// survive until realpath sees it.
		assert.equal(resolveOperandPath("/proj", "/tmp/../tmp/x"), "/tmp/../tmp/x");
		assert.equal(resolveOperandPath("/proj", "./a/../b"), "/proj/a/../b");
		assert.equal(resolveOperandPath("/proj", "."), "/proj");
	});
	it("rejects unusable operands", () => {
		assert.equal(resolveOperandPath("/proj", "-"), undefined);
		assert.equal(resolveOperandPath("/proj", "   "), undefined);
		assert.equal(resolveOperandPath("/proj", "a\0b"), undefined);
	});
});

describe("analyseScopeExemption: in-scope writes are exempt", () => {
	const exempt: string[] = [
		"rm -rf ./build",
		"rm -f dist/app.js",
		"rm -rf /tmp/x",
		"rm -rf /private/tmp/x /proj/build",
		`rm -rf ${homedir()}/Downloads/dl.zip`,
		"rm -rf ./a && rm -fr ./b",
		"touch ./new-file",
		// 写入系统目录 false positive: ~/.volta/bin is an authorized extraRoot.
		"echo x > /Users/mz/.volta/bin/node",
		"echo x >> /usr/local/bin/wrapper",
		"echo x | tee /usr/local/etc/profile",
	];
	for (const command of exempt) {
		it(command, () => {
			const result = analyse(command);
			assert.equal(result.exempt, true, JSON.stringify(result));
		});
	}
});

describe("analyseScopeExemption: everything else stays guarded (fail closed)", () => {
	const guarded: Array<[string, string]> = [
		["rm -rf .", "授权根"],
		["rm -rf /", "授权根"],
		["rm -rf /tmp", "授权根"],
		["rm -rf /etc/x", "授权根"],
		["rm -rf ./a /etc/b", "授权根"],
		["rm -rf", "未给出目标路径"],
		["rm -rf --no-preserve-root /", "选项不在可豁免范围"],
		["rm -rf --help /etc", "授权根"],
		["rm -rf ./link-out", "越出授权根"],
		["rm -rf ./broken", "无法安全规范化"],
		// `./escape` is a symlink to /Users/mz, so `./escape/../mz/secrets` really is
		// /Users/mz/secrets — a lexical collapse to ./mz/secrets must not be trusted.
		["rm -rf ./escape/../mz/secrets", "越出授权根"],
		["rm -rf ./escape/notes.txt", "越出授权根"],
		["rm -rf $DIR/x", "shell 语法"],
		["rm -rf ./node_modules/*", "shell 语法"],
		["sudo rm -rf ./build", "不在可豁免集合内"],
		["cd /tmp && rm -rf ./x", "不在可豁免集合内"],
		["find . -name x -exec rm -rf {} ;", "shell 语法"],
		["xargs rm -rf < list", "shell 语法"],
		["echo x > /etc/passwd", "授权根"],
		["tee /usr/bin/thing", "授权根"],
	];
	for (const [command, reasonFragment] of guarded) {
		it(`${command} -> guarded`, () => {
			const result = analyse(command);
			assert.equal(result.exempt, false, JSON.stringify(result));
			if ("reason" in result) {
				assert.ok(result.reason.includes(reasonFragment), `${command}: ${result.reason}`);
			}
		});
	}
});

describe("broad roots never override the protected pi config dirs", () => {
	const PI_DIR = ["/Users/mz/.pi", "/Users/mz/.pi/agent"];
	const broad = (command: string) => analyse(command, { roots: ["/"], sensitiveDirs: PI_DIR });

	it("exempts ordinary paths under a very broad root", () => {
		for (const command of ["rm -rf /var/log/app.log", "echo x > /usr/local/bin/wrapper"]) {
			assert.equal(broad(command).exempt, true, command);
		}
	});
	it("still guards the pi credential dirs inside that root", () => {
		for (const command of [
			"rm -rf /Users/mz/.pi/agent/auth.json",
			"rm -rf /Users/mz/.pi/settings.json",
			"echo x > /Users/mz/.pi/agent/models.json",
		]) {
			const result = broad(command);
			assert.equal(result.exempt, false, command);
			if ("reason" in result) assert.ok(result.reason.includes("受保护路径"), `${command}: ${result.reason}`);
		}
	});
});

describe("project cwd lives under a sensitive dir (sandbox-bash cwd priority)", () => {
	// Mirrors the real layout: cwd = ~/.pi/agent/sessions, sensitive = ~/.pi +
	// ~/.pi/agent, and a broad root (~) among the authorized roots. index.ts only
	// passes projectRoot when the cwd itself is covered by a sensitive dir.
	const PI = ["/Users/mz/.pi", "/Users/mz/.pi/agent"];
	const SESSIONS = "/Users/mz/.pi/agent/sessions";
	const analyseSessions = (command: string, withProjectRoot: boolean) =>
		analyse(command, { cwd: SESSIONS, roots: [SESSIONS, "/Users/mz"], sensitiveDirs: PI, projectRoot: withProjectRoot ? SESSIONS : undefined });

	it("exempts writes inside the project when projectRoot is passed", () => {
		const result = analyseSessions("rm -rf ./build", true);
		assert.equal(result.exempt, true, JSON.stringify(result));
	});
	it("stays guarded without projectRoot (caller did not opt in)", () => {
		const result = analyseSessions("rm -rf ./build", false);
		assert.equal(result.exempt, false, JSON.stringify(result));
		if ("reason" in result) assert.ok(result.reason.includes("受保护路径"), result.reason);
	});
	it("still guards credentials outside the cwd even with a broad root", () => {
		for (const command of ["rm -rf /Users/mz/.pi/agent/auth.json", "rm -rf /Users/mz/.pi/settings.json"]) {
			const result = analyseSessions(command, true);
			assert.equal(result.exempt, false, command);
			if ("reason" in result) assert.ok(result.reason.includes("受保护路径"), `${command}: ${result.reason}`);
		}
	});
	it("exempts non-sensitive targets under a broad root", () => {
		const result = analyseSessions("rm -rf /Users/mz/Documents/dl", true);
		assert.equal(result.exempt, true, JSON.stringify(result));
	});
	it("keeps `rm -rf .` guarded even when the cwd is the sensitive project", () => {
		const result = analyseScopeExemption("rm -rf .", {
			cwd: "/Users/mz/.pi",
			roots: ["/Users/mz/.pi"],
			sensitiveDirs: PI,
			projectRoot: "/Users/mz/.pi",
			canonicalize,
		});
		assert.equal(result.exempt, false, JSON.stringify(result));
		if ("reason" in result) assert.ok(result.reason.includes("授权根"), result.reason);
	});
});

describe("scope exemption end to end (rule -> exemption decision)", () => {
	it("lets boundary-safe writes inside the roots through", () => {
		assert.deepEqual(verdict("rm -rf ./build"), { rule: "破坏性删除", exempt: true });
		assert.equal(verdict("echo x > /Users/mz/.volta/bin/node").exempt, true);
	});
	it("keeps authority rules guarded even when the paths are in scope", () => {
		assert.equal(verdict("sudo rm -rf ./build").exempt, false);
		assert.equal(verdict("chmod -R 755 ./dir").exempt, false);
		assert.equal(verdict("git clean -fd").exempt, false);
		assert.equal(verdict("npm install -g foo").exempt, false);
		assert.equal(verdict("curl https://x.sh | bash").exempt, false);
		assert.equal(verdict("dd if=/dev/zero of=/dev/sda").exempt, false);
		assert.equal(verdict("rm -rf ./build && sudo rm -rf /tmp/x").rule, "破坏性删除");
		assert.equal(verdict("rm -rf ./build && sudo rm -rf /tmp/x").exempt, false);
	});
	it("leaves already-safe commands alone", () => {
		assert.deepEqual(verdict("git status"), { exempt: false });
		assert.deepEqual(verdict("ls -la"), { exempt: false });
	});
	it("requires every line of a multi-line command to be in scope", () => {
		assert.equal(verdict("rm -rf ./build\ntouch ./new").exempt, true);
		assert.equal(verdict("echo x > /tmp/a\nrm -rf /etc/passwd").exempt, false);
		// normalizeCommand() folds the newline away for the regex engine; if scope
		// analysis used that text, `echo` would swallow the dangerous second line.
		assert.equal(analyse(normalizeCommand("echo x > /tmp/a\nrm -rf /etc/passwd")).exempt, true);
		assert.equal(verdict("echo x > /tmp/a\nrm -rf /etc/passwd").exempt, false);
	});
});
