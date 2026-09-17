# thinking-breaker

思考**复读**（reasoning loop）的探针与熔断。

某些模型（实测只有 `workbuddy/deepseek-v4.1-flash`）会在思考里陷入尾部周期复读：

```
OK. Let me write. Go. Now.
OK. Let me write. Go. Producing.
OK. Let me write. Go. Now.
...（重复几万次）
```

真实事故（2026-09-17）：

| 指标 | 值 |
|---|---|
| 思考字符数 | 353,961（≈ 8.8 万 token） |
| thinking_delta 次数 | 107,387 |
| 耗时 | **289 秒** |
| 产出 | `textDelta = 0`、`toolcallStart = 0` —— **一个字都没产出** |
| 收尾 | 用户按 Esc（`stopReason: "aborted"`） |

即：**近 5 分钟的算力与上下文预算，产出为零。**

## Phase 1（观测）的实测结论

用 2601 条真实思考原文回答"能不能熔断、靠什么熔断"：

| 问题 | 结论 | 依据 |
|---|---|---|
| 哪些模型吐思考原文？ | 12 个模型里 11 个吐，捕获率 78%–100% | `deltaMode` 与 `deltaCapture` 汇总 |
| `delta` 是增量还是累计？ | 全部 `incremental` | 流式明细里 `deltaLen` 与 `partialThinkingLen` 严格同步递增 |
| `usage.reasoning` 可用吗？ | **对 workbuddy 不可用** | 事故记录 `reasoningReported: false`，input/output/cache 全 0 |
| 复读只出现在哪？ | 只有 `workbuddy/deepseek-v4.1-flash` | 2679 条样本中仅 2 条命中（16 次、29 次），其余模型 0 命中 |

因此**唯一可靠的信号是思考原文的尾部周期**。

## Phase 2（熔断）

`enforce` 默认**关**。开启后：

```
thinking_delta（每 750ms 节流检测一次）
  → 尾部窗口 detectTailPeriod ≥ 10 次连续重复
  → 在线 DeltaGuard 校验 delta 为增量（否则本条永不熔断）
  → 打标记 + ctx.abort()
message_end(stopReason="aborted" 且标记命中)
  → stripAllLoopTail 剥掉复读 → 替换消息（这是关键：中止后的思考块会完整留在上下文里）
  → 第 1 次命中：同模型续跑
  → 第 2 次命中：发 thinking-breaker:escalate 交给 model-failback 换链
```

实测效果（真实事故回放）：

| | 未熔断 | 熔断后 |
|---|---|---|
| 拦截点 | 289 秒 / 353,961 字符 | **42,500 字符处** |
| 回灌下一轮的思考 | 353,961 字符（≈ 8.8 万 token） | 4,021 字符（≈ 1 千 token） |
| 节省 | — | 311,461 字符（≈ 7.8 万 token） |

### 三条纪律

1. **只信尾部周期**。全篇词频会被模板化枚举污染（`第 1 项…第 2 项…`）——实测这种文本在词频方案下必然误报，在尾部周期方案下 0 误报。
2. **delta 必须是增量**。累计模式下把 delta 拼起来会凭空造出复读。`DeltaGuard` 在线校验拼接长度与 partial 长度是否同步，偏差超容差就永久放弃该消息。
3. **拿不到证据就不动手**。没有思考原文、delta 校验不过、已产出工具调用或文本 —— 一律只观测。

### 剥复读为什么不能用"按周期整块比对"

真实复读是**变体轮换**：`OK. Let me write. Go. Now.` 与 `OK. Let me write. Go. Producing.`
周期相同（68）但逐字不同。按整块比对只能剥掉一层，剩下的一层会残留成新的复读
（实测剥完仍能命中，等于没剥）。

改为**按行反向游走**：复读的行必然重复出现，从末尾往前，只要还在"重复行密集区"
就继续，遇到连续 4 行全新内容就停手。判据对变体免疫，对正常推理也免疫 ——
在 2673 条真实思考原文上实测**零误伤**。

单行内复读（`OK. OK. OK. …`）行级判据看不到重复行，由字符周期剥离补上，两者交替执行。

## 配置

`~/.pi/agent/thinking-breaker.json`（不存在则用默认值）：

```json
{
  "enabled": true,
  "enforce": false,
  "enforceMinRepeats": 10,
  "enforceMinChars": 20000,
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
| `enforceMinRepeats` | `10` | 熔断阈值。实测 6/8/10/12/15 在真实数据上命中数完全相同（都是那 2 条），10 留足余量 |
| `enforceMinChars` | `20000` | 短思考不值得动手 |
| `enforceCheckIntervalMs` | `750` | 检测节流。一次事故有 10 万个 delta，逐个检测是 O(n²) |
| `enforceKeepPrefixChars` | `4000` | 回灌下一轮的思考前缀上限 |
| `enforceEscalateAfter` | `2` | 第几次命中时升级换模型；`0` 关闭升级 |
| `alertMinRepeats` | `20` | 仅观测模式（`enforce: false`）的提示阈值 |

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
| `YYYY-MM-DD.stream.jsonl` | 前 40 个 thinking_delta 的流式明细（用于判定增量/累计） |

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
