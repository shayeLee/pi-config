/**
 * thinking-breaker 熔断路径的端到端集成测试。
 *
 * 回放测试（tests/replay.ts）覆盖纯函数；这里覆盖**接线**——最容易在重构中
 * 悄悄断掉、且后果最严重的那几步：
 *   1. `message_update` 里命中后真的调用 `ctx.abort()`
 *   2. `message_end` 返回**替换消息**，把复读从思考块里剥掉
 *      （漏掉这一步就会把 8.8 万 token 的复读垃圾灌给下一轮）
 *   3. 用户按 Esc 中止（无标记）时绝不替换、绝不续跑
 *   4. 首次命中同模型续跑，第二次命中向 model-failback 升级换模型
 *
 * 用法: volta run node tests/enforce.ts
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 扩展运行时 import 了 `@earendil-works/pi-coding-agent`（用它的 getAgentDir）。
 * 在 pi 里由 pi 自己的 loader 解析；直接用 node 跑测试时需要我们自己提供解析路径。
 * 这里建一个指向真实安装位置的 node_modules 软链（node_modules 已被 .gitignore）。
 */
const PKG = "@earendil-works/pi-coding-agent";
function ensureResolvable(): void {
	const local = join(import.meta.dirname, "..", "node_modules");
	if (existsSync(join(local, "@earendil-works", "pi-coding-agent", "dist", "index.js"))) return;
	// Volta 在 ~/.volta/tools/shared 下维护一份带 exports 的真实包；用它建软链，
	// 让扩展里的裸 import 能被 node 正常解析（pi 自己运行时不需要这一步）。
	const candidates = [
		join(homedir(), ".volta", "tools", "shared", "@earendil-works", "pi-coding-agent"),
		join(homedir(), ".volta", "tools", "image", "packages", "@earendil-works", "pi-coding-agent",
			"lib", "node_modules", "@earendil-works", "pi-coding-agent"),
	];
	const target = candidates.find((path) => existsSync(join(path, "dist", "index.js")));
	if (!target) throw new Error(`找不到 ${PKG} 的安装位置，无法运行测试`);
	mkdirSync(join(local, "@earendil-works"), { recursive: true });
	symlinkSync(target, join(local, "@earendil-works", "pi-coding-agent"), "dir");
}
ensureResolvable();

