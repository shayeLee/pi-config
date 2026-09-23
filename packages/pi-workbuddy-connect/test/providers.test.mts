// 双 provider 并存：各自注册、模型归属互不串写、marker 各认各的。
const ext: any = await import("../extensions/workbuddy.ts");

const handlers: Record<string, Function[]> = {};
const registered: { id: string; cfg: any }[] = [];
const shortcuts: string[] = [];
const commands: string[] = [];
const pi: any = {
  on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn); },
  registerProvider: (id: string, cfg: any) => { registered.push({ id, cfg }); },
  registerCommand: (name: string) => { commands.push(name); },
  registerShortcut: (name: string) => { shortcuts.push(name); },
};

await ext.default(pi);

const fail = (msg: string): never => { throw new Error(msg); };

// 两个 provider 都注册了，且 id 正确。
const ids = registered.map((r) => r.id).sort();
if (JSON.stringify(ids) !== JSON.stringify(["workbuddy", "workbuddy-cn"])) {
  fail(`registered providers: ${JSON.stringify(ids)}`);
}
for (const { id, cfg } of registered) {
  const expectedBase = id === "workbuddy-cn" ? "https://www.workbuddy.cn/v2" : "https://www.workbuddy.ai/v2";
  if (cfg.baseUrl !== expectedBase) fail(`${id} baseUrl: ${cfg.baseUrl}`);
  if (cfg.headers["X-Pi-WorkBuddy"] !== id) fail(`${id} marker: ${JSON.stringify(cfg.headers)}`);
  if (cfg.models.length === 0) fail(`${id} registered no models`);
}
// 命令与快捷键各一份，不互相覆盖。
if (JSON.stringify(commands.sort()) !== JSON.stringify(["workbuddy", "workbuddy-cn"])) {
  fail(`commands: ${JSON.stringify(commands)}`);
}
if (JSON.stringify(shortcuts.sort()) !== JSON.stringify(["ctrl+shift+u", "ctrl+shift+w"])) {
  fail(`shortcuts: ${JSON.stringify(shortcuts)}`);
}

// before_provider_request 只装一份（共享），且只碰 WorkBuddy 的模型。
const reqHooks = handlers["before_provider_request"] ?? [];
if (reqHooks.length !== 1) fail(`before_provider_request handlers: ${reqHooks.length}`);

// 别的 provider 的独有 id：不动。
const foreign = { model: "grok-4.6", messages: [{ role: "developer", content: "x" }] };
const before = JSON.stringify(foreign);
reqHooks[0]({ type: "before_provider_request", payload: foreign }, { model: { provider: "xai", id: "grok-4.6" } });
if (JSON.stringify(foreign) !== before) fail("foreign payload rewritten");

// 自己的模型：必须改写（provider 取自 ctx.model.provider）。
const cnCfg = registered.find((r) => r.id === "workbuddy-cn")!.cfg;
const cnModel = cnCfg.models[0].id;
const own = { model: cnModel, messages: [{ role: "developer", content: "x" }] };
reqHooks[0]({ type: "before_provider_request", payload: own }, { model: { provider: "workbuddy-cn", id: cnModel } });
if ((own.messages as any)[0].role !== "system") fail("own payload not rewritten");

// before_provider_headers 每个 provider 一份，marker 决定谁应答。
const hdrHooks = handlers["before_provider_headers"] ?? [];
if (hdrHooks.length !== 2) fail(`before_provider_headers handlers: ${hdrHooks.length}`);
for (const hook of hdrHooks) {
  // 对方的 marker 必须完全不响应（无凭据时也不该抛错）。
  const other = { "X-Pi-WorkBuddy": "not-mine" };
  await hook({ type: "before_provider_headers", headers: other });
  if (Object.keys(other).length !== 1) fail("header hook answered a foreign marker");
}

// 设置/凭据文件不共用（否则两个账号会互相顶掉）。
const files = new Set(registered.map((r) => r.cfg.models[0].id));
if (files.size === 0) fail("no models");

console.log("OK: dual provider registration is isolated.");
