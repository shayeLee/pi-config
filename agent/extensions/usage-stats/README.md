# Usage Stats

Pi usage 统计扩展，按 `provider/model` 汇总 Token 与费用。

## 命令

```text
/usage             打开统计面板，默认显示本周
/usage day         今日
/usage week        本周
/usage month       本月
/usage all         全部时间
```

面板列顺序：

```text
provider/model | tokens(M) | cost | hit% | input(M) | output(M) | cacheR(M) | cacheW(M)
```

`hit%` 是当前选定时间范围的累计缓存命中率：

```text
cacheRead / (input + cacheRead + cacheWrite) × 100%
```

列表按当前选定时间范围的 `tokens(M)` 降序排列，tokens 相同时按 cost 降序排列。

操作：

- `1`-`4`：切换时间范围
- `↑` / `↓`：滚动
- `PgUp` / `PgDn`：翻页
- `Esc`：关闭

Token 数值使用 `M` 单位；小于 `0.01M` 的非零数值显示为 `<0.01M`。

Session footer 中：

- `CH`：最后一次 assistant 请求的缓存命中率
- `ΣCH`：当前 session 分支的累计缓存命中率，计算所有 assistant、compaction 和 branch summary 的输入 Token

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

## JSONL 记录格式

每行一个对象，例如：

```json
{
  "version": 1,
  "timestamp": "2026-09-03T07:01:00.007Z",
  "provider": "opencode-go",
  "model": "mimo-v2.5",
  "kind": "assistant",
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

因此重启 Pi 后也可以复用未变化文件的解析结果。缓存仅保存统计数据，不保存提示词或响应内容；`/reload` 会重新加载缓存并校验文件指纹。

## 注意事项

- 不设置 TTL；session 和每日 usage 账本会一直保留，除非手动删除。
- “全部时间”指当前仍保留的 session JSONL 与每日 usage 账本。
- 分支、fork 或 clone 产生的记录按文件中的实际记录统计，可能包含重复上下文的 usage。
- tool、compaction、branch summary 如果没有直接的 provider/model，会归属到当时的当前模型；无法归属时显示为 `unknown/unknown`。
