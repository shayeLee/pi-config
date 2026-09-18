# thinking-breaker

思考**复读**（reasoning loop）的探针与熔断。

某些模型（实测只有 `workbuddy/deepseek-v4.1-flash`）会在思考里陷入尾部复读：

```
OK. Let me write. Go. Now.
OK. Let me write. Go. Producing.
OK. Let me write. Go. Now.
...（重复几万次）
```

复读有两种形状，各由一个探针负责：

- **尾部周期**（探针 A）：整段单元逐字重复，`detectTailPeriod` 能测出精确周期。
- **词表塌缩**（探针 B）：同一批短句反复出现但**顺序不规则**，不存在任何精确周期；
  可判据变成「末尾窗口里不同行的种类数极低」。

报障事故（2026-09-18，`workbuddy/deepseek-v4.1-flash`）：

| 指标 | 值 |
|---|---|
| 思考字符数 | 234,172（≈ 5.9 万 token） |
| thinking_delta 次数 | 70,373 |
| 耗时 | **164 秒** |
| 产出 | `textDeltaChars = 0`、`toolcallStart = 0` —— **一个字都没产出** |
| 复读单元 | **405 字符**（9 个短句变体轮换） |
| 收尾 | 用户按 Esc（`stopReason: "aborted"`）；账本 `break = null`、`verdict = null` |

旧配置（`enforceMaxPeriod = 200`）对该样本**结构性失明**：405 > 200，`detectTailPeriod`
恒返回 null —— 在整篇 200,000 字符（真实 234,172）上从不命中。这就是「熔断没触发」
的根因。放宽到 600 后：

| 探针 | 原始首次命中位置 | 受 `enforceMinChars = 20000` 门禁后的开火位置 |
|---|---|---|
| A（maxPeriod 200，旧） | **从不命中** | — |
| A（maxPeriod 600，新） | 9,000 字符 | 20,000 字符 |
| B（词表塌缩，新） | 6,000 字符 | 20,000 字符 |

更早的两次事故（2026-09-17，35 万字符；2026-09-18，50 万字符）同样是零产出 + Esc：

| 事故 | 思考字符数 | 耗时 | 产出 | 探针 A 首次命中 |
|---|---|---|---|---|
| 2026-09-17T06:36 | 353,961 | 289 秒 | 0 | 42,500 字符 |
| 2026-09-18T08:43 | 500,374 | 298 秒 | 0 | 20,000 字符（原始 6,000） |
| **2026-09-18T13:05（报障）** | **234,172** | **164 秒** | **0** | 旧配置**从不命中** / 新配置 20,000 字符 |

即：**近 5 分钟的算力与上下文预算，产出为零。**

## Phase 1（观测）的实测结论

用 2601 条真实思考原文回答"能不能熔断、靠什么熔断"（下表为 Phase 1 当时的结论，
命中统计已按 6210 条的最新数据更新）：

| 问题 | 结论 | 依据 |
|---|---|---|
| 哪些模型吐思考原文？ | 12 个模型里 11 个吐，捕获率 78%–100% | `deltaMode` 与 `deltaCapture` 汇总 |
| `delta` 是增量还是累计？ | 全部 `incremental` | 流式明细里 `deltaLen` 与 `partialThinkingLen` 严格同步递增 |
| `delta` 值得信赖吗？ | **不值得** —— 已弃用 | 判"不可信"的 259 条消息，delta 累加值 100% 等于原文长度，全是误杀 |
| `usage.reasoning` 可用吗？ | **对 workbuddy 不可用** | 事故记录 `reasoningReported: false`，input/output/cache 全 0 |
| 复读只出现在哪？ | 只有 `workbuddy/deepseek-v4.1-flash` | 6210 条样本中仅 5 条命中（14–88 次），其余模型 0 命中 |

因此**可靠的信号都在思考原文的尾部**，但有两个：**尾部周期**（探针 A）与
**尾部词表塌缩**（探针 B）。早期只实现了 A，于是对「无精确周期」的复读结构性失明
（2026-09-18 报障事故的第二类复读就是这种）。

## Phase 2（熔断）

`enforce` 默认**关**。开启后：

