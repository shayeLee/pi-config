# Pi 本地沙箱配置说明（sandbox + path-scope）

本文档说明本机 Pi 的本地沙箱方案：对模型工具的读写做「项目内放行 / 项目外询问」，对 `bash` 做 OS 级限制，同时保留宿主工具链（可用 `volta run` 跑构建/测试）。

## 架构概览

| 扩展 | 管什么 | 手段 |
|------|--------|------|
| `path-scope` | **文件工具** read/write/edit/grep/find/ls | pi 的 `tool_call` 事件：项目内放行，项目外弹框询问 |
| `sandbox` | **bash 工具** + `!` 命令 | macOS `sandbox-exec`（OS 级）：读/写/网络规则 |
| `sandbox.json` | sandbox 的规则配置 | 白名单 + 敏感读保护 + 未匹配网络询问 |

> 两者分工：`path-scope` 管「模型主动调工具的动作」，`sandbox` 管「bash 进程的系统调用」。二者是护栏而非 OS 安全边界——对不可信/对抗输入不足，只用于防正常开发时模型顺手越界。

## 文件位置

```
~/.pi/agent/extensions/
├── path-scope.ts       # 文件工具路径拦截（询问式）
├── sandbox/            # bash OS 沙箱扩展
└── sandbox.json        # sandbox 规则配置（全局）
~/.pi/disabled-extensions/gondolin   # 备用：被替换掉的 Gondolin 方案
```

## 行为语义

### path-scope（文件工具）
- **项目内**（以启动 Pi 的 cwd 为根）→ 直接放行，不提示；
- **项目外** → 交互模式弹框询问，允许后本会话内该路径不再重复问；拒绝则 `block`；
- 无交互（`-p` / json / rpc 模式）→ 默认拒绝；可用 `PATH_SCOPE_NOUI=allow` 放行；
- 覆盖工具：read / write / edit / grep / find / ls（bash 不在此列，交给 sandbox）。

环境变量：
| 变量 | 作用 |
|------|------|
| `PATH_SCOPE=0` | 关闭 path-scope |
| `PATH_SCOPE_EXTRA=/a,/b` | 追加视为「项目内」的额外根路径 |
| `PATH_SCOPE_NOUI=allow` | 非交互模式也放行项目外路径 |

### sandbox（bash）
- 网络：`allowedDomains` 白名单；未匹配域名在交互模式弹框询问，无交互拒绝；
- 文件写：`allowWrite` 白名单（已含项目、`~/.pi`、volta、npm/缓存、临时目录）；
- 敏感读：`denyRead` 拦截（`~/.ssh` 等）；
- `denyWrite`：保护 `.env`、`*.pem`、`*.key`。

## 使用姿势

```bash
# 进入项目（cwd 即沙箱的「项目根」）
cd /path/to/project
pi

# 沙箱内：
#   - 让模型读/写项目：正常，不打扰
#   - 让模型碰项目外文件：会弹框问你
#   - 跑构建/测试：用 volta 前缀（见下）
volta run yarn test
volta run yarn build
volta run node script.js
```

> 说明：因 `sandbox-exec` 内层 shell 不继承 Pi 的 bash 函数包装，沙箱内裸 `node`/`yarn` 无法按项目 pin 解析，需用 `volta run` 前缀（宿主终端则无需）。这是当前方案的已知取舍。

## 修改规则

```jsonc
// ~/.pi/agent/extensions/sandbox.json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["npmjs.org", "*.npmjs.org", "github.com", "*.github.com", "10.0.0.205"], // 免问域名（含私服）
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "~/.pi", "~/.volta", "~/.npm", "~/.cache", "~/Library/Caches", "/tmp", "/private/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

项目级可用 `<项目>/.pi/sandbox.json` 覆盖全局（合并，项目优先）。

**注意**：`~/.pi` 必须在 `allowWrite` 中——sandbox 会限制 bash 及它 fork 的一切子进程（含 `pi -p`、git 等），若 pi 连自己的 `settings.json.lock`/session 都写不了，子会话无法启动。

## 已验证

| 场景 | 结果 |
|------|------|
| 项目内读文件 | ✅ 放行 |
| 项目外 read（无交互）| ❌ 拦截 |
| `cat ~/.ssh/config` | ❌ `Operation not permitted`（OS 拦截）|
| `volta run yarn --version` | ✅ 1.22.22 |
| `volta run yarn build` | ✅ 退出码 0，生成 `dist/supportComponents.umd.min.js` 等产物 |
| 项目外 write | ❌ 拦截 |

## 还原 / 切换

- 关闭全部：`PATH_SCOPE=0` + 把 `sandbox/` 与 `sandbox.json` 移出 `extensions/`；
- 恢复 Gondolin：`mv ~/.pi/disabled-extensions/gondolin ~/.pi/agent/extensions/gondolin`（并移除 sandbox/path-scope）。

## 已知注意点

1. **网络「全放开」在 macOS 沙箱下不可行**：`sandbox-exec` 走 SOCKS 代理模型，进程须经其代理 socket 才出网，未经代理的直连/DNS 被挡（实测 `example.com → ENOTFOUND`）。因此保持 `allowedDomains` 白名单 + 未匹配询问；空 `allowedDomains` = 全禁网络。
2. 网络白名单对 **IP**（如私服 `10.0.0.205`）的效果未实跑确认；若 `yarn install` 走私服被拦，把对应 host 加入 `allowedDomains` 或在询问时允许。
3. `sandbox` 是护栏而非 OS 安全边界，不可信仓库请用容器/VM 隔离。
