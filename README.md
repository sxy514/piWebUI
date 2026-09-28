# Pi AI Agent 实验项目

基于 **[pi-agent-python-sdk](https://pypi.org/project/pi-agent-python-sdk)**（把 [Pi](https://pi.dev) 编码助手作为 Python API 调用）的实验项目，包含：

- **CLI 演示脚本**：SDK 同步/异步用法、终端连续对话
- **Web 聊天应用**：FastAPI + SSE 流式后端，React + ObsidianUI 玻璃质感前端（对标 Kimi/DeepSeek 布局）

```
AIAgentPr/
├── demo_pi_sdk.py          # 同步 SDK 演示（run/stream/多轮记忆/工具调用）
├── demo_async.py           # 异步 SDK 演示（流式 + 双会话并发）
├── chat.py                 # 终端连续对话（斜杠命令/中断/切模型）
├── web/
│   ├── server/             # FastAPI 后端（SSE 流式 + 历史会话管理）
│   │   ├── server.py
│   │   └── requirements.txt
│   └── client/             # React + Vite + ObsidianUI 前端
│       ├── src/
│       │   ├── App.tsx             # 主布局（侧边栏/顶栏/对话列/输入区）
│       │   ├── components/         # Sidebar/Composer/MessageItem/ModelMenu...
│       │   └── lib/                # SSE 客户端 + Markdown 渲染管线
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
> 未启动 LM Studio 时可改用其他已配置的提供方（如 Anthropic）。

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

## 二、Web 版本

### 1. 启动后端（FastAPI + SSE）

```powershell
# piWeb 环境（Python 3.13）
conda activate piWeb
# 首次安装依赖：
pip install -r web\server\requirements.txt

cd web\server
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

验证：访问 `http://127.0.0.1:8000/docs` 返回 200。

### 2. 启动前端（Vite dev server）

另开一个终端：

```powershell
cd web\client
npm install               # 首次
npm run dev               # http://localhost:5173
```

打开 **http://localhost:5173** 即可使用（dev 模式下 `/api` 自动代理到
`127.0.0.1:8000`，无需额外配置 CORS）。

### 3. 其他命令

```powershell
cd web\client
npm run build             # TypeScript 检查 + 生产构建（dist/）
npm run preview           # 预览生产构建
npm run test:md           # Markdown 渲染管线测试（GFM/高亮/KaTeX/mermaid/XSS）
```

## 功能特性

**Web 聊天**
- SSE 流式输出：正文、思考过程、工具调用事件实时推送
- Kimi/DeepSeek 风格布局：左侧历史会话栏、居中对话列、AI 回复纯文本排版
- 思考过程可折叠面板（流式自动展开，结束自动折叠）
- 工具调用状态条（执行中/完成/失败，输出可展开查看）
- 历史会话列表、切换回填、新建会话
- 模型下拉切换（读取 pi 已配置的全部模型）
- 中断生成、复制回复、重新生成
- Markdown 全量渲染：GFM 表格、代码高亮（highlight.js）、
  LaTeX 公式（KaTeX）、mermaid 图表（消息完成后渲染）、DOMPurify XSS 防护

**API 端点**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/session` | 创建/获取 pi 客户端会话 |
| POST | `/api/chat` | SSE 流式对话（text/thinking/tool/done/error） |
| POST | `/api/interrupt` | 中断当前生成 |
| POST | `/api/new` | 新建会话 |
| POST | `/api/switch` | 切换到历史会话并回填消息 |
| GET  | `/api/history` | 历史会话列表（标题 + 修改时间） |
| GET  | `/api/messages` | 当前会话消息 |
| GET  | `/api/models` | 可用模型列表 |
| POST | `/api/model` | 切换模型 |
| GET  | `/api/stats` | 会话 token/用量统计 |

## 技术栈

- **后端**：FastAPI · uvicorn · pi-agent-python-sdk（`AsyncPiClient`，以子进程 RPC 模式驱动 pi）
- **前端**：React 19 · Vite · TypeScript · Tailwind CSS v4 ·
  [ObsidianUI](https://www.obsidianui.dev)（card/button/textarea/badge/spinner 等 shadcn 兼容组件）·
  marked + highlight.js + KaTeX + mermaid + DOMPurify
- **通信**：fetch + ReadableStream 解析 SSE（`data: {...}` 帧）

## 目录/会话数据

- pi 会话文件：`~/.pi/agent/sessions/<项目目录>/*.jsonl`（历史列表即扫描此目录）
- 每个浏览器客户端对应一个独立 pi 子进程（`client_id` 标识，服务内存态）

## 常见问题

- **后端连接失败**：确认 uvicorn 已启动在 8000 端口（前端错误页会给出提示）
- **回答为空/报错**：确认 LM Studio 正在运行且已加载模型；或用 `/api/model` 切换其他提供方
- **切换会话 409**：上一轮回答尚未结束，先点停止
- **前端 5173 无法访问后端**：dev 模式依赖 Vite 代理；直接访问 8000 端口只提供 API，不提供页面
