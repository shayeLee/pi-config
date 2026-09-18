# 后台化子代理 + JSON 模式 steer —— 实施评估

> **状态：implemented（A → B → B-s 已全部落地并验证；默认异步）**
>
> 本文档记录解决该痛点的**选定路线**：继续使用 `--mode json`，不切换到常驻 RPC。
> 曾评估过的「常驻 `pi --mode rpc` 复用上下文」方案已因实测缺陷被否决，否决理由
> 完整保留在第 3 节（无需外部文档）。
>
> **痛点**：`subagent` 曾是同步阻塞调用 —— 子代理启动后主代理无法干预、无法停止、无法查看进度。
>
> **实施结果**：新增 `background-runs.ts`、`control-ext.js`，改造 `index.ts`，
> 新增 5 个工具（`subagent_wait` / `subagent_status` / `subagent_logs` / `subagent_stop` / `subagent_steer`），
> **single 与 parallel 均默认异步**，**chain 模式已删除**（顺序执行改由主代理自行调度）。
> 自动化 `harness/run.mjs` 98/98 通过，真实模型端到端 `harness/background-e2e.py`
> 两个场景（supervise 13/13、wait 7/7）通过。
>
> 🔴 **实施中发现并修复的关键缺陷**见第 5.6 节：非交互模式下 `followUp` 提醒不可靠，
> 因此引入 `subagent_wait` 作为可靠收口方式。

---

## 1. 问题陈述

### 1.1 根因：`execute()` 的同步契约

`agent-team` 的 `subagent` 工具在 `index.ts` 中这样执行子代理：

```ts
const exitCode = await new Promise<number>((resolve) => { /* spawn + 采集事件 + proc.on("close") */ });
```

`runSingleAgent()` 会 `await` 子进程**完整结束**才返回。这带来一个结构性后果：

```text
主代理调用 subagent
  → execute() 进入 await，主代理卡在这一次 tool call 里
  → 主代理无法再发起任何 tool call
  → ∴ 主代理不可能停止/干预正在运行的子代理
```

**这不是实现缺陷，是同步契约的必然结果。** 无论子进程是一次性 JSON 还是常驻 RPC，
只要 `execute()` 同步等待完成，主代理就没有机会介入。

### 1.2 当前唯一可用的控制手段

| 控制方 | 手段 | 覆盖范围 |
| --- | --- | --- |
| 用户 | `Ctrl+Alt+F` / `/subagents` 浮层 → 连续两次 `x` | 单个子代理 |
| 用户 | `Esc`（触发工具 `signal` → `AbortSignal`） | 当前整轮 |
| 主代理 | **无** | — |

即：**停止能力只属于人，不属于主代理。** 当主代理在长任务中需要「发现方向错了就改」时，它没有任何工具可用。

### 1.3 目标

1. 主代理能**异步**发起子代理，不被阻塞（后台化）。
2. 主代理能**停止**指定子代理（急停）。
3. 主代理能**查询**运行中/已完成子代理的状态与输出。
4. 主代理能**改方向**（steer 运行中的子代理）。
5. 子代理结束后若结果未被收取，**提醒**主代理去收取（正常使用时不产生提醒）。

---

## 2. 方案总览：B / B-s 分层

| 阶段 | 内容 | 解决的目标 | 工时 |
| --- | --- | --- | --- |
| **B** | 后台化（**single 与 parallel 默认异步**）+ `subagent_wait` / `subagent_status` / `subagent_logs` / `subagent_stop` + 未收取结果提醒 | 1, 2, 3, 5 | **6–9 人日** |
| **B-s** | JSON 模式 + 控制扩展（Unix socket）+ `subagent_steer` | 4 | **+2–3 人日** |
| **合计** | | 1–5 | **8–12 人日** |
| **额外** | 删除 chain 模式 | 简化语义（见 §6.5） | 含在上面 |

**两者都留在 `--mode json`，不引入 RPC。**

---

## 3. 为什么不用 RPC（实测证据）

常驻 `pi --mode rpc` 复用上下文这一路线已被评估并否决。本机实测发现三个问题，其中两个足以否决。

### 3.1 🔴 RPC 下 `ctx.hasUI === true`，扩展对话框会导致子进程静默自杀

| 模式 | `ctx.mode` | `ctx.hasUI` |
| --- | --- | --- |
| `--mode json -p --no-session`（现状） | `json` | **false** |
| `--mode rpc --no-session` | `rpc` | **true** |

