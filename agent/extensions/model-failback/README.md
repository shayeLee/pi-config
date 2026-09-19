# model-failback

订阅/账户**终态错误**(如 ChatGPT 订阅额度用尽)时的**会话内模型 failback**:
自动切换到备用模型并让 agent 从失败点继续,**会话上下文不中断、不重启、不重跑任务**。

与重跑式 failback 的区别:

| | 重跑式(agent-team 父进程) | model-failback(本扩展) |
|---|---|---|
| 层次 | 进程级:失败后重新 spawn | 请求级:会话内 `setModel` + steering |
| 上下文 | 全部丢失,从头再来 | 原样保留,失败点继续 |
| 时窗 | 仅"起步即挂" | 任意时刻(包括任务中途) |
| 适用范围 | agent-team subagent | 主会话 + subagent 子进程都生效 |

## 为什么按 provider 判定

ChatGPT 订阅 backend 与其他 provider 的终态错误形状完全不同(错误码、文案、作用域),因此判定做成了**按 provider 分派**的插拔层。当前已实现并注册 `openai-codex`、`opencode`、`opencode-go`、`modelscope`、`command-code` 与 `workbuddy`;接入新 provider 只需新增一个文件并注册一行,见下文"扩展新 provider"。

## 工作原理(openai-codex)

`openai-codex` 走 ChatGPT 订阅 backend(`chatgpt.com/backend-api`)。额度类错误是**账户级终态**:重试与同 provider 换模型都无效,只能跨 provider 切换。

扩展监听 `message_end`,当 assistant 消息以 `stopReason === "error"` 结束且命中终态判定时展开 failback:

```text
message_end(assistant, error)
  → 按 message.provider 分派判定 handler
  → 终态?逐层锚定:
      1. pi 归一文案:"You have hit your ChatGPT usage limit …"
      2. 错误码:     usage_limit_reached / usage_not_included
      3. 订阅历史词: GoUsageLimitError / FreeUsageLimitError / Monthly usage limit reached
      4. 流式原文:   "Codex error: The usage limit has been reached"
  → 跳过已 ban 的链节点 → 环检测 + 连跳上限(前进放行、成环拦截)
  → 解析 fallback 目标(精确键 → provider 通配 → 全局通配)
  → cross-provider 守卫:跳过同 provider 目标
  → setModel(备用模型)→ 写入台账 → 通知 → steering 让 agent 继续当前任务
```

`resetsAt` 优先从 pi 文案 `Try again in ~N min.` 推算。若文案未给出倒计时，`openai-codex` 会复用 `usage-stats` 的 ChatGPT/Codex 额度获取器（已解析 OAuth 鉴权、`GET /backend-api/wham/usage`、90 秒内存缓存、8 秒超时），仅在**已耗尽**的窗口中取最晚重置时刻；因此 5h 与 weekly 同时耗尽时不会过早恢复。`opencode-go` 的 `GoUsageLimitError` 同样会在缺失倒计时时查询官方 `/zen/go/v1/usage`；503 端点故障不会误填配额恢复时间。查询失败仍会照常 failback，只保留“未知”。`autoRestore` 打开后，额度到点的下一次任务开始前自动切回原模型。

## 工作原理(opencode)

`opencode` 仅覆盖账户余额耗尽终态；`opencode-go` 还覆盖 Go 订阅额度耗尽的 `429` + `GoUsageLimitError`，以及 Console Go 返回的 `503` + `Endpoint is unavailable` 端点故障。assistant 消息必须是 `stopReason === "error"`，且 `errorMessage` 命中对应错误形态。三类判定分别为 `credits_exhausted`、`usage_limit` 或 `endpoint_unavailable`，均为 `scope: "cross-provider"`，因此只会跨 provider 切换。Go 错误中的 `Resets in 22hr 52min` 会解析为恢复时间并写入 ban。

`ModelError` 属于模型/端点错误，不会触发；无 API key 属于初始化阶段错误，发生在扩展能收到 `message_end` 之前，扩展没有机会覆盖，同样不会触发。