// 必须在 import 扩展之前设置：getAgentDir() 读取这个环境变量。
const STATE_DIR = mkdtempSync(join(tmpdir(), "tb-enforce-"));
const AGENT_DIR = join(STATE_DIR, "agent");
mkdirSync(AGENT_DIR, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	if (ok) console.log(`  ✓ ${name}`);
	else {
		failures += 1;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** 复读事故的真实形状：长分析 + 变体轮换的尾部复读。 */
function buildLoopedThinking(): string {
	const analysis = Array.from(
		{ length: 400 },
		(_, i) => `第 ${i + 1} 步分析：检查模块 ${i + 1} 的边界条件，确认与上游契约一致。`,
	).join("\n\n");
	const variants = ["Now.", "Producing."];
	const loop: string[] = [];
	for (let i = 0; i < 4000; i++) loop.push("OK.", "Let me write.", "Go.", variants[i % 2]);
	return `${analysis}\n\n${loop.join("\n\n")}\n\n`;
}

interface Harness {
	stream(text: string, chunkSize?: number): { aborted: boolean; abortCount: number };
	end(text: string, stopReason: string): Promise<unknown>;
	notifications: string[];
	continuations: string[];
	/** 注册一个假的 model-failback 订阅者；返回它收到的请求。 */
	installFailback(reply: { ok: boolean; switchedTo?: string; message?: string } | null): Array<any>;
}

async function createHarness(enforce: boolean): Promise<Harness> {
	writeFileSync(
		join(AGENT_DIR, "thinking-breaker.json"),
		JSON.stringify({
			enforce,
			captureThinkingText: false,
			captureStreamDetail: false,
			enforceMinRepeats: 10,
			enforceMinChars: 20_000,
		}),
	);

	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const listeners = new Map<string, (payload: unknown) => void>();
	const notifications: string[] = [];
	const continuations: string[] = [];
	let aborted = false;
	let abortCount = 0;

	const ctx = {
		model: { provider: "workbuddy", id: "deepseek-v4.1-flash" },
		modelRegistry: { find: () => undefined },
		sessionManager: { getSessionId: () => "test-session" },
		signal: undefined,
		isIdle: () => true,
		abort: () => {
			aborted = true;
			abortCount += 1;
		},
		ui: { notify: (message: string) => notifications.push(message) },
	};

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: () => {},
		appendEntry: () => {},
		sendUserMessage: (text: string) => {
			continuations.push(text);
		},
		events: {
			on: (channel: string, listener: (payload: unknown) => void) => {
				listeners.set(channel, listener);
			},
			emit: (channel: string, payload: unknown) => {
				const listener = listeners.get(channel);
				if (listener) listener(payload);
			},
		},
	};

	const mod = await import("../index.ts");
	mod.default(pi as never);
	await (handlers.get("session_start") as any)({}, ctx);

	return {
		notifications,
		continuations,
		stream(text, chunkSize = 37) {
			aborted = false;
			abortCount = 0;
			void (handlers.get("message_start") as any)(
				{ message: { role: "assistant", provider: "workbuddy", model: "deepseek-v4.1-flash" } },
				ctx,
			);
			for (let i = 0; i < text.length; i += chunkSize) {
				const delta = text.slice(i, i + chunkSize);
				const partial = {
					role: "assistant",
					provider: "workbuddy",
					model: "deepseek-v4.1-flash",
					content: [{ type: "thinking", thinking: text.slice(0, i + delta.length) }],
				};
				void (handlers.get("message_update") as any)(
					{
						message: partial,
						assistantMessageEvent: {
							type: "thinking_delta",
							contentIndex: 0,
							delta,
							partial,
						},
					},
					ctx,
				);
			}
			return { aborted, abortCount };
		},
		async end(text, stopReason) {
			const message = {
				role: "assistant",
				provider: "workbuddy",
				model: "deepseek-v4.1-flash",
				stopReason,
				content: [{ type: "thinking", thinking: text, thinkingSignature: "reasoning_content" }],
				usage: { input: 1, output: 1 },
			};
			return (handlers.get("message_end") as any)({ message }, ctx);
		},
		installFailback(reply) {
			const received: Array<any> = [];
			listeners.set("thinking-breaker:escalate", (payload: any) => {
				received.push(payload);
				payload.accept(reply ?? { ok: false, message: "未安装 model-failback" });
			});
			return received;
		},
	};
}

console.log("thinking-breaker 熔断集成测试\n");
const thinking = buildLoopedThinking();
console.log(`构造的思考原文: ${thinking.length} 字符（真实事故形状）\n`);

// ---------------------------------------------------------------- 1) enforce 关
console.log("[1] enforce 关（默认）：必须完全不干预");
{
	const h = await createHarness(false);
	const r = h.stream(thinking);
	check("没有调用 ctx.abort()", !r.aborted, `abortCount=${r.abortCount}`);
	check("message_end 不返回替换消息", (await h.end(thinking, "stopReason")) === undefined);
}

// ---------------------------------------------------------------- 2) enforce 开
console.log("\n[2] enforce 开：命中即 abort");
{
	const h = await createHarness(true);
	const r = h.stream(thinking);
	check("触发了 ctx.abort()", r.aborted, `abortCount=${r.abortCount}`);
	check("只 abort 一次", r.abortCount === 1, `abortCount=${r.abortCount}`);
	check(
		"提示里说明了复读次数",
		h.notifications.some((n) => n.includes("思考尾部连续重复")),
		h.notifications.slice(-1).join(" | "),
	);
}

// ---------------------------------------------------------------- 3) 替换消息
console.log("\n[3] message_end 必须剥掉复读再落盘");
{
	const h = await createHarness(true);
	h.stream(thinking);
	const replacement = (await h.end(thinking, "aborted")) as any;
	check("返回了替换消息", replacement?.message !== undefined);
	const replacedText: string = replacement?.message?.content?.[0]?.thinking ?? "";
	check(
		`替换后的思考从 ${thinking.length} 缩到 ${replacedText.length} 字符`,
		replacedText.length > 0 && replacedText.length < thinking.length / 2,
	);
	check("替换后不再包含复读单元", !replacedText.includes("OK.\n\nLet me write.\n\nGo."));
	check("保留了思考签名（provider 可能校验）", replacement?.message?.content?.[0]?.thinkingSignature === "reasoning_content");
	check("保留了 role", replacement?.message?.role === "assistant");
	check("保留了 stopReason", replacement?.message?.stopReason === "aborted");
	check(
		"首次命中用同模型续跑",
		h.continuations.length === 1 && h.continuations[0].includes("反复重复同一段内容"),
		h.continuations.join(" | ").slice(0, 160),
	);
}

// ---------------------------------------------------------------- 4) 用户 Esc
console.log("\n[4] 用户按 Esc 中止（没有熔断标记）时必须完全不干预");
{
	const h = await createHarness(true);
	// 不喂流式数据，直接来一条 aborted 消息 —— 这就是用户 Esc 的形状。
	const replacement = await h.end(thinking, "aborted");
	check("不返回替换消息", replacement === undefined);
	check("不自动续跑", h.continuations.length === 0);
}

// ---------------------------------------------------------------- 5) 升级换模型
console.log("\n[5] 第二次命中必须升级给 model-failback");
{
	const h = await createHarness(true);
	const received = h.installFailback({ ok: true, switchedTo: "modelscope/Qwen/Qwen3.8-Flash-Next" });

	// 第一次：同模型续跑。
	h.stream(thinking);
	await h.end(thinking, "aborted");
	check("第一次不升级", received.length === 0, `received=${received.length}`);
	check("第一次同模型续跑", h.continuations.length === 1);

	// 第二次：升级。
	h.stream(thinking);
	await h.end(thinking, "aborted");
	check("第二次发出升级请求", received.length === 1, `received=${received.length}`);
	const req = received[0];
	check("请求带了模型 key", req?.key === "workbuddy/deepseek-v4.1-flash", String(req?.key));
	check("请求带了复读证据", req?.evidence?.repeats >= 10, JSON.stringify(req?.evidence));
	check("请求带了命中次数", req?.evidence?.strikes === 2, String(req?.evidence?.strikes));
	check(
		"升级成功后不再重复发续跑（接手方负责续跑）",
		h.continuations.length === 1,
		`continuations=${h.continuations.length}`,
	);
	check(
		"升级成功后不报降级提示",
		!h.notifications.some((n) => n.includes("升级换模型未完成")),
		h.notifications.slice(-1).join(" | "),
	);
}

// ---------------------------------------------------------------- 6) 升级失败降级
console.log("\n[6] model-failback 缺席时降级为同模型续跑（不能丢任务）");
{
	const h = await createHarness(true);
	h.installFailback(null); // 回复 ok:false
	h.stream(thinking);
	await h.end(thinking, "aborted");
	h.stream(thinking);
	await h.end(thinking, "aborted");
	check("升级失败仍续跑", h.continuations.length === 2, `continuations=${h.continuations.length}`);
	check(
		"提示里说明了降级原因",
		h.notifications.some((n) => n.includes("升级换模型未完成")),
		h.notifications.slice(-1).join(" | "),
	);
}

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 个用例失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