`hasUI=true` 使 `ctx.ui.*` 从「静默 no-op」变成**真实异步往返**，而 RPC 子进程会主动退出。实测三种行为：

| 场景 | 实测结果 |
| --- | --- |
| 扩展调 `ctx.ui.confirm()` **无 timeout** | 261ms 发出 `extension_ui_request` → **进程 exit 0** |
| 扩展调 `confirm(..., {timeout})` | 优雅降级：返回 `false`，进程存活 |
| 扩展 `session_start` handler **挂住不返回** | **同样 exit 0** |
| 扩展在**启动之后**弹 dialog | 进程存活，请求悬着 |

根因（用 `process.on("beforeExit")` 抓到）：

```text
beforeExit code=0 at 19ms     ← 事件循环瞬时排空
process  exit code=0 at 19ms
```

**启动阶段阻塞等待 pending promise 时，Node 事件循环排空 → 触发 `beforeExit` → 进程静默 exit 0。**
父进程只会看到「子进程正常退出、无输出」，极难排查。

### 3.2 启动成本：继承扩展带来 ~2.8s 税

| 启动参数 | 就绪耗时（`get_state` 响应） |
| --- | --- |
| 默认（继承全部扩展） | **~2700–2840ms** |
| `--no-extensions` | **~190ms** |

这**推翻了「常驻 RPC 复用上下文」方案的核心动机**。该方案假设常驻 RPC 的收益是「避免重复冷启动」，
但实测显示主要冷启动成本来自扩展加载（2.8s vs 0.19s），而非进程本身。
与其花 20–35 人日做上下文复用，不如先做扩展白名单（见 §7.1）。

> 注意：扩展继承在**现状下已经发生**（`--mode json` 同样加载全部扩展）。
> 这不是 RPC 引入的问题，而是既有事实。

### 3.3 RPC 还需重写两处核心

- **事件解析器**：现有 `processLine()` 解析 `--mode json` 事件；RPC 事件虽同构，
  但混入了 `response` / `extension_ui_request` 等控制帧，需适配。
- **停止链**：现有 SIGTERM → 5s → SIGKILL 的进程组终止逻辑（`sendTerminationSignal` /
  `terminateProcess`）针对一次性子进程设计，常驻会话需重新设计回收协议。

### 3.4 结论

**`--mode json` + 侧信道控制扩展可以达成全部目标，且保留 JSON 模式的所有安全属性。** 见第 4 节实测。

---

## 4. 实测验证：JSON 模式下的 steer 可用

验证脚本：`harness/steer-spike.py`（纯标准库，无第三方依赖）。

### 4.1 架构

```text
主进程（agent-team 扩展）
  └─ spawn: pi --mode json -p --no-session -e control-ext.ts
       │   env: SUBAGENT_CONTROL_SOCKET=<path>
       └─ control-ext.ts 监听 Unix socket
            收到 {"type":"steer","message":"..."}
            → pi.sendUserMessage(msg, { deliverAs: "steer" })

主代理工具 subagent_steer(runId, message)
  → 按 runId 找到 socket → 写一行 JSON → steer 生效
```

### 4.2 实测结果（真实模型）

```text
 284ms  [ctl] session_start mode=json hasUI=false
 285ms  USER      "Task: Count slowly from 1 to 400, one number per line, nothing else."
3261ms  >> 通过 socket 发送 steer
3262ms  [ctl] accepted: steer
18134ms ASSISTANT stop=stop len=1491  "1\n2\n3\n...\n20..."     ← 第一轮跑完整个任务
18135ms USER      "STOP counting. Reply with exactly: PINEAPPLE" ← steer 真正投递
19795ms ASSISTANT stop=stop len=9     "PINEAPPLE"                ← 真实模型改变了方向
19795ms [ctl] server closed on agent_settled
结果: PASS（10/10 项通过）
```

mock 模式（本地假模型，确定性）同样 10/10 通过，且 mock server 侧证实
steer 消息**真的进入了下一轮 LLM 请求的 messages**：

```text
system     You are an expert coding assistant...
user       Task: Count slowly.
assistant  w1 w2 w3 ... w24
user       STOP counting. Reply with exactly: PINEAPPLE   ← 模型确实看到了
```

### 4.3 确认的关键事实

