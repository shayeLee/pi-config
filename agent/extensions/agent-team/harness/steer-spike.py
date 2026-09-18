#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
JSON 模式 + socket 侧信道 steer 可行性验证（agent-team 评估用）

验证目标（全部在 `--mode json` 下，即现有一次性子进程路径）：

  1. ctx.hasUI === false              → 不踩 RPC 模式的 beforeExit 静默退出坑
  2. 子进程内的扩展可以开 Unix socket 侧信道
  3. pi.sendUserMessage(msg, {deliverAs:"steer"}) 在异步回调中可用（不抛 stale）
  4. steer 消息作为 user message 进入事件流，且排在当前 assistant 回合之后
  5. steer 消息真的进入下一轮 LLM 请求上下文（mock server 端可见）
  6. 产生第二轮 assistant 回复

默认 mock 模式：本地起一个假的 OpenAI 兼容 SSE 服务，不需要真实模型或凭证，
结果确定、可重复。加 --real 则用你本机凭证打真实模型。

用法：
    python3 steer-spike.py                                  # mock 模式（推荐先跑）
    python3 steer-spike.py --real                           # 真实模型（用 PI_PROVIDER/PI_MODEL）
    python3 steer-spike.py --real --provider X --model Y
    python3 steer-spike.py --keep                           # 保留临时目录便于排查

退出码：0 = 全部断言通过；1 = 有断言失败。
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# 注入到子进程的「控制扩展」：开一个 Unix socket，收到命令后 steer 当前会话。
# 纯 JS 语法（无类型注解），.ts 后缀仅为让 pi 的加载器按 TS 处理。
# ---------------------------------------------------------------------------
CONTROL_EXT_SOURCE = r"""
import * as net from "node:net";

export default function (pi) {
  const sockPath = process.env.SUBAGENT_CONTROL_SOCKET;
  let server = null;

  // 关键：net.Server 会让 Node 事件循环常驻。若不释放，agent 结束后子进程
  // 永不退出，父进程 await 子进程退出的逻辑会永久挂起。必须在 agent_settled
  // 时关闭监听。
  pi.on("agent_settled", () => {
    if (server) {
      server.close();
      console.error("[ctl] server closed on agent_settled");
    }
  });

  pi.on("session_start", async (_e, ctx) => {
    console.error("[ctl] session_start mode=" + ctx.mode + " hasUI=" + ctx.hasUI);
    if (!sockPath) {
      console.error("[ctl] no SUBAGENT_CONTROL_SOCKET, control channel disabled");
      return;
    }
    server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let cmd;
          try { cmd = JSON.parse(line); } catch { continue; }
          const deliverAs = cmd.type === "followUp" ? "followUp" : "steer";
          try {
            pi.sendUserMessage(cmd.message, { deliverAs });
            console.error("[ctl] accepted: " + cmd.type);
          } catch (err) {
            console.error("[ctl] FAILED: " + String(err).slice(0, 160));
          }
        }
      });
    });
    server.on("error", (err) => console.error("[ctl] server error " + String(err)));
    server.listen(sockPath, () => console.error("[ctl] listening on " + sockPath));
  });
}
"""

# ---------------------------------------------------------------------------
# mock 模式用的 provider 注册扩展。端口由 MOCK_PORT 环境变量传入。
# ---------------------------------------------------------------------------
MOCK_PROVIDER_SOURCE = r"""
export default function (pi) {
  const port = process.env.MOCK_PORT;
  pi.registerProvider("mock", {
    baseUrl: "http://127.0.0.1:" + port + "/v1",
    apiKey: "dummy",
    api: "openai-completions",
    models: [{
      id: "mock-model",
      name: "Mock Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
  });
}
"""

STEER_TEXT = "STOP counting. Reply with exactly: PINEAPPLE"


# ---------------------------------------------------------------------------
# 断言收集
# ---------------------------------------------------------------------------
class Report:
    def __init__(self):
        self.results = []

    def check(self, name, ok, extra=""):
        self.results.append((name, bool(ok), extra))
        mark = "ok  " if ok else "FAIL"
        line = "  %s  %s" % (mark, name)
        if extra:
            line += "   (%s)" % extra
        print(line, flush=True)

    @property
    def failed(self):
        return [r for r in self.results if not r[1]]


