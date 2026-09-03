/**
 * Bash Guard — pure core logic (no Pi or fs dependency).
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested directly with `node --test` without loading the Pi runtime.
 * The extension entry point (index.ts) imports from this module.
 *
 * Path resolution only: `node:os`/`node:path` are used for `~` expansion and
 * relative-path anchoring; the filesystem side (realpath / fail-closed
 * canonicalization) is injected by the caller as `canonicalize`.
 */

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

export interface BashGuardConfig {
	enabled?: boolean;
	mode?: "ask" | "block";
	noUI?: "block" | "allow";
	allowlist?: string[];
	patterns?: string[];
	/** Explicit roots whose strict descendants may be removed without a guard. */
	rmExemptRoots?: string[];
	/**
	 * When true (default), a command whose *write/delete targets* all live inside
	 * the authorized roots (project cwd + path-scope extraRoots) is let through
	 * without a prompt — but only for the rules that exist purely because a write
	 * crosses the path boundary (`破坏性删除`, `写入系统目录`). Rules that guard
	 * authority rather than a path boundary (`sudo`, git history/remote, remote
	 * script execution, disk ops, global installs) are never exempted.
	 */
	scopeExempt?: boolean;
}

export type BashGuardConfigValidation =
	| { config: BashGuardConfig }
	| { error: string };

export interface DangerousRule {
	name: string;
	pattern: RegExp;
	/** True when "inside the authorized path roots" removes the reason to ask. */
	scopeExempt?: boolean;
}

/** Built-in danger rules. Override or extend via the `patterns` config. */
export const DEFAULT_DANGEROUS_RULES: DangerousRule[] = [
	{
		// Deleting inside the authorized roots is the same authority path-scope
		// already grants the write/edit tools, so it can be scope-exempt.
		name: "破坏性删除",
		pattern: /\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/,
		scopeExempt: true,
	},
	{
		name: "提权执行",
		pattern: /\bsudo\b/,
	},
	{
		name: "chmod/chown 危险参数",
		pattern: /\b(chmod|chown)\b.*(\b7777?\b|\s-[Rr]|\s--recursive)/,
	},
	{
		name: "git 破坏性操作",
		pattern: /\bgit\b.*(\breset\s+--hard|\bclean\b|\bpush\b.*(\s-f(?:\s|$)|\s--force(?:\s|$)))/,
	},
	{
		name: "远程脚本执行",
		pattern: /\b(curl|wget)\b.*\|\s*(ba|z)?sh\b/,
	},
	{
		name: "磁盘/分区操作",
		pattern: /\b(mkfs|fdisk|diskutil\s+eraseDisk|dd\s+if=)/,
	},
	{
		// This rule is *defined* by the path boundary: writing outside the system
		// dirs. A target that resolves inside an authorized root is exempt.
		name: "写入系统目录",
		pattern: /([>]|[&>]|>>|tee)\s*([^;\n]*)(\/etc|\/usr|\/bin|\/sbin|\/System|\/Library)\b/,
		scopeExempt: true,
	},
	{
		name: "全局安装到系统",
		pattern: /\b(npm|yarn|pnpm|pip|pip3|gem|brew)\b.*\s(-g|--global)(\s|$)/,
	},
];

