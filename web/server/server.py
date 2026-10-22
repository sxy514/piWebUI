"""pi web chat 后端: FastAPI + pi-agent-python-sdk, SSE 流式输出。

启动 (在 piWeb 环境):
    python -m uvicorn server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from pi_agent import AsyncPiClient, Event, Limits, PiBusyError, PiError, PiRunError

PROJECT_DIR = Path(__file__).resolve().parent.parent.parent
RUN_TIMEOUT = 300.0
TOOL_RESULT_MAX = 400

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
# 超时与限流配置：调大 command_timeout 与 run_start_timeout，防止插件初始化或长任务处理中误掐断
PI_LIMITS = Limits(startup_timeout=120.0, command_timeout=120.0, run_start_timeout=60.0)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("piweb")


def load_env_file():
    """读取根目录或 server 目录下的 .env 文件配置。"""
    search_paths = [
        PROJECT_DIR / ".env",
        Path(__file__).resolve().parent / ".env",
    ]
    for env_path in search_paths:
        if env_path.is_file():
            try:
                with env_path.open(encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k, v = k.strip(), v.strip().strip('"').strip("'")
                            if k and k not in os.environ:
                                os.environ[k] = v
            except Exception as e:
                log.warning("读取 %s 失败: %s", env_path, e)


load_env_file()


def ensure_extensions():
    """确保环境所需的原生审核扩展就绪（实现新环境克隆后零配置自愈）。"""
    ext_dir = PROJECT_DIR / ".pi" / "extensions"
    ext_dir.mkdir(parents=True, exist_ok=True)
    target_ext = ext_dir / "web_approval.js"
    source_ext = Path(__file__).resolve().parent / "extensions" / "web_approval.js"
    if source_ext.is_file() and not target_ext.is_file():
        shutil.copy2(source_ext, target_ext)
        log.info("已自动为当前环境就绪工具审核扩展: %s", target_ext)


ensure_extensions()

# 访问密码与安全配置
AUTH_TOKEN = os.environ.get("PI_AUTH_TOKEN", "").strip()
CLIENT_IDLE_TIMEOUT = float(os.environ.get("PI_CLIENT_IDLE_TIMEOUT", "1800.0"))  # 默认 30 分钟无请求自动回收子进程
# 审核策略：'safe' (常规放行, 高危确认) / 'manual' (每次执行均在网页端手动确认) / 'deny' (全拒绝) / 'allow_all' (全放行)
AUTO_APPROVE_POLICY = os.environ.get("PI_AUTO_APPROVE_POLICY", "safe").lower()
# 客户端密码保存模式：'true'/'local' (长期记住), 'session' (会话级别), 'false'/'none' (完全不缓存)
AUTH_REMEMBER = os.environ.get("PI_AUTH_REMEMBER", "true").lower()

if AUTH_TOKEN:
    log.info("🔐 访问密码保护已开启 (PI_AUTH_TOKEN 已配置)")
else:
    log.info("🔓 未配置 PI_AUTH_TOKEN，免密模式运行")

log.info("🛡️ 工具确认审核策略: %s", AUTO_APPROVE_POLICY)
if AUTH_TOKEN:
    log.info("💾 客户端密码记住模式: %s", AUTH_REMEMBER)

DANGEROUS_COMMAND_PATTERNS = [
    # 破坏性文件/磁盘删除
    r"\brm\s+-[rf]{1,2}\b",
    r"\bdel\s+/[fFqsSQ\s]+",
    r"\brmdir\s+/[sS]\b",
    r"\bformat\s+[a-zA-Z]:",
    r"\bmkfs\b",
    # 关机 / 重启 / 提权
    r"\bshutdown\b",
    r"\breboot\b",
    r"\binit\s+[06]\b",
    # 危险下载执行 / 远程代码执行
    r"\bcurl\b.*\|\s*(?:ba|z)?sh",
    r"\bwget\b.*\|\s*(?:ba|z)?sh",
    r"\bpowershell(?:\.exe)?\s+.*-(?:enc|encodedcommand|e)\b",
    r"\biex\b",
    r"\bInvoke-Expression\b",
    # 破坏敏感系统目录
    r"[\\/](?:windows|system32|etc|boot)\b",
]
_DANGEROUS_REGEX = re.compile("|".join(DANGEROUS_COMMAND_PATTERNS), re.IGNORECASE)

_clients: dict[str, AsyncPiClient] = {}
_client_locks: dict[str, asyncio.Lock] = {}
_client_last_active: dict[str, float] = {}
_creation_lock = asyncio.Lock()  # 全局创建锁，防止并发请求竞态创建相同 client 导致子进程泄漏

# 人类在环手动确认通道
_pending_confirms: dict[str, asyncio.Future[bool]] = {}
_active_sse_queues: dict[str, asyncio.Queue[dict[str, Any]]] = {}


def touch_client(client_id: str) -> None:
    """更新客户端最近活跃时间。"""
    _client_last_active[client_id] = time.time()


async def close_client(client_id: str) -> None:
    """安全关闭指定客户端并清理所有子进程资源。"""
    client = _clients.pop(client_id, None)
    _client_locks.pop(client_id, None)
    _client_last_active.pop(client_id, None)
    _active_sse_queues.pop(client_id, None)
    if client is not None:
        try:
            await client.aclose()
            log.info("Client %s closed successfully", client_id)
        except Exception as exc:
            log.warning("Error closing client %s: %s", client_id, exc)


async def _cleanup_idle_clients():
    """后台任务：定期检查并释放空闲超时的 pi 子进程，杜绝进程泄漏。"""
    while True:
        try:
            await asyncio.sleep(60)
            now = time.time()
            expired = [
                cid
                for cid, last_active in list(_client_last_active.items())
                if (now - last_active > CLIENT_IDLE_TIMEOUT)
                and not (_client_locks.get(cid) and _client_locks[cid].locked())
            ]
            for cid in expired:
                log.info(
                    "Client %s 超时空闲 (>%s秒), 正在自动释放子进程...",
                    cid,
                    CLIENT_IDLE_TIMEOUT,
                )
                await close_client(cid)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            log.error("空闲子进程清理任务异常: %s", exc)


@asynccontextmanager
async def lifespan(_: FastAPI):
    cleanup_task = asyncio.create_task(_cleanup_idle_clients())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        for client_id in list(_clients.keys()):
            await close_client(client_id)
        _clients.clear()
        _client_locks.clear()
        _client_last_active.clear()
        _pending_confirms.clear()
        _active_sse_queues.clear()


app = FastAPI(title="pi web chat", lifespan=lifespan)

# CORS 跨域安全配置：收紧跨域白名单，仅放行 本机 (localhost/127.0.0.1) 及 局域网私有网段 IP，拒绝外网恶意网页跨域请求探测
ALLOWED_ORIGIN_REGEX = r"^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|100\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$"

custom_cors = os.environ.get("CORS_ALLOWED_ORIGINS", "").strip()
cors_origins = [o.strip() for o in custom_cors.split(",") if o.strip()] if custom_cors else [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX if not custom_cors else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AuthMiddleware:
    """局域网访问鉴权中间件，纯 ASGI 实现，零开销且完美支持 SSE 长流式。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        # 放行 OPTIONS 预检请求以及非 API 路由
        if scope.get("method") == "OPTIONS" or not path.startswith("/api/"):
            return await self.app(scope, receive, send)

        # 密码未配置时放行，或认证状态/校验接口放行
        if not AUTH_TOKEN or path in ("/api/auth/status", "/api/auth/verify"):
            return await self.app(scope, receive, send)

        headers = dict(scope.get("headers", []))
        auth_val = headers.get(b"authorization", b"").decode("utf-8")
        token = ""
        if auth_val.startswith("Bearer "):
            token = auth_val[7:].strip()
        elif b"x-auth-token" in headers:
            token = headers[b"x-auth-token"].decode("utf-8").strip()

        if token != AUTH_TOKEN:
            res = JSONResponse({"detail": "访问密码错误或未提供"}, status_code=401)
            return await res(scope, receive, send)

        return await self.app(scope, receive, send)