## 工作原理(modelscope)

`modelscope` 推理 API 底层为阿里云百炼(Model Studio)的 OpenAI-compatible completions 端点。仅覆盖账户/计划额度耗尽终态:命中 `insufficient_quota`、`You exceeded your current quota`、`Free allocated quota exceeded`、`insufficient balance`,或 `out of budget` 时,判定为 `reason: "quota_exhausted"`、`scope: "cross-provider"`。

瞬时频率/并发限流(`Throttling.RateQuota`、`BurstRate`、`Concurrency`)与鉴权错误(`InvalidApiKey`)**不会**触发——前者交给 pi 的退避重试,后者属配置问题换 provider 也无效。

## 工作原理(command-code)

`command-code` 是聚合网关(Provider API,OpenAI-compatible 的 completions 端点)。额度由三部分组成:账户 credits(充值/月度额度)、订阅的 5h/weekly 滚动窗口,以及组织级月度 spend cap。

四类终态,按从具体到宽泛的顺序判定:

| reason | 触发信号 | scope | 恢复时间 |
|---|---|---|---|
| `model_not_in_plan` | `MODEL_NOT_IN_PLAN`、`is not included in your current plan` | `any` | 无 |
| `quota_exhausted` | `insufficient credits`、`PREMIUM_CREDITS_EXHAUSTED` | `cross-provider` | 无(充值后手动 `/failback unban`) |
| `usage_limit` | 具名窗口文案(`You've reached your 5-hour/weekly/daily … limit`、`5-hour limit reached`);或 429/`RATE_LIMITED` + `"window":"fiveHour\|weekly\|daily"`;或泛化文案(`usage limit for your plan`、`usage limit has been reached`)配门禁/倒计时 | `cross-provider` | 文案倒计时就地解析;缺失时复用 `usage-stats` 的 `/alpha/billing/credits` 补查已耗尽窗口 |
| `spend_limit` | 错误正文顶层 `code: "USAGE_EXCEEDED"`、组织 spend cap 文案 | `cross-provider` | 只取文案里的倒计时,**不**查窗口 |

`model_not_in_plan` 只影响单个模型,因此 `scope: "any"` —— 换同 provider 的其他模型仍然有效(例如 `claude-opus-5` 不在计划内时,`deepseek/deepseek-v4.1-flash` 仍可接续),不会像账户级终态那样强制跨 provider。

`usage_limit` 与 `spend_limit` 分开是有意的:只有**滚动窗口**的耗尽才对应 credits 接口里的窗口重置时刻;把消费限额也套上窗口时间会给出误导性的乐观恢复承诺,并影响 `autoRestore` 时机。

**一律不触发**(交给 pi 退避重试或用户处理):无窗口证据的瞬时限流(`429 rate_limit_error`)、5xx 上游故障(`server_error` / `api_error` / `Endpoint is unavailable`)、`401` 鉴权、`403 upgrade_required`(Go 计划无 API)、`unsupported_model`、`cmd_zdr_no_providers`(ZDR)。这些错误即使带上 `rateLimit` / `window` 元数据也不会触发。

两道解析纪律防止误判:

- **窗口证据必须有限流门禁**。复刻官方 CLI 的语义:只有在 `status === 429`、`code === "RATE_LIMITED"` 或 `type === "rate_limit_error"` 时,错误正文里的 `window` 字段才算额度终态。否则上游透传的 5xx/401/403 响应只要带上 `rateLimit` 元数据就会被误判为额度耗尽。唯一的例外是**具名窗口文案**(`You've reached your 5-hour usage limit` 这类),它本身已经足够明确。
- **只解析错误正文,且终态 code 优先**。`inspect()` 先取第一个**括号配平**的 JSON 对象,所有字段(`code` / `type` / `rateLimit`)都从该对象读取,绝不做跨文档的正则子串匹配 —— pi 的 `formatProviderError` 会把 `error.error.metadata.raw` 追加在换行之后,元数据里的同名 token 不得把非终态错误升级为整 provider 级 ban。同时,终态 code 优先于同层/嵌套的非终态 `type`,且与字段顺序无关,避免真终态被漏判。

