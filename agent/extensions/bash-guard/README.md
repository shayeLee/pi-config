# bash-guard — Bash 命令守卫扩展

`bash-guard` 是 `path-scope` 的补充。`path-scope` 只按**路径边界**守护文件类工具（read/write/edit/grep/find/ls），并刻意不拦 bash——因为一条命令字符串无法**完整地**归约为一组路径。`bash-guard` 按**命令模式**（pattern match）补齐这个缺口：危险命令要么弹窗征求确认，要么直接拦截。反过来，当一条命令确实只写了「路径边界内」的位置时，它能被安全地归约，于是也按同一条边界放行（见「授权根放行」）。

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
| 越界类规则命中，但**全部写入/删除目标都在授权根内** | 放行，不打扰（见「授权根放行」） |
| 危险命令 + 有 UI | **弹窗确认**（默认 `ask`）或**直接拦截**（`mode: "block"`） |
| 危险命令 + 无 UI（`-p` / json / rpc） | **拦截**（默认 `block`，fail-closed） |

拦截时调用方收到 `{ block: true, reason: "危险命令（规则名）…" }`。

## 授权根放行（与 path-scope / sandbox-bash 共用一条边界）

三个扩展描述的是同一条路径边界，因此对「边界内」的判定必须一致：

| 扩展 | 边界内的效果 |
|------|--------------|
| `path-scope` | 文件工具在项目目录 + `extraRoots` 内不弹窗 |
| `sandbox-bash` | 项目目录 + `extraRoots`（+ 临时目录）内内核允许写 |
| `bash-guard` | 命令的写入/删除目标全部落在项目目录 + `extraRoots` 内时，**只因越界而危险**的两条规则不再弹窗/拦截 |

可豁免的规则只有：`破坏性删除`、`写入系统目录`。其余规则（`提权执行`、`chmod/chown 危险参数`、`git 破坏性操作`、`远程脚本执行`、`磁盘/分区操作`、`全局安装到系统`、自定义 `patterns`）保护的是权限、git 历史/远端、全局状态，与路径无关，**永不豁免**。

`extraRoots` 的来源**只有**用户级 `~/.pi/agent/path-scope.json`：项目级 `.pi/path-scope.json` 不参与，否则一个仓库就能自选「这里的删除不用问我」。

**放行条件**（任一不满足即回到原有 ask/block 流程，fail-closed）：

1. 命令的每个命令段都可解析（换行与 `&&`、`;`、`|` 一样都是命令分隔，**每一段**都必须在根内）：命令词仅限 `rm`、`tee`、`touch` 与纯 stdout 生产者（`echo`、`printf`、`cat`、`true`、`false`）；`git`、`find`、`xargs`、`sudo`、`cd`、`python` 等一律不豁免。
2. 选项在已知集合内（如 `rm -rf`、`--force`、`--recursive`；`--no-preserve-root` 之类直接拒绝豁免）。
3. 写入/删除目标（`rm`/`tee`/`touch` 的位置参数 + `>`、`>>`、`&>`、`2>` 的重定向目标）**严格位于**某个授权根之内——授权根本身不算：`rm -rf .`、`rm -rf <项目目录>`、`rm -rf /tmp`（当 `/tmp` 是根时）仍会弹窗。
4. 命令不含无法解析的 shell 语法：`$`、反引号、glob（`* ? [ ]`）、`( ) { }`、here-doc、`>&`、`!`、`#`、反斜杠、引号内转义、未闭合引号、悬空 `>`、空命令段。
5. 目标按内核语义解析（`realpath(3)`，含符号链接与穿过链接的 `..`）；解析失败、指向根外，或落在 `~/.pi` / `~/.pi/agent`（pi 凭据/配置目录）内 → 不豁免。后一条与 `sandbox-bash` 的写授权根排除一致：即使 `~/.pi` 出现在 `extraRoots` 里，也不会让 `rm -rf ~/.pi/...` 静默通过。

读操作不参与判定：这两条规则关注的是**越界写**，而 bash-guard 本来就不拦读（`cat /etc/hosts` 一直是放行）。

> 已知例外：当项目目录本身就位于 `~/.pi` 下（例如在本仓库里跑 pi），第 5 条的受保护目录判定对**项目 cwd 子树内**的目标不再生效（与 `sandbox-bash` 的 cwd 优先一致）：项目内的 `rm -rf` 不再额外弹窗。cwd 子树外的凭据不受影响：目标仍需严格位于某个授权根内，且覆盖「包含 cwd 的受保护目录」的宽根 `extraRoots`（如 `~`、`/`）会被丢弃（与 sandbox-bash 的宽根过滤一致），因此 cwd 之外的 `agent/auth.json` 等凭据不会因放行 cwd 而被放宽。

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

以上内置规则**哪些可被豁免由代码固定**（仅 `破坏性删除`、`写入系统目录`）；自定义 `patterns` 添加的规则永不参与豁免。用户能配置的只有总开关 `scopeExempt`，见下。

