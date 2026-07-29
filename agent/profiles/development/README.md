# Pi 配置组使用说明

这里保存可复用的 Pi 领域配置。当前配置根目录为 `~/.pi/agent/profiles/development/`，与本地维护的 `development-team` 扩展同属 `~/.pi/agent/`；领域角色不会作为全局 Pi 角色加载，也不会被其它领域复用。

## 组成

```text
profiles/<配置名>/
├── APPEND_SYSTEM.md  # 根提示词，追加到 Pi 默认系统提示词
└── agents/
    └── <领域子角色>.md
```

全局的 `~/.pi/agent/extensions/development-team/` 只保存本地维护的官方 `subagent` 扩展；它提供 `subagent` 工具，不包含任何领域的业务提示词。

## 在项目中启用

在目标项目根目录执行一次。将 `profile_name` 设为配置名；开始前确认项目中没有同名的 `.pi/APPEND_SYSTEM.md` 或 `.pi/agents`，以免覆盖该项目已有 Pi 配置。

```sh
profile_name=development
profile_dir="/Users/mz/.pi/agent/profiles/$profile_name"
mkdir -p .pi
ln -s "$profile_dir/APPEND_SYSTEM.md" .pi/APPEND_SYSTEM.md
ln -s "$profile_dir/agents" .pi/agents
```

当前可用的配置名是 `development`；新增配置后只需把 `profile_name` 改为新配置名。

## 启动

启用后仍按 Pi 的正常方式在项目根目录启动：

```sh
pi
```

首次启动时，Pi 会要求信任这个项目，因为它包含项目级 `.pi` 资源。仅在你信任项目中确认；信任后重启 Pi 即可加载配置。

`development-team` 扩展默认使用 `agentScope: "project"`。因此子角色只从当前项目的 `.pi/agents` 发现，不会错误复用其它领域的角色。

## 停用

在项目根目录移除这两个链接即可停用当前配置：

```sh
unlink .pi/APPEND_SYSTEM.md
unlink .pi/agents
```

重启 Pi 后生效。

## 当前配置

`development` 是当前提供的软件开发配置，包含下列角色与模型：

| 角色 | 用途 | 模型 |
| --- | --- | --- |
| `coder` | 调查、实现、调试与验证 | `openai-codex/gpt-5.6-terra` |
| `lite` | 明确、局部、低风险改动 | `openai-codex/gpt-5.4-mini` |
| `reviewer` | 只读代码审查 | `openai-codex/gpt-5.6-sol` |
| `rescue` | 反复失败后的只读诊断 | `openai-codex/gpt-5.6-sol` |

删除该角色 frontmatter 中的 `model:` 行，可继承当前 Pi 会话模型。

## 添加领域配置

新领域创建独立目录：

```text
profiles/<配置名>/APPEND_SYSTEM.md
profiles/<配置名>/agents/
```

为它编写根提示词和领域角色，再按“在项目中启用”的方式链接到对应项目。一个项目只启用一套完整根配置；只共享 `subagent` 扩展及真正跨领域的基础约束，不共享领域角色提示词。