app.add_middleware(AuthMiddleware)


class VerifyTokenRequest(BaseModel):
    token: str


class ChatRequest(BaseModel):
    client_id: str
    message: str


class ConfirmActionRequest(BaseModel):
    client_id: str
    confirm_id: str
    approved: bool


class ClientRequest(BaseModel):
    client_id: str | None = None


class ModelRequest(BaseModel):
    client_id: str
    provider: str
    model_id: str


class SwitchRequest(BaseModel):
    client_id: str
    session_file: str


class DeleteSessionRequest(BaseModel):
    client_id: str
    session_file: str


def sse(payload: dict[str, Any]) -> str:
    frame = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    return clean_text(frame)


def make_ui_handler(client_id: str):
    """为指定客户端构建交互式安全审核处理器，支持网页端人类在环手动确认。"""

    async def ui_handler(request: dict) -> object:
        method = request.get("method")
        if method != "confirm":
            return None

        title = str(request.get("title") or "")
        message = str(request.get("message") or "")
        full_desc = f"{title}\n{message}"
        is_dangerous = bool(_DANGEROUS_REGEX.search(full_desc))

        # 1. deny 策略：一律拒绝
        if AUTO_APPROVE_POLICY == "deny":
            log.warning("policy=deny: 自动拦截确认请求: %s", title or message)
            return False

        # 2. allow_all 策略：全放行
        if AUTO_APPROVE_POLICY == "allow_all":
            log.warning("policy=allow_all: 自动放行确认请求: %s", title or message)
            return True

        # 3. safe 策略且无危险特征：常规开发指令自动放行
        if AUTO_APPROVE_POLICY == "safe" and not is_dangerous:
            log.info("safe-approve: 自动放行常规安全操作: %s", title or message)
            return True

        # 4. manual 模式 或 safe 模式下的高危指令：推送到前端网页供用户手动确认
        confirm_id = uuid.uuid4().hex[:8]
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        _pending_confirms[confirm_id] = future

        queue = _active_sse_queues.get(client_id)
        if queue is not None:
            await queue.put(
                {
                    "type": "confirm_request",
                    "confirm_id": confirm_id,
                    "title": title or ("⚠️ 高危命令执行申请" if is_dangerous else "🛠️ 终端命令执行申请"),
                    "message": message or title,
                    "is_dangerous": is_dangerous,
                }
            )

        try:
            log.info("等待用户在网页端手动确认 [%s]: %s", confirm_id, title or message)
            # 等待用户在网页端点击，超时时间 120 秒
            approved = await asyncio.wait_for(future, timeout=120.0)
            log.info("用户确认结果 [%s]: %s", confirm_id, "允许执行" if approved else "拒绝执行")
            return approved
        except (asyncio.TimeoutError, asyncio.CancelledError):
            log.warning("用户确认超时或取消 [%s]，默认拒绝执行", confirm_id)
            return False
        finally:
            _pending_confirms.pop(confirm_id, None)

    return ui_handler


