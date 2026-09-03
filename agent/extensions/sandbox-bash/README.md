# sandbox-bash — macOS 原生写隔离扩展

用 macOS 的 `sandbox-exec`（Seatbelt）把 **bash 工具**和 **`!` 命令**包进内核级沙箱，**只限制文件写入**：授权根内可写，授权根外任何写操作被内核直接拒绝（`Operation not permitted`），无论命令怎么措辞都无法绕过。

> 与 `bash-guard` 的分工：`bash-guard` 是进程内**正则提醒/拦截**（可被混淆绕过）；`sandbox-bash` 是**内核强制写隔离**（无法绕过）。两者可共存，构成「提醒 → 硬隔离」的分层。

## 目录结构

```
~/.pi/agent/extensions/sandbox-bash/
├── index.ts      # 扩展入口（覆盖 bash 工具 + user_bash）
├── core.ts       # profile 生成等纯逻辑（无 Pi 依赖，可单测）
├── core.test.ts  # 单元 + 集成测试
└── README.md
```

放置后 `/reload` 生效。

## 行为

写授权根 = **cwd（项目目录） + `path-scope.json` 的 `extraRoots` + `/tmp` + `/private/tmp` + `os.tmpdir()`**，再**减去 `~/.pi` 及其子目录**（凭据/配置目录，永不授权）。每个根同时列「原始路径 + realpath」双变体，以兼容目录符号链接（如 `/var`→`/private/var`）。根与 `denyRead` 条目中的**相对路径都按会话 cwd 解析**（不是按 pi 启动目录），且比对敏感目录时会考察原始、`..` 保留、realpath 三种形式。

| 操作 | 结果 |
|------|------|
| 写授权根内 | 放行 |
| 写授权根外任何路径 | **内核拒绝** |
| 写 `~/.pi`、`~/.pi/agent`（含通过符号链接、`..` 绕行、或被 `~` 这样的宽根包含） | **内核拒绝** |
| 写 pi 配置/凭据**文件**（`auth.json`、`oauth.json`、`trust.json`、`settings.json`、`models.json`、`models-store.json`、`path-scope.json`、`sandbox-bash.json`、`bash-guard.json`，由 `getAgentDir()` 派生的绝对路径，含其父目录同名文件） | **任何 cwd 下都内核拒绝**（即使 cwd 就在 `~/.pi` 内、目录级 deny 被豁免） |
| 写 `~/.pi/agent/extensions`（扩展源码） | **放行**（目录级 deny 之后重新放开，任何 cwd 下都可编辑扩展代码） |
| 写 `/dev/null`、`/dev/zero` | 放行（`file-write*`，覆盖 `>`、`>>`、`touch` 等变体，git 等工具依赖） |
| 读 / 执行 / 网络 | **完全放行** |
| 读 `denyRead` 配置的路径 | **内核拒绝**（data + metadata） |

内置 `read` / `grep` / `find` / `ls` 工具同样受本配置的 `denyRead` 限制（实现在 `path-scope` 扩展里，路径解析与内置工具的 `resolveToCwd` 一致后再 canonicalize；deny 优先于 cwd/extraRoots/会话批准；`grep`/`find` 的搜索根若包含 deny 根也会被拒，因为递归搜索会进入敏感根）。`write`/`edit` 不受 `denyRead` 限制，只受上面的敏感配置文件写保护限制。

## 设计取舍（重要）

**为什么只做写隔离，不碰读和网络？**

- **写是最高危害面**：`rm -rf /`、覆盖配置、越界写文件外泄数据——这些是 read/write 工具之外的破坏面，值得用内核硬拦。
- **读默认放行**：模型想读文件用 `read` 工具就行（path-scope 只弹窗、非硬拦），bash 里 `cat` 被拦挡不住它。但敏感目录（密钥、凭证）仍可用 `denyRead` **黑名单**精确拦截——这是可选的双保险。
- **网络不碰**：之前基于 `@anthropic-ai/sandbox-runtime` 的 `sandbox` 扩展（已删除）在 macOS 上失败，根因就是 SOCKS 代理式网络白名单导致 DNS/直连被挡。

需要更强管控（网络、进程、凭证、读）时，请用容器/VM（见 pi 的 `containerization.md`）。

## 配置

**`~/.pi/agent/sandbox-bash.json`**（可选，缺省即启用）

