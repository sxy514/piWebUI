"""pi-agent-python-sdk 同步客户端演示。

用法: python demo_pi_sdk.py

演示内容:
  1. run()          — 一次性问答, 拿最终结果
  2. stream()       — 流式打印 text / thinking / 工具事件
  3. 多轮对话        — 同一 session 追问 + 用量统计
  4. 工具调用        — 让 agent 真正执行 bash/read, ui_handler 自动审批
"""

from __future__ import annotations

import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from pi_agent import Event, PiClient, RunResult

DEMO_DIR = os.path.dirname(os.path.abspath(__file__))
RUN_TIMEOUT = 180.0


def banner(text: str) -> None:
    print("\n" + "=" * 64)
    print(text)
    print("=" * 64)


def auto_approve(request: dict) -> object:
    """审批回调: confirm 类请求自动放行, 其余返回默认值。"""
    method = request.get("method")
    title = request.get("title") or request.get("message") or ""
    print(f"\n  [ui:{method}] {title}")
    if method == "confirm":
        return True
    return None


def print_usage(result: RunResult) -> None:
    u = result.usage
    if u is None:
        return
    print(
        f"  usage: in={u.input_tokens} out={u.output_tokens} "
        f"total={u.total_tokens} cost={u.cost} "
        f"| {result.elapsed_seconds:.1f}s stop={result.stop_reason}"
    )


def handle_event(event: Event, *, stream_out: bool = True) -> None:
    """把 RPC 事件翻译成终端输出。"""
    if event.text_delta:
        if stream_out:
            print(event.text_delta, end="", flush=True)
        return

    if event.type == "message_update":
        nested = event.raw.get("assistantMessageEvent") or {}
        kind = nested.get("type")
        if kind == "thinking_delta" and stream_out:
            print(nested.get("delta", ""), end="", flush=True)
        elif kind == "toolcall_start":
            print(f"\n  [toolcall] {nested.get('toolName')}")
        return

    if event.type == "tool_execution_start":
        args = event.raw.get("args")
        print(f"\n  [exec] {event.raw.get('toolName')}({args})")
    elif event.type == "tool_execution_end":
        result = event.raw.get("result")
        text = result if isinstance(result, str) else str(result)
        flag = "ERR" if event.raw.get("isError") else "OK"
        print(f"  [done:{flag}] {text[:200]}")
    elif event.type == "turn_end":
        print()


def section_one_shot(pi: PiClient) -> None:
    banner("1) run() — 一次性问答")
    result = pi.run("用两句话介绍你自己, 并说出你当前使用的模型名。", timeout=RUN_TIMEOUT)
    print(result.text)
    print_usage(result)
    print(f"  session: {result.session.session_id}")


def section_streaming(pi: PiClient) -> None:
    banner("2) stream() — 流式输出 (text/thinking/tool 事件)")
    with pi.stream("写一首关于「终端里的一行代码」的四行小诗。", timeout=RUN_TIMEOUT) as stream:
        for event in stream:
            handle_event(event)
        result = stream.result()
    print()
    print_usage(result)


def section_multi_turn(pi: PiClient) -> None:
    banner("3) 多轮对话 — 同一 session 追问")
    first = pi.run("记住这个暗号: 青柠-42。只回复「已记住」。", timeout=RUN_TIMEOUT)
    print(f"  第1轮: {first.text.strip()}")

    second = pi.run("刚才的暗号是什么? 只回复暗号本身。", timeout=RUN_TIMEOUT)
    print(f"  第2轮: {second.text.strip()}")

    stats = pi.get_session_stats()
    print(f"  session stats: {stats}")


def section_tools(pi: PiClient) -> None:
    banner("4) 工具调用 — agent 真正执行命令")
    prompt = (
        f"用 bash 工具列出目录 {DEMO_DIR} 下的文件名(只要文件名, 不要子命令解释), "
        "然后用一句话总结这个目录里有什么。"
    )
    with pi.stream(prompt, timeout=RUN_TIMEOUT) as stream:
        for event in stream:
            handle_event(event)
        result = stream.result()
    print()
    print_usage(result)


def main() -> int:
    banner(f"pi-agent-python-sdk demo | cwd={DEMO_DIR}")
    print("启动 pi 子进程 (RPC 模型) ...")

    with PiClient(cwd=DEMO_DIR, ui_handler=auto_approve) as pi:
        state = pi.get_state()
        model = state.get("model") or {}
        print(f"model: {model.get('provider')}/{model.get('id')}")
        print(f"thinking: {state.get('thinkingLevel')}")

        section_one_shot(pi)
        section_streaming(pi)
        section_multi_turn(pi)
        section_tools(pi)

        banner("完成")
        print("session 文件保留在 ~/.pi/agent/sessions/ 下, 可用 pi 继续查看。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
