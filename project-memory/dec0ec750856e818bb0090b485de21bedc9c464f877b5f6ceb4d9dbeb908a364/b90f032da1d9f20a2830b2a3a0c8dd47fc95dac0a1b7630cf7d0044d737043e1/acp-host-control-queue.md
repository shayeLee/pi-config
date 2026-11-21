<!-- {"summary":"ACP 追加队列由宿主（adapter+runtime）持有，轮结束由 runtime 走 submitMessage 排出，promote = 中止并发送；服务器通知走 promptCustom 排队投递，空闲唤醒走 lateIdleTurn。","revision":"520d9908-46f5-4b11-9dd6-6a00173d392f","updatedAt":"2026-11-20T05:56:29.034Z","sessionId":"4dcffd8a-95cd-4350-a9a4-1e6123dfcc72"} -->
# ACP 追加队列（宿主持有）与通知投递

结论：ACP 引擎侧没有队列，追加队列由工作台自己做，行为对齐 Pi。代码在 `src/agent/acp/acp-agent-adapter.ts`
（`queuedFollowUps` + getControlQueueItems/subscribeControlQueue/mutateControlQueue/peekQueuedFollowUp/takeQueuedFollowUp）
与 `src/runtime/session-runtime.ts`（`drainHostQueue`、`adoptHostQueue`、`consumeQueuedControl`）。

## 已实现的机制
- `followUp` 只入队（内存），不发送；快照通过同一个 `GET .../control-queue` 暴露，前端无需按引擎分支。
- 消费在 runtime：每轮 settle 的 finally 里（outcome 非 aborted）取队首，用 `submitMessage` + `beforeAccept`（准入时 take 条目）
  发成下一轮，因此新轮有自己的 requestId / user_message / 终态事件；一轮一条，顺序保持。
- 剩余条目在 `startAdmittedTask` 里把 steering admission 的 requestId 改挂到新轮（`adoptHostQueue`），否则新轮期间
  队列面板看不到、也无法删除/提升。
- 中止后不自动排（对齐 Pi：press Esc 不替用户发）；队列留到下一轮正常结束后再发。
- `promote` = 宿主侧「中止并发送」：session-service 先 `interruptAndSend`（abort + 等交还 + submitMessage），
  成功后才 `takeQueuedFollowUp` + `consumeQueuedControl`（补发 steering_consumed 让页面收掉提交回执）。
- 前端 `interruptSteer` / `interruptPlaceholder` / 相关 i18n 键已删除：ACP 与 Pi 完全同一套 Composer。

## 服务器通知与空闲唤醒
- 服务器通知走 `promptCustom` + `subscribeNotifications` 排队投递，入口是 `SessionRuntime.admitNotification`：
  与用户消息共用准入/队列机制，不打断进行中的轮次。
- 后台命令的空闲唤醒走 `lateIdleTurn`：复用 `AcpEventBridge` 与既有权限审批策略，产出 `late: true` 的事件流，
  前端据此区分「后台任务完成后的续答」与正常轮次。

## 边界
- 队列在内存，重启丢失（接受）。
- 与 Pi 的唯一语义差异：Pi 中止后残留的 follow-up 会在下一次 prompt 里被 SDK 一并交付；ACP 是下一轮结束后单独发一轮。

依据：2026-11 这轮实现与测试（后端、Web 全量、双端构建、tsc 通过），追加队列与通知投递已在真机 ACP 会话验证。