def get_client_session_dir(client_id: str) -> Path:
    """为每个 client_id 分配独立的会话存储目录，杜绝多端共享与并发写冲突。"""
    safe_cid = re.sub(r"[^a-zA-Z0-9_\-]", "", client_id) or "default"
    target = (PROJECT_DIR / ".pi" / "sessions" / safe_cid).resolve()
    target.mkdir(parents=True, exist_ok=True)
    return target


def get_allowed_sessions_dir(client_id: str) -> Path:
    """获取指定客户端合法受信任的专属会话目录。"""
    return get_client_session_dir(client_id)


async def get_client(client_id: str) -> AsyncPiClient:
    """安全获取或创建客户端实例，带有双重检查锁防止并发竞态。"""
    touch_client(client_id)
    client = _clients.get(client_id)
    if client is not None:
        return client

    async with _creation_lock:
        # 双重检查，避免排队中的并发协程重复拉起进程
        client = _clients.get(client_id)
        if client is not None:
            return client

        session_dir = get_client_session_dir(client_id)
        client = AsyncPiClient(
            executable=PI_EXECUTABLE,
            cwd=str(PROJECT_DIR),
            session_dir=str(session_dir),
            ui_handler=make_ui_handler(client_id),
            limits=PI_LIMITS,
            extra_args=["--offline", "--approve"],
        )
        await client.start()
        _clients[client_id] = client
        if client_id not in _client_locks:
            _client_locks[client_id] = asyncio.Lock()
        touch_client(client_id)
        state = await client.get_state()
        model = state.get("model") or {}
        log.info(
            "client %s started (session_dir=%s): %s/%s",
            client_id,
            session_dir,
            model.get("provider"),
            model.get("id"),
        )
        return client