1. ✅ `--mode json` 下 `ctx.hasUI === false`（mock + 真实双确认）—— 绕开 §3.1 的自杀坑。
2. ✅ socket 回调中 `pi.sendUserMessage({deliverAs:"steer"})` 可用，**无 stale 错误**。
3. ✅ steer 进入下一轮 LLM 请求上下文（mock server 侧可见完整 messages）。
4. ✅ 真实模型按 steer 改变方向。
5. 🔴 **`net.Server` 会让子进程永不退出** → 必须在 `agent_settled` 时 `server.close()`。
   不做会**死锁**（父进程 `await` 永久挂起）。这是最大的实现坑。
6. ⚠️ steer 是**回合边界**生效，不是中途打断。

### 4.4 ⚠️ steer 的语义边界（重要，避免误用）

实测时间线显示：steer 在 3261ms 就被受理，但直到 18135ms（第一轮 assistant 完成后）才投递。

| 需求 | 机制 | 生效时机 |
| --- | --- | --- |
| **改方向** | `steer` | **下一回合边界**（当前生成/工具链跑完后） |
| **立刻停** | SIGTERM（B 阶段） | **立即** |

**对 worker / reviewer 这类多轮工具调用的子代理，steer 完全够用**——工具链会经过多个回合边界。
但若子代理是「一次长生成」，steer 必须等它生成完，**不能当急停用**。

> **这直接支撑了优先级：B（stop，急停）比 B-s（steer）更紧急。**

---

## 5. B 阶段设计：后台化 + 控制工具

### 5.1 数据流改造

`runSingleAgent()` 增加 `background` 分支：

```ts
if (background) {
  const promise = runSingleAgent(...);          // 不 await
  backgroundRegistry.set(runId, { promise, fleetRun, ... });
  return { runId, status: "running" };          // 立即返回
}
```

子进程 `close` 时（现有 `finally` 块已在此处）检查是否有未被收取的结果需要提醒。

### 5.2 新增工具

| 工具 | 签名 | 行为 |
| --- | --- | --- |
| `subagent_status` | `{ runId? }` | 无参：列出所有后台 run；有参：单个 run 的状态 + 摘要 |
| `subagent_stop` | `{ runId }` | 调 `fleetStore.stop(runId)` → 复用现有 SIGTERM→SIGKILL 链 |
| `subagent_logs` | `{ runId, tail? }` | 返回 `run.messages` 的文本化摘要 |

### 5.3 未收取结果的提醒

子代理结束后，若其结果一直未被收取，扩展会发一条 `followUp` 提醒主代理去 `subagent_wait`。

```ts
pi.sendUserMessage(reminder, { deliverAs: "followUp" });
```

用 `followUp` 而非 `steer`：提醒不应打断主代理当前正在做的事。

**提醒有两个触发时机**（run 可能在任一时点结束）：

| run 结束时机 | 处理 |
| --- | --- |
| 回合进行中 | 等到 `agent_settled` 再检查；届时通常已被 `subagent_wait` 收取，于是**不发任何消息** |
| 回合已空闲 | 立即提醒（没有别的东西会唤醒主代理） |

`needsReminder()` = 已结束 ∧ 未收取 ∧ 未提醒；`notified` 标记保证同一 run 只提醒一次，
也避免提醒自激成循环。因此**正常使用（用 `subagent_wait` 收口）零提醒消息**。

**提醒是尽力而为的，不能作为唯一结果通道** —— 详见 5.6。

### 5.4 Fleet / UI 改动

**几乎为零。** `FleetRun` 已含 `status: "running"`、`stop()` 控制端口、`messages`。
`fleet-view.ts` / `fleet-web.ts` 是只读消费者，后台 run 与前台 run 在它们看来完全相同。

**中立契约 `fleet-store.ts` 不需要改动**（可能只需加一个按 id 查找的只读方法）。

### 5.5 需要保留的既有行为

- 停止信号链：SIGTERM → 5s → SIGKILL（`sendTerminationSignal` / `terminateProcess`）
- `exitCode 130` / `stopReason: "stopped"` / Fleet 状态 `stopped`
- 临时系统提示词文件的创建与清理
- `PI_USAGE_ROOT_SESSION_ID` / `MODEL_FAILBACK_*` 环境变量传递

### 5.6 🔴 实施中发现的关键缺陷：非交互模式下提醒不可靠

**这是本次实施最重要的发现：仅靠 `followUp` 提醒会静默丢结果。**

#### 现象（本机实测）

