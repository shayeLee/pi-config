/**
 * Bash Guard — pure core logic (no Pi or fs dependency).
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested directly with `node --test` without loading the Pi runtime.
 * The extension entry point (index.ts) imports from this module.
 */

export interface BashGuardConfig {
	enabled?: boolean;
	mode?: "ask" | "block";
	noUI?: "block" | "allow";
	allowlist?: string[];
	patterns?: string[];
}

export type BashGuardConfigValidation =
	| { config: BashGuardConfig }
	| { error: string };

export interface DangerousRule {
	name: string;
	pattern: RegExp;
}

/** Built-in danger rules. Override or extend via the `patterns` config. */
export const DEFAULT_DANGEROUS_RULES: DangerousRule[] = [
	{
		name: "破坏性删除",
		pattern: /\brm\s+(-[a-zA-Z]*[rf]|--recursive|--force)/,
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
		name: "写入系统目录",
		pattern: /([>]|[&>]|>>|tee)\s*([^;\n]*)(\/etc|\/usr|\/bin|\/sbin|\/System|\/Library)\b/,
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

	const allowedKeys = new Set(["enabled", "mode", "noUI", "allowlist", "patterns"]);
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

	const config: BashGuardConfig = {};
	if (candidate.enabled !== undefined) config.enabled = candidate.enabled as boolean;
	if (candidate.mode !== undefined) config.mode = candidate.mode as "ask" | "block";
	if (candidate.noUI !== undefined) config.noUI = candidate.noUI as "block" | "allow";
	if (candidate.allowlist !== undefined) config.allowlist = candidate.allowlist as string[];
	if (candidate.patterns !== undefined) config.patterns = candidate.patterns as string[];
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
	const rules: DangerousRule[] = [...DEFAULT_DANGEROUS_RULES];
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