/** Pure schema validation. */
export function validateBashGuardConfig(value: unknown): BashGuardConfigValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { error: "expected a JSON object" };
	}

	const allowedKeys = new Set(["enabled", "mode", "noUI", "allowlist", "patterns", "rmExemptRoots", "scopeExempt"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) return { error: `unknown property ${JSON.stringify(key)}` };
	}

	const candidate = value as Record<string, unknown>;
	if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
		return { error: "enabled must be a boolean" };
	}
	if (candidate.mode !== undefined && candidate.mode !== "ask" && candidate.mode !== "block") {
		return { error: 'mode must be "ask" or "block"' };
	}
	if (candidate.noUI !== undefined && candidate.noUI !== "block" && candidate.noUI !== "allow") {
		return { error: 'noUI must be "block" or "allow"' };
	}
	if (candidate.allowlist !== undefined && (!Array.isArray(candidate.allowlist) ||
		!candidate.allowlist.every((s) => typeof s === "string" && s.trim().length > 0))) {
		return { error: "allowlist must be an array of non-empty strings" };
	}
	if (candidate.patterns !== undefined && (!Array.isArray(candidate.patterns) ||
		!candidate.patterns.every((s) => typeof s === "string" && s.length > 0))) {
		return { error: "patterns must be an array of non-empty strings" };
	}
	if (candidate.rmExemptRoots !== undefined && (!Array.isArray(candidate.rmExemptRoots) ||
		!candidate.rmExemptRoots.every((s) => typeof s === "string" && s.trim().length > 0))) {
		return { error: "rmExemptRoots must be an array of non-empty strings" };
	}
	if (candidate.scopeExempt !== undefined && typeof candidate.scopeExempt !== "boolean") {
		return { error: "scopeExempt must be a boolean" };
	}

	const config: BashGuardConfig = {};
	if (candidate.enabled !== undefined) config.enabled = candidate.enabled as boolean;
	if (candidate.mode !== undefined) config.mode = candidate.mode as "ask" | "block";
	if (candidate.noUI !== undefined) config.noUI = candidate.noUI as "block" | "allow";
	if (candidate.allowlist !== undefined) config.allowlist = candidate.allowlist as string[];
	if (candidate.patterns !== undefined) config.patterns = candidate.patterns as string[];
	if (candidate.rmExemptRoots !== undefined) config.rmExemptRoots = candidate.rmExemptRoots as string[];
	if (candidate.scopeExempt !== undefined) config.scopeExempt = candidate.scopeExempt as boolean;
	return { config };
}

/**
 * Compile the configured extra patterns plus the built-in rules. Invalid extra
 * patterns are reported (via onInvalid) and skipped rather than throwing.
 */
export function compileRules(
	patterns: string[],
	onInvalid: (source: string, error: string) => void,
): DangerousRule[] {
	const rules: DangerousRule[] = DEFAULT_DANGEROUS_RULES.map((rule) => ({ ...rule }));
	for (const source of patterns) {
		try {
			rules.push({ name: `自定义规则: ${source}`, pattern: new RegExp(source, "i") });
		} catch (error) {
			onInvalid(source, String(error));
		}
	}
	// Fresh RegExp instances (no shared lastIndex state across .test() calls).
	for (const rule of rules) rule.pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
	return rules;
}