def get_lock(client_id: str) -> asyncio.Lock:
    lock = _client_locks.get(client_id)
    if lock is None:
        lock = asyncio.Lock()
        _client_locks[client_id] = lock
    return lock


def validate_session_path(session_path: str, allowed_dir: Path) -> Path:
    """严格校验会话路径，防止跨目录路径遍历与任意文件读写删除。"""
    try:
        target = Path(session_path).resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="非法路径格式")

    if target.suffix.lower() != ".jsonl":
        raise HTTPException(status_code=400, detail="非法会话文件格式: 仅支持 .jsonl")

    # 目录沙箱校验 (禁止跨目录越权访问)
    try:
        target.relative_to(allowed_dir)
    except ValueError:
        raise HTTPException(status_code=403, detail="禁止跨目录越权访问会话文件")

    if not target.is_file():
        raise HTTPException(status_code=404, detail="会话文件不存在")

    return target


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


@app.get("/api/auth/status")
async def auth_status() -> dict[str, Any]:
    """检查当前服务是否启用了访问密码保护及客户端持久化模式。"""
    return {
        "auth_required": bool(AUTH_TOKEN),
        "auth_remember": AUTH_REMEMBER,
    }


@app.post("/api/auth/verify")
async def auth_verify(req: VerifyTokenRequest) -> dict[str, bool]:
    """验证用户输入的访问密码。"""
    if not AUTH_TOKEN:
        return {"ok": True}
    if req.token.strip() == AUTH_TOKEN:
        return {"ok": True}
    raise HTTPException(status_code=401, detail="访问密码错误")


@app.post("/api/confirm")
async def confirm_action_endpoint(req: ConfirmActionRequest) -> dict[str, bool]:
    """接收用户在网页端对工具执行的手动确认结果。"""
    touch_client(req.client_id)
    future = _pending_confirms.get(req.confirm_id)
    if future and not future.done():
        future.set_result(req.approved)
        if not req.approved:
            # 用户选择【拒绝】，主动中止当前任务，停止后续工具与回复生成
            async def trigger_abort():
                await asyncio.sleep(0.05)
                client = _clients.get(req.client_id)
                if client is not None:
                    try:
                        await client.abort()
                    except Exception as e:
                        log.debug("abort after rejection: %s", e)

            asyncio.create_task(trigger_abort())
        return {"ok": True}
    return {"ok": False}


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


@app.post("/api/session/close")
async def close_session_endpoint(req: ClientRequest) -> dict[str, bool]:
    """主动注销客户端会话并销毁后台子进程。"""
    if req.client_id:
        await close_client(req.client_id)
    return {"ok": True}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="消息不能为空")
    try:
        client = await get_client(req.client_id)
    except PiError as exc:
        raise HTTPException(status_code=500, detail=f"pi 不可用: {exc}") from exc

    touch_client(req.client_id)
    lock = get_lock(req.client_id)

    async def generate():
        async with lock:
            touch_client(req.client_id)
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            _active_sse_queues[req.client_id] = queue

            async def drive_stream():
                try:
                    async with client.stream(
                        req.message,
                        timeout=RUN_TIMEOUT,
                        command_timeout=PI_LIMITS.command_timeout,
                    ) as stream:
                        async for event in stream:
                            payload = event_payload(event)
                            if payload is not None:
                                await queue.put(payload)
                        res = await stream.result()
                        await queue.put({"type": "__RUN_RESULT__", "result": res})
                except PiRunError as exc:
                    reason = exc.result.stop_reason
                    if reason == "aborted":
                        await queue.put({"type": "__RUN_EVENT__", "payload": {"type": "interrupted"}})
                    else:
                        await queue.put({"type": "__RUN_EVENT__", "payload": {"type": "error", "message": str(exc)}})
                except PiBusyError as exc:
                    await queue.put({"type": "__RUN_EVENT__", "payload": {"type": "error", "message": f"上一轮尚未结束: {exc}"}})
                except PiError as exc:
                    await queue.put({"type": "__RUN_EVENT__", "payload": {"type": "error", "message": f"{type(exc).__name__}: {exc}"}})
                except Exception as exc:
                    await queue.put({"type": "__RUN_EVENT__", "payload": {"type": "error", "message": str(exc)}})
                finally:
                    await queue.put({"type": "__STREAM_FINISHED__"})

            drive_task = asyncio.create_task(drive_stream())

            try:
                while True:
                    item = await queue.get()
                    item_type = item.get("type")
                    if item_type == "__STREAM_FINISHED__":
                        break
                    elif item_type == "__RUN_EVENT__":
                        yield sse(item["payload"])
                        break
                    elif item_type == "__RUN_RESULT__":
                        result = item["result"]
                        usage = result.usage
                        touch_client(req.client_id)
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
                        break
                    else:
                        # 正常流事件（text, thinking, tool, confirm_request 等）
                        yield sse(item)
            finally:
                _active_sse_queues.pop(req.client_id, None)
                if not drive_task.done():
                    drive_task.cancel()

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
    cid = req.client_id or ""
    client = _clients.get(cid)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    touch_client(cid)
    try:
        await client.abort()
    except PiError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/new")