## 工作原理(workbuddy)

`workbuddy`(WorkBuddy AI 国际版)与腾讯官方 CodeBuddy CLI 共用同一后端,因此判定依据是官方 CLI 里的**业务错误码枚举**与归类表。

这个 provider 有个前提:WorkBuddy 原生错误是 `{code, msg}`,而 pi 的 openai-completions 路径只保留 OpenAI 形状 `{error:{message,...}}`,不改写时 `errorMessage` 会退化成 `"400 status code (no body)"`——业务码与文案全部丢失,TUI 和本扩展都看不见原因。`pi-workbuddy-connect` 扩展在 fetch 层把 `{code,msg}` 补成 `{error:{message,type,code}}`(`code` 保留为字符串,因为 pi 只透传 `error.error.code`),本 handler 才能读到 `"400: {\"message\":\"…\",\"code\":\"14001\"}"`。

`quota_exhausted` / `cross-provider`,覆盖账户/计划额度耗尽(官方归类 `quota_balance_exhausted`):

| code | 含义 |
|---|---|
| `14001` | UsageLimitExceeded |
| `14002` | ConversationChatTooMany(同一额度的并发表现) |
| `14012` / `14013` / `14014` | 企业/腾讯侧额度耗尽 |
| `14018` | 用户额度耗尽 |

> `14019`(`UsageLimitNoTokenBudget`)只在早期文档/版本里出现:当前官方制品里该码与 `UsageLimitNoTokenBudget` 的检索计数均为 `0`,`UsageLimit*` 枚举只有 `14001/14012/14013/14014/14015/14016/14017/14018`。handler 保留它仅作 legacy 兼容,不影响现行判定。

无业务码时按官方兜底把 `429` 视为额度耗尽,但要求文案里出现额度语义(`usage limit` / `quota` / `balance` / `insufficient credits`)。

**限流 / 配额窗口(直接切链)**:`14003`、`6003`/`6004`、`6005`-`6008`、以及无 code 的裸 `429`。这些错误 pi 会退避重试(默认 3 次,1s/2s/4s,共约 7 秒),但 WorkBuddy 单请求就要数分钟,7 秒总退避远小于限流窗口 —— 重试耗尽后 pi 只会把错误交还用户、任务中断。因此**按配置直接切备用链**,不再等重试耗尽:判为 `rate_limited` + `scope: any`(逐跳按你配的链走 —— 限流窗口按模型计算,同 provider 的另一档位/其它部署有独立配额),并带 `resetsAt`,到期自动解 ban、模型重新可用。把 `workbuddyRateLimitCooldownMs` 配成 `<=0` 即关闭此逃逸,回到"全部交给 pi 退避重试"的旧行为。

`6003`(CraftRateTPHLimit)/`6004`(CraftRateTPDLimit)虽然与 `6005`-`6008` 同属官方 `CraftRate*` 限流族(归类 `quota_token_limit`),但它们是**按模型的免费档 token 窗口**,不是账户级余额:

- 官方 `isCraftDailyQuotaBusinessCode` 集合为 `{6004, 6008}`,且这两个码在 `isRequestLevelRetryableError` 里被**显式排除在重试之外** —— 官方自己也认为日粒度窗口不应交给退避重试,而应换模型继续;`6000`-`6002`(秒/分钟级)不在该集合里,仍交给 pi 退避重试。注意官方 `isTransientRateLimitBusinessCode` 覆盖的是 `6000`-`6003` / `6005`-`6007` 加 `14003`,**不含** `6004`/`6008`(日配额被单独摘出来);
- 官方产品配置 `productFeaturesConfig.ModelRateLimitCap` 给出 freeId/paidId 双档(实测 WorkBuddy 国际版为 `freeId=deepseek-v4.1-flash` 记 `x0.00` credits、`paidId=deepseek-v4.1-flash-sg` 记 `x0.03` credits,且 `allowPaidSwitch=true`);
- 真实错误文案自己就给出了官方逃生路径,形如:

  ```
  429: {"message":"usage exceeds frequency limit, but don't worry, your usage will reset at
  2026-09-19 09:43:30 UTC+8, alternatively, you can switch to the other models to continue
  using it.","type":"invalid_request_error","code":"6004"}
  ```