/** Normalize a command for matching: collapse whitespace and trim. */
export function normalizeCommand(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

/** A command in the allowlist (equal to, or prefixed by, a listed entry) skips checks. */
export function isAllowlisted(command: string, allowlist: string[]): boolean {
	for (const entry of allowlist) {
		const trimmed = entry.trim();
		if (command === trimmed) return true;
		if (command.startsWith(trimmed + " ")) return true;
	}
	return false;
}

/* ------------------------------------------------------------------ *
 * Authorized-root scope exemption (path boundary).                   *
 *                                                                      *
 * path-scope treats "inside cwd + extraRoots" as allowed without      *
 * asking, and sandbox-bash authorizes the same roots for writes. This *
 * makes bash-guard agree with that boundary for the two rules that    *
 * exist *because* a write crosses it, while staying fail-closed:      *
 * unless every write/delete operand of the command can be proven to   *
 * land strictly inside an authorized root, the normal danger flow     *
 * (ask / block) applies unchanged.                                    *
 * ------------------------------------------------------------------ */

/** Tokens that end the current simple command when unquoted. */
const SEGMENT_SEPARATORS = new Set([";", "|", "||", "&&", "&", "\n"]);
/** Unquoted characters that make operand analysis unreliable -> no exemption. */
const UNSAFE_CHARACTERS = "`$(){}[]*?!#\\";

/** `rm` short flags: force / recursive / dir / verbose. Anything else is refused. */
const RM_SHORT_FLAGS = /^-[frRvd]+$/;
const RM_LONG_FLAGS = new Set(["--force", "--recursive", "--verbose", "--preserve-root", "--help", "--version"]);
const TEE_SHORT_FLAGS = /^-a$/;
const TEE_LONG_FLAGS = new Set(["--append"]);
/** Commands that only produce bytes on stdout (so a redirect is their only write). */
const PRODUCER_COMMANDS = new Set(["echo", "printf", "cat", "true", "false"]);

export interface LexedSegment {
	/** Command word and arguments, in order (redirect operators/targets removed). */
	tokens: string[];
	/** Targets of `>` / `>>` / `&>` / `2>` redirects in this segment. */
	redirectTargets: string[];
}

interface LexerOptions {
	allowGlob?: boolean;
}

/** Split into whitespace-separated tokens, keeping separators and redirects. */
function tokenize(input: string, options: LexerOptions = {}): string[] | undefined {
	const tokens: string[] = [];
	let buffer = "";
	let started = false;
	let quote: string | undefined;

	const flush = () => {
		if (started) {
			tokens.push(buffer);
			buffer = "";
			started = false;
		}
	};

	for (let index = 0; index < input.length; index++) {
		const ch = input[index];

		if (quote) {
			if (ch === quote) {
				quote = undefined;
				continue;
			}
			// `$`, backticks and backslashes expand inside double quotes and
			// newlines break the single-line assumption: treat both as opaque.
			if (ch === "$" || ch === "`" || ch === "\\" || ch === "\n") return undefined;
			buffer += ch;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			flush();
			continue;
		}
		if (ch === "\n") {
			flush();
			tokens.push("\n");
			continue;
		}
		if (UNSAFE_CHARACTERS.includes(ch) && !(options.allowGlob && (ch === "*" || ch === "?" || ch === "[" || ch === "]"))) return undefined;

		if (ch === ";") {
			flush();
			tokens.push(";");
			continue;
		}
		if (ch === "|") {
			flush();
			if (input[index + 1] === "|") {
				tokens.push("||");
				index++;
			} else {
				tokens.push("|");
			}
			continue;
		}
		if (ch === "&") {
			const next = input[index + 1];
			if (next === "&") {
				flush();
				tokens.push("&&");
				index++;
				continue;
			}
			if (next === ">") {
				flush();
				tokens.push("&>");
				index++;
				continue;
			}
			// `& <`, backgrounded subshell or fd duplication: opaque.
			return undefined;
		}
		if (ch === "<") return undefined; // input redirect / heredoc: never analysed
		if (ch === ">") {
			const next = input[index + 1];
			if (next === "&") return undefined; // >& fd duplication
			flush();
			if (next === ">") {
				tokens.push(">>");
				index++;
			} else {
				tokens.push(">");
			}
			continue;
		}
		if ((ch === "1" || ch === "2") && input[index + 1] === ">" && input[index + 2] !== "&") {
			flush();
			tokens.push(ch === "1" ? ">" : "2>");
			index++;
			continue;
		}

		buffer += ch;
		started = true;
	}

	if (quote) return undefined; // unbalanced quote
	flush();
	return tokens;
}

/**
 * Lex a command into simple segments with their redirect targets.
 * Returns undefined when the command uses shell constructs that cannot be
 * analysed reliably (expansion, globs, subshells, heredocs, fd duplication,
 * unbalanced quotes, dangling redirect).
 */
export function lexCommand(command: string, options: LexerOptions = {}): LexedSegment[] | undefined {
	const tokens = tokenize(command, options);
	if (!tokens) return undefined;

	const segments: LexedSegment[] = [];
	let current: LexedSegment = { tokens: [], redirectTargets: [] };
	let pendingRedirect: boolean | undefined;
	let lastWasSeparator = true;

	const closeSegment = (): boolean => {
		if (pendingRedirect) return false;
		if (current.tokens.length === 0) return false;
		segments.push(current);
		current = { tokens: [], redirectTargets: [] };
		return true;
	};

	for (const token of tokens) {
		if (token === ">" || token === ">>" || token === "&>" || token === "2>") {
			if (pendingRedirect) return undefined;
			pendingRedirect = true;
			lastWasSeparator = false;
			continue;
		}
		if (pendingRedirect) {
			if (SEGMENT_SEPARATORS.has(token) || token === "") return undefined;
			current.redirectTargets.push(token);
			pendingRedirect = undefined;
			lastWasSeparator = false;
			continue;
		}
		if (SEGMENT_SEPARATORS.has(token)) {
			// An empty segment (`a && b`, a trailing `&&`) is a shell syntax error:
			// refuse rather than reason about a command that cannot run.
			if (!closeSegment() || lastWasSeparator) return undefined;
			lastWasSeparator = true;
			continue;
		}
		current.tokens.push(token);
		lastWasSeparator = false;
	}

	if (pendingRedirect || lastWasSeparator) return undefined;
	if (!closeSegment()) return undefined;
	if (segments.length === 0) return undefined;
	// An empty quoted token (`""`) carries no path information: stay conservative.
	for (const segment of segments) {
		if (segment.tokens.some((token) => token === "")) return undefined;
	}
	return segments;
}

/**
 * Make `value` absolute against `base` while KEEPING `..` segments in place.
 *
 * `path.resolve()` collapses `a/link/../b` to `a/b` lexically, but the filesystem
 * resolves `..` against the *real* directory of `link` — so collapsing first can
 * hide a path that actually escapes the roots. Only `.` and duplicate separators
 * are removed here; `..` is left for realpath/the kernel to resolve.
 */
function anchorKeepDotDot(base: string, value: string): string {
	const joined = isAbsolute(value) ? value : `${base}/${value}`;
	const segments = joined.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
	return `${joined.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

/** Expand `~`, anchor relative operands to `cwd`, keeping `..` for the filesystem. */
export function resolveOperandPath(cwd: string, operand: string): string | undefined {
	const trimmed = operand.trim();
	if (trimmed.length === 0 || trimmed === "-" || trimmed.includes("\0")) return undefined;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
		return anchorKeepDotDot(homedir(), trimmed.slice(2));
	}
	return anchorKeepDotDot(cwd, trimmed);
}

/** True when `target` equals `root` or lives under it. */
export function isPathCoveredBy(target: string, root: string): boolean {
	if (target === root) return true;
	const rel = relative(root, target);
	return rel.length > 0 && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

/** True when `target` is a strict descendant of `root` (both absolute/canonical). */
export function isPathStrictlyInside(root: string, target: string): boolean {
	return root !== target && isPathCoveredBy(target, root);
}

function positionalOperands(
	commandWord: string,
	args: string[],
	shortFlags: RegExp,
	longFlags: Set<string>,
): { ok: true; operands: string[] } | { ok: false; reason: string } {
	const operands: string[] = [];
	let endOfOptions = false;
	for (const arg of args) {
		if (!endOfOptions) {
			if (arg === "--") {
				endOfOptions = true;
				continue;
			}
			if (arg.startsWith("-")) {
				if (!shortFlags.test(arg) && !longFlags.has(arg)) {
					return { ok: false, reason: `${commandWord} 的选项不在可豁免范围：${arg}` };
				}
				continue;
			}
		}
		operands.push(arg);
	}
	return { ok: true, operands };
}

/**
 * Collect the paths a segment writes to (or deletes). Only `rm`, `tee`, `touch`
 * and pure stdout producers (`echo`/`printf`/`cat`/`true`/`false`) are
 * understood; anything else — including `cd`, `find`, `xargs`, `sudo`, `git` —
 * refuses the exemption.
 */
function segmentWriteTargets(
	segment: LexedSegment,
): { ok: true; targets: string[] } | { ok: false; reason: string } {
	const commandWord = segment.tokens[0];
	if (!commandWord) return { ok: false, reason: "存在空命令段" };
	if (commandWord.includes("/") || commandWord.includes("=")) {
		return { ok: false, reason: `无法确认命令词：${commandWord}` };
	}

	const targets = [...segment.redirectTargets];
	const args = segment.tokens.slice(1);

	if (commandWord === "rm" || commandWord === "tee") {
		const parsed = commandWord === "rm"
			? positionalOperands("rm", args, RM_SHORT_FLAGS, RM_LONG_FLAGS)
			: positionalOperands("tee", args, TEE_SHORT_FLAGS, TEE_LONG_FLAGS);
		if (!parsed.ok) return parsed;
		if (parsed.operands.length === 0) return { ok: false, reason: `${commandWord} 未给出目标路径` };
		targets.push(...parsed.operands);
		return { ok: true, targets };
	}

	if (commandWord === "touch") {
		if (args.some((arg) => arg.startsWith("-"))) {
			return { ok: false, reason: "touch 带选项，无法确认写入目标" };
		}
		if (args.length === 0) return { ok: false, reason: "touch 未给出目标路径" };
		targets.push(...args);
		return { ok: true, targets };
	}

	if (PRODUCER_COMMANDS.has(commandWord)) return { ok: true, targets };
	return { ok: false, reason: `命令 ${commandWord} 不在可豁免集合内` };
}

/**
 * A deliberately narrow parser for explicit rmExemptRoots. It permits terminal
 * shell globs only for rm operands and allows read-only inspection commands
 * after the final rm. Every other shell construct stays fail-closed.
 */
function isReadOnlyTailSegment(segment: LexedSegment): boolean {
	if (segment.redirectTargets.some((target) => target !== "/dev/null" && target !== "/dev/zero")) return false;
	const [command, ...args] = segment.tokens;
	if (!command) return false;
	if (command === "ls" || command === "grep" || command === "pwd" || command === "echo" || command === "printf" || command === "true" || command === "false" || command === "cd") return true;
	return command === "git" && args[0] === "status";
}

function hasTerminalGlob(operand: string): boolean {
	const firstGlob = operand.search(/[?*[]/);
	return firstGlob >= 0 && !operand.slice(firstGlob).includes("/");
}

function globParent(absolute: string): string | undefined {
	const firstGlob = absolute.search(/[?*[]/);
	if (firstGlob < 0) return undefined;
	const slash = absolute.lastIndexOf("/", firstGlob);
	return slash <= 0 ? "/" : absolute.slice(0, slash);
}

function isPathWithinExplicitRoot(root: string, target: string, allowRootForGlob: boolean): boolean {
	return (allowRootForGlob && root === target) || isPathStrictlyInside(root, target);
}

/**
 * Check an rm command against explicit rmExemptRoots. Unlike the legacy scope
 * exemption this accepts `foo-*` only in the final path component: its parent
 * is canonicalized before the shell expands it, so symlinked prefixes cannot
 * escape the explicit root. The root itself can never be a literal rm target.
 */
export function analyseExplicitRmExemption(command: string, input: ScopeAnalysisInput): ScopeAnalysisResult {
	const segments = lexCommand(command, { allowGlob: true });
	if (!segments) return { exempt: false, reason: "命令含无法解析的 shell 语法" };

	const rmIndexes = segments
		.map((segment, index) => segment.tokens[0] === "rm" ? index : -1)
		.filter((index) => index >= 0);
	if (rmIndexes.length === 0) return { exempt: false, reason: "未识别到 rm 删除段" };
	const lastRmIndex = rmIndexes[rmIndexes.length - 1]!;
	const operands: string[] = [];

	for (const [index, segment] of segments.entries()) {
		const commandWord = segment.tokens[0];
		if (commandWord === "rm") {
			if (segment.redirectTargets.length > 0) return { exempt: false, reason: "rm 带重定向，无法确认所有写入目标" };
			const parsed = positionalOperands("rm", segment.tokens.slice(1), RM_SHORT_FLAGS, RM_LONG_FLAGS);
			if (!parsed.ok || parsed.operands.length === 0) return { exempt: false, reason: parsed.ok ? "rm 未给出目标路径" : parsed.reason };
			operands.push(...parsed.operands);
			continue;
		}
		// A cd before any later rm changes relative-path meaning, so do not infer it.
		if (commandWord === "cd" && index < lastRmIndex) return { exempt: false, reason: "rm 前存在 cd，无法确认相对路径" };
		if (index <= lastRmIndex || !isReadOnlyTailSegment(segment)) {
			return { exempt: false, reason: `rm 删除链包含无法确认的命令段：${commandWord ?? "(empty)"}` };
		}
	}

	for (const operand of operands) {
		const absolute = resolveOperandPath(input.cwd, operand);
		if (!absolute) return { exempt: false, reason: `删除目标格式无效：${operand}` };
		const terminalGlob = hasTerminalGlob(operand);
		// Any glob not confined to the final component is unsafe: it could traverse
		// a symlink selected by an earlier wildcard component.
		if (/[?*[]/.test(operand) && !terminalGlob) return { exempt: false, reason: `glob 必须位于最后一个路径段：${operand}` };
		const candidate = terminalGlob ? globParent(absolute) : absolute;
		if (!candidate) return { exempt: false, reason: `glob 目标格式无效：${operand}` };
		const canonical = input.canonicalize(candidate);
		if (!canonical) return { exempt: false, reason: `无法安全规范化删除目标：${operand}` };
		const sensitive = input.sensitiveDirs ?? [];
		const sensitiveHit = sensitive.some((root) => isPathCoveredBy(absolute, root) || isPathCoveredBy(canonical, root));
		const inProject = input.projectRoot !== undefined && isPathCoveredBy(canonical, input.projectRoot);
		if (sensitiveHit && !inProject) return { exempt: false, reason: `删除目标命中受保护路径：${canonical}` };
		if (!input.roots.some((root) => isPathWithinExplicitRoot(root, canonical, terminalGlob))) {
			return { exempt: false, reason: `删除目标越出 rmExemptRoots：${canonical}` };
		}
	}
	return { exempt: true, targets: operands };
}

export interface ScopeAnalysisInput {
	/** Directory the bash command runs in (the project cwd). */
	cwd: string;
	/** Absolute, symlink-resolved authorized roots (cwd + path-scope extraRoots). */
	roots: string[];
	/**
	 * Absolute, symlink-resolved protected dirs (pi's ~/.pi and ~/.pi/agent). A
	 * target that lands under one of them is never exempt, even when a very broad
	 * root (`/`, `~`) contains it — the same invariant sandbox-bash enforces with
	 * an explicit deny clause.
	 *
	 * Exception: when the project cwd itself lives under a sensitive dir, the
	 * caller passes the canonical cwd here (sandbox-bash's cwd priority). Targets
	 * covered by the project root are then exempt from the sensitive check — the
	 * project is authorized — while sensitive targets outside it stay guarded, so
	 * credentials outside the cwd are never relaxed just to make the cwd writable.
	 */
	sensitiveDirs?: string[];
	projectRoot?: string;
	/**
	 * Canonicalize an absolute path: resolve symlinks, fail closed (undefined) on
	 * a broken/unresolvable path. Injected so this module stays fs-free and the
	 * symlink behaviour can be asserted with a fake resolver.
	 */
	canonicalize: (absolutePath: string) => string | undefined;
}

export type ScopeAnalysisResult =
	| { exempt: true; targets: string[] }
	| { exempt: false; reason: string };

/**
 * Decide whether every write/delete operand of `command` is confined to the
 * authorized roots. Fail-closed by construction: any unknown syntax, unknown
 * command, unparsable operand, unresolvable path (including a symlink pointing
 * out of the roots), or an operand that *is* a root itself (`rm -rf .`) refuses
 * the exemption.
 */
export function analyseScopeExemption(command: string, input: ScopeAnalysisInput): ScopeAnalysisResult {
	const segments = lexCommand(command);
	if (!segments) return { exempt: false, reason: "命令含无法解析的 shell 语法" };

	const operands: string[] = [];
	for (const segment of segments) {
		const verdict = segmentWriteTargets(segment);
		if (!verdict.ok) return { exempt: false, reason: verdict.reason };
		operands.push(...verdict.targets);
	}
	if (operands.length === 0) return { exempt: false, reason: "未识别到明确的写入目标路径" };

	for (const operand of operands) {
		const absolute = resolveOperandPath(input.cwd, operand);
		if (absolute === undefined) return { exempt: false, reason: `写入目标格式无效：${operand}` };
		const canonical = input.canonicalize(absolute);
		if (canonical === undefined) return { exempt: false, reason: `无法安全规范化写入目标：${operand}` };
		const sensitive = input.sensitiveDirs ?? [];
		const sensitiveHit = sensitive.some((root) => isPathCoveredBy(absolute, root) || isPathCoveredBy(canonical, root));
		// The cwd-priority carve-out: only targets inside the authorized project
		// itself waive the sensitive check (the caller passes projectRoot only when
		// the cwd lives under a sensitive dir). Everything else — e.g. a credential
		// file outside the cwd reached through a broad root — stays guarded.
		const inProject = input.projectRoot !== undefined && isPathCoveredBy(canonical, input.projectRoot);
		if (sensitiveHit && !inProject) {
			return { exempt: false, reason: `写入目标命中受保护路径：${canonical}` };
		}
		if (!input.roots.some((root) => isPathStrictlyInside(root, canonical))) {
			return { exempt: false, reason: `写入目标越出授权根：${canonical}` };
		}
	}
	return { exempt: true, targets: operands };
}