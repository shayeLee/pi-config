# Usage Stats

Pi usage 统计扩展，按 `provider/model` 汇总 Token 与费用。

## 命令

```text
/usage             打开统计面板，默认显示本周
/usage day         今日
/usage yesterday   昨日（别名：yday）
/usage week        本周
/usage month       本月
/usage all         全部时间
```

面板列顺序：

```text
provider/model | tokens(M) | cost | hit% | input(M) | output(M) | cacheR(M) | cacheW(M)
```

若当前已配置 `openai-codex`（ChatGPT OAuth）登录，面板顶部会额外显示对应的订阅额度；`opencode-go` 额度默认隐藏，可通过配置开启；DeepSeek API 余额也可通过配置开启。未配置或请求失败时不显示。

`hit%` 是当前选定时间范围的累计缓存命中率：

```text
cacheRead / (input + cacheRead + cacheWrite) × 100%
```

列表按当前选定时间范围的 `tokens(M)` 降序排列，tokens 相同时按 cost 降序排列。

操作：

- `1`-`5`：切换时间范围
- `↑` / `↓`：滚动
- `PgUp` / `PgDn`：翻页
- `Esc`：关闭

## 配置

配置文件：`~/.pi/agent/usage-stats.json`。额度和余额默认隐藏；如需显示，可写入：

```json
{
  "showOpenCodeGoQuota": false,
  "showDeepSeekBalance": true
}
```

配置在每次打开 `/usage` 时读取。关闭对应开关时不会请求相应接口，也不影响对应 provider 的 Token/费用统计。

昨日按本地时区计算，统计区间为 `[昨日 00:00, 今日 00:00)`。

Token 数值使用 `M` 单位；小于 `0.01M` 的非零数值显示为 `<0.01M`。

面板的 `Current session` 行显示当前 session JSONL 的累计用量；由 `agent-team` 启动的 subagent 会额外计入该行，并标出 subagent 账本记录数。该 session 小计不受上方时间范围 tab 影响，始终是该 session 的完整累计。

Session footer 中：

- `CH`：最后一次 assistant 请求的缓存命中率
- `ΣCH`：当前 session 分支的累计缓存命中率，计算所有 assistant、compaction 和 branch summary 的输入 Token

## OpenAI Codex 订阅额度

使用 Pi 已解析的 `openai-codex` OAuth 凭据，请求 Codex CLI 同款的 ChatGPT 非公开 usage 端点：

```text
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <access token>
ChatGPT-Account-Id: <account id>   # 从 access token 的 JWT claim 中仅内存解析，不落盘、不显示
```

响应为 `rate_limit.primary_window`（5 小时窗口）与 `rate_limit.secondary_window`（周窗口），面板显示每个窗口的剩余百分比（100 - 已用百分比）与重置时间，例如：

```text
Codex quota (plus): 5h 58% left · resets 14:32  │  weekly 93% left · resets 09-08 00:00
```

字段解析做兼容性处理，任一字段缺失、类型不符或为 null 都不会报错：

- 百分比：`used_percent`（0-100）；缺失时退回 `used / max × 100`，超界钳制到 0-100
- 重置时间：`reset_at`（Unix 秒）→ `resets_at`（ISO 字符串）→ `reset_after_seconds` / `resets_in_secs`（相对秒）
- 窗口时长：`limit_window_seconds` / `window_minutes`；300 分钟显示为 `5h`，10080 分钟显示为 `weekly`，其余按小时/分钟格式化
- 兼容旧版 `/backend-api/usage` 的 `limits["5h"]` / `limits["1week"]` 数组结构

安全与降级：

- 绝不输出或持久化 access token、响应原文；面板仅显示窗口标签、百分比、重置时间与 plan type
- 未登录、网络失败、超时（8s）、非 2xx 或解析失败时静默跳过该行，不影响现有统计与面板
- 请求与扫描并行，不拖慢 `/usage` 打开速度；结果在内存中缓存 90 秒

## DeepSeek API 账户余额

该功能默认关闭，由 `~/.pi/agent/usage-stats.json` 中的 `showDeepSeekBalance` 控制。开启后，使用 Pi 已解析的 `deepseek` API key 请求官方余额接口：

```text
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
```

响应中的 `balance_infos` 按币种显示总余额、赠送余额和充值余额，例如：

