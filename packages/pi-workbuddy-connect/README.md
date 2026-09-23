# pi-workbuddy-connect

WorkBuddy provider for [pi](https://pi.dev)。在 pi 里直接使用 WorkBuddy 桌面 App 的模型。

同时支持两版：

| provider | 产品 | 登录域 |
| --- | --- | --- |
| `workbuddy` | WorkBuddy AI（国际版） | `www.workbuddy.ai` |
| `workbuddy-cn` | WorkBuddy（国内版） | `www.workbuddy.cn` |

两版**各自独立**：账号、积分、模型清单、设置文件互不混用。装哪个 App 就登录哪个；
两个都装就两个 provider 并存。

移植自 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（DSH 插件），
现在是 pi 原生扩展：无 shim、无 loopback 代理，直接注册 provider。

## 安装

### 本地副本（推荐）

本仓库位于 `~/.pi/packages/pi-workbuddy-connect`，含本地改动（见下方「与上游的差异」）。

`~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "/Users/mz/.pi/packages/pi-workbuddy-connect"
  ]
}
```

为什么用本地路径而不是 `git:`：

- git 包克隆在 `~/.pi/agent/git/<host>/<path>`，`pi update --extensions` 会对它 `git reset --hard` + `git clean -fdx`，未提交的本地改动会被抹掉。
- 本地路径引用不复制、不 reconcile，`pi update --extensions` 直接跳过（只处理 npm 与 git 类型）。

### 从上游安装

```bash
pi install git:github.com/icekale/pi-workbuddy-connect
```

### 临时加载

```bash
pi -e /Users/mz/.pi/packages/pi-workbuddy-connect
```

## 登录

设置 → 模型 → WorkBuddy / WorkBuddy AI → **Connect**（弹出浏览器登录页），或：

```
/login workbuddy        # 国际版
/login workbuddy-cn     # 国内版
```

凭据按优先级解析：

1. 环境变量（`WORKBUDDY_AUTH_FILE` / `WORKBUDDY_CN_AUTH_FILE`）
2. pi 自存的 `<agentDir>/.workbuddy-auth.json` / `.workbuddy-cn-auth.json`
3. 桌面 App 的凭据文件（见下）

桌面凭据文件位置（两版共用同一个 `CodeBuddyExtension/Data/Public/auth` 目录，只有文件名不同）：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<file>` |
| Windows | `%LOCALAPPDATA%` 或 `%APPDATA%` 下的同构路径 |
| Linux | `$XDG_CONFIG_HOME`（默认 `~/.config`）下的同构路径 |

`<file>` 为 `workbuddy-desktop-ai.info`（国际版）或 `workbuddy-desktop.info`（国内版）。
access token 过期前 5 分钟自动续期。

### 桌面凭据的静态加密（国内版 5.6+）

国内版自 5.6 起把 `auth.accessToken` / `auth.refreshToken` 与 `account.nickname`
以 `{$wbEncrypted:1, envelope}` 形式加密落盘（AES-256-GCM，suite 1）。三者同一把钥匙、
同一个 AAD 框定，本扩展一并还原。

加密凭据打不开时报错，**不会静默回退到 pi 自存副本**：桌面文件是「当前是谁登录」的权威，
回退到可能属于上一个账号的副本会以错误身份发请求。

密钥就在本机：跑一次 App 自带的 Electron 读它私有的存储绑定即可。本扩展自动完成，
顺序是 **环境变量 → spec 默认路径 → Spotlight 发现**：

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_CN_ELECTRON_BIN` | 指定国内版 Electron 二进制 |
| `WORKBUDDY_AI_ELECTRON_BIN` | 指定国际版 Electron 二进制 |
| `WORKBUDDY_ELECTRON_BIN` | 两者的通用回退 |

默认路径为 `/Applications/WorkBuddy.app/Contents/MacOS/Electron`（国内版，macOS）。
密钥只缓存在内存里，绝不落盘、绝不进日志。解密失败时报可诊断错误（带字段名与 keyId，
不带任何凭据内容），而不是静默降级。

## hook 的 provider 归属

pi 的 `before_provider_request` 事件本身不带 provider，且传给 hook 的 `payload.model` 是
**裸模型 id**（实测：`deepseek-v4-pro`，而非 `deepseek/deepseek-v4-pro`）。只看 id 是不够的：
pi 自带目录里有 **44 条**与 WorkBuddy 撞名的 id（`deepseek-v4-pro`、`glm-5.3`、`hy3`、
`kimi-k3`、`minimax-m3` 等），按 id 判断会误改别的 provider 的请求。

**解决办法**：hook 的第二个参数 `ctx` 里有 `ctx.model.provider`，它就是本次请求的
provider id。实测在普通请求、多轮对话、强制上下文压缩、重试等场景下，`ctx.model.id`
始终等于本次 `payload.model`，所以这是可靠的请求归属依据：

```ts
pi.on("before_provider_request", (event, ctx) => {
  const payload = asObject(event.payload);
  if (!payload) return;
  if (!ownsPayload(payload, ctx.model?.provider, ctx)) return;  // 只认自己的 provider
  return prepareChatPayload(payload);
});
```

`ownsPayload` 三重校验：provider 属于本扩展、`ctx.model.id === payload.model`（纵深防御，
防 pi 内部路由变化）、且该 id 确实在该 provider 的模型集合里。任一条不满足就原样放行。

实测确认：同一个 id `hy3`，来自第三方 provider `collide` 时 payload 完整保留（`tools` 4 个、
无改写），来自 `workbuddy-cn` 时才被改写。`test/scope.test.mts` 覆盖了撞名 id、缺 ctx、
`ctx.model.id` 与 `payload.model` 不一致等六种情形。

header 侧靠 `X-Pi-WorkBuddy` marker 精确区分，各 provider 只认自己的取值
（`test/providers.test.mts` 已断言：对方 marker 的请求不被响应）。

## 模型与推理档

默认只列出免费模型。每个模型的推理档来自产品配置的 `reasoning.supportedEfforts`；
缓存不存在时回退到内置清单。

产品配置路径：

| provider | 路径 | 覆盖变量 |
| --- | --- | --- |
| `workbuddy` | `~/.workbuddy-ai/cache/acc-product-config-v3.json` | `WORKBUDDYAI_PRODUCT_CONFIG` |
| `workbuddy-cn` | `~/.workbuddy/cache/acc-product-config-v3.json` | `WORKBUDDY_PRODUCT_CONFIG` |

配置里的模型先按 `agents[name=cli].models`（CLI roster）收窄。顶层 `models` 还包含
补全、本地自定义等 CLI 用不了的条目（国内版尤其多：`codewise-completions`、
`custom-local:*`、`hunyuan-*` 等），不过滤就会把它们摆进选择器，选中后必然失败。

内置兜底（配置缓存缺失时）：

| provider | 模型 |
| --- | --- |
| `workbuddy` | Deepseek-V4.1-Flash · Hy4 preview · Hy3 |
| `workbuddy-cn` | 19 条 CLI roster（快速 / 均衡 / 极致 / Hy4 preview / Hy3 / Hy3-X / Deepseek-V4.1-Flash / GLM-5.3(-Flash) / GLM-5.2 / GLM-5.1 / GLM-5v-Turbo / MiniMax-M3 / Kimi-K3 / Kimi-K2.8-Preview / Kimi-K2.7-Code / Kimi-K2.6 / Deepseek-V4-Pro / Hy4 preview） |

没声明 `supportedEfforts` 的模型（`supportsReasoning: true`）默认给全套 low/medium/high/xhigh/max。

## 设置

pi 没有 DSH 那种插件配置卡片，等价入口有两处：

- **侧栏 widget** — 账号、token 过期时间、各积分包余量，以及当前模型列表。两档：
  `on` 显示、`off` 完全隐藏（侧栏与底部状态栏一并清空）。两个 provider 各占一个 widget，
  footer 文本带区域标签（`国际版 积分 N` / `国内版 积分 N`）。
  快捷键：`ctrl+shift+w`（国际版）、`ctrl+shift+u`（国内版）。
- **`/workbuddy`** / **`/workbuddy-cn`** — 弹出选择菜单：

  ```
  刷新积分与账号
  列出全部模型（含付费）   ← 切换范围
  断开登录
  侧栏显示：显示          ← 切换 显示 / 隐藏
  ```

  也接受参数：`/workbuddy-cn free` · `/workbuddy-cn all` · `/workbuddy-cn on` ·
  `/workbuddy-cn off` · `/workbuddy-cn logout`。

切换范围后 provider 立即重新注册模型，无需 `/reload`。
设置分别存在 `<agentDir>/.workbuddy-settings.json`（国际版）与
`<agentDir>/.workbuddy-cn-settings.json`（国内版）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 国际版桌面凭据文件路径 |
| `WORKBUDDY_CN_AUTH_FILE` | 国内版桌面凭据文件路径 |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 国际版产品配置 JSON 路径 |
| `WORKBUDDY_PRODUCT_CONFIG` | 国内版产品配置 JSON 路径 |
| `WORKBUDDY_CN_ELECTRON_BIN` | 国内版 Electron 二进制（解密桌面凭据用） |
| `WORKBUDDY_AI_ELECTRON_BIN` | 国际版 Electron 二进制 |
| `WORKBUDDY_ELECTRON_BIN` | 上面两者的通用回退 |
| `PI_CODING_AGENT_DIR` | pi agent 目录，影响自存凭据与设置文件位置 |

## 自检

```bash
node --experimental-strip-types extensions/workbuddy.ts --self-check
```

覆盖认证解析（含毫秒 `expiresAt`）、payload 规整、推理档映射、CLI roster 收窄、
积分解析、widget/footer 渲染、错误信封补全，以及加密凭据的分类与加解密 round-trip。

## 与上游的差异

本副本相对上游的本地改动：

- **侧栏显示收敛为两档** `on` / `off`（上游为三档 `full` / `compact` / `off`）。
- **`off` 时同时清空底部状态栏积分**（上游 `off` 只清 widget，footer 仍显示 `积分 N`）。
- 旧设置值向后兼容：`visibility` 为 `full` / `compact` 或缺失时一律视为 `on`，仅 `off` 表示隐藏。
- **未标价模型计入免费**（上游要求 `credits` 显式声明为 `x0.00`）：`undefined` / 空串同样视为免费，
  且先剥掉 `credits` 单位后缀再比对（上游两种写法都存在）。
- **错误信封补全**（见下）：把 WorkBuddy 的 `{code,msg}` 补成 OpenAI 形状，否则 pi 只能看到
  `400 status code (no body)`。

### 错误信封补全

WorkBuddy 的错误体是 `{code, msg}`，但 pi 的 openai-completions 路径只保留 OpenAI 形状
`{error:{message,...}}`：`normalizeProviderError` 取 `error.error`，非对象时退化成
`error.message`，最终 `errorMessage` 只剩 `"400 status code (no body)"`。业务码与文案全部丢失，
TUI 与 `model-failback` 都看不见原因。

`installErrorEnvelopeRewrite()` 在 `globalThis.fetch` 上装一层（pi 的 OpenAI 客户端用
`options.fetch ?? 默认 fetch`，而 pi 不传 `options.fetch`，这是唯一能触到响应体的位置），
只对两个 base 下的**失败响应**生效：

```json
{"code":14001,"msg":"UsageLimitExceeded"}
  → {"error":{"message":"UsageLimitExceeded","type":"invalid_request_error","code":"14001"}}
```

要点：

- `code` 必须保留为**字符串** —— pi 只把 `error.error.code` 透传进 `errorMessage` 的 JSON 里，数字会被丢掉。
- 已是 OpenAI 形状（`error` 为对象）或无法解析时不二次包装，原响应原样透传。
- 幂等：重复调用只装一次，避免 `/reload` 后层层包裹。
- 只做信封补全，不做语义判定 —— 哪些码属于额度终态由 `model-failback` 的 `workbuddy` handler 决定。

其余与上游一致：

- 直接 `pi.registerProvider`，去掉 DSH 的 shim 与 loopback 端口转发。
- 推理档由 pi-ai 的 `thinkingLevelMap` 驱动，选择器直接读 `getSupportedThinkingLevels`。
- 选 Default（auto）时**不发送** `reasoning_effort`；选具体档位时原样透传，不做任何改写。
  上游国际版会在发送前丢弃 `off` 档（issue #49），本扩展不复制这条：`off` 照常透传。
- 发送前剔除 assistant 消息里回放的 `reasoning` / `thinking` / `reasoning_content` 字段，
  上游端点会拒绝这些字段。
- 未移植上游的 reasoning-effort 探测（probe）功能：需要联网发真实请求，且当前免费模型
  都已声明 `supportedEfforts`，探测无增益。

## 结构

```
extensions/
  providers.ts   两个 provider 的共享实现 + ProviderSpec 变体描述符
  workbuddy.ts   入口：注册两个 spec，并承载 --self-check
test/
  scope.test.mts      断言 hook 不污染其他 provider 的请求
  providers.test.mts  断言两个 provider 各自注册、互不串写
```

两版的差异（端点、域名、凭据文件名、设置文件名、产品配置路径、命令、快捷键、
内置兜底模型、Electron App）全部收敛在 `providers.ts` 顶部的 `WORKBUDDY_AI` /
`WORKBUDDY_CN` 两个 `ProviderSpec` 常量里。共享逻辑只吃 spec，没有任何
`if (international)` 分支。

## 测试

```bash
node --experimental-strip-types test/scope.test.mts       # hook 作用域
node --experimental-strip-types test/providers.test.mts   # 双 provider 隔离
node --experimental-strip-types extensions/workbuddy.ts --self-check
npx tsc -p tsconfig.json                                  # 类型检查
```

## License

MIT