已排除的常见误报：`git push --force-with-lease`、`chmod 644`、`pip --user`、`cat /etc/hosts`、普通 `brew install`。

## 配置

配置文件（优先级高于环境变量）：**`~/.pi/agent/bash-guard.json`**

```json
{
  "enabled": true,
  "mode": "ask",
  "noUI": "block",
  "allowlist": ["npm run build", "git pull"],
  "patterns": ["\\bmake\\b.*\\binstall\\b"],
  "scopeExempt": true
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | `false` 完全禁用本扩展 |
| `mode` | `"ask"` \| `"block"` | `"ask"` | 有 UI 时：`ask` 弹窗确认；`block` 直接拦截 |
| `noUI` | `"block"` \| `"allow"` | `"block"` | 无 UI 时：`block` 拦截；`allow` 放行 |
| `allowlist` | string[] | `[]` | 命令**精确相等**或**以之为前缀**（如 `"npm install"` 匹配 `"npm install lodash"`）即跳过所有检查 |
| `patterns` | string[] | `[]` | 追加的自定义危险正则（正则 source，自动加 `i` 标志） |
| `scopeExempt` | boolean | `true` | `false` 关闭「授权根放行」，越界类规则也一律按原流程处理 |

配置为**会话级**：修改后需 `/reload` 重读。`session_start` 时读取一次并缓存，`/reload` 会清空缓存并重新读取。

### 环境变量（配置文件未设置对应项时生效）

| 变量 | 作用 |
|------|------|
| `BASH_GUARD=0` | 禁用本扩展 |
| `BASH_GUARD_MODE=block` | 等价于 `mode: "block"` |
| `BASH_GUARD_NOUI=allow` | 等价于 `noUI: "allow"` |
| `BASH_GUARD_SCOPE_EXEMPT=0` | 等价于 `scopeExempt: false` |

优先级：**配置文件 > 环境变量 > 内置默认值**。

### 无效配置

JSON 无法解析、出现未知字段、或字段类型错误时：该配置文件被忽略并产生一条 `bash-guard: …` 告警；同时**关闭环境变量兜底**，退回安全默认值（`enabled=true`、`mode=ask`、`noUI=block`、`scopeExempt=true`），避免环境变量意外放宽限制。修复后 `/reload` 即可恢复。

若 `~/.pi/agent/path-scope.json` 缺失或格式非法，`extraRoots` 视为空（只剩项目目录这一个授权根），同样 fail-closed。

## 单元测试

纯逻辑（`core.ts`）不依赖 Pi 运行时，用 Node 24 原生 `node:test` 直接跑：

```bash
cd ~/.pi/agent/extensions/bash-guard
volta run node --test core.test.ts
```

覆盖：schema 校验、命令归一化、白名单匹配、自定义规则编译（含非法正则跳过）、全部内置危险规则的**正向命中**与**反向不误伤**回归，以及授权根放行的词法解析（拒绝 `$`/glob/子 shell/heredoc/未闭合引号等）、路径锚定（相对路径、`~`、穿过符号链接的 `..`）、符号链接越界与受保护目录判定、以及「哪些规则可豁免」的表驱动回归。

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

**每次都问，连项目目录/extraRoots 内的删除与写入也不豁免：**

```json
{ "scopeExempt": false }
```

**临时禁用：**

```bash
BASH_GUARD=0 pi   # 或配置 {"enabled": false}
```

## 已知局限

1. **黑名单可被绕过**：语义等价但写法不同的命令（混淆、别名、脚本文件、`sh -c` 等）无法穷尽。不要把它当安全边界。
2. **只拦 LLM 发起的工具调用**（`tool_call` 事件）。你自己用 `!命令` / `!!` 手动执行的命令走 `user_bash` 事件，不在本扩展范围——那是你的显式输入，通常无需守卫。
3. **正则跨行安全**：`.*` 不匹配换行，所以一条命令里“安全前半段 + 危险后半段”仍会命中，而“危险片段在另一行”不会误伤前半行。
4. **授权根放行是保守推断**：只看 `rm`/`tee`/`touch`/重定向能确定的写入目标，因此像 `python x.py > /tmp/out` 这类「命令自己还会写别的文件」的情况，只要重定向目标在根内就会被豁免（`echo`/`printf`/`cat` 同理，其参数只作为读或纯文本处理）。真正的越界写由 `sandbox-bash` 的内核隔离兜底；不需要这条豁免时用 `{ "scopeExempt": false }` 或 `BASH_GUARD_SCOPE_EXEMPT=0` 关闭即可。
5. **授权根来自用户级配置**：`extraRoots` 写得越宽（例如 `/` 或 `/var`），豁免范围就越宽——`~/.pi` 是唯一不可放宽的底线。请确认 `agent/path-scope.json` 里的每一项都是你愿意让文件工具与 bash 无条件写入的位置。