"""pi web chat 后端: FastAPI + pi-agent-python-sdk, SSE 流式输出。

启动 (在 piWeb 环境):
    python -m uvicorn server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pi_agent import AsyncPiClient, Event, Limits, PiBusyError, PiError, PiRunError

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
RUN_TIMEOUT = 300.0
TOOL_RESULT_MAX = 400

import shutil

NODE_DIR = Path(r"D:\ProgramFile\NodeJs")

def get_pi_executable() -> list[str] | str:
    if shutil.which("pi"):
        return "pi"
    node_exe = NODE_DIR / "node.exe"
    cli_js = NODE_DIR / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
    if node_exe.is_file() and cli_js.is_file():
        return [str(node_exe), str(cli_js)]
    pi_cmd = NODE_DIR / "pi.cmd"
    if pi_cmd.is_file():
        return str(pi_cmd)
    return "pi"

PI_EXECUTABLE = get_pi_executable()
PI_LIMITS = Limits(startup_timeout=120.0, command_timeout=60.0)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("piweb")

_clients: dict[str, AsyncPiClient] = {}
_client_locks: dict[str, asyncio.Lock] = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    for client in list(_clients.values()):
        try:
            await client.aclose()
        except Exception:
            pass
    _clients.clear()


app = FastAPI(title="pi web chat", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    client_id: str
    message: str


class ClientRequest(BaseModel):
    client_id: str | None = None


class ModelRequest(BaseModel):
    client_id: str
    provider: str
    model_id: str


class SwitchRequest(BaseModel):
    client_id: str
    session_file: str


def sse(payload: dict[str, Any]) -> str:
    frame = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    return clean_text(frame)


def auto_approve(request: dict) -> object:
    method = request.get("method")
    if method == "confirm":
        log.info("auto-approve: %s", request.get("title") or request.get("message"))
        return True
    return None


async def get_client(client_id: str) -> AsyncPiClient:
    client = _clients.get(client_id)
    if client is None:
        client = AsyncPiClient(
            executable=PI_EXECUTABLE,
            cwd=str(PROJECT_DIR),
            ui_handler=auto_approve,
            limits=PI_LIMITS,
            extra_args=["--offline"],
        )
        await client.start()
        _clients[client_id] = client
        _client_locks[client_id] = asyncio.Lock()
        state = await client.get_state()
        model = state.get("model") or {}
        log.info("client %s started: %s/%s", client_id, model.get("provider"), model.get("id"))
    return client


def get_lock(client_id: str) -> asyncio.Lock:
    lock = _client_locks.get(client_id)
    if lock is None:
        lock = asyncio.Lock()
        _client_locks[client_id] = lock
    return lock


def event_payload(event: Event) -> dict[str, Any] | None:
    if event.text_delta:
        return {"type": "text", "delta": event.text_delta}

    if event.type == "message_update":
        nested = event.raw.get("assistantMessageEvent") or {}
        kind = nested.get("type")
        if kind == "thinking_delta":
            return {"type": "thinking", "delta": nested.get("delta", "")}
        if kind == "toolcall_start":
            return {"type": "tool_start", "name": nested.get("toolName")}
        return None

    if event.type == "tool_execution_start":
        return {
            "type": "tool_exec",
            "name": event.raw.get("toolName"),
            "args": event.raw.get("args"),
        }
    if event.type == "tool_execution_end":
        result = event.raw.get("result")
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        return {
            "type": "tool_end",
            "name": event.raw.get("toolName"),
            "ok": not event.raw.get("isError"),
            "result": text[:TOOL_RESULT_MAX],
        }
    return None


@app.post("/api/session")
async def create_session(req: ClientRequest) -> dict[str, Any]:
    client_id = req.client_id or uuid.uuid4().hex
    try:
        client = await get_client(client_id)
        state = await client.get_state()
    except PiError as exc:
        raise HTTPException(status_code=500, detail=f"启动 pi 失败: {exc}") from exc
    model = state.get("model") or {}
    return {
        "client_id": client_id,
        "model": f"{model.get('provider')}/{model.get('id')}",
        "session_id": state.get("sessionId"),
    }


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="消息不能为空")
    try:
        client = await get_client(req.client_id)
    except PiError as exc:
        raise HTTPException(status_code=500, detail=f"pi 不可用: {exc}") from exc

    lock = get_lock(req.client_id)

    async def generate():
        async with lock:
            try:
                async with client.stream(req.message, timeout=RUN_TIMEOUT) as stream:
                    async for event in stream:
                        payload = event_payload(event)
                        if payload is not None:
                            yield sse(payload)
                    result = await stream.result()
            except PiRunError as exc:
                reason = exc.result.stop_reason
                if reason == "aborted":
                    yield sse({"type": "interrupted"})
                else:
                    yield sse({"type": "error", "message": str(exc)})
                return
            except PiBusyError as exc:
                yield sse({"type": "error", "message": f"上一轮尚未结束: {exc}"})
                return
            except PiError as exc:
                yield sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
                return

            usage = result.usage
            yield sse(
                {
                    "type": "done",
                    "stop_reason": result.stop_reason,
                    "elapsed": round(result.elapsed_seconds, 2),
                    "usage": None
                    if usage is None
                    else {
                        "input_tokens": usage.input_tokens,
                        "output_tokens": usage.output_tokens,
                        "total_tokens": usage.total_tokens,
                        "cost": usage.cost,
                    },
                    "session_id": result.session.session_id,
                }
            )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def clean_text(text: str) -> str:
    """去掉孤立代理字符, 避免 JSON 序列化失败 (历史脏数据兜底)。"""
    return text.encode("utf-8", "replace").decode("utf-8")


def session_title(path: Path) -> str:
    """从 session jsonl 提取首条用户消息作为标题。"""
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for _ in range(30):
                line = fh.readline()
                if not line:
                    break
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") != "message":
                    continue
                message = entry.get("message") or {}
                if message.get("role") != "user":
                    continue
                content = message.get("content")
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    text = "".join(
                        b.get("text", "")
                        for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                else:
                    continue
                text = clean_text(" ".join(text.split()))
                if text:
                    return text[:40]
    except OSError:
        pass
    return path.stem


def to_ui_messages(raw: list[Any]) -> list[dict[str, Any]]:
    """pi 的 AgentMessage 列表 → 前端消息结构。"""
    tool_results = {
        m.get("toolCallId"): m
        for m in raw
        if isinstance(m, dict) and m.get("role") == "toolResult"
    }
    out: list[dict[str, Any]] = []
    seq = 0

    for m in raw:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "user":
            content = m.get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = "".join(
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            else:
                continue
            if not text.strip():
                continue
            out.append(
                {
                    "id": f"h{seq}",
                    "role": "user",
                    "parts": [{"kind": "text", "text": clean_text(text)}],
                    "streaming": False,
                }
            )
            seq += 1
        elif role == "assistant":
            parts: list[dict[str, Any]] = []
            for block in m.get("content") or []:
                btype = block.get("type")
                if btype == "text":
                    if block.get("text"):
                        parts.append(
                            {"kind": "text", "text": clean_text(block["text"])}
                        )
                elif btype == "thinking":
                    if block.get("thinking"):
                        parts.append(
                            {
                                "kind": "thinking",
                                "text": clean_text(block["thinking"]),
                            }
                        )
                elif btype == "toolCall":
                    tr = tool_results.get(block.get("id")) or {}
                    tr_text = ""
                    for b in tr.get("content") or []:
                        if isinstance(b, dict) and b.get("type") == "text":
                            tr_text += b.get("text", "")
                    raw_args = block.get("arguments")
                    try:
                        args = (
                            json.loads(
                                clean_text(
                                    json.dumps(raw_args, ensure_ascii=False, default=str)
                                )
                            )
                            if raw_args is not None
                            else None
                        )
                    except ValueError:
                        args = None
                    parts.append(
                        {
                            "kind": "tool",
                            "name": block.get("name", "tool"),
                            "args": args,
                            "done": bool(tr),
                            "ok": not tr.get("isError", False),
                            "result": clean_text(tr_text[:TOOL_RESULT_MAX]) or None,
                        }
                    )
            if not parts:
                continue
            usage = m.get("usage") or {}
            out.append(
                {
                    "id": f"h{seq}",
                    "role": "assistant",
                    "parts": parts,
                    "streaming": False,
                    "usage": {
                        "input_tokens": usage.get("input"),
                        "output_tokens": usage.get("output"),
                        "total_tokens": usage.get("totalTokens"),
                        "cost": None,
                    },
                }
            )
            seq += 1
    return out


@app.post("/api/interrupt")
async def interrupt(req: ClientRequest) -> dict[str, bool]:
    client = _clients.get(req.client_id or "")
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    try:
        await client.abort()
    except PiError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/new")
async def new_session(req: ClientRequest) -> dict[str, Any]:
    client = _clients.get(req.client_id or "")
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    lock = get_lock(req.client_id or "")
    if lock.locked():
        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")
    await client.new_session()
    state = await client.get_state()
    return {
        "ok": True,
        "session_id": state.get("sessionId"),
        "session_file": state.get("sessionFile"),
    }


@app.get("/api/stats")
async def stats(client_id: str) -> dict[str, Any]:
    client = _clients.get(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return await client.get_session_stats()


@app.get("/api/models")
async def models() -> list[dict[str, Any]]:
    for client in _clients.values():
        try:
            available = await client.get_available_models()
            return [
                {"id": m.get("id"), "name": m.get("name"), "provider": m.get("provider")}
                for m in available
            ]
        except PiError:
            continue
    raise HTTPException(status_code=409, detail="没有可用客户端")


@app.post("/api/model")
async def set_model(req: ModelRequest) -> dict[str, Any]:
    client = _clients.get(req.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    try:
        model = await client.set_model(req.provider, req.model_id)
    except PiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"model": f"{model.get('provider')}/{model.get('id')}"}


@app.get("/api/history")
async def history(client_id: str) -> dict[str, Any]:
    """当前项目目录下的历史会话列表 (按修改时间倒序)。"""
    client = _clients.get(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    state = await client.get_state()
    current = state.get("sessionFile")
    if not current:
        return {"current": None, "items": []}

    folder = Path(current).parent
    items: list[dict[str, Any]] = []
    if folder.is_dir():
        for path in folder.glob("*.jsonl"):
            stat = path.stat()
            items.append(
                {
                    "file": str(path),
                    "title": session_title(path),
                    "mtime": int(stat.st_mtime),
                    "current": str(path) == current,
                }
            )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return {"current": current, "items": items}


@app.get("/api/messages")
async def get_messages_endpoint(client_id: str) -> dict[str, Any]:
    client = _clients.get(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    raw = await client.get_messages()
    state = await client.get_state()
    return {
        "messages": to_ui_messages(raw),
        "session_file": state.get("sessionFile"),
        "session_id": state.get("sessionId"),
    }


@app.post("/api/switch")
async def switch_session_endpoint(req: SwitchRequest) -> dict[str, Any]:
    client = _clients.get(req.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    lock = get_lock(req.client_id)
    if lock.locked():
        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")
    if not Path(req.session_file).is_file():
        raise HTTPException(status_code=404, detail="会话文件不存在")
    try:
        result = await client.switch_session(req.session_file)
    except PiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result.get("cancelled"):
        raise HTTPException(status_code=409, detail="切换被取消")
    raw = await client.get_messages()
    state = await client.get_state()
    return {
        "ok": True,
        "messages": to_ui_messages(raw),
        "session_file": state.get("sessionFile"),
        "session_id": state.get("sessionId"),
    }
