# pi-workbuddy-connect

WorkBuddy AI 国际版 provider for [pi](https://pi.dev)。在 pi 里直接使用 WorkBuddy AI 桌面 App 的模型。

移植自 [iceloon/dsh-workbuddyai-connect](https://github.com/iceloon/dsh-workbuddyai-connect)（DSH 插件），现在是 pi 原生扩展：无 shim、无 loopback 代理，直接注册 provider。

## 安装

### 本地副本（推荐）

本仓库是 `icekale/pi-workbuddy-connect` 的本地副本，位于 `~/.pi/packages/pi-workbuddy-connect`，含本地改动（见下方「与上游的差异」）。

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

### 从上游安装（无本地改动）

```bash
pi install git:github.com/icekale/pi-workbuddy-connect
```

### 临时加载

```bash
pi -e /Users/mz/.pi/packages/pi-workbuddy-connect
```

## 登录

设置 → 模型 → WorkBuddy AI → **Connect**（弹出浏览器登录页），或：

```
/login workbuddy
```

凭据按优先级解析：环境变量 `WORKBUDDY_AUTH_FILE` → pi 自存的 `~/.pi/agent/.workbuddy-auth.json` → 桌面 App 的 `workbuddy-desktop-ai.info`（macOS / Windows / Linux）。access token 过期前 5 分钟自动续期。

## 模型与推理档

默认只列出免费模型（`x0.00`）。每个模型的推理档来自产品配置 `~/.workbuddy-ai/cache/acc-product-config-v3.json` 的 `reasoning.supportedEfforts`；缓存不存在时回退到内置清单：

| 模型 | 上下文 | 推理档 |
| --- | --- | --- |
| Deepseek-V4.1-Flash | 1M / 128k | low · medium · high · xhigh · max |
| Hy4 preview | 1M / 64k | high |
| Hy3 | 192k / 64k | low · high |

没声明 `supportedEfforts` 的模型（`supportsReasoning: true`）默认给全套 low/medium/high/xhigh/max。

## 设置

pi 没有 DSH 那种插件配置卡片，等价入口有两处：

- **侧栏 widget** — 账号、token 过期时间、各积分包余量，以及当前模型列表。两档：`on` 显示、`off` 完全隐藏（侧栏与底部状态栏一并清空）。快捷键 `ctrl+shift+w` 可切换。
- **`/workbuddy`** — 弹出选择菜单：

  ```
  刷新积分与账号
  列出全部模型（含付费）   ← 切换范围，scope/visibility 存 ~/.pi/agent/.workbuddy-settings.json
  断开登录
  侧栏显示：显示          ← 切换 显示 / 隐藏
  ```

  也接受参数：`/workbuddy free` · `/workbuddy all` · `/workbuddy on` · `/workbuddy off` · `/workbuddy logout`。

切换范围后 provider 立即重新注册模型，无需 `/reload`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 指定凭据文件路径，优先于所有其他来源 |
| `WORKBUDDYAI_PRODUCT_CONFIG` | 指定产品配置 JSON 路径 |
| `PI_CODING_AGENT_DIR` | pi agent 目录，影响自存凭据与设置文件位置 |

## 自检

```bash
node --experimental-strip-types extensions/workbuddy.ts --self-check
```

覆盖认证解析、payload 规整、推理档映射、积分解析、widget 渲染与 footer 状态文本。

## 与上游的差异

本副本相对上游的本地改动：

- **侧栏显示收敛为两档** `on` / `off`（上游为三档 `full` / `compact` / `off`）。
- **`off` 时同时清空底部状态栏积分**（上游 `off` 只清 widget，footer 仍显示 `积分 N`）。footer 文本由 `statusText()` 统一产出。
- 旧设置值向后兼容：`visibility` 为 `full` / `compact` 或缺失时一律视为 `on`，仅 `off` 表示隐藏。

其余与上游一致：

- 直接 `pi.registerProvider`，去掉 DSH 的 shim 与 loopback 端口转发。
- 内置模型清单与上游 `BUILTIN_FREE_MODELS` 一致。
- 推理档由 pi-ai 的 `thinkingLevelMap` 驱动，选择器直接读 `getSupportedThinkingLevels`。
- 选 Default（auto）时**不发送** `reasoning_effort`，与上游一致；选具体档位时原样透传，不做任何改写。
- Deepseek-V4.1-Flash 的 `max_tokens` 封顶 16k（`FLASH_MAX_TOKENS`）：该模型会陷入 `OK. / Let me write. / Go.` 式推理循环，把 128k 预算烧完才停。长答案被截断时调大此常量。
- 发送前剔除 assistant 消息里回放的 `reasoning` / `thinking` / `reasoning_content` 字段，上游端点会拒绝这些字段。
- 未移植上游的 reasoning-effort 探测（probe）功能：需要联网发真实请求，且当前免费模型都已声明 `supportedEfforts`，探测无增益。

## 测试

```bash
node --experimental-strip-types test/scope.test.mts   # 断言 hook 不污染其他 provider 的请求
npx tsc -p tsconfig.json                              # 类型检查
```

## License

MIT