# ---------------------------------------------------------------------------
# Mock LLM 服务：OpenAI 兼容 SSE，慢速流式，便于在流式中途 steer。
# ---------------------------------------------------------------------------
class MockLLM:
    def __init__(self):
        self.requests = []  # 每次请求的 messages 摘要
        self.lock = threading.Lock()
        self._server = None
        self.port = None

    def start(self):
        record = self

        class Handler(BaseHTTPRequestHandler):
            # HTTP/1.0：响应结束后关闭连接，客户端无需 Content-Length 或
            # chunked 编码即可逐块读取 SSE。用 1.1 时 BaseHTTPRequestHandler
            # 不带这两个头，客户端会一直等待而收不到流。
            protocol_version = "HTTP/1.0"

            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b""
                if "/chat/completions" not in self.path:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except Exception:
                    payload = {}
                messages = payload.get("messages") or []
                with record.lock:
                    record.requests.append(messages)

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()

                # 慢速吐 40 个词，约 8 秒，留出 steer 窗口。
                for i in range(40):
                    chunk = {
                        "choices": [
                            {"index": 0, "delta": {"content": "w%d " % (i + 1)}, "finish_reason": None}
                        ]
                    }
                    self.wfile.write(("data: %s\n\n" % json.dumps(chunk)).encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(0.2)
                stop = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
                self.wfile.write(("data: %s\n\n" % json.dumps(stop)).encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    @staticmethod
    def _flatten(messages):
        out = []
        for m in messages:
            content = m.get("content")
            if isinstance(content, list):
                content = " ".join(
                    p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
                )
            out.append((m.get("role"), str(content or "")))
        return out


# ---------------------------------------------------------------------------
# 主体
# ---------------------------------------------------------------------------
def find_pi():
    pi = shutil.which("pi")
    if not pi:
        print("找不到 pi 可执行文件，请确认 PATH。", file=sys.stderr)
        sys.exit(2)
    return pi


def run(args):
    report = Report()
    work = tempfile.mkdtemp(prefix="pi-steer-spike-")
    # 短的 socket 路径（macOS AF_UNIX 路径上限约 104 字节）
    sock_path = os.path.join("/tmp", "pi-steer-%d.sock" % os.getpid())
    for p in (sock_path,):
        try:
            os.unlink(p)
        except OSError:
            pass

    mock = None
    proc = None
    events = []
    stderr_lines = []
    lock = threading.Lock()

    try:
        # ---- 写扩展文件 -------------------------------------------------
        control_ext = os.path.join(work, "control-ext.ts")
        with open(control_ext, "w", encoding="utf-8") as f:
            f.write(CONTROL_EXT_SOURCE)

        cmd = [
            find_pi(),
            "--mode", "json",
            "-p",
            "--no-session",
            "--no-extensions",
            "-e", control_ext,
        ]

        env = os.environ.copy()
        env["SUBAGENT_CONTROL_SOCKET"] = sock_path

        if args.real:
            provider = args.provider or env.get("PI_PROVIDER")
            model = args.model or env.get("PI_MODEL")
            if provider:
                cmd += ["--provider", provider]
            if model:
                cmd += ["--model", model]
            task = args.task or "Count slowly from 1 to 400, one number per line, nothing else."
            print("模式: 真实模型 (%s/%s)" % (provider or "?", model or "?"))
        else:
            mock = MockLLM()
            mock.start()
            mock_provider = os.path.join(work, "mock-provider.ts")
            with open(mock_provider, "w", encoding="utf-8") as f:
                f.write(MOCK_PROVIDER_SOURCE)
            cmd += ["-e", mock_provider, "--provider", "mock", "--model", "mock-model"]
            env["MOCK_PORT"] = str(mock.port)
            # mock 模式不依赖真实凭证；用临时 agent dir，避免污染 ~/.pi/agent
            agent_dir = os.path.join(work, "agent-dir")
            os.makedirs(agent_dir, exist_ok=True)
            env["PI_CODING_AGENT_DIR"] = agent_dir
            task = args.task or "Count slowly."
            print("模式: mock（本地假模型，端口 %d）" % mock.port)

        cmd.append("Task: " + task)

        print("临时目录: %s" % work)
        print("socket:   %s" % sock_path)
        print("-" * 68)

        # ---- 启动子进程 -------------------------------------------------
        t0 = time.time()

        def ts():
            return "%6dms" % int((time.time() - t0) * 1000)

        proc = subprocess.Popen(
            cmd,
            cwd=work,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )

        first_assistant_start = threading.Event()
        assistant_ends = []

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
                etype = ev.get("type")
                if etype == "message_start":
                    msg = ev.get("message") or {}
                    if msg.get("role") == "assistant":
                        first_assistant_start.set()
                elif etype == "message_end":
                    msg = ev.get("message") or {}
                    role = msg.get("role")
                    content = msg.get("content") or []
                    text = "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
                    if role == "user":
                        print("%s  USER      %s" % (ts(), json.dumps(text[:70])))
                    elif role == "assistant":
                        assistant_ends.append(text)
                        print(
                            "%s  ASSISTANT stop=%s len=%d %s"
                            % (ts(), msg.get("stopReason"), len(text), json.dumps(text[:50]))
                        )

        def read_stderr():
            for line in proc.stderr:
                line = line.rstrip("\n")
                if not line:
                    continue
                with lock:
                    stderr_lines.append(line)
                if line.startswith("[ctl]"):
                    print("%s  %s" % (ts(), line))

        th_out = threading.Thread(target=read_stdout, daemon=True)
        th_err = threading.Thread(target=read_stderr, daemon=True)
        th_out.start()
        th_err.start()

        # ---- 等待流式开始，然后在流式中途 steer -------------------------
        started = first_assistant_start.wait(timeout=args.timeout)
        report.check("第一轮 assistant 流式已开始", started)

        steer_sent_at = None
        if started:
            time.sleep(args.steer_delay)
            print("%s  >> 通过 socket 发送 steer" % ts())
            steer_sent_at = time.time()
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(5)
                s.connect(sock_path)
                s.sendall((json.dumps({"type": "steer", "message": STEER_TEXT}) + "\n").encode("utf-8"))
                time.sleep(0.3)
                s.close()
                report.check("socket 连接并写入成功", True)
            except Exception as exc:
                report.check("socket 连接并写入成功", False, repr(exc)[:120])

        # ---- 等待子进程结束（或超时） -----------------------------------
        try:
            proc.wait(timeout=args.timeout)
            report.check("子进程正常退出", proc.returncode == 0, "exit=%s" % proc.returncode)
        except subprocess.TimeoutExpired:
            report.check("子进程正常退出", False, "超时，强制终止")
            proc.kill()
            proc.wait(timeout=10)
        th_out.join(timeout=5)
        th_err.join(timeout=5)

        # ---- 断言 -------------------------------------------------------
        print("-" * 68)
        print("断言：")

        with lock:
            all_stderr = list(stderr_lines)
            all_events = list(events)

        # 1. hasUI=false
        ctl_start = [l for l in all_stderr if "session_start" in l and "hasUI=" in l]
        if ctl_start:
            has_ui_false = any("hasUI=false" in l for l in ctl_start)
            report.check("JSON 模式下 ctx.hasUI === false", has_ui_false, ctl_start[0].split("[ctl] ")[-1])
        else:
            report.check("JSON 模式下 ctx.hasUI === false", False, "未捕获到 [ctl] session_start 日志")

        # 2. socket 监听
        report.check(
            "控制扩展成功监听 socket",
            any("listening on" in l for l in all_stderr),
            "",
        )

        # 3. steer 被接受（无 stale）
        accepted = any("accepted: steer" in l for l in all_stderr)
        failed = [l for l in all_stderr if "FAILED:" in l]
        report.check("pi.sendUserMessage(steer) 被接受", accepted, failed[0][:140] if failed else "")

        # 4. steer 文本作为 user message 进入事件流
        user_msgs = []
        for ev in all_events:
            if ev.get("type") == "message_end":
                msg = ev.get("message") or {}
                if msg.get("role") == "user":
                    content = msg.get("content") or []
                    text = "".join(
                        p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
                    )
                    user_msgs.append(text)
        steer_in_stream = any(STEER_TEXT in t for t in user_msgs)
        report.check("steer 文本作为 user message 进入事件流", steer_in_stream, "user messages=%d" % len(user_msgs))

        # 5. steer 消息排在第一轮 assistant 完成之后（真正"运行中"注入）
        order_ok = False
        if steer_in_stream:
            idx_steer = next(i for i, t in enumerate(user_msgs) if STEER_TEXT in t)
            # 第一个 Task 之后才可能出现 steer；且 steer 之前应已有 assistant 产出
            order_ok = idx_steer >= 1 and len(assistant_ends) >= 2
        report.check(
            "steer 在运行中注入（assistant 回合之后，并触发新回合）",
            order_ok,
            "assistant 回合数=%d" % len(assistant_ends),
        )

        # 6. steer 真的进入下一轮 LLM 请求上下文
        if mock is not None:
            with mock.lock:
                reqs = list(mock.requests)
            llm_saw_steer = False
            for msgs in reqs:
                flat = MockLLM._flatten(msgs)
                if any(role == "user" and STEER_TEXT in text for role, text in flat):
                    llm_saw_steer = True
                    break
            report.check(
                "steer 进入下一轮 LLM 请求上下文（mock server 可见）",
                llm_saw_steer,
                "LLM 请求数=%d" % len(reqs),
            )
            if reqs:
                print("")
                print("  最后一次 LLM 请求的 messages：")
                for role, text in MockLLM._flatten(reqs[-1]):
                    print("    %-10s %s" % (role, text[:88]))
        else:
            report.check(
                "steer 进入下一轮 LLM 请求上下文",
                len(assistant_ends) >= 2,
                "真实模型模式：以「出现第二轮 assistant 回复」间接判定",
            )

        # 7. 第二轮 assistant 回复
        report.check("产生第二轮 assistant 回复", len(assistant_ends) >= 2, "回合数=%d" % len(assistant_ends))

        # ---- 汇总 -------------------------------------------------------
        print("-" * 68)
        if report.failed:
            print("结果: FAIL（%d/%d 项失败）" % (len(report.failed), len(report.results)))
            for name, _, extra in report.failed:
                print("  - %s %s" % (name, ("(%s)" % extra) if extra else ""))
            return 1
        print("结果: PASS（%d/%d 项通过）" % (len(report.results), len(report.results)))
        print("")
        print("结论：--mode json 下 socket 侧信道 steer 可用，无需切换到 RPC 模式。")
        return 0

    finally:
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        if mock:
            mock.stop()
        try:
            os.unlink(sock_path)
        except OSError:
            pass
        if args.keep:
            print("保留临时目录: %s" % work)
        else:
            shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(
        description="验证 JSON 模式子进程能否被运行中 steer（agent-team 评估用）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--real", action="store_true", help="使用真实模型（默认用本地 mock 模型）")
    parser.add_argument("--provider", help="真实模式下的 provider（默认取 $PI_PROVIDER）")
    parser.add_argument("--model", help="真实模式下的 model（默认取 $PI_MODEL）")
    parser.add_argument("--timeout", type=float, default=90.0, help="总超时秒数（默认 90）")
    parser.add_argument(
        "--steer-delay",
        type=float,
        default=1.5,
        help="检测到流式开始后等待多少秒再发 steer（默认 1.5）",
    )
    parser.add_argument("--keep", action="store_true", help="保留临时目录便于排查")
    parser.add_argument(
        "--task",
        help="自定义子代理任务（默认：慢速数数，便于在流式中途 steer）。"
        "若模型太快答完导致 steer 来不及注入，可换一个更长的任务。",
    )
    args = parser.parse_args()

    if sys.platform == "win32":
        print("注意：本脚本用 Unix domain socket，Windows 需改为 named pipe 或 TCP localhost。", file=sys.stderr)

    return run(args)


if __name__ == "__main__":
    sys.exit(main())
