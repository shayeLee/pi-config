
Agent Delegation
Do the work yourself by default. A subagent starts cold: it re-reads context you already have, and its work is harder for the user to follow. Delegate via `subagent` only when:
- the user asks for it or names an agent;
- independent pieces are large enough that running them in parallel saves real time, and none needs another's result;
- a broad search or long investigation would flood your context and you only need its conclusion.
Size, multiple angles, or a request to be thorough are not by themselves reasons to delegate.
For agent discovery, call `subagent` with `{"list": true, "agentScope": "both"}` and treat its returned list as authoritative; listing does not start any agent. Do not infer availability by scanning only Markdown directories. Pi agents load from `~/.pi/agent/agents` and the nearest project `.pi/agents`; project-level Pi agents override same-named user-level Pi agents in `both` scope.
`subagent` returns one `runId` per subagent and does not include the subagent's output. Collect results with `subagent_wait`: with no arguments it waits for every outstanding run, including all tasks of a parallel call, and explicit runIds wait for specific runs.
`subagent_wait` blocks until those runs settle (or `timeoutMs` elapses), so it is the wrong tool for a quick look. Use `subagent_status` for a run's status and `subagent_logs` for what it has produced so far; both return immediately.

- `worker`: the general-purpose execution subagent. Give it a clear objective and scope.

The root Agent reviews delegation results and verification evidence before making the final judgment.

- Start independent, non-conflicting work in parallel. Sequence work that may interfere or depends on earlier results: collect the previous result before starting the next subagent.
- Supervise long or risky runs instead of blocking on them: `subagent_status` for progress, `subagent_logs` for the transcript so far, and `subagent_stop` to terminate one that is no longer needed. `subagent_steer` can redirect a running subagent that has an available control channel; if a steer fails because the run has no channel or has already ended, stop it if needed and delegate a new task with the revised instructions. Status, logs, steer, and stop return immediately; call `subagent_wait` only when you actually need a result before you can continue.
- Each task of a parallel call is a separate run with its own runId, so tasks can be supervised or stopped individually.

Typical flow: start one or more subagents, keep working or start more, check on them with `subagent_status` / `subagent_logs` while they run, then `subagent_wait` to collect the results you depend on before forming your conclusion.

Repository Search
Use `rg` (ripgrep) as the primary repository search tool.

- Use `rg` for recursive content search. Do not use `grep -r` or `grep -R` when `rg` is available.
- Use `rg --files` for repository file enumeration and prefer it over `find` for ordinary source-tree discovery.
- For filename filtering, prefer `rg --files | rg '<pattern>'` when appropriate.
- Scope searches to likely directories, file types, filenames, or symbols whenever possible.
- Prefer one targeted `rg` query over broad repository-wide scans followed by shell filtering.
- Respect `.gitignore` and other ignore rules by default. Search ignored or hidden content only when the task requires it.
- Use `rg -uu` only when there is a concrete reason to include ignored and hidden files.
- Avoid repeated full-tree scans for closely related queries.
- `grep` is allowed, but it is not the default search tool. Use it only when `rg` is unavailable or when `grep` provides semantics specifically needed by the task.
- `find` and equivalent tools are also allowed when their specific behavior is required, but should not be the default for ordinary repository discovery.

Node Toolchain Commands
Prefix each top-level Node toolchain command (`node`, `npm`, `npx`, `yarn`, `yarnpkg`, `pnpm`, or `pnpx`) with `volta run`, for example, `volta run yarn test:unit`.
Do not repeat the prefix for commands invoked within scripts, such as `vue-cli-service`, `cross-env`, or `patch-package`.
In command chains, prefix each top-level command: `volta run yarn build && volta run yarn lint`.

Always respond in Chinese unless the user explicitly requests another language.
