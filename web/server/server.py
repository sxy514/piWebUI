"""pi web chat 后端: FastAPI + pi-agent-python-sdk, 多用户系统与私有工作区隔离。



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



from fastapi import FastAPI, HTTPException, Request, UploadFile, File

from fastapi.middleware.cors import CORSMiddleware

from fastapi.responses import JSONResponse, StreamingResponse, FileResponse, Response

import io

import zipfile

import mimetypes

from datetime import datetime

from pydantic import BaseModel

from pi_agent import AsyncPiClient, Event, Limits, PiBusyError, PiError, PiRunError, ImageContent

from extractor import extract_document_text



from db import (

    init_db,

    count_users,

    create_user,

    get_user_by_id,

    get_user_by_username,

    record_audit,

    User,

)

from auth import (

    hash_password,

    verify_password,

    create_access_token,

    decode_access_token,

)



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

    if source_ext.is_file():

        # 若目标文件不存在或源文件更新，自动同步覆盖

        if not target_ext.is_file() or source_ext.stat().st_mtime > target_ext.stat().st_mtime:

            shutil.copy2(source_ext, target_ext)

            log.info("已自动为当前环境就绪/更新工具审核扩展: %s", target_ext)





ensure_extensions()



# 系统安全与策略配置

CLIENT_IDLE_TIMEOUT = float(os.environ.get("PI_CLIENT_IDLE_TIMEOUT", "1800.0"))  # 默认 30 分钟无请求自动回收子进程

# 审核策略：'safe' (常规放行, 高危确认) / 'manual' (每次执行均在网页端手动确认) / 'deny' (全拒绝) / 'allow_all' (全放行)

AUTO_APPROVE_POLICY = os.environ.get("PI_AUTO_APPROVE_POLICY", "safe").lower()

# 客户端密码保存模式：'true'/'local' (长期记住), 'session' (会话级别), 'false'/'none' (完全不缓存)

AUTH_REMEMBER = os.environ.get("PI_AUTH_REMEMBER", "true").lower()

# 等待用户审核超时时间（秒）

APPROVAL_TIMEOUT = float(os.environ.get("PI_APPROVAL_TIMEOUT", "60.0"))

# 自定义工作目录配置（可选）

PI_WORKSPACE_DIR = os.environ.get("PI_WORKSPACE_DIR", "").strip()



log.info("🛡️ 工具确认审核策略: %s (超时: %.0f秒)", AUTO_APPROVE_POLICY, APPROVAL_TIMEOUT)

log.info("💾 客户端登录保持模式: %s", AUTH_REMEMBER)

if PI_WORKSPACE_DIR:

    log.info("📂 自定义工作目录基准: %s", PI_WORKSPACE_DIR)



DANGEROUS_COMMAND_PATTERNS = [

    # 敏感元数据与跨租户会话目录探测（严禁越权窃取）

    r"(?:[\\/]\.pi(?:[\\/]|$)|^\.pi(?:[\\/]|$))",

    r"\bpiweb\.db\b",

    r"\bjwt\.secret\b",

    r"\.pi[\\/]sessions",

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





def touch_client(client_key: str) -> None:

    """更新客户端最近活跃时间。"""

    _client_last_active[client_key] = time.time()





async def clean_idle_clients():

    """定期清理长时间无活动的客户端，优雅关闭 underlying node 进程以防资源泄漏。"""

    while True:

        try:

            await asyncio.sleep(60)  # 每分钟巡检一次

            now = time.time()

            idle_keys = [

                key

                for key, last_time in _client_last_active.items()

                if (now - last_time > CLIENT_IDLE_TIMEOUT)

                or (_clients.get(key) is not None and not _clients[key].running)

            ]

            for key in idle_keys:

                lock = _client_locks.get(key)

                if lock and lock.locked():

                    continue  # 任务进行中，推迟回收以防中断活跃任务

                client = _clients.pop(key, None)

                _client_locks.pop(key, None)

                _client_last_active.pop(key, None)

                _active_sse_queues.pop(key, None)

                if client is not None:

                    log.info("客户端空闲超时，主动回收释放底层进程资源: %s", key)

                    try:

                        await client.aclose()

                    except Exception as e:

                        log.warning("关闭空闲客户端 %s 时异常: %s", key, e)

        except asyncio.CancelledError:

            break

        except Exception as e:

            log.warning("clean_idle_clients 任务异常: %s", e)





def get_lock(client_key: str) -> asyncio.Lock:

    if client_key not in _client_locks:

        _client_locks[client_key] = asyncio.Lock()

    return _client_locks[client_key]





@asynccontextmanager

async def lifespan(app: FastAPI):

    # 启动时：初始化 SQLite 数据库及扩展

    init_db()

    ensure_extensions()

    clean_task = asyncio.create_task(clean_idle_clients())

    log.info("系统初始化完成，用户与工作区沙箱已就绪")

    yield

    # 关闭时：取消后台清理任务，并安全杀死所有底层 Node 子进程

    clean_task.cancel()

    try:

        await clean_task

    except asyncio.CancelledError:

        pass



    close_tasks = []

    for client in _clients.values():

        close_tasks.append(client.aclose())

    if close_tasks:

        await asyncio.gather(*close_tasks, return_exceptions=True)

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

    """多用户 JWT 鉴权中间件，纯 ASGI 实现，零开销且完美支持 SSE 长流式。"""



    def __init__(self, app):

        self.app = app



    async def __call__(self, scope, receive, send):

        if scope["type"] != "http":

            return await self.app(scope, receive, send)



        path = scope.get("path", "")

        # 放行 OPTIONS 预检请求以及非 API 路由（如静态资源）

        if scope.get("method") == "OPTIONS" or not path.startswith("/api/"):

            return await self.app(scope, receive, send)



        # 公开接口放行：状态检查、登录、注册

        public_paths = (

            "/api/auth/status",

            "/api/auth/login",

            "/api/auth/register",

        )

        if path in public_paths:

            return await self.app(scope, receive, send)



        headers = dict(scope.get("headers", []))

        auth_val = headers.get(b"authorization", b"").decode("utf-8")

        token = ""

        if auth_val.startswith("Bearer "):

            token = auth_val[7:].strip()

        elif b"x-auth-token" in headers:

            token = headers[b"x-auth-token"].decode("utf-8").strip()



        if not token and scope.get("query_string"):

            from urllib.parse import parse_qs

            qs = scope.get("query_string", b"").decode("utf-8")

            parsed = parse_qs(qs)

            if "token" in parsed and parsed["token"]:

                token = parsed["token"][0].strip()



        if not token:

            res = JSONResponse({"detail": "未登录或缺少身份凭证，请先登录"}, status_code=401)

            return await res(scope, receive, send)



        payload = decode_access_token(token)

        if not payload or "sub" not in payload:

            res = JSONResponse({"detail": "登录已过期或凭证无效，请重新登录"}, status_code=401)

            return await res(scope, receive, send)



        user = get_user_by_id(payload["sub"])

        if not user:

            res = JSONResponse({"detail": "用户不存在，请重新登录"}, status_code=401)

            return await res(scope, receive, send)

        if user.status != "active":

            res = JSONResponse({"detail": "账号已被禁用，请联系管理员"}, status_code=403)

            return await res(scope, receive, send)



        # 将解析出的用户对象存入 ASGI scope state

        scope.setdefault("state", {})["user"] = user



        return await self.app(scope, receive, send)





app.add_middleware(AuthMiddleware)





class AuthRequest(BaseModel):

    username: str

    password: str





class ClientRequest(BaseModel):

    client_id: str | None = None





class AttachmentPayload(BaseModel):

    name: str

    path: str

    size: int = 0

    size_formatted: str = ""

    is_image: bool = False

    mime_type: str = ""

    data: str = ""

    extracted_text: str = ""





class ChatRequest(BaseModel):

    client_id: str

    message: str

    attachments: list[AttachmentPayload] = []





class SwitchRequest(BaseModel):

    client_id: str

    session_file: str





class DeleteSessionRequest(BaseModel):

    client_id: str

    session_file: str





class ModelRequest(BaseModel):

    client_id: str

    provider: str

    model_id: str





class ConfirmActionRequest(BaseModel):

    client_id: str

    confirm_id: str

    approved: bool





def clean_text(text: str) -> str:

    """清理多余空行，保留段落结构。"""

    return re.sub(r"\n{3,}", "\n\n", text).strip()





def sse(data: dict[str, Any]) -> str:

    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"





def make_ui_handler(client_key: str):

    """为指定客户端连接构建交互式安全审核处理器，支持网页端人类在环手动确认。"""



    async def ui_handler(request: dict) -> object:

        method = request.get("method")

        if method != "confirm":

            return None



        title = str(request.get("title") or "")

        message = str(request.get("message") or "")

        full_desc = f"{title}\n{message}"

        is_dangerous = bool(_DANGEROUS_REGEX.search(full_desc))



        # 0. 核心安全红线：严禁任何工具探测/读写系统敏感元数据与跨租户会话目录 (.pi, piweb.db, jwt.secret)

        if re.search(r"(?:[\\/]\.pi(?:[\\/]|$)|^\.pi(?:[\\/]|$)|piweb\.db|jwt\.secret|\.pi[\\/]sessions)", full_desc, re.I):

            log.warning("🚨 [沙箱阻断] 拦截到涉及系统元数据/多租户敏感目录的未授权操作: %s", full_desc)

            return False



        # 严禁探测多租户根目录 (workspaces) 或访问其他租户的工作区

        user_id = client_key.split(":")[0] if ":" in client_key else ""

        if "workspaces" in full_desc.lower():

            ws_matches = list(re.finditer(r"workspaces(?:[\\/]([a-zA-Z0-9_\-]+))?", full_desc, re.I))

            for m in ws_matches:

                target_sub = m.group(1)

                if not target_sub or (user_id and target_sub.lower() != user_id.lower()):

                    log.warning("🚨 [沙箱阻断] 拦截到试图探测或越权访问多租户工作区 [%s]: %s", target_sub or "workspaces", full_desc)

                    return False



        # 严禁通过 .. 向上逃逸工作区

        if re.search(r"""(?<!\.)\.\.(?!\.)(?:[\\/]|$|['"\s])|\bcd\s+\.\.""", full_desc, re.I):

            log.warning("🚨 [沙箱阻断] 拦截到试图通过 '..' 逃逸工作区的命令: %s", full_desc)

            return False



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



        queue = _active_sse_queues.get(client_key)

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

            log.info("等待用户在网页端手动确认 [%s] (client=%s): %s", confirm_id, client_key, title or message)

            # 等待用户在网页端点击确认

            approved = await asyncio.wait_for(future, timeout=APPROVAL_TIMEOUT)

            log.info("用户确认结果 [%s]: %s", confirm_id, "允许执行" if approved else "拒绝执行")

            return approved

        except (asyncio.TimeoutError, asyncio.CancelledError):

            log.warning("用户确认超时或取消 [%s]，默认拒绝执行", confirm_id)

            if queue is not None:

                try:

                    await queue.put(

                        {

                            "type": "confirm_timeout",

                            "confirm_id": confirm_id,

                        }

                    )

                except Exception:

                    pass

            return False

        finally:

            _pending_confirms.pop(confirm_id, None)



    return ui_handler





# -------------------------------------------------------------

# 多租户会话目录与私有工作区沙箱 (Phase 1 & Phase 2)

# -------------------------------------------------------------



def get_user_session_dir(user_id: str) -> Path:

    """获取用户专属的会话存储目录（跨设备多端漫游与同步）。"""

    safe_uid = re.sub(r"[^a-zA-Z0-9_\-]", "", user_id) or "default"

    target = (PROJECT_DIR / ".pi" / "sessions" / safe_uid).resolve()

    target.mkdir(parents=True, exist_ok=True)

    return target





DEFAULT_AGENTS_TEMPLATE = """# Agent 行为准则与项目规范 (AGENTS.md)



> 此文件定义专属 Agent 的工作流准则、角色定位与系统级安全规范。
> 此文件为平台统一制定的系统级文件，受到强制写保护，禁止用户和 Agent 篡改。
> 个人交互偏好与称呼请在 USER.md 中定义，长期记忆请在 MEMORY.md 中维护。

## 0. 配置文件只读保护与权责边界 (重要红线)
- **AGENTS.md 强制只读**：此文件为平台制定的系统级行为规范与多租户安全红线，受到强制写保护，严禁通过任何文件工具或终端命令修改、覆盖或删除 `AGENTS.md`。
- **偏好分流**：当用户提出修改称呼、语言风格或输出要求时，必须引导并更新到专属 `USER.md`。
- **记忆沉淀**：当用户设定重要技术约定、业务共识或纠错时，必须更新到专属 `MEMORY.md`。

## 1. 角色定位与回复风格

- **身份定位**：全能型软件工程师与高级开发助理。

- **回复风格**：直接、精准、清晰。优先给出可落地的解决方案和完整代码，避免冗余寒暄。

- **语言习惯**：中文交流，专业术语保留标准英文表达。



## 2. 个人画像与长期记忆协同

- **用户个性化**：请结合专属 `USER.md` 中的偏好为用户提供贴合习惯的解答。

- **长期记忆维护**：当用户达成重要技术共识、设定项目约定或纠正错误时，主动通过工具更新沉淀到专属 `MEMORY.md` 中。



## 3. 编码与工程规范

- **代码质量**：注重安全性、健壮性与边界异常处理。

- **增量编辑**：进行代码修改时，尽量保持既有代码风格和注释完整性。

- **环境适配**：终端命令优先使用兼容当前宿主机系统的语法。



## 4. 运行规则与沙箱安全边界 (系统级红线)

- **严格空间受限 (Strict Jail)**：

  - 你的所有文件读写、创建以及终端命令执行，**绝对且唯一受限于当前工作空间**。

  - **严禁越界逃逸**：绝对禁止在命令或参数中使用 `..` 尝试向上逃逸、禁止切换目录（`cd ..`）、禁止扫描宿主机根驱动器（如 `C:\\`、`G:\\`）或上级工程目录。

  - **多租户隔离红线**：系统中不存在任何对你开放的其他工作区，绝对禁止尝试探测、列出、遍历或访问 `workspaces` 根目录或其他任何租户的空间。

  - **敏感元数据绝对禁区**：严禁探测、读取或修改任何以 `.pi` 开头的隐藏目录、系统数据库（`piweb.db`）、会话存储（`.pi/sessions`）或认证凭证（`jwt.secret`）。

- **用户咨询答复规范**：

  - 若用户询问“是否存在其他工作区”或要求“查看别的用户空间”，必须直接且明确地告知：“我当前运行在为你分配的专属独立安全沙箱中，系统实施了严格的租户隔离，我无法、也不会探测系统中可能存在的其他空间”。

- **成果文件产出规范**：

  - 生成的代码、报表、文档或产物保存在当前工作区相应子目录中，用户可直接在前端「成果文件」抽屉中一键下载或打包。

- **高危破坏性指令警示**：

  - 严禁执行未受保护的批量删除（如 `rm -rf /`、`del /s`）、磁盘格式化或关机等破坏性指令。



## 5. 用户专属约定

- 专属归属：用户 `{username}` 的私有工作区沙箱。

"""



DEFAULT_USER_TEMPLATE = """# 用户画像与个人偏好 (USER.md)



> 此文件记录当前用户的个人偏好与交互习惯，系统会在每次对话前自动加载此配置。

> 您可以直接在此修改，也可以在聊天中让 AI 帮您更新。



## 1. 基础信息

- **用户称呼**：`{username}`

- **技术角色**：软件工程师 / 架构师

- **工作语言**：中文（技术名词保留英文）



## 2. 交互偏好

- **直奔主题**：解答直接切入核心，无需过多铺垫说明。

- **代码优先**：涉及功能实现时，优先给出规范、完整的代码片段。

- **方案对比**：存在多种方案时，先简要列出优缺点与推荐方案。

"""



DEFAULT_MEMORY_TEMPLATE = """# 长期知识记忆库 (MEMORY.md)



> 此文件是专属工作区的跨会话记忆库。系统在每次对话时会自动加载这里的记忆。

> 当您与 AI 聊到重要技术决策、常用环境配置或特定业务规则时，AI 会将要点沉淀在此。



## 1. 基础环境事实

- 归属用户：`{username}`

- 默认沙箱：本工作区



## 2. 核心技术约定

- （暂无，在对话中确认的架构约定或开发偏好将自动记录在此）



## 3. 踩坑与避坑记录

- （暂无，历史排查解决的特殊 Bug 或关键配置将记录在此）

"""





def ensure_user_agent_config(workspace_dir: Path, username: str = "") -> None:

    """确保用户工作区内拥有完整的 Agent 三件套配置文件 (AGENTS.md, USER.md, MEMORY.md)。"""

    uname = username or "developer"

    configs = [

        ("AGENTS.md", DEFAULT_AGENTS_TEMPLATE),

        ("USER.md", DEFAULT_USER_TEMPLATE),

        ("MEMORY.md", DEFAULT_MEMORY_TEMPLATE),

    ]

    for filename, template in configs:

        target_file = workspace_dir / filename

        if not target_file.is_file():

            try:

                content = template.replace("{username}", uname)

                target_file.write_text(content, encoding="utf-8")

                log.info("已为用户工作区自动就绪配置文件: %s", target_file)

            except Exception as e:

                log.warning("初始化 %s 失败: %s", filename, e)





def get_user_workspace_dir(user_id: str, username: str = "") -> Path:

    """获取用户的工作区沙箱目录（Agent 执行命令、读写文件的工作目录）。"""

    safe_uid = re.sub(r"[^a-zA-Z0-9_\-]", "", user_id) or "default"

    safe_uname = re.sub(r"[^a-zA-Z0-9_\-]", "", username) if username else safe_uid

    if PI_WORKSPACE_DIR:

        # 支持占位符 {user_id} 或 {username}

        rendered = PI_WORKSPACE_DIR.replace("{user_id}", safe_uid)

        rendered = rendered.replace("{username}", safe_uname)

        target = Path(rendered)

        if not target.is_absolute():

            target = (PROJECT_DIR / target).resolve()

        else:

            target = target.resolve()

    else:

        # 默认多租户沙箱隔离模式

        target = (PROJECT_DIR / "workspaces" / safe_uid).resolve()



    target.mkdir(parents=True, exist_ok=True)

    ensure_user_agent_config(target, safe_uname)

    return target





def get_client_key(user_id: str, client_id: str) -> str:

    """将 user_id 与当前终端 client_id 联合编码作为活跃进程标识。"""

    safe_cid = re.sub(r"[^a-zA-Z0-9_\-]", "", client_id) or "default"

    return f"{user_id}_{safe_cid}"





def get_user_and_key(request: Request, client_id: str) -> tuple[User, str]:

    """从请求中提取已通过鉴权的用户对象及当前终端 Key。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")

    key = get_client_key(user.id, client_id)

    return user, key





def validate_session_path(session_file: str, allowed_dir: Path) -> Path:

    """严格防路径穿越校验，确保只能访问当前用户所属的会话目录。"""

    try:

        resolved = Path(session_file).resolve()

    except (ValueError, OSError) as exc:

        raise HTTPException(status_code=400, detail="非法文件路径") from exc



    try:

        resolved.relative_to(allowed_dir)

    except ValueError as exc:

        raise HTTPException(status_code=403, detail="禁止访问未授权的会话目录") from exc



    if not resolved.is_file():

        raise HTTPException(status_code=404, detail="会话文件不存在")

    return resolved





async def get_client(user_id: str, client_id: str) -> AsyncPiClient:

    """安全获取或创建客户端实例，隔离工作区与独立会话目录。底层进程若已终止则自动自愈重建。"""

    key = get_client_key(user_id, client_id)

    touch_client(key)

    client = _clients.get(key)

    if client is not None:

        if client.running:

            return client

        log.warning("检测到客户端实例 %s 底层进程未运行 (running=False)，自动注销回收并重新启动", key)

        try:

            await client.aclose()

        except Exception:

            pass

        _clients.pop(key, None)



    async with _creation_lock:

        client = _clients.get(key)

        if client is not None:

            if client.running:

                return client

            try:

                await client.aclose()

            except Exception:

                pass

            _clients.pop(key, None)



        user = get_user_by_id(user_id)

        uname = user.username if user else ""

        session_dir = get_user_session_dir(user_id)

        workspace_dir = get_user_workspace_dir(user_id, uname)

        ext_script = PROJECT_DIR / "web" / "server" / "extensions" / "web_approval.js"



        extra_args = ["--offline", "--approve"]

        if ext_script.is_file():

            extra_args.extend(["--extension", str(ext_script)])



        client = AsyncPiClient(

            executable=PI_EXECUTABLE,

            cwd=str(workspace_dir),

            session_dir=str(session_dir),

            ui_handler=make_ui_handler(key),

            limits=PI_LIMITS,

            extra_args=extra_args,

        )

        await client.start()

        _clients[key] = client

        if key not in _client_locks:

            _client_locks[key] = asyncio.Lock()

        touch_client(key)

        state = await client.get_state()

        model = state.get("model") or {}

        log.info(

            "client %s started (user=%s, workspace=%s, session_dir=%s): %s/%s",

            key,

            user_id,

            workspace_dir,

            session_dir,

            model.get("provider"),

            model.get("id"),

        )

        return client





# -------------------------------------------------------------

# 身份认证 API

# -------------------------------------------------------------



@app.get("/api/auth/status")

async def auth_status() -> dict[str, Any]:

    """检查系统认证模式、是否已有注册用户以及保持模式。"""

    return {

        "auth_mode": "user",

        "auth_required": True,

        "has_users": count_users() > 0,

        "auth_remember": AUTH_REMEMBER,

    }





@app.post("/api/auth/register")

async def register_endpoint(req: AuthRequest) -> dict[str, Any]:

    """用户注册。首位注册者自动成为管理员。"""

    username = req.username.strip()

    if len(username) < 3 or len(username) > 32:

        raise HTTPException(status_code=400, detail="用户名长度需在 3 到 32 个字符之间")

    if not re.match(r"^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$", username):

        raise HTTPException(status_code=400, detail="用户名仅支持中英文字符、数字与下划线")

    if len(req.password) < 6:

        raise HTTPException(status_code=400, detail="密码长度不能少于 6 位")



    if get_user_by_username(username) is not None:

        raise HTTPException(status_code=409, detail="该用户名已被注册")



    pw_hash = hash_password(req.password)

    user = create_user(username, pw_hash)

    token = create_access_token(user)

    record_audit(user.id, "register", f"新用户注册: {user.username} (角色: {user.role})")

    return {

        "token": token,

        "user": user.to_dict(),

    }





@app.post("/api/auth/login")

async def login_endpoint(req: AuthRequest) -> dict[str, Any]:

    """用户登录并签发 JWT 访问令牌。"""

    username = req.username.strip()

    user = get_user_by_username(username)

    if user is None or not verify_password(req.password, user.password_hash):

        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if user.status != "active":

        raise HTTPException(status_code=403, detail="该账号已被禁用，请联系管理员")



    token = create_access_token(user)

    record_audit(user.id, "login", f"用户登录: {user.username}")

    return {

        "token": token,

        "user": user.to_dict(),

    }





@app.get("/api/auth/me")

async def get_me_endpoint(request: Request) -> dict[str, Any]:

    """获取当前已登录用户的详情。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="未登录或登录已失效")

    return {"user": user.to_dict()}





@app.post("/api/auth/logout")

async def logout_endpoint(request: Request) -> dict[str, Any]:

    """退出登录并记录审计日志。"""

    user: User | None = getattr(request.state, "user", None)

    if user:

        record_audit(user.id, "logout", f"用户退出登录: {user.username}")

    return {"ok": True}





# -------------------------------------------------------------

# 业务 API

# -------------------------------------------------------------



@app.post("/api/confirm")

async def confirm_action_endpoint(req: ConfirmActionRequest, request: Request) -> dict[str, Any]:

    """接收用户在网页端对工具执行的手动确认结果。"""

    user, key = get_user_and_key(request, req.client_id)

    touch_client(key)

    future = _pending_confirms.get(req.confirm_id)

    if future and not future.done():

        future.set_result(req.approved)

        if not req.approved:

            # 用户选择【拒绝】，主动中止当前任务，停止后续工具与回复生成

            async def trigger_abort():

                await asyncio.sleep(0.05)

                client = _clients.get(key)

                if client is not None:

                    try:

                        await client.abort()

                    except Exception as e:

                        log.debug("abort after rejection: %s", e)



            asyncio.create_task(trigger_abort())

        return {"ok": True}

    return {"ok": False, "expired": True}





@app.post("/api/session")

async def create_session(req: ClientRequest, request: Request) -> dict[str, Any]:

    """创建或恢复客户端会话，自动归属至当前用户目录。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    client_id = req.client_id or uuid.uuid4().hex

    try:

        client = await get_client(user.id, client_id)

        state = await client.get_state()

    except PiError as exc:

        raise HTTPException(status_code=500, detail=f"启动 pi 失败: {exc}") from exc

    model = state.get("model") or {}

    return {

        "client_id": client_id,

        "model": f"{model.get('provider')}/{model.get('id')}",

        "context_window": model.get("contextWindow", 262144),

        "max_tokens": model.get("maxTokens", 8192),

        "session_id": state.get("sessionId"),

        "user": user.to_dict(),

    }





@app.post("/api/session/close")

async def close_session(req: ClientRequest, request: Request) -> dict[str, bool]:

    user, key = get_user_and_key(request, req.client_id or "")

    client = _clients.pop(key, None)

    _client_locks.pop(key, None)

    _client_last_active.pop(key, None)

    _active_sse_queues.pop(key, None)

    if client is not None:

        log.info("用户主动注销客户端实例: %s", key)

        await client.aclose()

        return {"ok": True}

    return {"ok": False}





def event_payload(event: Event) -> dict[str, Any] | None:

    t = event.type

    raw = getattr(event, "raw", {}) or {}



    # 1. 核心协议：message_update (包含 text_delta / thinking_delta)

    if t == "message_update":

        sub = raw.get("assistantMessageEvent")

        if isinstance(sub, dict):

            st = sub.get("type")

            if st == "text_delta":

                return {"type": "text", "delta": sub.get("delta", "")}

            elif st == "thinking_delta":

                return {"type": "thinking", "delta": sub.get("delta", "")}



    # 兼容扁平分发模式

    if t == "text_delta":

        delta = getattr(event, "delta", None) or raw.get("delta", "")

        return {"type": "text", "delta": delta}

    if t == "thinking_delta":

        delta = getattr(event, "delta", None) or raw.get("delta", "")

        return {"type": "thinking", "delta": delta}



    # 2. 工具开始执行事件

    if t in ("tool_execution_start", "tool_call_start"):

        tool_name = raw.get("toolName") or getattr(event, "tool_name", None)

        return {"type": "tool_start", "name": tool_name}



    # 3. 工具执行更新事件 (包含参数等)

    if t in ("tool_execution_update", "tool_call_update"):

        tool_name = raw.get("toolName") or getattr(event, "tool_name", None)

        args = raw.get("args") if "args" in raw else getattr(event, "arguments", None)

        return {"type": "tool_exec", "name": tool_name, "args": args}



    # 4. 工具执行完成事件

    if t in ("tool_execution_end", "tool_call_end"):

        tool_name = raw.get("toolName") or getattr(event, "tool_name", None)

        is_error = raw.get("isError") if "isError" in raw else getattr(event, "is_error", False)

        res = raw.get("result") if "result" in raw else getattr(event, "result", None)



        text = ""

        if hasattr(res, "content"):

            content = getattr(res, "content")

        elif isinstance(res, dict):

            content = res.get("content")

        else:

            content = None



        if isinstance(content, list):

            for b in content:

                if isinstance(b, dict) and b.get("type") == "text":

                    text += b.get("text", "")

                elif hasattr(b, "type") and getattr(b, "type") == "text":

                    text += getattr(b, "text", "")

        elif isinstance(content, str):

            text = content

        elif isinstance(res, str):

            text = res

        elif res is not None:

            try:

                text = json.dumps(res, ensure_ascii=False)

            except Exception:

                text = str(res)



        return {

            "type": "tool_end",

            "name": tool_name,

            "ok": not bool(is_error),

            "result": text[:TOOL_RESULT_MAX],

        }



    return None





@app.post("/api/chat")

async def chat(req: ChatRequest, request: Request):

    user, key = get_user_and_key(request, req.client_id)

    client = await get_client(user.id, req.client_id)

    lock = get_lock(key)

    if lock.locked():

        raise HTTPException(status_code=409, detail="上一轮回答尚未结束")



    async def generate():

        async with lock:

            touch_client(key)

            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

            _active_sse_queues[key] = queue



            async def drive_stream():

                try:

                    images: list[ImageContent] = []

                    doc_sections: list[str] = []

                    for att in req.attachments:

                        if att.is_image and att.data:

                            images.append(

                                {

                                    "type": "image",

                                    "data": att.data,

                                    "mimeType": att.mime_type or "image/png",

                                }

                            )

                        else:

                            doc_item = f"📎 **用户上传附件**: `{att.path}` ({att.size_formatted})"

                            if att.extracted_text:

                                doc_item += f"\n```text\n{att.extracted_text[:20000]}\n```"

                            doc_sections.append(doc_item)



                    final_message = req.message

                    if doc_sections:

                        final_message = "\n\n".join(doc_sections) + f"\n\n---\n**用户提问与任务要求**:\n{req.message}"



                    async with client.stream(

                        final_message,

                        images=images if images else None,

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

                    if not client.running:

                        log.warning("会话流结束后检测到底层客户端 %s 已退出，自动从缓存中清除", key)

                        _clients.pop(key, None)

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

                        touch_client(key)

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

                _active_sse_queues.pop(key, None)

                if not drive_task.done():

                    drive_task.cancel()



    return StreamingResponse(

        generate(),

        media_type="text/event-stream",

        headers={

            "Cache-Control": "no-cache",

            "X-Accel-Buffering": "no",

        },

    )





def session_title(path: Path) -> str:

    """提取首条用户消息前 40 字作为会话展示标题。"""

    try:

        with path.open(encoding="utf-8") as f:

            for line_idx, line in enumerate(f):

                if line_idx > 40:

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

async def interrupt(req: ClientRequest, request: Request) -> dict[str, bool]:

    user, key = get_user_and_key(request, req.client_id or "")

    client = _clients.get(key)

    if client is None:

        raise HTTPException(status_code=404, detail="会话不存在")

    touch_client(key)

    try:

        await client.abort()

    except PiError as exc:

        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {"ok": True}





@app.post("/api/new")

async def new_session(req: ClientRequest, request: Request) -> dict[str, Any]:

    user, key = get_user_and_key(request, req.client_id or "")

    client = await get_client(user.id, req.client_id or "")

    touch_client(key)

    lock = get_lock(key)

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

async def fork_endpoint(req: ClientRequest, request: Request) -> dict[str, Any]:

    """通过 pi 原生 fork 分叉，将当前会话切到上一条用户消息处，避免重新生成污染会话。"""

    user, key = get_user_and_key(request, req.client_id or "")

    client = await get_client(user.id, req.client_id or "")

    touch_client(key)

    lock = get_lock(key)

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

async def stats(client_id: str, request: Request) -> dict[str, Any]:

    user, key = get_user_and_key(request, client_id)

    client = await get_client(user.id, client_id)

    touch_client(key)

    try:

        return await client.get_session_stats()

    except Exception as e:

        log.warning("获取 stats 失败: %s", e)

        if not client.running:

            _clients.pop(key, None)

        return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost": 0.0}





@app.get("/api/models")

async def models(request: Request) -> list[dict[str, Any]]:

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    for client in _clients.values():

        try:

            available = await client.get_available_models()

            return [

                {

                    "id": m.get("id"),

                    "name": m.get("name"),

                    "provider": m.get("provider"),

                    "context_window": m.get("contextWindow", 262144),

                    "max_tokens": m.get("maxTokens", 8192),

                }

                for m in available

            ]

        except PiError:

            continue



    # 如果当前没有任何客户端在运行，临时拉起一个探针检查可用模型

    temp_client = await get_client(user.id, "probe")

    available = await temp_client.get_available_models()

    return [

        {

            "id": m.get("id"),

            "name": m.get("name"),

            "provider": m.get("provider"),

            "context_window": m.get("contextWindow", 262144),

            "max_tokens": m.get("maxTokens", 8192),

        }

        for m in available

    ]





@app.post("/api/model")

async def set_model(req: ModelRequest, request: Request) -> dict[str, Any]:

    user, key = get_user_and_key(request, req.client_id)

    client = await get_client(user.id, req.client_id)

    touch_client(key)

    try:

        model = await client.set_model(req.provider, req.model_id)

    except PiError as exc:

        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {

        "model": f"{model.get('provider')}/{model.get('id')}",

        "context_window": model.get("contextWindow", 262144),

        "max_tokens": model.get("maxTokens", 8192),

    }





@app.get("/api/history")

async def history(client_id: str, request: Request) -> dict[str, Any]:

    """当前用户独立存储目录下的历史会话列表 (支持跨设备多端漫游)。"""

    user, key = get_user_and_key(request, client_id)

    client = await get_client(user.id, client_id)

    touch_client(key)

    try:

        state = await client.get_state()

        current = state.get("sessionFile")

    except Exception as e:

        log.warning("获取 history 状态失败: %s", e)

        if not client.running:

            _clients.pop(key, None)

        current = None



    folder = get_user_session_dir(user.id)

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

async def get_messages_endpoint(client_id: str, request: Request) -> dict[str, Any]:

    user, key = get_user_and_key(request, client_id)

    client = await get_client(user.id, client_id)

    touch_client(key)

    try:

        raw = await client.get_messages()

        state = await client.get_state()

        return {

            "messages": to_ui_messages(raw),

            "session_file": state.get("sessionFile"),

            "session_id": state.get("sessionId"),

        }

    except Exception as e:

        log.warning("获取 messages 失败: %s", e)

        if not client.running:

            _clients.pop(key, None)

        return {"messages": [], "session_file": None, "session_id": None}





@app.post("/api/switch")

async def switch_session_endpoint(req: SwitchRequest, request: Request) -> dict[str, Any]:

    user, key = get_user_and_key(request, req.client_id)

    client = await get_client(user.id, req.client_id)

    touch_client(key)

    lock = get_lock(key)

    if lock.locked():

        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")



    # 路径严格沙箱校验：必须在当前用户专属 session_dir 内

    allowed_dir = get_user_session_dir(user.id)

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

async def delete_session_endpoint(req: DeleteSessionRequest, request: Request) -> dict[str, Any]:

    user, key = get_user_and_key(request, req.client_id)

    client = await get_client(user.id, req.client_id)

    touch_client(key)

    lock = get_lock(key)

    if lock.locked():

        raise HTTPException(status_code=409, detail="回答进行中, 请先停止")



    # 路径严格沙箱校验：必须在当前用户专属 session_dir 内

    allowed_dir = get_user_session_dir(user.id)

    target = validate_session_path(req.session_file, allowed_dir)



    state = await client.get_state()

    current_file = state.get("sessionFile")

    was_current = bool(current_file and target == Path(current_file).resolve())



    if was_current:

        # 如果删除的是当前活动会话，先安全中断当前任务并创建新会话

        try:

            await client.interrupt()

        except Exception:

            pass

        await client.new_session()



    try:

        target.unlink(missing_ok=True)

    except OSError as exc:

        raise HTTPException(status_code=500, detail=f"删除会话文件失败: {exc}") from exc



    return {"ok": True, "was_current": was_current}





# -------------------------------------------------------------

# 工作区文件获取与下载 API

# -------------------------------------------------------------



def format_file_size(size_bytes: int) -> str:

    """人类可读的文件大小格式化。"""

    if size_bytes >= 1024 * 1024 * 1024:

        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"

    if size_bytes >= 1024 * 1024:

        return f"{size_bytes / (1024 * 1024):.1f} MB"

    if size_bytes >= 1024:

        return f"{size_bytes / 1024:.1f} KB"

    return f"{size_bytes} B"





def is_forbidden_workspace_path(rel_path: str) -> bool:

    """沙箱阻断：严禁访问或下载系统内部元数据与敏感凭证。"""

    p = rel_path.replace("\\", "/").strip("/").lower()

    forbidden_parts = {".pi", "node_modules", ".git", "__pycache__", ".system_generated"}

    parts = p.split("/")

    for part in parts:

        if part in forbidden_parts or part.endswith(".pyc"):

            return True

    if any(secret in p for secret in ["jwt.secret", "piweb.db", ".env"]):

        return True

    return False





AGENT_CONFIG_FILES = {"agents.md", "user.md", "memory.md"}





def is_agent_config_file(rel_path: str) -> bool:

    """检查是否为 Agent 人设配置与记忆文件 (AGENTS.md, USER.md, MEMORY.md)。"""

    p = rel_path.replace("\\", "/").strip("/").lower()

    parts = p.split("/")

    return len(parts) == 1 and parts[0] in AGENT_CONFIG_FILES





@app.get("/api/workspace/files")

async def list_workspace_files(request: Request, include_system: bool = False) -> dict[str, Any]:

    """获取当前登录用户独立工作区下的文件与目录列表。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    workspace_dir = get_user_workspace_dir(user.id, user.username)

    if not workspace_dir.exists():

        workspace_dir.mkdir(parents=True, exist_ok=True)



    items = []

    total_size = 0

    total_files = 0



    try:

        count = 0

        MAX_FILES = 1000

        for p in workspace_dir.rglob("*"):

            if count >= MAX_FILES:

                break

            if p.is_symlink():

                continue

            try:

                rel = p.relative_to(workspace_dir).as_posix()

                resolved_rel = p.resolve().relative_to(workspace_dir.resolve()).as_posix()

            except ValueError:

                continue



            if is_forbidden_workspace_path(rel) or is_forbidden_workspace_path(resolved_rel):

                continue



            # 成果文件列表中默认隐藏 Agent 人设与记忆文件 (AGENTS.md, USER.md, MEMORY.md)

            if not include_system and (is_agent_config_file(rel) or is_agent_config_file(resolved_rel)):

                continue



            count += 1

            is_dir = p.is_dir()

            size = 0

            mtime = 0

            try:

                stat = p.stat()

                size = stat.st_size if not is_dir else 0

                mtime = stat.st_mtime

            except OSError:

                pass



            ext = p.suffix.lstrip(".").lower() if not is_dir else ""



            if not is_dir:

                total_files += 1

                total_size += size



            items.append({

                "name": p.name,

                "path": rel,

                "is_dir": is_dir,

                "size": size,

                "size_formatted": format_file_size(size) if not is_dir else "-",

                "mtime": mtime,

                "extension": ext,

            })

    except Exception as exc:

        log.warning("扫描工作区文件失败: %s", exc)



    # 排序：修改时间倒序（最新生成的排在前面）

    items.sort(key=lambda x: (not x["is_dir"], x["mtime"]), reverse=True)



    return {

        "workspace": str(workspace_dir.name),

        "total_files": total_files,

        "total_size": total_size,

        "total_size_formatted": format_file_size(total_size),

        "items": items,

    }





@app.get("/api/workspace/file/download")

async def download_workspace_file(path: str, preview: bool = False, request: Request = None) -> Response:

    """下载或预览工作区内的单个文件。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    if not path or not path.strip():

        raise HTTPException(status_code=400, detail="缺少文件路径")



    workspace_dir = get_user_workspace_dir(user.id, user.username)

    if not workspace_dir.exists():

        raise HTTPException(status_code=404, detail="工作区不存在")



    clean_path = path.strip().replace("\\", "/")

    if is_forbidden_workspace_path(clean_path):

        raise HTTPException(status_code=403, detail="禁止访问敏感文件")



    target_path = (workspace_dir / clean_path).resolve()

    try:

        resolved_rel = target_path.relative_to(workspace_dir.resolve()).as_posix()

    except ValueError:

        raise HTTPException(status_code=403, detail="非法越界访问")



    if is_forbidden_workspace_path(resolved_rel):

        raise HTTPException(status_code=403, detail="禁止访问敏感文件")



    if not target_path.is_file():

        raise HTTPException(status_code=404, detail="文件不存在")



    mime_type, _ = mimetypes.guess_type(target_path.name)

    if not mime_type:

        mime_type = "application/octet-stream"



    disposition_type = "inline" if preview else "attachment"



    from urllib.parse import quote

    filename_encoded = quote(target_path.name)

    headers = {

        "Content-Disposition": f"{disposition_type}; filename*=UTF-8''{filename_encoded}"

    }



    return FileResponse(

        path=target_path,

        media_type=mime_type,

        headers=headers,

    )





@app.get("/api/workspace/archive")

async def download_workspace_archive(request: Request) -> Response:

    """将当前用户工作区的所有生成成果打包为 ZIP 压缩包下载。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    workspace_dir = get_user_workspace_dir(user.id, user.username)

    if not workspace_dir.exists():

        raise HTTPException(status_code=404, detail="工作区不存在")



    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:

        count = 0

        MAX_ARCHIVE_FILES = 2000

        for p in workspace_dir.rglob("*"):

            if count >= MAX_ARCHIVE_FILES:

                break

            if not p.is_file() or p.is_symlink():

                continue

            try:

                rel = p.relative_to(workspace_dir).as_posix()

                resolved_rel = p.resolve().relative_to(workspace_dir.resolve()).as_posix()

            except ValueError:

                continue

            if is_forbidden_workspace_path(rel) or is_forbidden_workspace_path(resolved_rel):

                continue

            if is_agent_config_file(rel) or is_agent_config_file(resolved_rel):

                continue

            zf.write(p, rel)

            count += 1



    data = buf.getvalue()

    now_str = datetime.now().strftime("%Y%m%d_%H%M%S")

    safe_uname = re.sub(r"[^a-zA-Z0-9_\-]", "", user.username) or "user"

    zip_filename = f"workspace_{safe_uname}_{now_str}.zip"

    from urllib.parse import quote

    filename_encoded = quote(zip_filename)



    return Response(

        content=data,

        media_type="application/zip",

        headers={

            "Content-Disposition": f"attachment; filename*=UTF-8''{filename_encoded}",

            "Content-Length": str(len(data)),

        },

    )











@app.delete("/api/workspace/file")

async def delete_workspace_file(path: str, request: Request) -> dict[str, Any]:

    """删除工作区内的单个成果文件或子目录。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    if not path or not path.strip():

        raise HTTPException(status_code=400, detail="缺少文件路径")



    workspace_dir = get_user_workspace_dir(user.id, user.username)

    if not workspace_dir.exists():

        raise HTTPException(status_code=404, detail="工作区不存在")



    clean_path = path.strip().replace("\\", "/").lstrip("/")

    if not clean_path:

        raise HTTPException(status_code=400, detail="非法文件路径")



    if is_forbidden_workspace_path(clean_path):

        raise HTTPException(status_code=403, detail="禁止删除系统内部文件")



    if is_agent_config_file(clean_path):

        raise HTTPException(status_code=403, detail="禁止删除 Agent 人设与记忆文件")



    target_path = (workspace_dir / clean_path).resolve()

    try:

        resolved_rel = target_path.relative_to(workspace_dir.resolve()).as_posix()

    except ValueError:

        raise HTTPException(status_code=403, detail="非法越界访问")



    if is_forbidden_workspace_path(resolved_rel) or is_agent_config_file(resolved_rel):

        raise HTTPException(status_code=403, detail="禁止删除受保护的文件")



    if target_path == workspace_dir.resolve():

        raise HTTPException(status_code=403, detail="禁止删除工作区根目录")



    if not target_path.exists():

        raise HTTPException(status_code=404, detail="目标文件或目录不存在")



    try:

        if target_path.is_file() or target_path.is_symlink():

            target_path.unlink()

        elif target_path.is_dir():

            import shutil

            shutil.rmtree(target_path)

    except Exception as e:

        log.error("删除文件失败 %s: %s", target_path, e)

        raise HTTPException(status_code=500, detail=f"删除失败: {e}")



    return {"success": True, "path": clean_path, "message": "文件已成功删除"}





@app.post("/api/workspace/clear")

async def clear_workspace(request: Request) -> dict[str, Any]:

    """清空当前用户工作区的所有生成成果与上传文件（安全保留 Agent 人设与记忆文件）。"""

    user: User | None = getattr(request.state, "user", None)

    if not user:

        raise HTTPException(status_code=401, detail="请先登录")



    workspace_dir = get_user_workspace_dir(user.id, user.username)

    if not workspace_dir.exists():

        return {"success": True, "deleted_count": 0, "message": "工作区为空"}



    deleted_count = 0

    import shutil

    for item in list(workspace_dir.iterdir()):

        try:

            rel = item.relative_to(workspace_dir).as_posix()

            resolved_rel = item.resolve().relative_to(workspace_dir.resolve()).as_posix()

        except ValueError:

            continue



        if is_forbidden_workspace_path(rel) or is_forbidden_workspace_path(resolved_rel):

            continue

        if is_agent_config_file(rel) or is_agent_config_file(resolved_rel):

            continue



        try:

            if item.is_file() or item.is_symlink():

                item.unlink()

                deleted_count += 1

            elif item.is_dir():

                shutil.rmtree(item)

                deleted_count += 1

        except Exception as e:

            log.warning("清空工作区文件失败 %s: %s", item, e)



    return {"success": True, "deleted_count": deleted_count, "message": f"已清空 {deleted_count} 项成果文件"}





@app.post("/api/workspace/upload")



async def upload_workspace_file(



    request: Request,



    file: UploadFile = File(...),



) -> dict[str, Any]:



    """用户上传文件/图片并自动保存到当前用户的独立工作区 uploads/ 目录。"""



    user: User | None = getattr(request.state, "user", None)



    if not user:



        raise HTTPException(status_code=401, detail="请先登录")







    if not file.filename:



        raise HTTPException(status_code=400, detail="未选择文件")







    workspace_dir = get_user_workspace_dir(user.id, user.username)



    uploads_dir = workspace_dir / "uploads"



    uploads_dir.mkdir(parents=True, exist_ok=True)







    raw_filename = Path(file.filename).name



    safe_name = re.sub(r'[\/\\:\*\?"<>\|]', '_', raw_filename).strip()



    if not safe_name:



        safe_name = f"upload_{int(time.time())}.dat"







    target_file = uploads_dir / safe_name



    if target_file.exists():



        stem = target_file.stem



        suffix = target_file.suffix



        safe_name = f"{stem}_{int(time.time())}{suffix}"



        target_file = uploads_dir / safe_name







    content = await file.read()



    file_size = len(content)



    if file_size > 50 * 1024 * 1024:



        raise HTTPException(status_code=413, detail="文件体积超出 50MB 限制")







    target_file.write_bytes(content)







    rel_path = target_file.relative_to(workspace_dir).as_posix()



    ext = target_file.suffix.lower()







    image_extensions = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}



    is_image = ext in image_extensions







    b64_data = ""



    extracted_text = ""



    import base64







    mime_type, _ = mimetypes.guess_type(target_file.name)



    if not mime_type:



        mime_type = "image/png" if is_image else "application/octet-stream"







    if is_image:



        b64_data = base64.b64encode(content).decode("ascii")



    else:



        extracted_text = extract_document_text(target_file)







    return {



        "ok": True,



        "name": safe_name,



        "path": rel_path,



        "size": file_size,



        "size_formatted": format_file_size(file_size),



        "is_image": is_image,



        "mime_type": mime_type,



        "data": b64_data,



        "extracted_text": extracted_text,



    }



