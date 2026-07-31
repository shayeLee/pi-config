# Pi 默认代理团队

`project` 是当前全局启用的通用项目代理团队，源文件位于：

```text
~/.pi/agent/profiles/project/
├── APPEND_SYSTEM.md
├── agents/
└── reviews/
```

全局入口通过符号链接指向这套 Profile：

```text
~/.pi/agent/APPEND_SYSTEM.md -> profiles/project/APPEND_SYSTEM.md
~/.pi/agent/agents           -> profiles/project/agents
```

`APPEND_SYSTEM.md` 会追加到 Pi 默认系统提示词，使根代理默认采用 Architect 工作方式。全局的 `~/.pi/agent/extensions/agent-team/` 提供 `subagent` 工具，不包含具体角色提示词。

## 角色发现

`agent-team` 默认使用 `agentScope: "both"`：

- 从 `~/.pi/agent/agents` 加载全局默认角色。
- 从当前工作目录向上查找最近的项目级 `.pi/agents`。
- 同名角色由项目级配置覆盖全局角色。

调用 `subagent` 时可显式传入 `agentScope: "user"` 或 `agentScope: "project"`，只使用对应范围。

## 当前角色

| 角色 | 用途 | 模型 |
| --- | --- | --- |
| `worker` | 调查、复杂执行与验证 | `openai-codex/gpt-5.6-luna` |
| `lite` | 明确、局部、可逆、低风险执行 | `openai-codex/gpt-5.6-luna` |
| `reviewer` | 只读审查 | `openai-codex/gpt-5.6-sol` |
| `rescue` | 反复失败后的只读诊断 | `openai-codex/gpt-5.6-sol` |

删除某个角色 frontmatter 中的 `model:` 行，可继承当前 Pi 会话模型。

## 生效与维护

在任意目录正常启动 Pi 即可使用这套团队：

```sh
pi
```

修改 Profile 后，新任务会直接加载最新内容；已有任务使用 `/reload` 或重启 Pi。

运行提示词与对应的 `reviews/*-bilingual-review.md` 应保持同步。全局入口是符号链接，因此维护时只编辑 `profiles/project/` 下的源文件。

## 暂时停用

移除全局链接即可停用默认团队，不会删除 Profile 源文件：

```sh
unlink ~/.pi/agent/APPEND_SYSTEM.md
unlink ~/.pi/agent/agents
```

重新创建上述链接即可恢复。
