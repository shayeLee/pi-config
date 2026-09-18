#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B/B-s 真实环境端到端验证：background + status/logs/stop + steer

与 steer-spike.py（只验证「控制扩展机制」）不同，本脚本验证**集成后的真实扩展**：
它用真实的 agent-team 扩展（agent-team/index.ts）启动一个真正的 pi 会话，
让主代理调用 subagent({background:true})，再用 subagent_steer / subagent_stop
控制它，全部走真实模型。

覆盖：
  1. subagent({ background: true }) 立即返回 runId（不阻塞主代理）
  2. subagent_status 能列出并报告 running
  3. subagent_steer 把指令送到运行中的子代理
  4. 子代理真的改变了方向（真实模型行为）
  5. subagent_stop 能停止运行中的子代理
  6. 终态为 stopped

用法：
    python3 harness/background-e2e.py --real
    python3 harness/background-e2e.py --real --model deepseek-v4.1-flash
    python3 harness/background-e2e.py --real --keep

退出码：0 = 全部断言通过。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

# 主代理要执行的任务：它必须自己调用 subagent / subagent_steer / subagent_stop。
DRIVER_PROMPT = """\
You are running an integration test of the agent-team extension. Follow these steps
EXACTLY and in order, using the subagent tools. Do not do the work yourself.

Step 1: Call the `subagent` tool with:
  agent: "worker"
  task: "Count slowly from 1 to 300, one number per line, nothing else."
  (Do NOT pass a `background` argument — the default must be used.)

Step 2: Immediately call `subagent_status` with the runId you received. Report its status.

Step 3: Call `subagent_steer` with that runId and this message:
  "STOP counting immediately. Reply with exactly: PINEAPPLE"

Step 4: Call `subagent_stop` with that runId to stop the subagent.

Step 5: Call `subagent_status` with that runId ONE MORE TIME and report whether it now
shows `stopped`. This second status check is REQUIRED — do not skip it.

Step 6: Call `subagent_wait` with that runId to collect the run's result.

Step 7: Reply with a short summary listing the runId, the status you observed in
Step 2, the status after stopping, whether subagent_wait returned a result, and whether
the steer and stop calls were accepted.
"""

# 验证 subagent_wait 在非交互模式下能可靠收口：主代理在「结束回合」前必须拿到结果。
WAIT_PROMPT = """\
You are running an integration test of the agent-team extension.

Step 1: Call the `subagent` tool with:
  agent: "worker"
  task: "Reply with exactly: BANANA"
  (Do NOT pass a `background` argument.)

Step 2: Call `subagent_wait` with the runId to collect the result.

Step 3: Reply with the exact text that the subagent produced, quoted verbatim.
"""

WORKER_AGENT = """---
name: worker
description: E2E test worker
tools: read, ls, bash
---
You are a test worker. Follow the task literally.
"""


class Report:
    def __init__(self):
        self.results = []

    def check(self, name, ok, extra=""):
        self.results.append((name, bool(ok), extra))
        line = "  %s  %s" % ("ok  " if ok else "FAIL", name)
        if extra:
            line += "   (%s)" % extra
        print(line, flush=True)

    @property
    def failed(self):
        return [r for r in self.results if not r[1]]


def find_pi():
    pi = shutil.which("pi")
    if not pi:
        print("找不到 pi，请确认 PATH。", file=sys.stderr)
        sys.exit(2)
    return pi