```json
{
  "enabled": true,
  "allowWrite": ["~/Downloads", "./build"],
  "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"]
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | `false` 完全禁用（回到普通 bash） |
| `allowWrite` | string[] | `[]` | 额外写授权根，绝对/`~`/相对（按会话 cwd 解析）路径。cwd、`/tmp`、`/private/tmp`、`os.tmpdir()` 恒定包含 |
| `denyRead` | string[] | `[]` | 禁止读的敏感路径（data + metadata），绝对/`~`/相对（按会话 cwd 解析）路径。读默认全放行，仅这些路径被内核拒绝。无法规范化的单条路径会被忽略。配置文件本身无效/不可读时，按未配置 denyRead 处理，并继续使用 path-scope 的 extraRoots 规则 |

写授权根的来源：**cwd + `/tmp` + `/private/tmp` + `os.tmpdir()` 恒定**，再叠加 `~/.pi/agent/path-scope.json` 的 `extraRoots` 和本配置的 `allowWrite`，但**自动过滤掉 `~/.pi`（含 `~/.pi/agent`）及其子路径**——这些目录存有 `auth.json`、`settings.json`、扩展自身代码，绝不能成为 bash 写授权根。被排除时会推一条 `info` 提醒（不是错误：例如 `extraRoots` 里写了 `~/.pi` 就是这个结果）。改任一配置后 `/reload` 重读。

> `extraRoots` **只读用户级** `~/.pi/agent/path-scope.json`，不读项目级 `.pi/path-scope.json`：一个仓库不应能自行拓宽内核写授权面。`path-scope`（文件工具弹窗）则会在项目受信任时叠加项目级配置——这是有意的不对称：前者只决定“问不问”，后者决定“能不能写”。

除过滤根列表外，profile 会在**所有 allow 子句之后**再为与项目无关的敏感目录补上 `(deny file-write* (subpath …))`，因此一个包含敏感目录的宽根（如 `~` 或 `/`）也不能写入 `~/.pi`。当 cwd 本身就在敏感目录下（例如就在 `~/.pi` 里跑 pi）时，敏感目录按位置分类而不是整体免 deny：cwd 子树内（含 cwd 本身）属于项目、保持可写；**严格包含 cwd** 的敏感目录不能 deny（会连项目一起拒），改为**丢弃所有覆盖它的宽根**（如 `~`、`/`），于是 cwd 子树之外的凭据（如 `agent/auth.json` 相对 cwd 在 `agent/sessions` 下时）依然够不到；与项目不相交的照常 deny。这与 bash-guard 的 cwd 优先豁免保持一致。

不论 cwd 如何分类，profile **始终**在末尾（所有 allow 与目录级 deny 之后）为敏感配置**文件**补 `(deny file-write* (subpath …))`（原始 + realpath 双变体）——所以「cwd 在 `~/.pi` 内时项目对 `~/.pi` 可写」不会连带解锁 `agent/auth.json` 之类的文件。同时 `~/.pi/agent/extensions` 在目录级 deny 之后重新放开，保证任何 cwd 下都能编辑扩展源码（注意：这使其他项目也能向扩展目录写入新代码，请按需取舍）。

## 环境要求

- macOS，且 `/usr/bin/sandbox-exec` 存在（系统自带）。
- 非 macOS 平台：扩展**静默不干预**，内置 bash 工具照常工作。

## 单元 / 集成测试

```bash
cd ~/.pi/agent/extensions/sandbox-bash
volta run node --test core.test.ts
```

纯函数测试（schema、path 转义/规范化、敏感根过滤（含真实符号链接与 `..` 绕行）、profile 生成、双变体）任何时候可跑；`sandbox-exec` 集成测试覆盖「cwd 内可写 / extraRoots 可写 / 相对根按 cwd 锚定 / `/dev/null` 可写（`>` 与 `>>`/`touch`）/ cwd 外写被拒 / 宽根下的敏感子目录仍被拒 / 读任意路径放行 / denyRead 被拒」。

集成测试在非 macOS **或已处于沙箱内**时自动跳过：嵌套 `sandbox_apply` 会被内核拒绝（`Operation not permitted`），例如在本扩展已生效的 pi 会话里跑测试——此时跳过信息会写明原因，应到普通终端里跑完整集成测试。

## 已知局限

1. **写隔离 + 读黑名单（denyRead）**，读默认放行、网络不碰。这是刻意的取舍，见「设计取舍」。
2. **目录符号链接（如 `/var`→`/private/var`）不解析**，故每个根同时列 raw + realpath 双变体；**文件符号链接会被解析**（写指向授权根外的符号链接被内核拒绝，已实测）。
3. **含 `..` 的根按内核语义解析**（`realpath(3)`，仅用 `realpathSync.native`；JS 实现会词法折叠，不可用/失败时 fail-closed，不做 JS 回退）：`a/link/../b` 不会在比对敏感目录前被词法折叠，以免“看似安全”的路径实际落在凭据目录。路径尚不存在时，解析**最近一个存在的祖先**再拼回缺失后缀（与 path-scope、bash-guard 同一契约）——纯词法回退会让 `link/newsub`（`link` → 敏感目录）在过滤时看似无害、写入时却落进敏感目录。祖先存在但不可解析（断链/不可读）则 fail-closed（该根被丢弃，即使它与敏感目录无关）。
4. **这是护栏，不是完整安全边界**：不可信/对抗性代码请用容器或 VM。