```
thinking_delta（每 750ms 节流检测一次）
  → 尾部窗口取自 provider 的 partial 全文（不拼接 delta）
  → 两个探针并联，命中任一即熔断：
      探针 A: detectTailPeriod，单元 8..600 字符，连续 ≥ 10 次
      探针 B: detectLineCollapse，1500 字符窗口内非空行 ≥ 40、不同行 ≤ 12、重复行占比 ≥ 0.75
  → 打标记 + ctx.abort()
message_end(stopReason="aborted" 且标记命中)
  → stripAllLoopTail 剥掉复读 → 替换消息（这是关键：中止后的思考块会完整留在上下文里）
  → 第 1 次命中：同模型续跑
  → 第 2 次命中：发 thinking-breaker:escalate 交给 model-failback 换链
```

实测效果（真实事故回放）：

| 事故 | 未熔断 | 熔断后（剥掉复读） |
|---|---|---|
| 2026-09-17（353,961 字符） | 289 秒 / 353,961 字符 | 42,500 字符处拦截；回灌 4,021 字符（剥掉 159,814） |
| 2026-09-18T13:05 报障（234,172 字符） | 164 秒 / 234,172 字符 | 20,000 字符处拦截；回灌 4,268 字符（剥掉 195,732） |

### 三条纪律

1. **只信尾部信号**。全篇词频会被模板化枚举污染（`第 1 项…第 2 项…`）——实测这种
   文本在词频方案下必然误报；尾部周期方案 0 误报，尾部词表塌缩方案同样 0 误报
   （6225 条有产出样本实测）。
2. **窗口只取 provider 的 `partial` 全文，不拼接 `delta`**。`delta` 是增量还是累计取决于 provider，猜错的代价极高。历史上用 `DeltaGuard` 在线猜：它取 `|拼接长度 − partial 长度|` 的绝对值，只要超过容差就永久否决该消息的熔断资格。实测 259 条被判"不可信"的消息，delta 累加值 **100% 精确等于**最终思考原文长度 —— 它们全是增量，`DeltaGuard` 一次都没判对。而 2026-09-18 那次 50 万字符事故就死在这道门上（`guardSkew: 99` 超过容差 64）。改为直接取 `partial.content[].thinking` 的尾部，歧义从根上消失。
3. **拿不到证据就不动手**。没有思考原文、已产出工具调用或文本 —— 一律只观测。

### 剥离为什么不能用"按周期整块比对"，也不能用"连续 N 行全新内容即停手"

真实复读是**变体轮换**：`OK. Let me write. Go. Now.` 与 `OK. Let me write. Go. Producing.`
周期相同（68）但逐字不同。按整块比对只能剥掉其中一层，剩下的一层会残留成
新的"复读"（实测剥完仍能命中，等于没剥）。

旧的**按行反向游走 + 连续 `maxGap` 行全新内容即停手**判据也已废弃：真实复读的行
种类有 9–16 种，反向游走时每遇到一行尚未见过的变体就累计 gap，第 `maxGap + 1` 种
变体就把自己截断。报障样本实测：

| maxGap | 剥离量 |
|---|---|
| 4（旧默认） | **0** |
| 8 | 200,000（把 4200 字符的真实前缀也剥光） |
| 10 | 200,000 |

即要么不剥、要么剥干净，没有可用档位。

新判据与探针 B **同源**：从末尾反向累积非空行，**不同行数一旦超过 `maxDistinct`
就停**，该区间即复读区，从它的起始行剥到末尾。因此「命中即能剥」。三道门保证不
吃掉正常内容：非空行 ≥ `minLines`、重复行占比 ≥ `minRepeatRatio`、剥掉字符数 ≥
`minChars`（实测 5965 条有产出样本中仅 2 条受影响，且都只切掉末尾 798–1218 字符）。

报障样本实测剥离：234,172 字符 → dropped 195,732 / 保留 4,268。剥完后尾部 2000
字符再测周期与塌缩，**全部无命中**（无残留复读）。

单行内复读（`OK. OK. OK. …`）行级判据看不到重复行，由字符周期剥离补上，两者交替执行。

## 配置

`~/.pi/agent/thinking-breaker.json`（不存在则用默认值）：

