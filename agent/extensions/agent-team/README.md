# agent-team 数据流说明

`agent-team` 扩展向 Pi 注册 `subagent` 工具，通过独立的 Pi 子进程运行项目级或用户级子角色。扩展只负责角色发现、任务转发、事件采集和结果汇总，不包含具体领域的角色提示词。

## 数据流概览

```text
主代理调用 subagent
  → 按 agentScope 发现角色 Markdown
  → 读取角色 frontmatter 和正文
  → 将角色正文作为子代理追加系统提示词
  → 将 task 作为子代理用户任务
  → 启动无会话的 Pi JSON 子进程
  → 采集 message_end 等 JSON 事件
  → 提取最终 assistant 文本
  → content 返回主代理，details 保留完整过程供 UI 使用
```

## 角色发现

角色由 `agents.ts` 从 Markdown 文件加载。每个文件需要以下 frontmatter：

```yaml
---
name: worker
description: 角色说明
tools: read, grep, find, ls, bash, edit, write
model: provider/model
---
```

Markdown 正文是该角色的系统提示词。

`agentScope` 决定发现范围：

- `both`：默认值。同时读取用户级角色和当前工作目录向上最近的 `.pi/agents`；同名角色由项目级配置覆盖用户级配置。
- `project`：只读取当前项目的 `.pi/agents`。
- `user`：只读取用户级 Pi agent 目录中的 `agents`。

角色配置在每次 `subagent` 调用时重新发现，不缓存到扩展的长期状态中。

## 系统提示词与任务提示词

每个子代理使用独立 Pi 进程和独立上下文窗口。

角色正文会写入权限为 `0600` 的 UTF-8 临时文件，并通过：

```text
--append-system-prompt <临时文件>
```

传给子进程。子进程结束后，扩展删除该临时文件和临时目录。

在当前 Pi 0.82.1 中，显式传入 `--append-system-prompt` 后，角色正文会作为本次调用的追加系统提示词来源；项目自动发现的 `.pi/APPEND_SYSTEM.md` 不会再次追加。Pi 的基础系统提示词以及正常发现的 `AGENTS.md`、`CLAUDE.md` 等项目上下文仍按子进程规则加载。

任务以单个进程参数传递：

```text
Task: <task>
```

子进程使用 `shell: false`，因此任务中的换行、引号、Unicode 和普通 `$` 字符不会经过 Shell 展开。

父代理的会话历史、附件、工具结果和隐含上下文不会自动复制给子代理。调用方需要让 `task` 自包含，明确给出目标、范围、约束、相关路径、已有发现和验收方式。

## 子进程

扩展使用以下等价参数启动子代理：

```text
pi --mode json -p --no-session
```

并根据角色配置追加：

```text
--model <model>
--tools <逗号分隔的工具名>
--append-system-prompt <临时文件>
```

`--no-session` 表示子代理不保存可恢复会话。这里的“隔离”是上下文和进程隔离，不是文件系统或命令权限沙箱。`tools` 控制 Pi 暴露的工具列表，但不能把包含 `bash` 的角色变成强制只读角色。

子进程工作目录按以下顺序确定：

1. 当前任务或 chain step 上显式提供的 `cwd`。
2. 主代理调用工具时的 `ctx.cwd`。

## JSON 事件采集

Pi JSON 模式按行输出事件。扩展解析每一行，并主要采集：

- `message_end`：一条 user、assistant 或 toolResult 消息已经结束。
- `tool_execution_update` / `tool_execution_end`：仅用于 Fleet 的运行中展示；不会写入 durable 消息记录。
- `tool_result_end`：旧版 runner 的兼容事件；存在时会采集其中的 durable toolResult。若同一 `toolCallId` 也收到 `message_end`，仅保留一次，避免重复。

所有采集到的消息保存在 `SingleResult.messages` 中。对于 assistant 消息，扩展还累计：

- 输入、输出和缓存 token；
- 费用；
- assistant 回合数；
- 当前上下文 token；
- 模型；
- `stopReason`；
- `errorMessage`。

最终文本通过倒序查找最后一条包含 `text` 内容块的 assistant 消息获得。工具结果、thinking 和其他非文本内容不会拼入最终文本，但仍保留在 `details` 中。

当前失败判定包括：

- 子进程退出码非零；
- `stopReason === "error"`；
- `stopReason === "aborted"`。

`stopReason === "length"` 表示模型输出达到长度限制；当前扩展保留部分文本，并按非错误结果处理。

## 执行模式

### Single

输入：

```json
{
  "agent": "worker",
  "task": "..."
}
```

扩展启动一个子进程。主代理收到该子代理最后一条 assistant 文本；完整消息记录保存在 `details.results[0]`。

### Parallel

输入：

```json
{
  "tasks": [
    { "agent": "reviewer", "task": "..." },
    { "agent": "reviewer", "task": "..." }
  ]
}
```

关键行为：

- 一次最多接收 8 个任务。
- 最多同时运行 4 个子进程。
- 最终结果保持输入任务的顺序，而不是完成顺序。
- 主代理收到每个任务的状态和最终 assistant 文本。
- 每个任务返回给主代理的文本上限为 50 KiB；完整文本仍保存在 `details` 中。
- 单个任务失败不会阻止其他并行任务完成。

