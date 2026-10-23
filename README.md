# Pi AI Agent 实验项目

基于 **[pi-agent-python-sdk](https://pypi.org/project/pi-agent-python-sdk)**（把 [Pi](https://pi.dev) 编码助手作为 Python API 调用）的实验项目，包含：

- **CLI 演示脚本**：SDK 同步/异步用法、终端连续对话
- **Web 聊天应用**：FastAPI + SSE 流式后端，React + ObsidianUI 玻璃质感前端（对标 Kimi/DeepSeek 布局，支持局域网多设备访问与安全鉴权）

```
AIAgentPr/
├── demo_pi_sdk.py          # 同步 SDK 演示（run/stream/多轮记忆/工具调用）
├── demo_async.py           # 异步 SDK 演示（流式 + 双会话并发）
├── chat.py                 # 终端连续对话（斜杠命令/中断/切模型）
├── .env.example            # 环境变量配置模板（访问密码/超时/CORS/审核策略）
├── web/
│   ├── server/             # FastAPI 后端（SSE 流式 + 历史会话管理 + ASGI 鉴权）
│   │   ├── server.py
│   │   └── requirements.txt
│   └── client/             # React + Vite + ObsidianUI 前端
│       ├── src/
│       │   ├── App.tsx             # 主布局（侧边栏/顶栏/对话列/输入区/鉴权拦截）
│       │   ├── components/         # Sidebar/Composer/MessageItem/AuthModal/ThemeMenu...
│       │   └── lib/                # SSE 客户端 + Markdown 渲染管线 + 鉴权管理
│       └── scripts/test-markdown.mjs
└── README.md
```

## 环境要求

| 依赖 | 版本/说明 |
|------|-----------|
| Python | 3.11+（CLI 用主环境；Web 后端用 `piWeb` 环境） |
| Node.js | 20+（实测 v24） |
| [pi](https://pi.dev) | ≥ 0.85.1（全局 npm 安装，实测 0.87.1） |
| LM Studio | 本地运行于 `localhost:1234`，默认模型 `lmstudio/ornith-1.5-9b` |

> pi 的模型/认证配置沿用 `~/.pi/agent/`（settings.json、auth.json）。
> 未启动 LM Studio 时可改用其他已配置的提供方（如 Anthropic、OpenAI 等）。

---

## 一、CLI 演示

```powershell
# 安装 SDK（主环境即可）
pip install pi-agent-python-sdk

python demo_pi_sdk.py     # 一次性问答 / 流式 / 多轮记忆 / bash 工具调用
python demo_async.py      # AsyncPiClient 流式 + asyncio 并发
python chat.py            # 终端连续对话
```

`chat.py` 命令：`/model`（查看/切换）、`/model list`、`/stats`、`/new`、`/quit`；
`Ctrl+C` 中断当前回答。

---

## 二、Web 版本快速启动

### 1. 配置环境变量（可选）

复制项目根目录的 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

可根据需要在 `.env` 中自定义配置（详见下文“环境配置项说明”）：
```bash
# 示例：设置局域网访问密码
PI_AUTH_TOKEN=mypassword123
```

### 2. 启动后端（FastAPI + SSE）

```powershell
# 激活环境
conda activate piWeb
# 首次安装依赖：
pip install -r web\server\requirements.txt

cd web\server
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

验证：访问 `http://127.0.0.1:8000/docs` 返回 200。

### 3. 启动前端（Vite 开发服务器）

另开一个终端：

```powershell
cd web\client
npm install               # 首次安装
npm run dev               # 启动开发服务器
```

* **本机访问**：打开 [http://localhost:5173](http://localhost:5173)；
* **局域网访问**：在同一 Wi-Fi 下的手机、平板或其它电脑输入控制台打印的局域网 IP（如 `http://192.168.0.131:5173`）即可使用。

### 4. 其他前端命令

```powershell
cd web\client
npm run build             # TypeScript 检查 + 生产构建（dist/）
npm run preview           # 预览生产构建
npm run test:md           # Markdown 渲染管线测试（GFM/高亮/KaTeX/mermaid/XSS）
```

---

## 三、环境配置项说明 (`.env`)

项目根目录的 `.env` 文件支持以下可配置项：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PI_AUTH_TOKEN` | 空（免密） | **局域网访问密码**。设置后，任何设备初次访问均弹出鉴权卡片；留空则为免密模式。 |
| `PI_AUTH_REMEMBER` | `true` | **客户端密码记住/缓存策略**。<br>• `true`（默认）：在浏览器 localStorage 中长期保持登录免密；<br>• `session`：仅当前会话有效（关闭标签页即失效需重输）；<br>• `false`：完全不缓存，每次刷新页面均需重新输入密码。 |
| `PI_CLIENT_IDLE_TIMEOUT` | `1800.0` | **客户端空闲回收时间（秒）**。超过该时间无活动的客户端子进程将被自动安全释放，杜绝内存堆积。 |
| `PI_AUTO_APPROVE_POLICY` | `safe` | **工具确认审核策略**。<br>• `manual`：每次执行命令均在网页端弹出确认卡片手动审核；<br>• `safe`（默认）：智能拦截已知高危破坏性 Shell 指令需审核，常规操作放行；<br>• `allow_all`：全自动放行；<br>• `deny`：一律拒绝所有交互确认。 |
| `CORS_ALLOWED_ORIGINS` | 自动内网白名单 | **跨域允许来源**。默认已通过正则放行所有 `localhost` 与私有局域网 IP（`192.168.*`, `10.*`, `172.16-31.*`, `100.*` Tailscale）；若绑定了公网域名，可在此填入（逗号分隔）。 |

---

## 四、功能特性与安全设计

### 🎨 Web 聊天与交互
- **现代化布局与多主题**：Kimi/DeepSeek 风格布局，支持暗色、亮色及多款预置页面主题无缝切换；
- **全量 SSE 流式输出**：正文打字机、折叠式思考链（流式自动展开，结束自动折叠）、工具执行状态条实时推送；
- **Markdown 全量排版**：GFM 表格、代码高亮、LaTeX 数学公式（KaTeX）、mermaid 图表异步渲染、DOMPurify XSS 防护；
- **代码复制体验优化**：代码块一键复制，正文复制按钮自动过滤思考链（仅复制最终回复正文）；
- **历史会话管理**：侧边栏支持会话切换、首条提问重命名标题、当前会话点击防抖，支持会话物理删除与二次确认；
- **断点无缝恢复**：前端本地持久化 `client_id` 与会话状态，移动端切后台休眠或页面刷新后秒级恢复历史对话，避免空白重建。

### 🛡️ 安全与高可用加固
1. **多用户体系与 JWT 鉴权 (Phase 1)**：
   - 基于原生 SQLite (`.pi/piweb.db`) 与标准 JWT，支持多账号登录与注册；
   - 首次启动系统，注册的首位用户自动获得超级管理员（`admin`）权限；
   - 密码采用 PBKDF2-HMAC-SHA256 加盐安全散列（10万次迭代，防彩虹表）；
   - 纯 ASGI 原生中间件鉴权，零性能开销，完美兼容 SSE 长流式连接；
   - **跨设备会话云同步**：会话按 `user_id` 归属隔离，手机与电脑登录同一账号即可多端漫游历史对话。
2. **多租户私有工作区沙箱 (Phase 2)**：
   - 每个用户分配物理隔离的私有工作目录（`workspaces/<user_id>/`）；
   - AI Agent 执行终端命令、创建和读写文件，均强制限制在当前用户的私有工作区内，彻底杜绝不同用户之间文件读取或误删的风险。
2. **CORS 跨域安全收紧**：
   - 移除危险的 `*` 全放通，采用私有局域网网段正则白名单；
   - 坚决阻断外网恶意网页探测、利用浏览器当跳板偷袭本地 8000 端口。
3. **子进程防泄漏与并发竞态防护**：
   - 后端基于心跳监控客户端活跃度，空闲超时自动调用 `client.aclose()` 释放底层 Node.js 进程；
   - 采用双重检查锁（Double-Checked Locking），杜绝并发请求重复 `start()` 导致的孤儿僵尸子进程。
4. **会话目录沙箱与多端隔离**：
   - 每个客户端分配专属会话目录（`.pi/sessions/<client_id>/`），避免多端同时使用时对同一 `.jsonl` 发生并发写踩踏；
   - 路径解析前强制进行沙箱边界检查，杜绝路径穿越（Path Traversal）与任意跨目录文件读写/删除。
5. **原生分支回退式“重新生成”**：
   - 调用 Pi 底层原生 `fork()` 分支机制，从上一轮提问处创建新分支并清除旧回答，彻底杜绝历史被重复污染。
6. **人类在环工具手动确认（Human-in-the-loop）**：
   - 支持设置 `PI_AUTO_APPROVE_POLICY=manual`：AI Agent 申请在宿主机执行终端命令或调用工具时，后端异步挂起，前端聊天流实时弹出确认卡片并展示要执行的命令与参数；
   - 用户点击【允许执行】或【拒绝】后，决策即时送达后端唤醒执行；默认 `safe` 策略仅在高危破坏性指令时弹出确认。

---

## 五、API 端点一览

| 方法 | 路径 | 鉴权保护 | 说明 |
| :--- | :--- | :---: | :--- |
| GET  | `/api/auth/status` | 否 | 获取认证状态与是否已有注册用户 |
| POST | `/api/auth/register` | 否 | 用户注册（首位注册者自动成为管理员） |
| POST | `/api/auth/login` | 否 | 用户登录并签发 JWT 令牌 |
| GET  | `/api/auth/me` | 是 | 获取当前登录用户的详情 |
| POST | `/api/auth/logout` | 是 | 退出当前登录 |
| POST | `/api/session` | 是 | 创建/恢复客户端会话 |
| POST | `/api/session/close` | 是 | 主动注销并释放客户端子进程资源 |
| POST | `/api/chat` | 是 | SSE 流式对话（text/thinking/tool/confirm_request/done/error） |
| POST | `/api/confirm` | 是 | 人工审核决策（允许执行 / 拒绝） |
| POST | `/api/interrupt` | 是 | 中断当前生成 |
| POST | `/api/new` | 是 | 新建会话 |
| POST | `/api/fork` | 是 | 原生回退到上一轮提问点创建分叉（重新生成使用） |
| POST | `/api/switch` | 是 | 切换到历史会话并回填消息 |
| GET  | `/api/history` | 是 | 获取当前客户端的历史会话列表 |
| POST | `/api/history/delete` | 是 | 安全物理删除指定的会话文件 |
| GET  | `/api/messages` | 是 | 获取当前会话全量消息 |
| GET  | `/api/models` | 是 | 获取当前可用模型列表 |
| POST | `/api/model` | 是 | 切换模型 |
| GET  | `/api/stats` | 是 | 获取当前会话 Token / 用量统计 |

---

## 六、常见问题与排查

- **局域网设备无法打开网页**：
  1. 确认手机/平板连接在与电脑相同的 Wi-Fi 下（不是蜂窝流量）；
  2. 检查 Windows Defender 防火墙：允许 Node.js 访问专用网络，或为入站端口 `5173` 添加放行规则；
  3. 确认路由器未开启“AP 隔离（Client Isolation）”或“访客 Wi-Fi”。
- **提示“需要访问密码”**：
  若在 `.env` 中设置了 `PI_AUTH_TOKEN`，在弹出的窗口中输入该密码即可；若忘记密码，可在 `.env` 中修改或直接留空重启服务。
- **回答为空 / 报模型错误**：
  确认 LM Studio 正在运行且已加载模型（默认端口 `1234`）；或在界面顶栏模型下拉菜单中切换至其他可用提供方。
- **切换会话提示 409**：
  上一轮回答或工具正在执行中，先点击停止生成按钮。
