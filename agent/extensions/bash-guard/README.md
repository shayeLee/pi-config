# bash-guard — Bash 命令守卫扩展

`bash-guard` 是 `path-scope` 的补充。`path-scope` 只按**路径边界**守护文件类工具（read/write/edit/grep/find/ls），并刻意不拦 bash——因为一条命令字符串无法可靠地归约为一组路径。`bash-guard` 按**命令模式**（pattern match）补齐这个缺口：危险命令要么弹窗征求确认，要么直接拦截。

> 定位与边界：这是**启发式黑名单**，用来降低误操作概率、让模型在危险动作前先征求你同意。它**不是安全沙箱**，可被混淆写法绕过（`rm --recursive`、变量拼接等）。真正的隔离来自容器/VM（见 pi 的 `security.md`）。

## 目录结构

```
~/.pi/agent/extensions/bash-guard/
├── index.ts      # 扩展入口（Pi 自动发现子目录中的 index.ts）
├── core.ts       # 纯逻辑（无 Pi/fs 依赖，可独立单测）
├── core.test.ts  # 单元测试
└── README.md
```

放置到位后执行 `/reload` 热加载（或在退出重进后自动生效）。

## 行为

| 场景 | 结果 |
|------|------|
| 安全命令 | 放行，不打扰 |
| 白名单（allowlist）命中 | 放行 |
| 危险命令 + 有 UI | **弹窗确认**（默认 `ask`）或**直接拦截**（`mode: "block"`） |
| 危险命令 + 无 UI（`-p` / json / rpc） | **拦截**（默认 `block`，fail-closed） |

拦截时调用方收到 `{ block: true, reason: "危险命令（规则名）…" }`。

## 内置危险规则

| 规则名 | 匹配示例 |
|--------|----------|
| 破坏性删除 | `rm -rf /x`、`rm -f a`、`rm -fr c` |
| 提权执行 | `sudo make install` |
| chmod/chown 危险参数 | `chmod 777 f`、`chmod -R 755 d` |
| git 破坏性操作 | `git reset --hard`、`git clean -fd`、`git push -f`/`--force` |
| 远程脚本执行 | `curl https://x.sh \| bash` |
| 磁盘/分区操作 | `dd if=… of=/dev/sda`、`mkfs.ext4`、`diskutil eraseDisk` |
| 写入系统目录 | `echo x > /etc/…`、`… \| tee /usr/…` |
| 全局安装到系统 | `npm install -g …`、`pip install -g …` |

已排除的常见误报：`git push --force-with-lease`、`chmod 644`、`pip --user`、`cat /etc/hosts`、普通 `brew install`。

## 配置

配置文件（优先级高于环境变量）：**`~/.pi/agent/bash-guard.json`**

```json
{
  "enabled": true,
  "mode": "ask",
  "noUI": "block",
  "allowlist": ["npm run build", "git pull"],
  "patterns": ["\\bmake\\b.*\\binstall\\b"]
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | `false` 完全禁用本扩展 |
| `mode` | `"ask"` \| `"block"` | `"ask"` | 有 UI 时：`ask` 弹窗确认；`block` 直接拦截 |
| `noUI` | `"block"` \| `"allow"` | `"block"` | 无 UI 时：`block` 拦截；`allow` 放行 |
| `allowlist` | string[] | `[]` | 命令**精确相等**或**以之为前缀**（如 `"npm install"` 匹配 `"npm install lodash"`）即跳过所有检查 |
| `patterns` | string[] | `[]` | 追加的自定义危险正则（正则 source，自动加 `i` 标志） |

配置为**会话级**：修改后需 `/reload` 重读。`session_start` 时读取一次并缓存，`/reload` 会清空缓存并重新读取。

### 环境变量（配置文件未设置对应项时生效）

| 变量 | 作用 |
|------|------|
| `BASH_GUARD=0` | 禁用本扩展 |
| `BASH_GUARD_MODE=block` | 等价于 `mode: "block"` |
| `BASH_GUARD_NOUI=allow` | 等价于 `noUI: "allow"` |

优先级：**配置文件 > 环境变量 > 内置默认值**。

### 无效配置

JSON 无法解析、出现未知字段、或字段类型错误时：该配置文件被忽略并产生一条 `bash-guard: …` 告警；同时**关闭环境变量兜底**，退回安全默认值（`enabled=true`、`mode=ask`、`noUI=block`），避免环境变量意外放宽限制。修复后 `/reload` 即可恢复。

## 单元测试

纯逻辑（`core.ts`）不依赖 Pi 运行时，用 Node 24 原生 `node:test` 直接跑：

```bash
cd ~/.pi/agent/extensions/bash-guard
volta run node --test core.test.ts
```

覆盖：schema 校验、命令归一化、白名单匹配、自定义规则编译（含非法正则跳过）、以及全部内置危险规则的**正向命中**与**反向不误伤**回归。

新增/修改规则后，把对应的命令加到 `core.test.ts` 的用列表里即完成回归保护。

## 常见操作

**改成默认直接拦截（不再弹窗）：**

```json
{ "mode": "block" }
```

**放行高频安全命令：**

```json
{ "allowlist": ["npm run build", "npm run test", "git pull"] }
```

**临时禁用：**

```bash
BASH_GUARD=0 pi   # 或配置 {"enabled": false}
```

## 已知局限

1. **黑名单可被绕过**：语义等价但写法不同的命令（混淆、别名、脚本文件、`sh -c` 等）无法穷尽。不要把它当安全边界。
2. **只拦 LLM 发起的工具调用**（`tool_call` 事件）。你自己用 `!命令` / `!!` 手动执行的命令走 `user_bash` 事件，不在本扩展范围——那是你的显式输入，通常无需守卫。
3. **正则跨行安全**：`.*` 不匹配换行，所以一条命令里“安全前半段 + 危险后半段”仍会命中，而“危险片段在另一行”不会误伤前半行。