### Chain

输入：

```json
{
  "chain": [
    { "agent": "worker", "task": "调查问题" },
    { "agent": "reviewer", "task": "根据以下结果复核：\n{previous}" }
  ]
}
```

关键行为：

- 每一步都启动新的无会话 Pi 子进程。
- 步骤按顺序执行。
- `{previous}` 只代表紧邻上一步的最终 assistant 文本，不包含其完整消息、工具结果或 `details`。
- `{previous}` 是可选占位符；未写入占位符时，该步骤不会收到上一步文本。
- 上一步文本通过函数替换按字面量注入，因此 `$$`、`$&`、``$` ``、`$'` 等 JavaScript replacement 特殊序列不会被改写。
- 任一步被当前失败判定识别为失败时，chain 立即停止。
- chain 完成后，主代理只收到最后一步的最终 assistant 文本；所有步骤记录保存在 `details.results` 中。

## 主代理可见结果

Pi 工具结果包含两个用途不同的字段：

- `content`：进入主代理模型上下文。
- `details`：保存结构化完整记录，供日志和 TUI 渲染使用。

因此主代理依赖的是子代理最终汇报，而不是完整中间过程。主代理仍应根据仓库状态、diff、文件内容和验证命令自行确认结果，不能只根据子代理汇报接受变更。

子角色的最终汇报应至少覆盖：

- 完成了什么或发现了什么；
- 修改了哪些文件；
- 执行了哪些验证及其结果；
- 剩余风险、阻塞和未验证项。

## TUI 展示

TUI 使用独立的轻量展示，不铺满工具成功/失败背景色。折叠视图按 `Activity` 和 `Result` 分区：

- `Activity` 汇总工具调用数量与类型，并只列出最近的调用；
- `Result` 使用 Markdown 渲染子代理最终结论；
- 流式执行期间显示 `running` / `Progress`，不会提前显示成功状态。

按 `Ctrl+O` 可展开完整调用轨迹，查看保存于 `details` 的每次工具调用、对应结果和各步骤消息。Single、Parallel 和 Chain 使用相同的分区与状态语义。

`renderCall` 和 `renderResult` 只控制 Pi TUI 展示，不改变主代理实际收到的 `content`，也不自动改变 pi-web 等其他宿主的渲染方式。

### FleetView 与对话浮层

TUI 会在编辑器下方显示当前 session 的 FleetView：

- 运行中的子代理持续显示 agent、model、任务、耗时和 token/费用摘要；
- 已完成、失败或停止的子代理短暂保留 15 秒，便于确认终态；
- FleetView 最多显示最近 6 项，扩展内存中保留最近 32 项供浮层查看。

恢复已有 session 时，浮层会从当前 session 分支中已保存的 `subagent` 工具结果重建最近 32 条记录。历史记录为只读，不能执行停止；没有最终工具结果的中断调用显示为 `interrupted`。切换 session tree 分支后，列表会按新分支重新构建。历史记录不会重新写入 session，也不会进入 LLM 上下文。

按 `Ctrl+Alt+F` 或运行 `/subagents` 打开对话浮层。列表中可以：

- 使用方向键、`j` / `k` 或 `Ctrl+N` / `Ctrl+P` 选择子代理；
- 按 `Enter` 在本机只读 Web UI 查看任务、实时状态、assistant 文本、工具调用和工具结果；macOS 明确使用 Safari，Windows/Linux 使用系统默认浏览器。页面只监听 `127.0.0.1`，关闭 Pi 后不可访问；
- 按 `i` 保持在终端内查看同样的对话详情；
- 在对话中使用方向键、`j` / `k`、`Ctrl+N` / `Ctrl+P`、`PageUp` / `PageDown`、鼠标滚轮或触摸板滚动；
- 在对话中使用 `Home` / `End` 回到内容顶部或底部；
- 连续按两次 `x` 停止运行中的子代理；首次按下后 3 秒内再按一次确认，其他按键会取消；
- 按 `Esc` 返回列表，再按一次关闭浮层。

进入对话详情时会临时启用终端 mouse tracking，返回列表或关闭浮层时恢复；agent 列表不响应触摸板滑动。Warp 需要先在 `Settings → Features` 开启 `Enable Mouse Reporting` 和 `Scroll Reporting`；按住 `Shift` 滚动或选择时，事件交还给 Warp。

停止操作针对单个子进程：在 POSIX 平台向独立进程组发送 `SIGTERM`，5 秒后仍有成员则发送 `SIGKILL`；已退出组长的后代仍会被该进程组信号覆盖。Windows 使用 `taskkill /T` 尝试终止进程树；这属于 best-effort，若根进程已先退出，后代可能无法被可靠发现或终止。已采集的消息和部分输出会保留，终态标记为 `stopped`，与正常完成和失败分开显示。Parallel 中停止一个任务不会终止其他任务；Chain 中停止当前步骤会结束整条 chain，不再启动后续步骤。

FleetView、对话浮层和运行注册表只消费现有的 JSON 事件与 `SingleResult` 引用，不改变主代理收到的 `content`、结构化 `details` 或 `{previous}` 传递规则。当前子进程仍使用一次性的 `--no-session` print 模式，不支持运行中 steer。