```
    50ms SETTLED (agent 回合结束)
  3052ms TIMEOUT-FIRED: about to inject
  3052ms INJECT-THREW: Error: This extension ctx is stale after session
          replacement or reload...
```

#### 根因

`agent_settled` handler resolve 后，pi 立即执行 teardown：

```
agent_settled 全部 resolve
  → prompt() 返回
  → print/json 输出 flush
  → disposeRuntime()   ← 发 session_shutdown、agent.abort()、扩展 runtime invalidate
  → main() return → 事件循环排空 → 进程退出
```

`dispose()` 会 `invalidate` 扩展 runtime，此后任何 `pi.sendUserMessage` 都抛 stale 错误。

#### 影响矩阵

| 模式 | 提醒 |
| --- | --- |
| TUI 交互 | ✅ session 长驻，提醒可送达 |
| `-p` / `--mode json` | ❌ 主代理回合一旦结束，提醒必失败 |

#### 为什么初期测试没发现

- `background-e2e.py`：主代理连续调 4 个工具，agent 从未 settle 到 dispose
- `run.mjs`：mock 的 `sendUserMessage` 不检查 stale —— **mock 盲区**

#### 修复

1. 提醒包在 `try/catch` 中，失败静默（不再抛 stale 崩溃）。
2. **新增 `subagent_wait` 工具作为可靠收口**：直接读 run registry，不依赖 session 存活。
3. run registry 增加 `outstanding()` / `markCollected()`：无参 `subagent_wait` 能取回
   「已结束但尚未被收取」的结果，避免调用方漏传 `runId` 就丢结果。
4. 提醒改为**仅在遗漏时触发**（见 5.3）：无条件推送会让每个已收取的 run 都产生一条
   重复消息，因为 `followUp` 等到 agent 空闲时才投递，而 agent 用 `subagent_wait` 收口时
   从不等空闲——推送必然迟到。

---

## 6. B-s 阶段设计：控制扩展 + steer

### 6.5 chain 模式已删除

`chain` 模式（`{chain: [...]}` + `{previous}` 占位符）**已被移除**，原因：

1. **它与「主代理可控」的目标相冲突。** chain 把控制权交给一个不可干预的内部循环：
   主代理无法在中途改方向、停止或放弃后续步骤。
2. **主代理完全可以自己调度。** 顺序执行不需要专用模式：跑一个子代理 →
   `subagent_wait` 拿结果 → 把结果写进下一个 `task`。这样每一步的输入与验证都是显式的。
3. **`{previous}` 的本质约束。** 第 N+1 步的任务文本由第 N 步输出拼成，所以 chain 内部
   必须逐步 `await`——它天然无法后台化。

**历史兼容**：旧 session 中记录的 chain 结果仍可被恢复与渲染（`restoredRun` 保留
`"chain"` 分支，只读），但不再能发起新的 chain 调用（工具 schema 中已无 `chain` 字段）。

### 6.1 控制扩展（`control-ext.ts`，约 60 行）

```ts
import * as net from "node:net";

export default function (pi) {
  const sockPath = process.env.SUBAGENT_CONTROL_SOCKET;
  let server = null;

  // 🔴 必须：net.Server 会让事件循环常驻，不释放则子进程永不退出（死锁）
  pi.on("agent_settled", () => { if (server) server.close(); });

  pi.on("session_start", async (_e, ctx) => {
    if (!sockPath) return;
    server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let cmd; try { cmd = JSON.parse(line); } catch { continue; }
          const deliverAs = cmd.type === "followUp" ? "followUp" : "steer";
          try { pi.sendUserMessage(cmd.message, { deliverAs }); }
          catch (err) { /* session 已 dispose，静默丢弃 */ }
        }
      });
    });
    server.listen(sockPath);
  });
}
```

### 6.2 `index.ts` 接入点

1. spawn 时追加 `-e <control-ext.ts 路径>`，并注入 `SUBAGENT_CONTROL_SOCKET` 环境变量。
2. 将 socket 路径登记到 run registry（与 `runId` 关联）。
3. 子进程退出时 `unlink` socket 文件。
4. 新工具 `subagent_steer({ runId, message })`：查 socket → 写一行 JSON。

### 6.3 跨平台

Unix domain socket 仅限 POSIX。Windows 需回退到 **TCP localhost** 或 **named pipe**。
建议：POSIX 用 UDS（路径短、无端口冲突），Windows 用 `127.0.0.1` 随机端口 + 令牌校验。

