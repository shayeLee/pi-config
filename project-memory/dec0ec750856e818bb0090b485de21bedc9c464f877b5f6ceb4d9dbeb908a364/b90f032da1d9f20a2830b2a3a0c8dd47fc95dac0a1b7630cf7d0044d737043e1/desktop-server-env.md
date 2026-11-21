<!-- {"summary":"桌面 App 配置在 ~/Library/Application Support/Mochi/server.env（MOCHI_CONFIG 可覆盖）；PI_PERSONAL_AGENT_DEFAULT_MODEL 对 Pi 与 ACP 助理引擎均生效；另有 age 加密备份资源路径。","revision":"3cee2d2b-efa3-426d-b457-0fc210a2b293","updatedAt":"2026-11-20T05:56:19.571Z","sessionId":"4dcffd8a-95cd-4350-a9a4-1e6123dfcc72"} -->
# Mochi 桌面 App 的 server.env

## 路径与读取
- 配置文件：`~/Library/Application Support/Mochi/server.env`（`desktop/src/config.ts` 的 `configPath(userData)`；设了 `MOCHI_CONFIG` 就用它的值）。
- 桌面端用 `node:util` 的 `parseEnv` 解析整个文件并作为后端子进程的环境；`HOST`/`PORT` 是后端地址，`MOCHI_WEB_HOST`/`MOCHI_WEB_PORT` 是 Web UI 地址。
- 权限惯例：`0600`；改前备份成 `server.env.bak-<时间戳>`（`cp -p` 保权限）。注意 macOS `date` 不支持 `%6N`，别用它拼时间戳。

## 引擎相关变量的生效范围（源码验证）
- `PI_PERSONAL_AGENT_ENGINE`：`pi` | `claude`（默认）| `acp`，启动时读一次，其他值 fail-fast（`src/server/start.ts` `parsePersonalAgentEngine`）。
- `PI_ACP=1`（或 `on`）才注册 ACP 工厂（`src/main.ts`）；ACP 缺 tier 配置不会让服务启动失败，只在会话创建时报不可用。
- `PI_PERSONAL_AGENT_DEFAULT_MODEL`：格式 `provider/id`（`src/main.ts` `parseDefaultModel`，斜杠分隔，否则报错）。
  **对 Pi 与 ACP 助理引擎均生效**：覆盖建会话时的默认模型，也覆盖新建/草稿态下的默认模型；ACP 未设置该项时回退 agy 默认模型。
  启动时仍无条件校验格式与可用性（模型必须在注册表里、provider 必须有凭证），所以这行写错会让服务起不来——即使引擎是 claude 或 acp。

## 桌面端打包的 server
- `desktop/release/mac-arm64/Mochi.app/Contents/Resources/server/dist` 是打包进 App 的后端，`build-info.json` 记录构建来源 commit。改 App 行为前先确认该 commit 是否已包含对应代码。

## 本机 age 加密备份资源
- 公钥/私钥：`~/.config/pi-agent-server/backup-recipients.txt` 与 `backup-identity.txt`。
- 密文备份根目录：`~/pi-agent-server-backups/local-deploy`。
- 本机已安装 `age v1.3.2`。
