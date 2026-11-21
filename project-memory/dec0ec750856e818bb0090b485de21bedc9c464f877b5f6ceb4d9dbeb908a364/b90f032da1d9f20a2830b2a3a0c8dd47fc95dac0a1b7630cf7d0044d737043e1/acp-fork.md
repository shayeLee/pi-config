<!-- {"summary":"ACP 分叉复制镜像、首轮注入历史和旧图；独立工作树隐藏入口，只配置过的无 load 空分叉可安全重建。","revision":"23890e92-fb66-4560-9b90-a8f540e5cd95","updatedAt":"2026-11-21T12:17:56.777Z","sessionId":"cf04b1ca-b2eb-4db9-b47d-54a258434bf0"} -->
# ACP 分叉实现约定

- 普通 ACP 与 Mochi ACP 共用镜像分叉。只读远端不妨碍复制可读镜像：截到下一条非通知用户记录之前；新镜像从未激活状态起步，不复用远端 ID、权限或检查点，不探测模型目录。独立工作树归单会话所有，不支持分叉，能力快照同步返回 `fork: false`。
- `forkPrefixLineCount` 是不可变的物理记录边界（不含 header），包括旧轮次之间的通知；`forkContextPending` 独立于激活，因配置或通知可能先启动引擎。旧记录仍供 UI 展示，原生回放对齐和用量汇总只取边界后的记录，避免重复文本歧义和重复计量。
- 首条实际用户消息才附带有界前情、支持时附最近的预算内旧图。前情用已持久化的轮次 nonce + 长度标记封装，`session/load` 可剥离；不写入本地用户原文。启动失败、取消或传输失败不消耗 pending；正常结束或达到 token 上限后才清理。通知不消费前情；注入成功前拒绝 `/compact`。
- 唯一可解锁远端 ID 的情形：分叉仍 pending，引擎明确不支持 `load`，没有只读标记，前缀之后只有配置/上下文元数据而没有实际轮次。下次连接前在镜像写入队列中重新检查并重置，再 `session/new`；已有通知也不允许重建。`configure()` 本身可能在前缀后写 `config` 行，不能只按总行数判定。
- 依据：`src/agent/acp/acp-conversation-storage.ts`、`acp-transcript.ts`、`acp-session-factory.ts`、`acp-agent-adapter.ts`、`acp-fork-context.ts`、`acp-replay.ts` 与 `tests/agent/acp-recovery.test.ts`；隔离测试数据上两条路径实测真实 agy 都能识别旧图颜色；后续用真实浏览器确认独立工作树隐藏分叉入口、普通 ACP 保留。