### 6.4 错误处理约定

- socket 消息到达时若子进程已退出 → **静默丢弃**，不抛错（`sendUserMessage` 会 `assertActive()`）。
- socket 连接失败 → `subagent_steer` 返回明确错误文本，不抛异常。
- 子进程异常退出 → 清理 socket 文件，避免残留。

---

## 7. 附带发现（建议单独立项）

### 7.1 子进程扩展白名单（独立收益，0.5–1 人日）

实测 `--no-extensions` 把启动从 **2.8s 降到 0.19s**。但**不能无脑使用**——以下扩展是
**故意**在子进程中工作的：

| 扩展 | 依赖的机制 | 证据 |
| --- | --- | --- |
| `model-failback` | `MODEL_FAILBACK_CHILD === "1"` | `engine.ts:76` 显式判断 |
| `usage-stats` | `PI_USAGE_ROOT_SESSION_ID` | `usage-stats.ts:257` |
| `thinking-breaker` | 跨进程共写同一 jsonl | `index.ts:173` 注释 |
| `agent-team` | 子代理嵌套 | 自身 |

**建议**：改为白名单 `--no-extensions -e <上述四个>`。每次 `subagent` 调用省 ~2.5s。
**此改动对现状（不做 B/B-s）也有独立价值。**

### 7.2 🔴 `ctx.ui.confirm()` 在子进程中静默返回 false（既有 bug）

`hasUI=false` 时 runner 走 `noOpUIContext`，`confirm()` 静默返回 `false`、`select()` 返回 `undefined`。

**影响**：任何用 `confirm` 做安全门的扩展，在子代理里都是**静默拒绝**（fail-closed）。
仓库中的 `path-scope`、`bash-guard` 属于此类。

这是**既有行为，与本次改动无关**，但既然要动子进程启动参数，建议一并确认预期语义
（是「故意 fail-closed」还是「应改用其他判定」）。

---

## 8. 验证计划

### 8.1 自动化（`harness/run.mjs`）—— 已实现，100/100 通过

- [x] **只有一种行为：总是后台**：`subagent` 不再接受 `background` 参数
- [x] parallel 每个 task 成为独立后台 run，可单独 supervise / stop
- [x] 停止单个 task 不影响其他 task
- [x] `subagent_wait` 返回 `details`（已结束 run 的结构化记录，供 TUI 渲染与历史恢复）
- [x] **chain 模式已从工具 schema 中移除**
- [x] `subagent_wait` 在 run settle 后返回结果与终态
- [x] `subagent_wait` 超时报告仍在运行的 run
- [x] 无参 `subagent_wait` 能取回「已结束但未收取」的结果；收取后离开 outstanding 集合
- [x] `subagent_stop` 对后台 run 生效，终态为 `stopped`
- [x] `subagent_status` 正确反映 running / completed / failed / stopped
- [x] 未收取的结果提醒以 `followUp` 投递（可用时）
- [x] B-s：控制 socket 可达、steer 到达子进程、payload 完整
- [x] 已终止/未知 run 的 steer 与 stop 被正确拒绝
- [x] 子进程在 `agent_settled` 后正常退出（`control-ext.js` 关闭 listener，防死锁）

### 8.2 真实环境端到端（`harness/background-e2e.py`）—— 两个场景均通过

用真实模型驱动主代理执行完整流程：

**scenario supervise（13/13）**：`subagent` → `status` → `steer` → `stop` → `status` → `wait`

- [x] 默认异步（未传 `background` 也后台化）
- [x] 立即返回 runId，不阻塞
- [x] `subagent_status` 报告 running；停止后报告 stopped
- [x] `subagent_steer` / `subagent_stop` 被接受
- [x] `subagent_wait` 返回结果

**scenario wait（7/7）**：`subagent` → `wait` → 复述子代理输出

- [x] 验证**非交互模式下 `subagent_wait` 能可靠收口**（5.6 缺陷的修复验证）
- [x] 主代理确实收到了子代理的真实输出（`BANANA`）

### 8.3 机制验证（`harness/steer-spike.py`）—— mock 10/10 + 真实 10/10

已覆盖 B-s 的底层机制（`hasUI=false`、socket 可达、steer 进入下一轮 LLM 上下文、
真实模型改变方向），作为回归基线保留。

### 8.4 真实 Pi 冒烟（手测，待完成）