```json
{
  "enabled": true,
  "enforce": false,
  "enforceMinRepeats": 10,
  "enforceMinChars": 20000,
  "enforceMaxPeriod": 600,
  "enforceMinPeriod": 8,
  "enforceCollapseWindowChars": 1500,
  "enforceCollapseMinLines": 40,
  "enforceCollapseMaxDistinct": 12,
  "enforceCollapseMinRepeatRatio": 0.75,
  "enforceCheckIntervalMs": 750,
  "enforceKeepPrefixChars": 4000,
  "enforceEscalateAfter": 2,
  "dryRunAlert": true,
  "alertMinRepeats": 20,
  "retentionDays": 14,
  "maxFileBytes": 20971520,
  "captureThinkingText": true,
  "captureStreamDetail": true,
  "maxThinkingCharsPerMessage": 200000
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enforce` | `false` | 熔断总开关。拦截是侵入性行为，必须显式打开 |
| `enforceMinRepeats` | `10` | 探针 A 阈值。实测 6/8/10/12/15 在真实数据上命中数完全相同，10 留足余量 |
| `enforceMinChars` | `20000` | 短思考不值得动手（两个探针共用这道门禁） |
| `enforceMaxPeriod` | `600` | 探针 A 单元长度上限。旧值 200 对 405 字符的报障样本结构性失明 |
| `enforceMinPeriod` | `8` | 探针 A 单元长度下限。p=1..7 的“周期”极易由标点/缩进噪声偶然满足；逐字复读（p=4）交由探针 B |
| `enforceCollapseWindowChars` | `1500` | 探针 B 的尾部窗口字符数 |
| `enforceCollapseMinLines` | `40` | 探针 B：非空行数下限 |
| `enforceCollapseMaxDistinct` | `12` | 探针 B：不同行数上限。模板化枚举实测 distinct=54，安全 |
| `enforceCollapseMinRepeatRatio` | `0.75` | 探针 B：重复行（出现 ≥2 次）占非空行的最低比例 |
| `enforceCheckIntervalMs` | `750` | 检测节流。一次事故有 10 万个 delta，逐个检测是 O(n²) |
| `enforceKeepPrefixChars` | `4000` | 回灌下一轮的思考前缀上限 |
| `enforceEscalateAfter` | `2` | 第几次命中时升级换模型；`0` 关闭升级 |
| `alertMinRepeats` | `20` | 仅观测模式（`enforce: false`）的提示阈值（探针 A 口径） |

> 两个探针共享一个尾部缓冲区，缓冲区尺寸取二者的较大值
> （`max(enforceMaxPeriod * 10, enforceCollapseWindowChars)`）。若只按探针 A 定尺寸，
> 把 `enforceMaxPeriod` 调小（如 100 → 1000 字符）就会饿死需要 1500 字符的探针 B。
> 缓冲区变大**不会**放宽探针 A 的周期搜索范围：它仍传自己的 `maxPeriod`。

## 命令

```
/breaker                 状态（含本次会话熔断统计）
/breaker enforce on|off  本次会话开关熔断
/breaker on|off          本次会话开关观测
/breaker purge           删除所有日志文件
/breaker open            显示日志目录
```

## 日志

`~/.pi/agent/thinking-breaker/`（已在 `.gitignore` 忽略，含思考原文，仅本机留存）：

| 文件 | 内容 |
|---|---|
| `YYYY-MM-DD.jsonl` | 每条 assistant 消息一行指标摘要（含 `break` 熔断台账） |
| `YYYY-MM-DD.thinking.jsonl` | 思考原文（可单独删除） |
| `YYYY-MM-DD.stream.jsonl` | 前 40 个 thinking_delta 的流式明细（诊断 delta/partial 计数差异） |

14 天惰性清理，单文件 20MB 上限。**任何写失败、检测异常都绝不打断 agent。**

## 与 model-failback 的集成

复读是**模型侧的行为问题**：同一模型在同一会话里第二次复读，继续给它机会只是把
同样的浪费再演一遍。因此第 2 次命中会发 `thinking-breaker:escalate`，由
model-failback 负责 ban 该模型（`reason: "thinking_loop"`，30 分钟冷却）+ 换链 +
发续跑指令。

用事件而不是直接调用，是为了不复制 ban 持久化/链解析/环检测/连跳上限那套逻辑。
**model-failback 未安装时**事件没有订阅者，自动降级为"剥复读 + 同模型续跑"，
功能不缺失。

两个扩展互不 import（各自独立加载），事件契约由两侧的回归测试固定。

## 测试

```bash
volta run node tests/replay.ts    # 纯函数回放：零误报 + 真实事故 + 单元用例
volta run node tests/enforce.ts   # 熔断接线：abort / 替换消息 / 续跑 / 升级 / Esc
```

`tests/replay.ts` 会读取 `~/.pi/agent/thinking-breaker/*.thinking.jsonl` 作为真实
样本。日志被 purge 后会跳过误报回归（并明确提示），单元用例仍然运行。

model-failback 侧的升级契约测试：

```bash
cd ../model-failback && volta run node tests/run-regression.mjs thinking
```
