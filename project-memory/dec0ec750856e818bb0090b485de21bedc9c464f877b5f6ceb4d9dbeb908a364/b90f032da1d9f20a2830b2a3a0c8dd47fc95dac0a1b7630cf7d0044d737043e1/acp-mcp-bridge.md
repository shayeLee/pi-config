<!-- {"summary":"ACP 工具桥用 HTTP 型 mcpServers；grant 层分两套工具集（项目 5 个、助理 33 个），五个 mcp_mochi_* 线名自动放行；桥给会话工具描述追加自己的工作台 sessionId/projectId/cwd。","revision":"7f3f9091-3dcf-417a-99b2-81928eea8fd1","updatedAt":"2026-11-20T05:56:25.230Z","sessionId":"4dcffd8a-95cd-4350-a9a4-1e6123dfcc72"} -->
# ACP MCP 工具桥

## 决策：用 HTTP 型 mcpServers，不用 stdio

`session/new` 的 `mcpServers` 传的是 agy 支持的 **HTTP 型**条目：

```json
{"name":"mochi","type":"http","url":"http://127.0.0.1:<port>/mcp",
 "headers":[{"name":"authorization","value":"Bearer <每会话 32 字节随机 token>"}]}
```

**依据（真机实测，非推测）**：

- 桌面 App 的后端是 Electron `utilityProcess`（见 `desktop/src/backend.ts`）；其中 `process.execPath` 是 helper 二进制，`ELECTRON_RUN_AS_NODE=1` 直接报 “This is a helper executable and cannot be launched directly”，主 App 二进制跑 `-e` 也无输出。即桌面端**没有可 spawn 的 node 可执行文件**，stdio MCP server 在那里无法启动。
- agy 接受 HTTP 型条目：POST `server/discover` → `initialize` → `notifications/initialized` → `tools/list` → `tools/call`，接受纯 JSON 应答（无需 SSE），`Accept: application/json, text/event-stream`，收尾发 `DELETE /mcp`；entries 带 authorization 时还会 GET `/.well-known/oauth-protected-resource*`（非我方路径，回 404 即可）。
- stdio 方案曾实现并跑通（env 走 ACP 规范的 `[{name,value}]` 数组；线名 `mcp_<server>_<tool>`），仅因桌面端死路而放弃。

好处：无子进程（无孤儿问题）、无凭据进 child env、无额外构建产物、Desktop 与 CLI 同一条路径。

## 实现位置

- `src/agent/acp/acp-bridge.ts`：`AcpBridge`。仅绑 127.0.0.1，懒启动监听；每会话一个 grant（32 字节 base64url token，`timingSafeEqual` 比对，仅存内存，adapter `disconnect()` 时 revoke）；body 上限 256KB、请求超时 20s；`DELETE /mcp` **不**撤 grant（grant 生命周期由 adapter 掌握，agy 重连还会复用该条目）；`/.well-known/*` 未经鉴权直接 404。
- `src/shared/acp-bridge-tools.ts`：零依赖命名模块——server 名 `mochi`、工具名列表、线名 `mcp_mochi_<tool>`、`AcpMcpServerSpec`（stdio/http 联合类型）。
- 接线：`acp-config.newAcpSession(…, mcpServers)`、adapter 的 `bridgeServers`/`bridgeRelease`（session/new 与 load/resume 都带；桥失败只降级为“本次无宿主工具”）、factory 只在 `context.mcpCredentialOwner` 存在时接桥（共享/原生会话没有），`start.ts` 懒挂 access。
- 工具逻辑**不重写**：直接复用 `createReportToAgentTool` 与 `createPersonalAgentTools`。

## 工具集分档（grant 层）

项目和助理共用同一个桥，由 grant 层决定各自拿到的工具集合：

- **项目会话**：5 个基础工具（`report_to_agent`、`agent_remember`、`agent_forget`、`agent_list_sessions`、`agent_session_brief`）。
- **个人助理会话**：全量工具（33 个）。

## 会话自我身份（mochi/bridge-self）

桥在 `tools/list` 时把当前会话的**工作台**身份写进 `agent_session_brief` 与 `agent_list_sessions` 的描述：「你自己（这个 ACP 会话）的工作台会话 ID 是 <sessionId>（项目 名（id …），工作目录 …）」，并点明引擎内部的 session id（remoteSessionId）不是工作台会话 ID。只改桥这一份视图（`withSessionNotes`），助理自己用的工具定义不动。workspace 由 `AcpBridge.workspaceOf` 每次 `tools/list` 用 `sessions.listForPersonalAgent` 查（优先 `session.workdir`，否则项目 `cwd`），失败只丢这句、不影响工具列表。

**真机已验证**：ACP 会话在没被提示 ID 的情况下调用 `mcp_mochi_agent_session_brief` 时填的是自己的工作台 ID，`agent_list_sessions` 填的是正确 `projectId`；随后按标题找到同项目另一个 ACP 会话并读取 `full=true`，逐字复述出对方助手回复内容。

**已知限制**：ACP 会话读**正在跑（含自己）**的会话时 `agent_session_brief` 返回 `steps: []`——`AcpAgentAdapter.getSessionSteps` 在 transcript 正在追加（`transcriptBusy>0`）时只返回空快照，是有意的（不读半行文件）。读空闲会话、读 Pi 会话内容正常。若将来要在回合中读实时内容，需要另想读取方式。

## 权限

规则引擎对未识别工具一律转人工，默认 allow 兜底走不到，因此 `acp-permissions.ts` 在 unrecognized-tool 判定**之前**对 `ACP_BRIDGE_TOOLS` 的确切线名返回 `allow`（`ruleId: acp-bridge-tool`，审计照记）。刻意只匹配确切名字：`mcp_mochi_agent_send`、`mcp_other_report_to_agent`、`mcp_mochi_report_to_agent_extra` 仍转人工。残余风险：agy 自己配置里也放一个叫 `mochi` 且提供同名工具的 server 也会被放行，靠 agy 配置层面避免。

## 验收结论（真机）

独立临时实例 + 真实 agy：API 建 ACP 会话 → 发消息 → `tool_call mcp_mochi_agent_remember completed` → `GET /v1/personal-agent/memories` 可见写入文本；`mcp_mochi_agent_session_brief` 读回真实会话首条 user 文本逐字一致；权限审计为 `decision: allow / ruleId: acp-bridge-tool` 后紧接 `option: allow_once`，全程无人审批；SIGTERM 后无 agy 残留。