- [ ] `Ctrl+Alt+F` Fleet 中后台 run 显示为 running
- [ ] 浮层连续两次 `x` 仍能停止后台 run
- [ ] 浏览器只读 Web UI 显示后台 run

---

## 8.5 实施结果（已完成）

| 文件 | 变更 |
| --- | --- |
| `background-runs.ts` | **新增**。后台 run 注册表（数据流层，不依赖展示层）。持有 `settled` promise 与 outstanding/collected 语义。 |
| `control-ext.js` | **新增**。注入子进程的控制扩展：Unix socket → `sendUserMessage({deliverAs:"steer"})`。 |
| `index.ts` | 新增 5 个工具；**删除 chain 模式**；**删除同步路径**（不再有 `background` 参数、`signal` 绑定、`onUpdate` 回调、`MAX_CONCURRENCY` 信号量）；single/parallel 共用 `startBackgroundRun`；spawn 时注入控制扩展与 socket；退出时清理 socket；提醒包 try/catch。 |
| `harness/run.mjs` | 重写为后台/wait/steer 模型（共 100 项）；停止流程改用 `subagent_stop`；补上 mock ctx 缺失的 `sessionManager`。 |
| `harness/fake-pi.cjs` | 新增 `SCENARIO:steerable`；移除 `SCENARIO:chain`。 |
| `harness/background-e2e.py` | **新增**。真实模型端到端验证（supervise / wait 两个场景）。 |
| `harness/steer-spike.py` | **新增**。机制验证脚本（mock + 真实）。 |
| `APPEND_SYSTEM.md` | 新增「Background Subagents」小节：默认异步、必须 `subagent_wait` 收口、不得带未收口的子代理结束回合。 |

### 实现中确认的三个关键细节

1. **后台 run 不绑定父代理的 `signal`**。父回合结束后会 abort，从而误杀后台子代理。
   后台 run 的停止只通过 `subagent_stop`（`FleetStore.stop` → SIGTERM → SIGKILL）。
   由于所有 run 都是后台 run，`runSingleAgent` 已不再接受 `signal` 参数。
2. **`onSpawned` 回调与 `promise` 之间存在 TDZ 循环**。`runSingleAgent` 是 async，
   函数体会同步执行到第一个 `await`，因此回调先于 `const promise` 赋值触发。
   解法：把启动逻辑抽成 `startBackgroundRun()`，由它内部持有 deferred promise。
3. **`subagent_wait` 必须返回 `details`**。Fleet 历史恢复依赖 `subagent` 工具结果里的
   `details.results`；当 `subagent` 只返回 `runId` 时，这个职责转给了 `subagent_wait`。
   run 记录因此需要携带 `agentScope` / `projectAgentsDir` 以重建完整的 details 形状。

---

## 9. 明确不在范围内

- ❌ 常驻 RPC 会话 / 上下文复用（已评估并否决，理由见第 3 节）
- ❌ 跨主进程重启恢复
- ❌ session 分支上下文隔离
- ❌ 同角色并行复用
- ❌ 重定义 `{previous}` 语义
- ❌ 改变前台（非后台）`subagent` 的默认行为

---

## 10. 实施顺序

```text
A  ← 本文档（评估固化）
B  ← 后台化（默认异步）+ wait/status/stop/logs + 未收取提醒（6–9 人日）
B-s ← JSON + 控制扩展 + steer（+2–3 人日）
```

B 与 B-s 独立可交付：B 完成后主代理已具备「异步 + 急停 + 查状态」能力，
B-s 是增量增强。若 B 落地后 `agent_settled` 死锁坑暴露，B-s 需先解决该问题再上。

---

## 附录：实测命令

```bash
# mock 模式（本地假模型，无需凭证，确定性）
python3 agent/extensions/agent-team/harness/steer-spike.py

# 真实模型
python3 agent/extensions/agent-team/harness/steer-spike.py --real

# 模型过快时加长任务、延后 steer
python3 agent/extensions/agent-team/harness/steer-spike.py --real \
  --task "Count slowly from 1 to 500, one number per line, nothing else." \
  --steer-delay 3 --timeout 180
```

---

*文档性质：实施评估（implemented）。所有实测数据来自本机 `harness/steer-spike.py`（mock 10/10 + 真实模型 10/10）、`harness/background-e2e.py`（真实模型 supervise 13/13 + wait 7/7）与 `harness/run.mjs`（98/98）。*
