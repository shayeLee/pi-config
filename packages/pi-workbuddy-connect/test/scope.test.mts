// 断言 before_provider_request hook 只碰自己的请求：
//  - 别的 provider 的独有 id：不动
//  - 别的 provider 用了与 WorkBuddy 撞名的 id：不动（靠 ctx.model.provider 判定）
//  - 自己的请求：正常改写
const ext: any = await import("../extensions/workbuddy.ts");

const handlers: Record<string, Function[]> = {};
const registered: { id: string; cfg: any }[] = [];
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: (id: string, cfg: any) => { registered.push({ id, cfg }); },
  registerCommand: () => {},
  registerShortcut: () => {},
};

await ext.default(pi);
const hook = handlers["before_provider_request"]?.[0];
if (!hook) throw new Error("no before_provider_request handler");

const fail = (msg: string): never => { throw new Error(msg); };
const run = (payload: any, provider: string) =>
  hook({ type: "before_provider_request", payload }, { model: { provider, id: payload.model } });

// 1) 无关 provider 的独有 id：payload 完全不变。
const foreign = {
  model: "claude-opus-4-8",
  messages: [
    { role: "developer", content: "You are Grok." },
    { role: "user", content: "hi" },
  ],
  tool_choice: "none",
  tools: [{ type: "function", function: { name: "bash" } }],
};
const before = JSON.stringify(foreign);
run(foreign, "anthropic");
if (JSON.stringify(foreign) !== before) fail("foreign provider payload was rewritten");

// 2) 撞名 id：`hy3` 既是我们的 CN 模型，也在 pi 自带的 opencode-go 里。
//    （`deepseek-v4-pro` 也是撞名 id，但它是付费模型、默认 free 范围下不在我们的索引里，
//      所以用 hy3 才真正验证到"索引命中但 provider 不是我们"这条路径。）
const colliding = {
  model: "hy3",
  messages: [
    { role: "developer", content: "You are DeepSeek." },
    { role: "user", content: "hi" },
  ],
  tool_choice: "none",
  tools: [{ type: "function", function: { name: "search" } }],
};
const collidingBefore = JSON.stringify(colliding);
run(colliding, "opencode-go");
if (JSON.stringify(colliding) !== collidingBefore) {
  fail("colliding-id foreign provider payload was rewritten (tools/role must survive)");
}

// 3) 同样的撞名 id，但来自我们自己的 provider：必须被改写。
const ours = {
  model: "hy3",
  messages: [
    { role: "developer", content: "sys" },
    { role: "user", content: "hi" },
  ],
  tool_choice: { type: "function", function: { name: "foo" } },
};
run(ours, "workbuddy-cn");
if ((ours.messages as any)[0].role !== "system") fail("own payload not rewritten (role)");
if ((ours as any).stream !== true) fail("own payload not rewritten (stream)");
if ((ours as any).tool_choice !== "foo") fail("own payload not rewritten (tool_choice)");

// 4) 国际版同样按 provider 判定。
const ai = { model: "hy3", messages: [{ role: "developer", content: "sys" }] };
run(ai, "workbuddy");
if ((ai.messages as any)[0].role !== "system") fail("workbuddy payload not rewritten");

// 5) 缺 ctx / 缺 provider 时保守不动。
const noCtx = { model: "hy3", messages: [{ role: "developer", content: "sys" }] };
const noCtxBefore = JSON.stringify(noCtx);
hook({ type: "before_provider_request", payload: noCtx }, {});
if (JSON.stringify(noCtx) !== noCtxBefore) fail("payload rewritten without provider identity");

// 6) ctx.model.id 与 payload.model 不一致时保守不动（纵深防御）。
const mismatch = { model: "hy3", messages: [{ role: "developer", content: "sys" }] };
const mismatchBefore = JSON.stringify(mismatch);
hook({ type: "before_provider_request", payload: mismatch }, { model: { provider: "workbuddy-cn", id: "other" } });
if (JSON.stringify(mismatch) !== mismatchBefore) fail("payload rewritten on model mismatch");

console.log("OK: hook is scoped by provider; foreign and colliding payloads untouched.");