因此这两码按**限流窗口**处理:`scope: "any"`,用户链上的付费档(`workbuddy/deepseek-v4.1-flash-sg`)与其它 provider 都会被逐跳尝试,而不是像 `14001` 那样判成账户级终态把整个 provider 跳过;`resetsAt` 优先取文案里的官方重置时刻,这样 `/failback status` 与 `autoRestore` 都能拿到真实恢复时间。note 文案也明确写"仅该模型受限",不会误导用户去充值/升级账户。

`6008`(CraftRateRPDLimit)与 `6004` 同为官方日配额,因此与它们共享同一条恢复时间路径:固定 60 秒冷却对日窗口明显偏短,解析到官方重置时刻时优先采用。

**恢复时刻的解析纪律**(任何一条不满足即退回冷却期兜底,绝不给出猜测时刻):

- **必须带显式 UTC/GMT 偏移**(`UTC+8` / `UTC+08:00` / `GMT+0800`)。缺偏移时无法确定 epoch,猜本地时区会让 `autoRestore` 在错误时刻切回;`CST`/`IST` 这类有歧义缩写一律不接受;
- **各字段必须真实存在**:月/日/时/分/秒做范围校验并 round-trip 比对,避免 `2026-02-31`、`25:70`、`UTC+99` 被 `Date.UTC` 悄悄规范化成另一个时刻;
- **必须是未来时刻**,且**日窗口不得超过 3 天**(超出说明解析出了错误时间,宁可退回冷却期也不给出假承诺);
- **必须只有一个、无冲突的时刻**:同时出现多个不同时刻时拒绝解析;
- 冷却期只是**估计**,不是真实窗口恢复时刻。`autoRestore` 会在该时刻提前切回源模型;若窗口其实仍开着,只是一次额外试探,不会造成停机。

> 与 pi auto_retry 不会双重续跑:failback 排入的 steer 消息会被 auto_retry 的 `agent.continue()` 在 `runLoop` 开头 drain 掉,且此时模型已是切换后的目标模型 —— 恰好一次续跑。

**不触发**:`14015`/`11140`/`11142`(鉴权)、`14016`/`14017`(未开通)、`11141`(模型行为错误)、`11115`(上下文超长,应触发压缩)、`10105`(会话数超限)、`15001`(联网搜索额度)。**未知 code 一律不猜测**,避免误 ban 整个 provider。

### 上游网关故障的有界逃逸

WorkBuddy 的推理端点(apisix/openresty 网关)会以**纯 HTML 页面**返回 500/502/503/504/524,`errorMessage` 里既没有业务码也没有 JSON 体。pi 把它归为可重试错误(`RETRYABLE_PROVIDER_ERROR_PATTERN` 命中这些状态码),但 WorkBuddy 的 Flash 单请求就要数分钟,退避重试只会在数十秒内再次撞上同一个网关页,最终把整轮任务交还给用户。

因此加了**有界逃逸**:同一模型在 `TRANSIENT_OUTAGE_WINDOW_MS`(2 分钟)内连续 `workbuddyTransientOutageStreak` 次(默认 3)命中网关故障时,判为 `endpoint_unavailable` + `scope: cross-provider`,并带 `TRANSIENT_OUTAGE_COOLDOWN_MS`(5 分钟)的 `resetsAt` —— 换到链上其它 provider 继续任务,冷却期过后 ban 自动过期、模型重新可用。

