"""基于 pi-agent-python-sdk 的连续对话脚本。

用法: python chat.py [问题...]

命令:
  /help              显示帮助
  /model             显示当前模型
  /model list        列出可用模型
  /model <prov/id>   切换模型 (如 /model lmstudio/minicpm5-2b)
  /stats             显示会话统计
  /new               开启全新会话 (清空上下文)
  /quit  /exit       退出

快捷键:
  Ctrl+C             中断当前回答 (会自动 abort 并清空队列)
  Ctrl+D             退出
"""

from __future__ import annotations

import os
import sys

for _stream in (sys.stdin, sys.stdout):
    try:
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8") # pyright: ignore[reportAttributeAccessIssue]
    except (OSError, ValueError):
        pass

from pi_agent import Event, PiClient, PiBusyError, PiError, RunResult

DEMO_DIR = os.path.dirname(os.path.abspath(__file__))
RUN_TIMEOUT = 300.0
IDLE_TIMEOUT = 30.0

HELP = __doc__ or ""


def auto_approve(request: dict) -> object:
    if request.get("method") == "confirm":
        title = request.get("title") or request.get("message") or ""
        print(f"\n  [审批] {title}")
        return True
    return None


def current_model(pi: PiClient) -> str:
    model = (pi.get_state().get("model") or {})
    return f"{model.get('provider')}/{model.get('id')}"


def print_usage(result: RunResult) -> None:
    u = result.usage
    if u is None:
        return
    print(
        f"\n  [tokens in={u.input_tokens} out={u.output_tokens} "
        f"| {result.elapsed_seconds:.1f}s | stop={result.stop_reason}]"
    )


def stream_reply(pi: PiClient, prompt: str) -> RunResult | None:
    """流式输出一轮回答, 返回结果; 被中断时返回 None。"""
    mode = "text"
    try:
        with pi.stream(prompt, timeout=RUN_TIMEOUT) as stream:
            for event in stream:
                mode = render_event(event, mode)
            result = stream.result()
    except KeyboardInterrupt:
        print("\n  [已中断本次回答]")
        return None
    except PiError as exc:
        print(f"\n  [错误] {type(exc).__name__}: {exc}")
        return None
    if mode == "think":
        print()
    return result


def render_event(event: Event, mode: str) -> str:
    """渲染单个事件, 返回当前内容模式 (text/think)。"""
    delta = event.text_delta
    if delta:
        if mode != "text":
            print()
        print(delta, end="", flush=True)
        return "text"

    if event.type == "message_update":
        nested = event.raw.get("assistantMessageEvent") or {}
        kind = nested.get("type")
        if kind == "thinking_delta":
            if mode != "think":
                print("\n  [思考] ", end="", flush=True)
            print(nested.get("delta", ""), end="", flush=True)
            return "think"
        if kind == "toolcall_start":
            if mode != "text":
                print()
            print(f"  [调用工具] {nested.get('toolName')}")
            return "text"
        return mode

    if event.type == "tool_execution_start":
        if mode != "text":
            print()
        args = event.raw.get("args")
        print(f"  [执行] {event.raw.get('toolName')}({args})")
        return "text"
    if event.type == "tool_execution_end":
        if mode != "text":
            print()
        result = event.raw.get("result")
        text = result if isinstance(result, str) else str(result)
        flag = "错误" if event.raw.get("isError") else "完成"
        print(f"  [{flag}] {text[:300]}")
        return "text"
    if event.type == "turn_end" and mode != "text":
        print()
        return "text"
    return mode


def handle_command(pi: PiClient, line: str) -> bool:
    """处理斜杠命令, 返回 False 表示退出。"""
    parts = line.split()
    cmd, args = parts[0].lower(), parts[1:]

    if cmd in ("/quit", "/exit"):
        return False
    if cmd == "/help":
        print(HELP)
    elif cmd == "/stats":
        stats = pi.get_session_stats()
        tokens = stats.get("tokens") or {}
        ctx = stats.get("contextUsage") or {}
        print(f"  session : {stats.get('sessionId')}")
        print(f"  messages: user={stats.get('userMessages')} assistant={stats.get('assistantMessages')}")
        print(f"  tools   : calls={stats.get('toolCalls')} results={stats.get('toolResults')}")
        print(f"  tokens  : in={tokens.get('input')} out={tokens.get('output')} total={tokens.get('total')}")
        print(f"  context : {ctx.get('tokens')}/{ctx.get('contextWindow')} ({ctx.get('percent', 0):.1f}%)")
        print(f"  file    : {stats.get('sessionFile')}")
    elif cmd == "/model":
        if not args:
            print(f"  当前模型: {current_model(pi)}")
        elif args[0] == "list":
            current = current_model(pi)
            for m in pi.get_available_models():
                mid = f"{m.get('provider')}/{m.get('id')}"
                mark = "*" if mid == current else " "
                print(f"  {mark} {mid}  ({m.get('name')})")
        else:
            provider, _, model_id = args[0].partition("/")
            if not model_id:
                print("  格式: /model <provider>/<id>")
            else:
                try:
                    pi.set_model(provider, model_id)
                    print(f"  已切换到 {current_model(pi)}")
                except PiError as exc:
                    print(f"  切换失败: {exc}")
    elif cmd == "/new":
        pi.new_session()
        print("  已开启新会话")
    else:
        print(f"  未知命令 {cmd}, 输入 /help 查看帮助")
    return True


def reply(pi: PiClient, prompt: str) -> None:
    try:
        result = stream_reply(pi, prompt)
    except PiBusyError:
        print("  [等待上一轮结束...]")
        pi.wait_for_idle(timeout=IDLE_TIMEOUT)
        result = stream_reply(pi, prompt)
    if result is not None:
        print_usage(result)


def main(argv: list[str]) -> int:
    print("=" * 64)
    print("pi-agent-python-sdk 连续对话  |  /help 查看命令, /quit 退出")
    print("=" * 64)

    with PiClient(cwd=DEMO_DIR, ui_handler=auto_approve) as pi: # pyright: ignore[reportArgumentType]
        print(f"模型: {current_model(pi)}  session: {pi.get_state().get('sessionId')}")

        initial = " ".join(argv)
        if initial:
            reply(pi, initial)

        while True:
            try:
                line = input("\n你> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n再见!")
                return 0
            if not line:
                continue
            if line.startswith("/"):
                if not handle_command(pi, line):
                    print("再见!")
                    return 0
                continue
            reply(pi, line)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\n再见!")
        sys.exit(130)