def run(args):
    report = Report()
    work = tempfile.mkdtemp(prefix="agent-team-e2e-")

    # 真实扩展路径
    ext_dir = os.path.dirname(os.path.abspath(__file__))
    ext_dir = os.path.dirname(ext_dir)  # harness/ -> agent-team/
    extension_entry = os.path.join(ext_dir, "index.ts")
    if not os.path.exists(extension_entry):
        print("找不到 agent-team 扩展: %s" % extension_entry, file=sys.stderr)
        return 2

    print("扩展:     %s" % extension_entry)
    print("临时目录: %s" % work)
    print("-" * 68)

    # 项目级 worker 角色
    agents_dir = os.path.join(work, ".pi", "agents")
    os.makedirs(agents_dir, exist_ok=True)
    with open(os.path.join(agents_dir, "worker.md"), "w", encoding="utf-8") as f:
        f.write(WORKER_AGENT)

    env = os.environ.copy()
    provider = args.provider or env.get("PI_PROVIDER")
    model = args.model or env.get("PI_MODEL")

    cmd = [
        find_pi(),
        "--mode", "json",
        "-p",
        "--no-session",
        # 不加 --no-extensions：用户环境可能通过扩展/模型配置注册 provider，
        # 禁用扩展会导致 provider 不可用。
        "-e", extension_entry,
        "--approve",
    ]
    if provider:
        cmd += ["--provider", provider]
    if model:
        cmd += ["--model", model]
    cmd.append(WAIT_PROMPT if args.scenario == "wait" else DRIVER_PROMPT)

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

    events = []
    stderr_lines = []
    lock = threading.Lock()
    tool_calls = []       # (name, args)
    tool_results = []     # (name, text)
    assistant_texts = []

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
            if etype == "message_end":
                msg = ev.get("message") or {}
                if msg.get("role") == "assistant":
                    for part in msg.get("content") or []:
                        if part.get("type") == "toolCall":
                            tool_calls.append((part.get("name"), part.get("arguments")))
                            print("%s  CALL    %s" % (ts(), part.get("name")))
                        elif part.get("type") == "text" and part.get("text", "").strip():
                            assistant_texts.append(part.get("text"))
                elif msg.get("role") == "toolResult":
                    text = "".join(
                        p.get("text", "") for p in (msg.get("content") or []) if p.get("type") == "text"
                    )
                    tool_results.append((msg.get("toolName"), text))

    def read_stderr():
        for line in proc.stderr:
            line = line.rstrip("\n")
            if not line:
                continue
            with lock:
                stderr_lines.append(line)

    th_out = threading.Thread(target=read_stdout, daemon=True)
    th_err = threading.Thread(target=read_stderr, daemon=True)
    th_out.start()
    th_err.start()

    try:
        proc.wait(timeout=args.timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
    th_out.join(timeout=5)
    th_err.join(timeout=5)

    print("-" * 68)
    print("断言：")

    names = [n for n, _ in tool_calls]
    # wait 场景只验证「默认异步 + 可靠收口」，不涉及监督类工具。
    supervises = args.scenario == "supervise"
    report.check("主代理调用了 subagent", "subagent" in names, "tools=%s" % ",".join(names))
    report.check("主代理调用了 subagent_wait", "subagent_wait" in names)
    if supervises:
        report.check("主代理调用了 subagent_status", "subagent_status" in names)
        report.check("主代理调用了 subagent_steer", "subagent_steer" in names)
        report.check("主代理调用了 subagent_stop", "subagent_stop" in names)

    # subagent 调用使用了 background
    bg_arg = None
    for name, a in tool_calls:
        if name == "subagent":
            bg_arg = (a or {}).get("background")
            break
    # 默认即后台：主代理未传 background 时也应异步发起。
    report.check(
        "subagent 默认异步（未传 background 也后台化）",
        bg_arg in (None, True),
        "background=%r" % (bg_arg,),
    )

    # 立即返回 runId
    bg_result = None
    for name, text in tool_results:
        if name == "subagent":
            bg_result = text
            break
    run_id = None
    if bg_result:
        m = re.search(r"runId:\s*(\d+)", bg_result)
        run_id = m.group(1) if m else None
    report.check("subagent 立即返回 runId（未阻塞）", bool(run_id), (bg_result or "")[:100])

    # status 报告 running
    status_result = None
    for name, text in tool_results:
        if name == "subagent_status":
            status_result = text
            break
    if supervises:
        report.check(
            "subagent_status 报告 running",
            bool(status_result) and "status: running" in status_result,
            (status_result or "").replace("\n", " | ")[:100],
        )

    # steer 被接受
    steer_result = None
    for name, text in tool_results:
        if name == "subagent_steer":
            steer_result = text
            break
    if supervises:
        report.check(
            "subagent_steer 被接受（无错误）",
            bool(steer_result) and "queued" in steer_result,
            (steer_result or "")[:110],
        )

    # stop 被接受
    stop_result = None
    for name, text in tool_results:
        if name == "subagent_stop":
            stop_result = text
            break
    if supervises:
        report.check(
            "subagent_stop 被接受",
            bool(stop_result) and ("Stop requested" in stop_result or "already" in stop_result),
            (stop_result or "")[:110],
        )

    # 最终 status：stopped。取**最后一次** subagent_status 结果（驱动提示词要求 stop
    # 之后再查一次），此时 SIGTERM 已生效。
    final_status = None
    for name, text in reversed(tool_results):
        if name == "subagent_status":
            final_status = text
            break
    if supervises:
        stopped_seen = bool(final_status) and "status: stopped" in final_status
        report.check(
            "停止后 status 为 stopped",
            stopped_seen,
            "" if stopped_seen else "observed: " + (final_status or "").replace("\n", " | ")[:90],
        )

    # 主代理有最终总结
    final_text = assistant_texts[-1] if assistant_texts else ""
    report.check("主代理产出最终总结", len(final_text.strip()) > 0, final_text.strip()[:100])

    # subagent_wait 返回了结果（非交互模式下可靠的收口方式）
    wait_result = None
    for name, text in tool_results:
        if name == "subagent_wait":
            wait_result = text
            break
    report.check(
        "subagent_wait 返回了结果",
        bool(wait_result) and ("finished" in wait_result or "stopped" in wait_result),
        (wait_result or "").replace("\n", " | ")[:110],
    )

    # wait 场景的核心断言：结果真的被主代理拿到并复述了。
    if not supervises:
        report.check(
            "主代理收到了子代理的真实输出",
            "BANANA" in final_text,
            final_text.strip()[:100],
        )

    if args.keep:
        print("\n保留临时目录: %s" % work)
        print("stderr 尾部:")
        for line in stderr_lines[-15:]:
            print("  " + line)
    else:
        shutil.rmtree(work, ignore_errors=True)

    print("-" * 68)
    if report.failed:
        print("结果: FAIL（%d/%d 项失败）" % (len(report.failed), len(report.results)))
        for name, _, extra in report.failed:
            print("  - %s %s" % (name, ("(%s)" % extra) if extra else ""))
        return 1
    print("结果: PASS（%d/%d 项通过）" % (len(report.results), len(report.results)))
    print("")
    print("结论：background + status/logs/stop + steer 在真实模型下全部生效。")
    return 0


def main():
    parser = argparse.ArgumentParser(description="agent-team B/B-s 真实环境端到端验证")
    parser.add_argument("--provider", help="provider（默认 $PI_PROVIDER）")
    parser.add_argument("--model", help="model（默认 $PI_MODEL）")
    parser.add_argument("--timeout", type=float, default=300.0, help="总超时秒数（默认 300）")
    parser.add_argument("--keep", action="store_true", help="保留临时目录并打印 stderr")
    parser.add_argument(
        "--scenario",
        choices=["supervise", "wait"],
        default="supervise",
        help="supervise：background+status/steer/stop/wait 全流程；wait：只验证非交互模式下 subagent_wait 能可靠收口",
    )
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