计数不区分具体状态码:真实会话里 500/502/504/`Provider finish_reason: error` 是**交替**出现的(同一个上游不稳定),因此它们共享同一个连续计数。

解析纪律:

- **必须没有结构化错误体**。只要 `errorMessage` 里有括号配平的 JSON,就一律走业务码判定 —— 上游透传的 JSON 哪怕带 500/502 字段也不能当成网关页。
- **网关页特征而不是单纯状态码**。`500 Internal Server Error` 这种没有 HTML 体的裸状态行不触发;必须同时命中 HTML 标记或 `Bad Gateway` / `Gateway Time-out` / `openresty` / `apisix` 这类只有网关才会用的短语。
- **计数按 `provider/model` 隔离**,并且每个新任务开始时清零(`agent_start` 非 steering 分支),长任务里跨小时的偶发 5xx 不会累加。
- **阈值 <=0 完全关闭**该逃逸,回到"全部交给 pi 重试"的旧行为。
- 逃逸成功后计数复位,后续单次故障又回到瞬时错误语义。

### WAF 拦截页(403)的即时逃逸

腾讯云 WAF 会直接返回 403 的 **HTML 拦截页**,真实样本形状:

```
403 <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>WAF Block Page</title>
<link rel="stylesheet" href="https://domain-config-1256704386.cos.accelerate.myqcloud.com/block-pages/403/main_en.css" />
</head><script> function submitWafFeedback() { … window.location.href = "https://api.waf-intl.qq.com/waf-attack-feedback/" + uuid; } </script>
<body>…<p class="desc">The web application firewall has detected a security risk or non-compliance in your visit</p>…
```

这条路径上面的两套机制都接不住:

- `readStatus` 只认 `"403:"` 冒号形式,而真实文本是 `403 <!DOCTYPE`(openai SDK 的 `APIError.makeMessage` 形如 `${status} ${msg}`),所以状态码读不出来;
- `classifyTransientOutage` 的 `GATEWAY_STATUS_PATTERN` 只含 500/502/503/504/524,403 不命中;而且 HTML 里内联 `<script>` 的 `{` 会让 `extractFirstJsonObject` 解析失败。

**为什么不能复用 5xx 的 streak 语义**:pi 的 `RETRYABLE_PROVIDER_ERROR_PATTERN` 不含 403,403 不会被 pi 退避重试 —— 一次 403 就直接终止该 run,不可能产生第二次 `message_end`。「连续 N 次才逃逸」对 WAF 永远等不到第 N 次,所以必须**默认首次即逃逸**(`DEFAULT_WAF_BLOCK_STREAK = 1`)。

- 判定为 `waf_blocked` + `scope: cross-provider` —— WAF 是 IP/请求特征级封禁,换同 provider 的其他模型无效,必须换 provider;
- 冷却期用固定的 `WAF_BLOCK_COOLDOWN_MS`(10 分钟),不做成配置项,`resetsAt` 到期自动解 ban;
- WAF 计数与 5xx 网关故障**各用一套计数器**,互不干扰。

**不触发**(三条纪律):

- **带 JSON 体的 403** 优先走业务码判定(`extractFirstJsonObject` 非空即直接返回 false),不得当成 WAF 页;
- **普通 403 HTML 页**(如 nginx 的 `401/403` 页)没有 WAF 特征串,不触发;
- **裸 `403 status code (no body)`**(未经 `pi-workbuddy-connect` 补全时的退化文案)不触发。

判定只看 WorkBuddy 侧 WAF 的**专有特征串**(`<title>WAF Block Page</title>` / `waf-intl.qq.com` / `web application firewall` / `block-pages/403`),不是「所有 403」的通用规则,也刻意不经过 `readStatus` 做状态码门禁。

## 配置

`~/.pi/agent/model-failback.json`:链式表达 `A → B → C`,首节点可为 `provider/*` 通配:

```json
{
  "chains": [
    ["opencode/*", "opencode-go/deepseek-v4-flash", "rightcode-codex/gpt-5.6-luna"],
    ["openai-codex/gpt-5.6-luna", "opencode-go/deepseek-v4-flash", "rightcode-codex/gpt-5.6-luna"],
    ["openai-codex/gpt-5.6-sol", "rightcode-codex/gpt-5.6-sol"]
  ],
  "maxConsecutive": 3,
  "banFileTtlMs": 604800000,
  "cooldownMs": 60000,
  "autoRestore": false
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `chains` | 无 | 链式映射:每项是字符串数组 `["A","B","C"]`,A 终态切 B,B 终态切 C;首节点支持 `provider/*` 通配 |
| `fallbacks` | `{}` | 旧平面映射 `"provider/model" → "provider/model"`,向后兼容;配置了 `chains` 时优先按链解析 |
| `cooldownMs` | `60000` | 向后兼容保留;不再参与切换拦截(由环检测 + `maxConsecutive` 接管) |
| `maxConsecutive` | `3` | 单次 failback 链允许的最大连续切换次数 |
| `banFileTtlMs` | `604800000` | 孤儿 session ban 文件的惰性清理 TTL(7 天);设为 `0` 或负数关闭 |
| `autoRestore` | `false` | 配额恢复后自动切回原模型(每次 agent 启动时检查,不打断进行中的任务) |
| `workbuddyTransientOutageStreak` | `3` | workbuddy:2 分钟内同一模型连续几次上游 5xx 网关页后允许一次跨 provider 逃逸;`<=0` 关闭 |
| `workbuddyRateLimitCooldownMs` | `60000` | workbuddy:命中限流/配额窗口(`14003`/`6003`/`6004`/`6005`-`6008`/裸 `429`)时直接切备用链,并对源模型设冷却 ban;`6003`/`6004`/`6008` 优先用错误文案里的官方重置时刻,解析不到才用该值;`<=0` 关闭(交给 pi 退避重试) |
| `workbuddyWafStreak` | `1` | workbuddy:连续几次 WAF 拦截页后跨 provider 逃逸;默认 `1`(首次即逃逸,pi 不重试 403);`<=0` 关闭 |

### 链式语义

- 链中节点按位置解析:命中某个非尾节点 → 切到下一节点;尾节点无再下一跳。
- `opencode/*` 这种首节点通配支持整 provider 兜底;中间节点通常写精确模型 key。
- 前进方向连跳放行,由两层机制防失控:

  - **环检测**:目标模型若已出现在当前链中(成环),拒绝切换;
  - **连跳上限**:超过 `maxConsecutive` 次连续切换即停在最后一跳并报错。

### 跨 subagent 的精确模型 ban

终态发生后，扩展会把**实际失败的精确模型**写入 `~/.pi/agent/model-failback-bans-<session-id>.json`。agent-team 的每个 worker 都是新 Pi 进程，但会继承主 session ID，共享该 session 的 ban；主 session 结束时自动删除文件。若 A、B 已先后耗尽，下一 worker 会直接从 C 开始，不会再为 A/B 各白撞一次。

- ban 只在当前主 session 内共享，不跨 session；主 session 结束后自动清空。
- 连跳上限和环检测只覆盖同一条连续 failback 链；steering continuation 保留链，下一条新任务自动重置。
- **只 ban `provider/model`，绝不 ban 整个 provider**；例如 ModelScope Flash 用尽不影响同 provider 的 Pro/Qwen。
- ban 记录保留到其 `resetsAt` 到期，或手动 `/failback unban <provider/model>` / `/failback reset`；没有明确恢复时间的余额错误，充值后需手动解除。
- Pi 的 `/model` 没有可取消的事前 extension hook；用户手动选回已 ban 模型时，扩展会在 `model_select` 后立即纠正到链上下一可用节点。

- ban 文件 GC 只由主 Pi 在 `session_start` 执行，worker 子进程不扫描；当前 session 文件和有活跃 lock 的文件不会被删除。
- 超过 TTL 的异常退出遗留文件会被清理；正常 session 结束仍通过生命周期事件即时删除。

会话级切换:`pi.setModel` 不持久化到 settings 默认模型,新会话仍用原默认模型。

## 命令

| 命令 | 说明 |
|---|---|
| `/failback` | 状态:支持 providers、当前映射、跨子进程 ban、连续切换次数、切换链、原模型、配额恢复估计；对已有但没有 `resetsAt` 的 Codex / OpenCode Go usage-limit ban，会即时复用 `usage-stats` 的额度接口补查展示，不改写历史 ban |
| `/failback restore` | 强制切回 failback 前的原模型，并清空当前链状态；不会被 ban 重定向立即撤销 |
| `/failback unban <provider/model>` | 解除一个精确模型 ban；`all` 清除全部 ban |
| `/failback reset` | 清空会话状态与全部 ban |

## 测试

默认离线回归测试（不发起 LLM 请求）：

```bash
volta run node tests/run-regression.mjs
```

只跑名字匹配某个子串的用例（大小写不敏感）：

```bash
volta run node tests/run-regression.mjs ttl
MODEL_FAILBACK_TEST_FILTER=ban volta run node tests/run-regression.mjs
```

过滤只影响执行范围：未命中的用例标记为 skipped，不参与 `passed` 判定；过滤器没有命中任何用例时按失败处理。

显式运行真实 OpenCode → RightCode failback E2E：

```bash
volta run node tests/e2e-opencode-credits.mjs
```

E2E 会真实调用 provider，前提是 `opencode` 账户当前无余额，并且本机同时具备 `opencode` 与 `rightcode-codex` 的有效鉴权；它不会被默认回归命令调用。

## 当前状态

当前实现已经完成并启用:

- 支持 `openai-codex`、`opencode`、`opencode-go`、`modelscope`、`command-code`、`workbuddy` 六个 provider;
- 使用 `chains` 表达多层 failback，精确节点优先于通配节点;
- 终态发生后只 ban 精确的 `provider/model`，不 ban 整个 provider;
- ban 在同一主 session 的 worker/reviewer 子进程之间共享，不跨 session;
- session 结束时清理 ban，`/reload` 保留 ban;
- 主 session 启动时按 `banFileTtlMs` 惰性清理异常退出遗留文件，默认 TTL 为 7 天;
- 多个并行 subagent 写入同一 session ban 文件时使用跨进程锁;
- agent-team 的 Fleet/subagent UI 以最后一条 assistant `provider/model` 显示 failback 最终落点;
- 用户显式 compaction 的 summarization 遇到终态错误时，先切换模型，再在 Pi 收尾且 session 空闲后重试一次 compaction；自动 threshold/overflow 压缩只切换模型，不中断新请求;
- `/failback restore`、`/failback unban`、`/failback reset` 可进行人工干预。

## 扩展新 provider

1. 在 `providers/` 新建 `my-provider.ts`,实现接口:

```ts
import type { ProviderFailbackHandler, TerminalVerdict } from "./types";

export const myProviderHandler: ProviderFailbackHandler = {
  providerId: "my-provider", // 换成你的 provider id
  inspect(message): TerminalVerdict | null {
    // role/stopReason/provider 过滤后,对 errorMessage 做判定
    // 返回 null = 与该 provider 无关或非终态;
    // 返回 { reason, scope, resetsAt?, note? } = 需要 failback
    //   scope: "cross-provider" 表示账户级终态,拒绝同 provider 目标;
    //          "any" 则允许同 provider 换模型
    return null;
  },
};
```

2. 在 `providers/registry.ts` 的 `HANDLERS` 数组注册。

引擎、配置、命令、台账零改动。

## 已验证

- 扩展被 pi 正常加载,不干扰正常任务
- 六个 provider 的终态判定、provider 隔离和无关错误过滤
- Codex 流式原文 `Codex error: The usage limit has been reached`
- compaction summarization 期间的 Codex 额度终态，以及切换后重新压缩上下文
- OpenCode `CreditsError / Insufficient balance`、OpenCode Go `GoUsageLimitError` 与 `503 / Endpoint is unavailable`
- ModelScope `insufficient_quota` 与 `429 {"message":"insufficient balance"}`
- Command Code 四类终态(`model_not_in_plan` / `quota_exhausted` / `usage_limit` / `spend_limit`)判定与 `scope` 语义,以及瞬时限流、5xx、`401`、`403 upgrade_required`、`unsupported_model`、`cmd_zdr_no_providers` 的离线排除用例
- Command Code 解析纪律:换行后追加的 `metadata.raw` 与嵌套字段里的同名 token 不得把非终态错误升级为终态;终态 code 不被同层非终态 `type` 覆盖;`MODEL_NOT_IN_PLAN` 走 `scope:"any"` 时不会跳过同 provider 的可用模型
- WorkBuddy 账户额度码(`14001` 等 7 个)判为终态、非终态码(限流/鉴权/未开通/模型错误/上下文超长/会话数/联网搜索)全部排除、未知 code 不猜测、无 code 的 `429` 需额度文案佐证;以及 workbuddy 链路的引擎级接续- WorkBuddy CraftRate token 窗口(`6003`/`6004`)与日配额 `6008` 按 per-model 限流处理(真实 `6004` 文案的 `UTC+8` 重置时刻解析为精确 epoch;缺偏移、非法日期、已过期、多个冲突时刻、日窗口超出 3 天上界时都退回冷却期),引擎级会走到用户链上的同 provider 付费档而不是跳过整个 provider,ban 携带官方重置时刻从而让 `autoRestore` 能切回免费档;`<=0` 时与其它瞬时限流一样不切不 ban
- WorkBuddy 上游网关故障的有界逃逸:单次 502/504 页保持瞬时、连续到阈值才逃逸、逃逸后计数复位、阈值 `<=0` 关闭、计数按模型隔离;带 JSON 体的响应与裸 5xx 状态行都不误判为网关页;以及引擎级的连续故障切换与 steering
- WorkBuddy WAF 403 拦截页的即时逃逸:真实样本(含内联 `<script>` 的 HTML)首次即判 `waf_blocked` + `cross-provider` + 有界冷却,引擎级切换会跳过同 provider 的下一跳;带 JSON 体的 403、普通 403 HTML 页与裸 `403 status code (no body)` 都不触发;WAF 计数与 5xx 计数互不干扰,阈值 `<=0` 关闭后不再切换/ban/steering
- `pi-workbuddy-connect` 的错误信封补全:`{code,msg}` → `{error:{message,type,code}}`,`code` 以字符串保留(实测真实 API 的 `11101` 与 mock 的 `14001` 均能活到 `errorMessage`)
- ModelScope Qwen 的 `insufficient balance` 真实 lite subagent 接续
- 两层 failback、链内已 ban 节点跳过、环检测、连跳上限和 cross-provider 守卫
- worker/reviewer 子进程启动前跳过已 ban 模型
- `reload` 保留当前 session ban
- 并行 ban 写入不丢记录、TTL 孤儿文件清理
- 真实端到端:
  - `opencode/gpt-5.6-sol` → `rightcode-codex/gpt-5.6-sol`
  - `modelscope/deepseek-ai/DeepSeek-V4-Flash-0731` → `openai-codex/gpt-5.6-luna`
  - `openai-codex/gpt-5.6-terra` → `rightcode-codex/gpt-5.6-terra`
- 离线回归测试全部通过

## 待观察

- `opencode-go` 真实 CreditsError 触发后的二跳，目前仅完成离线链路验证;
- `resetsAt` 与 provider 实际恢复时间的偏差;
- `autoRestore` 的真实额度恢复端到端行为;
- 异常强杀后只能依赖 TTL 清理遗留文件,无法保证立即清理。