# agent-team 数据流 harness

独立的 Node 测试 harness（仓库无现有测试框架），用临时 fake `pi` 可执行文件和 mock
ExtensionAPI 加载真实的 `../index.ts`，注册并调用 `subagent` 工具，验证数据流语义。
全程不调用任何真实模型。

## 运行

```bash
node agent/extensions/agent-team/harness/run.mjs
```

要求：

- Node.js >= 22（与 pi 的 engines 一致）。
- 本机可用的 pi-coding-agent 包（提供扩展运行时模块与 jiti）。默认按
  `$VOLTA_HOME/tools/image/packages/@earendil-works/pi-coding-agent/...` 探测；
  若探测失败，用 `PI_PACKAGE_ROOT` 显式指向包含 `dist/index.js` 和
  `node_modules` 的包目录。

退出码：全部断言通过为 0，任一失败为 1。

## 工作原理

1. 在临时目录生成项目级 agent 配置 `.pi/agents/worker.md`（frontmatter 含
   `model`/`tools`，正文为系统提示词）。
2. 生成临时 bin 目录，把 `fake-pi.cjs` 复制为名为 `pi` 的可执行文件，并把它放到
   `PATH` 最前面。扩展的 `getPiInvocation()` 在普通 node 运行时下回退为
   `spawn("pi", ...)`，因此子代理进程实际由 fake `pi` 承担。
3. fake `pi` 解析扩展传入的 argv（`--mode json -p --no-session`、`--model`、
   `--tools`、`--append-system-prompt`、`Task: ...`），按 task 中的场景标记输出
   确定性 JSONL 事件，并把每次调用的 argv/task/systemPrompt/cwd 追加到
   `$FAKE_PI_LOG` 供断言。
4. 用 jiti（与 pi 扩展加载器相同的别名，指向 pi 包内的 `pi-coding-agent`/
   `pi-ai`/`pi-tui`/`pi-agent-core`/`typebox`）加载 `../index.ts`，传入 mock
   ExtensionAPI 捕获注册，再直接调用 `subagent` 工具的 `execute()`。

## 断言

1. **tool_result_end-only**：只经 `tool_result_end` 到达的 toolResult 仍作为
   durable 消息保留在 `details.results[0].messages`，且只保留一次。
2. **同 toolCallId 去重**：同一 toolResult 同时经 `tool_result_end` 和
   `message_end` 到达时，transcript 中只保留一条。
3. **transient 事件隔离**：`tool_execution_update` / `tool_execution_end` 不进入
   `content` 或 `details` 的消息记录，最终文本不含 transient 输出。
4. **chain `{previous}`**：`{previous}` 只被紧邻上一步的最终 assistant 文本替换；
   上一步的工具结果文本（`CHAIN-TOOL-SECRET`）和完整 transcript 不会泄漏进下一步
   的 task。

另外断言临时 agent 配置确实到达子进程（`--model`/`--tools`/追加系统提示词）、
`cwd` 转发、扩展注册项（tool/command/shortcut/handler）齐全。

## 真实 Pi 手测清单

自动 harness 不调用真实模型；在发布前，可按本清单手测 TUI、Web UI 和进程生命周期。
使用临时目录，避免 Edit 修改真实项目：

```bash
mkdir -p /tmp/agent-team-smoke
cd /tmp/agent-team-smoke
printf 'before\n' > sample.txt
pi
```

### 1. 基本子代理与 Fleet

在 Pi 中要求主代理：

```text
使用 subagent 工具调用 worker，任务是：读取当前目录的 sample.txt，并只回复文件内容。
```

预期：主对话返回 `before`；按 `Ctrl+Alt+F` 或执行 `/subagents` 能打开 Fleet；选中任务后，
`Enter` 打开本机 Web UI，`i` 打开终端内详情。

### 2. Edit 与实际 diff

```text
使用 subagent 工具调用 worker，任务是：使用 edit 工具把 sample.txt 中的 before 改为 after，然后读取文件确认结果。
```

预期：`cat sample.txt` 输出 `after`；Fleet 中仅显示工具返回的 actual diff，删除行为红色、
新增行为绿色。若工具未返回 canonical diff，则不显示 diff。

### 3. Chain `{previous}`

```text
使用 subagent 工具执行 chain：
1. worker：只回复 CHAIN-FIRST。
2. worker：只回复“收到：{previous}”。
```

预期：最终输出为 `收到：CHAIN-FIRST`（或等价文本）；不应出现第一步的完整 transcript、工具输出
或 Fleet 的运行中输出。

### 4. 停止运行中的任务

```text
使用 subagent 工具调用具有 bash 权限的 agent，任务是：执行 sleep 60，然后回复完成。
```

任务运行时打开 Fleet，选中任务后连续按两次 `x`（3 秒内）确认停止。首次按下只显示确认提示；
按其他键或 `Esc` 会取消。预期任务状态变为 `stopped`。POSIX 平台应终止该子代理进程组；Windows
使用 `taskkill /T`，属于 best-effort，根进程先退出时可能残留后代。

### 5. 兼容事件

`tool_result_end` 兼容和与 `message_end` 的去重由自动 harness 覆盖，真实 Pi 手测无需伪造 JSON
事件。