async def new_session(req: ClientRequest) -> dict[str, Any]:
    cid = req.client_id or ""
    client = _clients.get(cid)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    touch_client(cid)
    lock = get_lock(cid)
    if lock.locked():
        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")
    await client.new_session()
    state = await client.get_state()
    return {
        "ok": True,
        "session_id": state.get("sessionId"),
        "session_file": state.get("sessionFile"),
    }


@app.post("/api/fork")
async def fork_endpoint(req: ClientRequest) -> dict[str, Any]:
    """通过 pi 原生 fork 分叉，将当前会话切到上一条用户消息处，避免重新生成污染会话。"""
    cid = req.client_id or ""
    client = _clients.get(cid)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    touch_client(cid)
    lock = get_lock(cid)
    if lock.locked():
        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")

    fork_msgs = await client.get_fork_messages()
    if not fork_msgs:
        raise HTTPException(status_code=400, detail="没有可分叉的用户消息")

    last_entry = fork_msgs[-1]
    try:
        fork_result = await client.fork(last_entry["entryId"])
    except PiError as exc:
        raise HTTPException(status_code=400, detail=f"分叉失败: {exc}") from exc

    raw = await client.get_messages()
    state = await client.get_state()
    prompt_text = fork_result.get("text") or last_entry.get("text") or ""
    return {
        "ok": True,
        "prompt": prompt_text,
        "messages": to_ui_messages(raw),
        "session_file": state.get("sessionFile"),
        "session_id": state.get("sessionId"),
    }


@app.get("/api/stats")
async def stats(client_id: str) -> dict[str, Any]:
    client = _clients.get(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    touch_client(client_id)
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
    touch_client(req.client_id)
    try:
        model = await client.set_model(req.provider, req.model_id)
    except PiError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"model": f"{model.get('provider')}/{model.get('id')}"}


@app.get("/api/history")
async def history(client_id: str) -> dict[str, Any]:
    """当前客户端独立存储目录下的历史会话列表 (按修改时间倒序)。"""
    client = _clients.get(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    touch_client(client_id)
    state = await client.get_state()
    current = state.get("sessionFile")

    folder = get_client_session_dir(client_id)
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
    touch_client(client_id)
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
    touch_client(req.client_id)
    lock = get_lock(req.client_id)
    if lock.locked():
        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")

    # 路径严格沙箱校验：必须在当前 client 的专属 session_dir 内
    allowed_dir = get_allowed_sessions_dir(req.client_id)
    target = validate_session_path(req.session_file, allowed_dir)

    try:
        result = await client.switch_session(str(target))
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


@app.post("/api/history/delete")
async def delete_session_endpoint(req: DeleteSessionRequest) -> dict[str, Any]:
    client = _clients.get(req.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    touch_client(req.client_id)
    lock = get_lock(req.client_id)
    if lock.locked():
        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")

    # 路径严格沙箱校验：必须在当前 client 的专属 session_dir 内
    allowed_dir = get_allowed_sessions_dir(req.client_id)
    target = validate_session_path(req.session_file, allowed_dir)

    state = await client.get_state()
    current_file = state.get("sessionFile")
    was_current = bool(current_file and target == Path(current_file).resolve())

    if was_current:
        # 如果删除的是当前活动会话，先创建一个新会话解除写入锁定
        await client.new_session()

    try:
        target.unlink(missing_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"删除会话文件失败: {exc}") from exc

    return {"ok": True, "was_current": was_current}