```text
DeepSeek balance: CNY ¥110.00 (granted ¥10.00 · topped-up ¥100.00) · available
```

接口失败、超时（8s）、非 2xx 或字段无效时，该行会静默隐藏，不影响现有 `/usage`。API key 和原始响应均不会显示或写入磁盘，结果只在内存缓存 90 秒。详情参见 [DeepSeek Get User Balance](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)。

## OpenCode Go 订阅额度

该功能默认关闭，由 `~/.pi/agent/usage-stats.json` 中的 `showOpenCodeGoQuota` 控制。开启后，使用 Pi 已解析的 `opencode-go` API key 请求官方 Go 额度端点：

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_API_KEY>
```

响应中的 `usage.rolling`、`usage.weekly` 与 `usage.monthly` 分别对应 5 小时、周和月窗口。面板显示**剩余百分比**与按本地时区格式化的 `resetsAt`，例如：

```text
OpenCode Go quota: 5h 38% left · resets 14:32  │  weekly 71% left · resets 09-08 00:00  │  monthly 84% left · resets 10-01 00:00
```

`percent` 表示已用比例，扩展会计算 `100 - percent`；`percent` 可为数字或数字字符串。未登录、无 Go 订阅、网络失败、8 秒超时、非 2xx 或字段无效时，该行会静默隐藏，不会影响现有 `/usage`。API key 和原始响应均不会显示或写入磁盘，结果只在内存缓存 90 秒。

## 数据来源

### 普通 session

扫描：

```text
~/.pi/agent/sessions/**/*.jsonl
```

### `--no-session`

`--no-session` 不会保存 session JSONL，因此扩展会将 usage 事件写入每日账本：

```text
~/.pi/agent/subagent-usage/YYYY-MM-DD.jsonl
```

目录和文件会在首次产生 usage 时自动创建，日期按本地时区计算。

账本只保存统计信息，不保存提示词或模型响应内容。扩展未加载、使用 `--no-extensions`，或扩展启用前已经结束的 `--no-session` 运行无法统计。账本目录权限为 `0700`，每日账本和缓存文件权限为 `0600`。

`agent-team` 会将调用方的根 session ID 传给其 `--no-session` 子进程；因此 `/usage` 能把这些 subagent 用量归入调用它的当前 session。升级前已写入的账本记录没有该 ID，仍会进入全局统计，但不会追溯归属到某个 session。

## JSONL 记录格式

每行一个对象，例如：

```json
{
  "version": 1,
  "timestamp": "2026-09-03T07:01:00.007Z",
  "provider": "opencode-go",
  "model": "mimo-v2.5",
  "kind": "assistant",
  "rootSessionId": "019...",
  "usage": {
    "input": 1305,
    "output": 18,
    "cacheRead": 2048,
    "cacheWrite": 0,
    "totalTokens": 3371,
    "cost": {
      "input": 0.0001827,
      "output": 0.00000504,
      "cacheRead": 0.0000057344,
      "cacheWrite": 0,
      "total": 0.0001934744
    }
  }
}
```

`kind` 可能为：

- `assistant`：模型响应
- `tool`：工具 usage
- `compaction`：上下文压缩
- `branch_summary`：分支摘要

`rootSessionId` 可选，仅由 `agent-team` 的子进程写入，用于将该条 `--no-session` 用量归属到发起它的 session。

统计 Token 数为：

```text
input + output + cacheRead + cacheWrite
```

reasoning 已包含在 `output` 中，不会重复计算。

## 性能

首次打开 `/usage` 会完整解析所有文件；后续打开会按文件 `mtime + ctime + size` 复用解析结果，只有新增或发生变化的文件才会重新读取。文件解析缓存会持久化到：

```text
~/.pi/agent/usage-cache.json
```

因此重启 Pi 后也可以复用未变化文件的解析结果。缓存仅保存统计数据，不保存提示词或响应内容；`/reload` 会重新加载缓存并校验文件指纹。缓存格式升级时会自动重建。

## 注意事项

- 不设置 TTL；session 和每日 usage 账本会一直保留，除非手动删除。
- “全部时间”指当前仍保留的 session JSONL 与每日 usage 账本。
- 分支、fork 或 clone 产生的记录按文件中的实际记录统计，可能包含重复上下文的 usage。
- tool、compaction、branch summary 如果没有直接的 provider/model，会归属到当时的当前模型；无法归属时显示为 `unknown/unknown`。
