#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
启动门控回归守护：subagent 的初始 Task prompt 不得被抢先的 steer 挤掉。

## 守护的 bug

`subagent` 会 spawn `pi --mode json -p -e control-ext.js`，control-ext 在
`session_start` 就把 socket 打开；而 CLI 要等**所有**扩展的 `session_start`
处理完才提交初始 Task prompt（print 模式的 `prompt(initialMessage)`）。父代理
如果在这条缝里调用 `subagent_steer`，命令会在 `isStreaming === false` 时到达：
`deliverAs` 被忽略，steer 反而**自己启动了一轮**，随后 CLI 提交 Task 时抛
`Agent is already processing`，整个 run 在产出任何东西之前就 exit=1（实测
`turns=0`）。

失败现场（OLD control-ext）：
    [INPUT] {"t":"GATE-STEER","src":"extension","idle":true}      ← steer 抢跑
    [INPUT] {"t":"Task: Count slowly.","src":"interactive","idle":false}
    Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')...
    exit=1

修复：control-ext 把首个 `agent_start` 之前到达的命令缓冲起来，等任务回合
真正取得会话后再放行。放行后 steer 正常入队（`beh:"steer"`、`idle:false`），
不再抢跑。

## 为什么必须这样构造

窗口是**跨进程**的：父代理必须在子进程仍在加载扩展时抢进来。两个条件缺一不可，
否则窗口太窄、竞态不复现（早期版本因此误判为「已修复」）：

  1. 加载**完整**用户扩展集 —— 大量扩展的 `session_start` 会把窗口撑开。
     这正是线上条件（stitch-mcp 等做远程初始化）。
  2. steer 的发起方必须是**被发现式加载**的扩展（放在隔离 agent 目录的
     `extensions/` 下），而不是 `-e` 显式传入 —— 显式 `-e` 扩展排在发现式扩展
     之前，`session_start` 会干净地先跑完，窗口就没了。

在该条件下，OLD control-ext 稳定 exit=1、turns=0；修复后 exit=0、次序正确。

用法：
    python3 steer-startup-gate.py

退出码：0 = 通过；1 = 失败（说明启动门控被破坏，即线上那个 bug 回来了）。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# 直接加载生产文件：内联副本会漂移，而正是副本漂移让这个 bug 溜过了原 harness。
CONTROL_EXT = os.path.normpath(os.path.join(HERE, "..", "control-ext.js"))
USER_EXT_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "extensions")
STEER_TEXT = "GATE-STEER"

MOCK_PROVIDER_SOURCE = r"""
export default function (pi) {
  const port = process.env.MOCK_PORT;
  pi.on("input", (e, ctx) => {
    console.error("[INPUT] " + JSON.stringify({
      t: String(e.text).slice(0, 24), src: e.source,
      beh: e.streamingBehavior, idle: ctx.isIdle(),
    }));
  });
  pi.registerProvider("mock", {
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    apiKey: "dummy", api: "openai-completions",
    models: [{
      id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096,
    }],
  });
}
"""

# 在 session_start 内把 steer 写进 socket，从而确定性地落在「Task prompt 之前」
# 的窗口里；不断重试直到 control-ext 的 socket 接受为止。
PROVOKER_SOURCE = r"""
import * as net from "node:net";

export default function (pi) {
  const sock = process.env.SUBAGENT_CONTROL_SOCKET;
  const msg = process.env.GATE_STEER_TEXT;
  pi.on("session_start", async () => {
    if (!sock || !msg) return;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const s = net.connect(sock);
        let done = false;
        const fin = (v) => { if (!done) { done = true; resolve(v); } };
        s.on("connect", () => s.write(JSON.stringify({ type: "steer", message: msg }) + "\n", () => { s.end(); fin(true); }));
        s.on("error", () => { try { s.destroy(); } catch {} fin(false); });
        setTimeout(() => { try { s.destroy(); } catch {} fin(false); }, 300);
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
}
"""


