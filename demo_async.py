"""pi-agent-python-sdk 异步客户端演示。

用法: python demo_async.py

演示 AsyncPiClient:
  1. 流式读取事件, 按行打印
  2. 两个独立会话并发运行 (asyncio.gather)
"""

from __future__ import annotations

import asyncio
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from pi_agent import AsyncPiClient, Event

DEMO_DIR = os.path.dirname(os.path.abspath(__file__))
RUN_TIMEOUT = 180.0


def banner(text: str) -> None:
    print("\n" + "=" * 64)
    print(text)
    print("=" * 64)


async def stream_and_print(
    client: AsyncPiClient, prompt: str, tag: str, *, line_buffered: bool = False
) -> str:
    """流式读取一个 run。line_buffered=True 时按完整行输出, 避免并发交错。"""
    buffer = ""

    def flush(force: bool = False) -> None:
        nonlocal buffer
        while "\n" in buffer:
            line, _, buffer = buffer.partition("\n")
            print(f"[{tag}] {line}")
        if force and buffer:
            print(f"[{tag}] {buffer}")
            buffer = ""

    async with client.stream(prompt, timeout=RUN_TIMEOUT) as stream:
        async for event in stream:
            if not (isinstance(event, Event) and event.text_delta):
                continue
            if line_buffered:
                buffer += event.text_delta
                flush()
            else:
                print(event.text_delta, end="", flush=True)
        result = await stream.result()
    if line_buffered:
        flush(force=True)
    else:
        print()
    return result.text


async def demo_single_stream() -> None:
    banner("1) AsyncPiClient 流式输出")
    async with AsyncPiClient(cwd=DEMO_DIR) as pi:
        state = await pi.get_state()
        model = state.get("model") or {}
        print(f"model: {model.get('provider')}/{model.get('id')}")

        text = await stream_and_print(pi, "用三句话解释什么是 RPC。", "rpc")
        print(f"\n  完成, 共 {len(text)} 字符")


async def demo_parallel() -> None:
    banner("2) 两个独立会话并发运行")
    async with AsyncPiClient(cwd=DEMO_DIR) as a, AsyncPiClient(cwd=DEMO_DIR) as b:
        r1, r2 = await asyncio.gather(
            stream_and_print(a, "出一道三位数加法心算题, 只给算式。", "A", line_buffered=True),
            stream_and_print(b, "说一句鼓励程序员的话。", "B", line_buffered=True),
        )
        print(f"\n  A 结果: {r1.strip()}")
        print(f"  B 结果: {r2.strip()}")


async def main() -> int:
    await demo_single_stream()
    await demo_parallel()
    banner("完成")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
