# agent-team 自动化 harness

独立的 Node 测试（仓库无现有测试框架），加载真实的扩展源码验证数据流与展示层语义，
全程不调用任何真实模型。三个入口：

- `run.mjs`：数据流 harness——加载 `../index.ts`，注册并调用 `subagent` 工具，用临时
  fake `pi` 可执行文件驱动子代理进程（确定性 JSONL 事件）。
- `presentation.mjs`：展示层 harness——加载 `fleet-view.ts` / `fleet-web.ts`，验证
  FleetStore、FleetWidget、Web payload 序列化与 FleetWebServer HTTP。
- `overrides.mjs`：角色发现 harness——加载 `../agents.ts`，验证 `agents.override.json`
  对 Markdown frontmatter 的字段级覆盖（model/tools/thinking）与清除/忽略语义。

对应 README 的"核心原则：数据与展示分离"：`run.mjs` 守护数据流产物（`content` /
`details`），`presentation.mjs` 守护展示层作为只读消费者时的行为；
`overrides.mjs` 守护角色配置的覆盖优先级。

## 运行

```bash
node agent/extensions/agent-team/harness/run.mjs
node agent/extensions/agent-team/harness/presentation.mjs
node agent/extensions/agent-team/harness/overrides.mjs
```

要求：

- Node.js >= 22（与 pi 的 engines 一致）。
- 本机可用的 pi-coding-agent 包（提供扩展运行时模块与 jiti）。默认按
  `$VOLTA_HOME/tools/image/packages/@earendil-works/pi-coding-agent/...` 探测；
  若探测失败，用 `PI_PACKAGE_ROOT` 显式指向包含 `dist/index.js` 和
  `node_modules` 的包目录。

退出码：全部断言通过为 0，任一失败为 1。

## run.mjs（数据流）

1. 在临时目录生成项目级 agent 配置 `.pi/agents/worker.md`（frontmatter 含
   `model`/`tools`，正文为系统提示词）。
2. 生成临时 bin 目录，把 `fake-pi.cjs` 复制为名为 `pi` 的可执行文件，并把它放到
   `PATH` 最前面。扩展的 `getPiInvocation()` 在普通 node 运行时下回退为
   `spawn("pi", ...)`，因此子代理进程实际由 fake `pi` 承担。
3. fake `pi` 解析扩展传入的 argv（`--mode json -p --no-session`、`--model`、
   `--tools`、`--append-system-prompt`、`Task: ...`），按 task 中的场景标记输出
   确定性 JSONL 事件，并把每次调用的 argv/task/systemPrompt/cwd 追加到
   `$FAKE_PI_LOG` 供断言。
4. 用 jiti（与 pi 扩展加载器相同的别名）加载 `../index.ts`，传入 mock ExtensionAPI
   捕获注册，再直接调用 `subagent` 工具的 `execute()`。

断言组：

1. **tool_result_end-only**：只经 `tool_result_end` 到达的 toolResult 仍作为 durable
   消息保留在 `details.results[0].messages`，且只保留一次。
2. **同 toolCallId 去重**：同一 toolResult 同时经 `tool_result_end` 和 `message_end`
   到达时，transcript 中只保留一条。
3. **transient 事件隔离**：`tool_execution_update` / `tool_execution_end` 不进入
   `content` 或 `details` 的消息记录，最终文本不含 transient 输出。
4. **parallel 后台化**：`parallel` 模式下每个 task 成为独立的后台 run，各自返回
   `runId`；无参 `subagent_wait` 能一次收齐全部结果，并返回带全部已结束 run 结构化记录的
   `details`。chain 模式已移除，工具 schema 中不再有 `chain` 字段。
5. **停止单个运行中的子代理**：通过 `subagent_stop` 停止 → fake `pi` 收到 SIGTERM，
   结果 `exitCode 130`、`stopReason "stopped"`；parallel 中停止一个 task 不影响其他 task。
6. **SIGKILL 升级**：对忽略 SIGTERM 的顽固子进程（`SCENARIO:stubborn`），约 5 秒后
   被 SIGKILL 强制终止，结果仍报告 `exitCode 130` 且 SIGTERM 确实被送达。
7. **进程组终止覆盖后代**：fake 组长（`SCENARIO:descendant`）spawn 一个同组后代并忽略
   SIGTERM；组长收到 SIGTERM 退出后，后代必须存活到 5 秒后的进程组 SIGKILL 才被终止——
   守护 README 中“已退出组长的后代仍会被该进程组信号覆盖”的语义。

另外断言临时 agent 配置确实到达子进程（`--model`/`--tools`/追加系统提示词）、
`cwd` 转发、扩展注册项（tool/command/shortcut/handler）齐全。

## presentation.mjs（展示层）

0. **依赖边界（静态）**：数据流层 `index.ts` 只从 `fleet-store.ts` 取状态，从
   `fleet-view.ts` 只 import composition root 用的 UI 符号（`FleetWidget` /
   `showFleetOverlay`）；`fleet-store.ts` 不 import 任何一层。
1. **FleetStore 状态容器**：add/finish/stop/markStopping/clear/touch 的状态转换、
   订阅者通知与退订、32 条上限 prune（只淘汰最老 completed、保留 running）、
   restore 历史重建（slice 32 + running 保留 + 恢复项 stop 为 no-op）。
2. **FleetWidget.render**：空 store 渲染为空、最多显示 6 条、运行计数只统计可见项、
   完成后 15 秒保留（过期隐藏但仍在 store）、长 task 按可见宽度截断（ANSI 感知）。
3. **Web payload 序列化**：`webRun`/`selectWebRun`/`serializeFleetRun`——消息/文本/
   content part/工具更新的截断档位、256 KiB payload 上限与降级、超长 id 的最终兜底
   截断、edit 参数清理与 omission 计数、toolResult diff 截断、深冻结 fixture 验证
   源数据不被修改（只读快照）。
4. **FleetWebServer HTTP**：注入 `openBrowser` 桩（不真实打开浏览器）后启动，验证
   token 鉴权（错误 token 404）、data 端点 JSON 与 revision 递增（变化 +1、不变保持）、
   no-store 头、HTML 页面、SSE `event: update` 推送（含 store 变更广播）、close 后
   端口拒绝。

## overrides.mjs（角色发现覆盖）

1. 在临时项目 `.pi/agents/` 生成 `worker.md`（frontmatter 含 `model`/`tools`/
   `thinking`）和 `agents.override.json`，用 jiti 加载 `../agents.ts` 的
   `discoverAgents` 后断言；`both` 场景通过 `PI_CODING_AGENT_DIR` 指向临时用户目录
   隔离用户级角色。
2. **覆盖**：JSON 显式字段替换 frontmatter（model/tools/thinking），description 与
   正文（systemPrompt）保留；JSON 中无对应 Markdown 角色的键被忽略；键名去除首尾
   空格后匹配。
3. **清除**：`""` / `[]` 清空 frontmatter 值，回退默认。
4. **类型**：`tools` 支持逗号分隔字符串或数组；不合法类型（含数组含非字符串元素）
   忽略并保留 Markdown 值。
5. **容错**：无法解析的 JSON、数组根节点、缺失 override 文件均静默忽略，行为等同
   未覆盖。
6. **作用域**：`both` 下项目级角色（含项目 override）整体覆盖同名用户级角色（含
   用户 override），用户 override 不泄漏到项目角色。

## 真实 Pi 冒烟清单（剩余手测项）

自动 harness 不涉及真实 TUI 渲染与浏览器打开；这两个交互面仍需在发布前手测。手测
清单见 `agent-team/README.md` 的"真实 Pi 冒烟清单"。
