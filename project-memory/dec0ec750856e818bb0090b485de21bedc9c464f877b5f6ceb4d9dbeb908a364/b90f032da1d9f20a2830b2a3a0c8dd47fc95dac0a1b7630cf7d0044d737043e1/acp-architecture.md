<!-- {"summary":"ACP 架构、两档配置、权限和真机排障；agy 1.5.13 默认 OS 单账号、原生登录登出/只读额度与共享目录。","revision":"ce0618f6-97a8-48eb-9a77-414bda9cb6c2","updatedAt":"2026-11-21T08:32:34.207Z","sessionId":"d451e407-29a3-4582-a769-5715b3250711"} -->
# ACP 引擎架构与环境（2026-11-20 定型）

## 现状
阶段一（项目编码会话）与阶段二（交互对齐与个人助理）均已完成，仓库已同步 `origin/main` 至 `67a8e461`。

- 阶段一：动态模型目录、两档配置与认证、事件桥、持久化镜像、`load` 恢复、权限引擎、取消回收、用量映射、创建入口、图片持久化、备份还原链。
- 阶段二：MCP 工具桥、追加队列与引导、工具卡渲染与耗时入镜像、会话详情栏、ACP 个人助理（主会话/频道/定时，含草稿态模型与思考档位选择）、`promptCustom` 通知排队投递、会话笔记抽取与压缩后增量抽取（`/compact` 成功或 `usage_update` 骤降 >50% 触发）、`/` 命令菜单（`AcpModelCatalog.probe()` 捕获 agy 完整 13 条命令，支持草稿态与冷回退）、后台任务空闲唤醒（`lateIdleTurn`）的权限审批与工具流。

## 环境与两档配置
- `agy` 在 `~/.local/bin/agy`，凭据在系统钥匙串，**禁止 HOME 重定向**；入口 `agy acp`。
- 工作台的 Antigravity 登录采用 `agy` 的默认 Google 认证（同一个服务 OS 用户共用一个活动账号位置）；`--gemini-dir` / `--app-data-dir` 隔离应用数据，不是账号选择器。依据：`agy 1.5.13` 的 `acp --help`、Google CLI 安装说明、仓库两档真实部署经验。旧版或特殊环境的文件回退不能视为工作台支持的账号隔离接口。宿主不读取或搬迁凭据。
- `agy acp --login` 能通过 stdout 授权 URL + stdin 授权码/完整回调地址工作；ACP `initialize` 宣告 `agentCapabilities.auth.logout` 后可发 `logout`。`agy -p /usage` 与 `/credits` 支持 JSON、实测 `num_turns: 0`；套餐名可从已有 ACP 目录探测的 `session/new._meta.antigravity.tier` 取得，不需要为查额度另建 ACP 会话。项目和个人助理当前共用一个 `AcpModelCatalog`（`src/application/session-service.ts`）。
- 参数：`--gemini-dir .config/pi-agent-server/acp/<tier> --app-data-dir antigravity-cli`，`<tier>` = `personal` | `project`。
- 配置：`$HOME/.config/pi-agent-server/acp/<tier>/antigravity-cli/settings.json`，用 `strict` 模板；`toolPermission` 用 `request-review`，封死 `always-proceed`。
- `personal` 档：cwd 为 homedir、拒绝敏感路径；`AGENTS.md` 写入 `gemini-dir/config` 每轮热重载；长期记忆随消息附带且仅变化时重附，镜像中剥离注入内容。

## 管控与权限设计决策
- 轻量方案：不做进程隔离或沙盒，复用 agy 自带权限。
- 管控只走 ACP `request_permission` 单一通道，不用 agy `hooks.json`（PreToolUse 等）旁路拦截——该规则不是沙箱，宿主只能审查 agy 主动送来的请求。
- 权限默认放行，只拦危险动作：`rm -rf`、破坏性 git 操作、提权、`curl | sh`、装包、写项目外或系统路径。
- 明确不做：不备份 brain 原生状态（换机仅还原工作台包时只读历史、不能续聊）；不做无人值守审批。

## 已知边界与降级
- `invoke_subagent` / `schedule` / `manage_task` 在 agy 侧不发 `request_permission` 直接执行，审计无记录；「未识别即转人工」仅在 agy 询问时生效。
- 恢复阶段失败、首个 prompt 被拒、镜像尾部中断或回放冲突，均持久化降级为只读；能力快照按 header mtime/size 失效；判断是否已发送用不会被 `closeRunInput()` 清空的 `run.delivered`。

## 真机排障经验
- 首次启动 agy 需 1–3 分钟；新数据目录先 bootstrap DB；IP 策略文件权限 `0600`；不设 `PI_DATA_MODE=development`。
- Vite dev 反复 SSE 后代理可能卡住，`web/dist` + 极简静态代理更稳。
- `pnpm dev` / `volta run node` 的 PID 可能只是包装进程，用 `lsof -iTCP:<port> -t` 定位实际监听进程；正常 SIGTERM 会清理 agy 进程组。
- SSE 每用户上限 10，429 时重启服务可清计数。

- agy 1.5.13 的后台命令实测（独立临时 cwd，经一次性审批运行 `sleep 18`，`WaitMsBeforeAsync=1000`）：前台 `end_turn` 后同 `toolCallId` 收到终态 `tool_call_update`，再约 3.5 秒收到唤醒的 `agent_message_chunk`、随后有 `usage_update`，没有第二个 `session/prompt` 响应。唤醒首包不是命令终态的同一时刻，宿主不能收到命令终态就立即判定收尾。另一次在 `end_turn` 后向该 session 发 `session/cancel`，约 20 毫秒后收到同一后台工具的 `failed` 终态。

- agy 1.5.14 的 `read_file` 可按内容识别上传存储的无扩展名 UUID 路径：用 MP4/H.264 测试样本在真实工作台 ACP 项目会话单轮验证，工具返回采样帧。不需为视频给存储 key 加后缀，也不需把视频编码成 ACP 内容块；读取仍受当前 ACP 权限档约束。
