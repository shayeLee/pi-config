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

写授权根 = **cwd（项目目录） + `path-scope.json` 的 `extraRoots` + `/tmp` + `/private/tmp` + `os.tmpdir()`**（自动包含）。

| 操作 | 结果 |
|------|------|
| 写授权根内 | 放行 |
| 写授权根外任何路径 | **内核拒绝** |
| 写 `/dev/null`、`/dev/zero` | 放行（git 等工具依赖，devfs 节点用 `literal` 放行） |
| 读 / 执行 / 网络 | **完全放行** |

## 设计取舍（重要）

**为什么只做写隔离，不碰读和网络？**

- **写是最高危害面**：`rm -rf /`、覆盖配置、越界写文件外泄数据——这些是 read/write 工具之外的破坏面，值得用内核硬拦。
- **读隔离性价比低**：模型想读文件，用 `read` 工具就行（path-scope 只弹窗、非硬拦），bash 里 `cat` 被拦挡不住它。强行读隔离反而会让 git（读 `~/.gitconfig`）、node（读家目录 metadata）等大量工具崩。
- **网络不碰**：之前基于 `@anthropic-ai/sandbox-runtime` 的 `sandbox` 扩展（已删除）在 macOS 上失败，根因就是 SOCKS 代理式网络白名单导致 DNS/直连被挡。

需要更强管控（网络、进程、凭证、读）时，请用容器/VM（见 pi 的 `containerization.md`）。

## 配置

**`~/.pi/agent/sandbox-bash.json`**（可选，缺省即启用）

```json
{
  "enabled": true,
  "allowWrite": ["~/Downloads"]
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | `true` | `false` 完全禁用（回到普通 bash） |
| `allowWrite` | string[] | `[]` | 额外写授权根，绝对/`~` 路径。cwd、`/tmp`、`/private/tmp`、`os.tmpdir()` 恒定包含 |

写授权根的来源：**cwd + `/tmp` + `/private/tmp` + `os.tmpdir()` 恒定**，再叠加 `path-scope.json` 的 `extraRoots` 和本配置的 `allowWrite`。改任一配置后 `/reload` 重读。

## 环境要求

- macOS，且 `/usr/bin/sandbox-exec` 存在（系统自带）。
- 非 macOS 平台：扩展**静默不干预**，内置 bash 工具照常工作。

## volta 工具链

`shellCommandPrefix`（`~/.pi/agent/settings.json`）会在沙箱前被前置进命令，因此 `node`/`yarn` 的 volta 包装在沙箱内仍生效。

## 单元 / 集成测试

```bash
cd ~/.pi/agent/extensions/sandbox-bash
volta run node --test core.test.ts
```

纯函数测试（schema、path 转义/规范化、profile 生成）任何时候可跑；4 个 `sandbox-exec` 集成测试在非 macOS 自动跳过，覆盖「cwd 内可写 / `/dev/null` 可写 / cwd 外写被拒 / 读任意路径放行」。

## 已知局限

1. **只限写，不限读/网络**。这是刻意的取舍，见「设计取舍」。
2. **写授权根是路径前缀匹配**（Seatbelt `subpath`），对符号链接不解析；已列 `/tmp`、`/private/tmp`、`os.tmpdir()` 三个临时目录别名。
3. **这是护栏，不是完整安全边界**：不可信/对抗性代码请用容器或 VM。