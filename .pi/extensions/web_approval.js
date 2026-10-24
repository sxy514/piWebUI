import fs from "node:fs";
import path from "node:path";

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName || "tool";
    const input = event.input || {};
    const payloadStr = JSON.stringify(input);
    const cwd = process.cwd();

    // =========================================================
    // 🛡️ 核心防线 1：系统核心元数据与跨租户目录绝对禁区 (Zero Trust)
    // =========================================================
    // 严禁任何工具（无论是命令、读写、动态执行）探测或访问 .pi 目录、jwt.secret、piweb.db 或多租户 sessions 目录
    const FORBIDDEN_META_REGEX = /(?:[\\/]\.pi(?:[\\/]|$)|^\.pi(?:[\\/]|$)|piweb\.db|jwt\.secret|\.pi[\\/]sessions)/i;
    if (FORBIDDEN_META_REGEX.test(payloadStr)) {
      return {
        block: true,
        reason: `[沙箱安全阻断] 严禁 Agent 探测或访问系统内部元数据、敏感凭证或多租户会话目录 (.pi)`,
      };
    }

    // 严禁访问其他租户的工作区目录 (workspaces/<other_user_id>)
    const currentWorkspaceName = path.basename(cwd);
    const OTHER_WORKSPACE_REGEX = /[\\/]workspaces[\\/]([a-zA-Z0-9_\-]+)/i;
    const wsMatch = payloadStr.match(OTHER_WORKSPACE_REGEX);
    if (wsMatch && wsMatch[1] && wsMatch[1] !== currentWorkspaceName) {
      return {
        block: true,
        reason: `[沙箱安全阻断] 严禁跨租户越权访问其他用户的工作区目录 [${wsMatch[1]}]`,
      };
    }

    // =========================================================
    // 🛡️ 核心防线 2：文件操作类工具严格工作区牢笼 (Jail Sandbox)
    // =========================================================
    const FILE_TOOLS = new Set([
      "read_file",
      "write_file",
      "edit_file",
      "file_search",
      "list_dir",
      "list_directory",
      "directory_list",
    ]);

    if (FILE_TOOLS.has(toolName)) {
      const rawTarget = input.path || input.file || input.dir || input.target || "";
      if (typeof rawTarget === "string" && rawTarget.trim()) {
        const targetTrimmed = rawTarget.trim();
        const resolved = path.resolve(cwd, targetTrimmed);
        const rel = path.relative(cwd, resolved);
        // 如果相对路径以 .. 开头，或者跨盘符（如在 Windows 下从 G: 指向 C:，isAbsolute 为 true）
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return {
            block: true,
            reason: `[沙箱安全阻断] Agent 文件操作被严格限定在当前工作区内 [${cwd}]，禁止跨越访问外部路径 [${targetTrimmed}]`,
          };
        }
      }
    }

    // =========================================================
    // 🛡️ 核心防线 3：动态脚本与代码执行工具管控 (ctx_execute / eval)
    // =========================================================
    if (toolName === "ctx_execute" || toolName === "eval" || toolName === "code_eval") {
      const code = String(input.code || "");
      // 严禁在脚本中使用 fs 扫描敏感目录、严禁使用 child_process、严禁 chdir
      if (
        FORBIDDEN_META_REGEX.test(code) ||
        /\b(?:child_process|cluster|process\.exit|process\.chdir)\b/i.test(code) ||
        /fs\s*\.\s*(?:readdir|readFile|stat|unlink|rmdir|rm|copyFile)[^)\n]*['"][A-Za-z]:/i.test(code)
      ) {
        return {
          block: true,
          reason: `[沙箱安全阻断] 动态代码执行工具包含未授权的高危操作或跨目录访问，已被强制拦截`,
        };
      }
    }

    // =========================================================
    // 🛡️ 核心防线 4：终端命令（powershell / bash / cmd）越界遍历拦截
    // =========================================================
    if (toolName === "bash" || toolName === "powershell" || toolName === "cmd") {
      const cmd = String(input.command || "");
      // 检查是否试图全局扫描根驱动器或项目根目录
      const OUT_OF_BOUNDS_SCAN = /\b(?:Get-ChildItem|dir|ls|find)\b.*-[Pp]ath\s+['\"][A-Za-z]:[\\\/]?(?:piWebUI)?['\"]/i;
      if (OUT_OF_BOUNDS_SCAN.test(cmd)) {
        return {
          block: true,
          reason: `[沙箱安全阻断] 严禁在宿主机根目录或项目根路径进行全局遍历扫描，命令限定在当前工作区内执行`,
        };
      }
    }

    // =========================================================
    // 🛡️ 核心防线 5：Human-in-the-loop 人类在环审核与放行策略
    // =========================================================
    const policy = (process.env.PI_AUTO_APPROVE_POLICY || "safe").toLowerCase();
    if (policy === "allow_all") {
      return;
    }

    if (!ctx.ui || typeof ctx.ui.confirm !== "function") {
      return;
    }

    let summary = "";
    if (toolName === "bash" || toolName === "powershell") {
      summary = input.command || JSON.stringify(input);
    } else if (toolName === "write_file" || toolName === "edit_file") {
      const p = input.path || "";
      const extra = input.content ? ` (写入长度: ${input.content.length})` : "";
      summary = `${p}${extra}`;
    } else {
      try {
        summary = JSON.stringify(input, null, 2);
      } catch {
        summary = String(input);
      }
    }

    const title = `申请执行: ${toolName}`;
    const message = summary;

    // 发起交互确认，将通过 RPC 推送至 Python AsyncPiClient 的 ui_handler
    const confirmed = await ctx.ui.confirm(title, message);
    if (!confirmed) {
      return {
        block: true,
        reason: `用户拒绝执行此操作 [${toolName}]，本次任务已中止`,
        terminate: true,
      };
    }
  });

  // =========================================================
  // 🧠 核心防线 6：原生聚合加载用户偏好 (USER.md) 与长期记忆 (MEMORY.md)
  // =========================================================
  pi.on("context", async (event, ctx) => {
    const cwd = process.cwd();
    const userMdPath = path.join(cwd, "USER.md");
    const memMdPath = path.join(cwd, "MEMORY.md");

    let extraContext = "";
    if (fs.existsSync(userMdPath)) {
      try {
        const uContent = fs.readFileSync(userMdPath, "utf-8").trim();
        if (uContent) extraContext += `\n\n[当前用户画像与偏好设置 (USER.md)]:\n${uContent}`;
      } catch {}
    }
    if (fs.existsSync(memMdPath)) {
      try {
        const mContent = fs.readFileSync(memMdPath, "utf-8").trim();
        if (mContent) extraContext += `\n\n[专属长期知识记忆库 (MEMORY.md)]:\n${mContent}`;
      } catch {}
    }

    if (!extraContext || !event.messages || event.messages.length === 0) {
      return;
    }

    const messages = [...event.messages];
    const first = messages[0];
    if (first && first.role === "system") {
      const origContent = typeof first.content === "string"
        ? first.content
        : Array.isArray(first.content)
          ? first.content.map(c => (typeof c === "string" ? c : c.text || "")).join("\n")
          : "";
      messages[0] = {
        ...first,
        content: origContent + extraContext,
      };
      return { messages };
    }
  });
}