class MockLLM:
    def __init__(self):
        self.requests = []

    def start(self):
        record = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except Exception:
                    payload = {}
                record.requests.append(payload.get("messages") or [])
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                for i in range(6):
                    try:
                        self.wfile.write(("data: %s\n\n" % json.dumps(
                            {"choices": [{"index": 0, "delta": {"content": "w%d " % (i + 1)}, "finish_reason": None}]})).encode())
                        self.wfile.flush()
                    except Exception:
                        return
                    time.sleep(0.05)
                try:
                    self.wfile.write(("data: %s\n\n" % json.dumps(
                        {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})).encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception:
                    pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        self.port = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()


def find_pi():
    return shutil.which("pi") or os.path.expanduser("~/.volta/bin/pi")


def main():
    if sys.platform == "win32":
        print("skip: AF_UNIX control channel is POSIX-only")
        return 0

    if not os.path.exists(CONTROL_EXT):
        print("FAIL: production control-ext.js not found: %s" % CONTROL_EXT)
        return 1
    if not os.path.isdir(USER_EXT_ROOT):
        print("FAIL: user extension root not found: %s" % USER_EXT_ROOT)
        return 1

    work = tempfile.mkdtemp(prefix="pi-steer-gate-")
    sock = os.path.join("/tmp", "pi-steer-gate-%d.sock" % os.getpid())
    try:
        os.unlink(sock)
    except OSError:
        pass

    mock = MockLLM()
    mock.start()
    events = []
    stderr_lines = []
    lock = threading.Lock()
    proc = None

    try:
        # 隔离 agent 目录：真实扩展集以发现式加载，provoker 也放进去。
        # 两者都是必需的 —— 见文件头「为什么必须这样构造」。
        agent_dir = os.path.join(work, "agent")
        ext_dir = os.path.join(agent_dir, "extensions")
        os.makedirs(ext_dir)
        for name in os.listdir(USER_EXT_ROOT):
            os.symlink(os.path.join(USER_EXT_ROOT, name), os.path.join(ext_dir, name))
        with open(os.path.join(ext_dir, "_gate_provoker.ts"), "w", encoding="utf-8") as f:
            f.write(PROVOKER_SOURCE)
        for extra in ("models.json", "settings.json"):
            src = os.path.join(os.path.dirname(USER_EXT_ROOT), extra)
            if os.path.exists(src):
                try:
                    shutil.copy2(src, os.path.join(agent_dir, extra))
                except Exception:
                    pass

        mock_provider = os.path.join(work, "mock-provider.ts")
        with open(mock_provider, "w", encoding="utf-8") as f:
            f.write(MOCK_PROVIDER_SOURCE)

        cmd = [
            find_pi(), "--mode", "json", "-p", "--no-session",
            "-e", CONTROL_EXT, "-e", mock_provider,
            "--provider", "mock", "--model", "mock-model",
            "Task: Count slowly.",
        ]
        env = os.environ.copy()
        env["SUBAGENT_CONTROL_SOCKET"] = sock
        env["GATE_STEER_TEXT"] = STEER_TEXT
        env["MOCK_PORT"] = str(mock.port)
        env["PI_CODING_AGENT_DIR"] = agent_dir

        proc = subprocess.Popen(
            cmd, cwd=work, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, bufsize=1,
        )

        def read_stdout():
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                with lock:
                    events.append(ev)

        def read_stderr():
            for line in proc.stderr:
                line = line.rstrip("\n")
                if line:
                    with lock:
                        stderr_lines.append(line)

        threading.Thread(target=read_stdout, daemon=True).start()
        threading.Thread(target=read_stderr, daemon=True).start()

        try:
            proc.wait(timeout=120)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)

        with lock:
            all_stderr, all_events = list(stderr_lines), list(events)

        user_msgs, assistant_turns = [], 0
        for ev in all_events:
            if ev.get("type") != "message_end":
                continue
            msg = ev.get("message") or {}
            content = msg.get("content") or []
            text = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
            if msg.get("role") == "user":
                user_msgs.append(text)
            elif msg.get("role") == "assistant":
                assistant_turns += 1

        checks = []
        rejected = [l for l in all_stderr if "already processing" in l]
        checks.append((
            "初始 Task prompt 未被抢跑（无 already processing）",
            not rejected,
            rejected[0][:140] if rejected else "",
        ))
        checks.append(("子进程正常退出", proc.returncode == 0, "exit=%s" % proc.returncode))
        checks.append((
            "原始 Task 进入事件流",
            any("Task: Count slowly." in t for t in user_msgs),
            "user messages=%d" % len(user_msgs),
        ))
        checks.append((
            "抢先的 steer 未被丢弃（缓冲后在 agent_start 放行）",
            any(STEER_TEXT in t for t in user_msgs),
            json.dumps([t[:30] for t in user_msgs], ensure_ascii=False),
        ))
        checks.append(("子代理产出 assistant 回合", assistant_turns >= 1, "turns=%d" % assistant_turns))
        checks.append((
            "抢先的 steer 进入 LLM 上下文",
            any(STEER_TEXT in json.dumps(msgs, ensure_ascii=False) for msgs in mock.requests),
            "LLM 请求数=%d" % len(mock.requests),
        ))

        print("启动门控：session_start 内 steer（完整扩展集 + 发现式加载）")
        print("生产 control-ext: %s" % CONTROL_EXT)
        print("-" * 66)
        failed = 0
        for name, ok, extra in checks:
            print("  %s  %s%s" % ("ok  " if ok else "FAIL", name, ("   (%s)" % extra) if extra else ""))
            if not ok:
                failed += 1
        print("-" * 66)
        if failed:
            print("结果: FAIL（%d 项未通过）" % failed)
            print("启动门控被破坏 —— control-ext 在首个 agent_start 之前放行了 steer，")
            print("会抢跑 CLI 的初始 Task prompt 并让整个 run 在产出前 exit=1。")
        else:
            print("结果: PASS（%d/%d 项通过）" % (len(checks), len(checks)))
        return 1 if failed else 0
    finally:
        try:
            os.unlink(sock)
        except OSError:
            pass
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
