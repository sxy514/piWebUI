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

    // 严禁探测多租户父目录 (workspaces) 或访问其他租户的工作区
    const currentWorkspaceName = path.basename(cwd);
    if (/workspaces/i.test(payloadStr)) {
      const wsMatches = [...payloadStr.matchAll(/workspaces(?:[\\/]([a-zA-Z0-9_\-]+))?/gi)];
      for (const m of wsMatches) {
        const targetSub = m[1];
        if (!targetSub || targetSub.toLowerCase() !== currentWorkspaceName.toLowerCase()) {
          return {
            block: true,
            reason: `[沙箱安全阻断] 严禁探测多租户父目录或跨租户访问其他工作区 [${targetSub || "workspaces"}]`,
          };
        }
      }
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
      "read",
      "write",
      "edit",
    ]);

    const WRITE_FILE_TOOLS = new Set([
      "write_file",
      "edit_file",
      "write",
      "edit",
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

        // 🛡️ 平台规则强制写保护：严禁 Agent 篡改或覆盖 AGENTS.md
        if (WRITE_FILE_TOOLS.has(toolName)) {
          const targetBase = path.basename(resolved).toLowerCase();
          if (targetBase === "agents.md") {
            return {
              block: true,
              reason: `[平台安全准则写保护] AGENTS.md 是平台设定的系统级行为规范与多租户安全红线文件，受到强制写保护，严禁修改。如需修改个人称呼、语言风格或输出习惯，请修改 USER.md；如需沉淀业务事实或技术约定，请更新 MEMORY.md。`,
            };
          }
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
    // 🛡️ 核心防线 4：终端命令（powershell / bash / cmd）越界遍历拦截
    // =========================================================
    if (toolName === "bash" || toolName === "powershell" || toolName === "cmd") {
      const cmd = String(input.command || "");

      // 0. 严禁通过终端命令篡改或删除平台系统级规则 AGENTS.md
      if (
        /(?:>|>>|Set-Content|Out-File|Remove-Item|rm\b|del\b|erase\b|truncate\b|tee\b|sed\s+-i).*AGENTS\.md/i.test(cmd) ||
        /AGENTS\.md.*(?:>|>>|\|)/i.test(cmd)
      ) {
        return {
          block: true,
          reason: `[平台安全准则写保护] 严禁通过终端命令篡改或删除平台系统级规则文件 AGENTS.md。个人偏好请通过 USER.md 配置。`,
        };
      }

      // 1. 严禁使用 .. 向上逃逸工作区
      if (/(?:(?<!\.)\.\.(?!\.)(?:[\\/]|$|["'\s])|\bcd\s+\.\.)/i.test(cmd)) {
        return {
          block: true,
          reason: `[沙箱安全阻断] 严禁使用相对路径 '..' 向上越界逃逸当前工作区`,
        };
      }

      // 2. 严禁扫描根目录、工程根目录或多租户根目录
      if (
        /\b(?:Get-ChildItem|dir|ls|find|tree)\b.*(?:-[Pp]ath\s+)?['"]?[A-Za-z]:[\\\/]?(?:piWebUI)?(?:["'\s]|$)/i.test(cmd) ||
        /\b(?:Get-ChildItem|dir|ls|find|tree)\b.*['"][A-Za-z]:/i.test(cmd) ||
        /\b(?:Get-ChildItem|dir|ls|find|tree)\b.*workspaces/i.test(cmd)
      ) {
        return {
          block: true,
          reason: `[沙箱安全阻断] 严禁在宿主机根目录或多租户根路径进行遍历扫描，命令限定在当前工作区内执行`,
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

    // 在 safe 策略下，已通过防线 1 与防线 2 严格牢笼校验的工作区文件读写/编辑操作，
    // 属于 Agent 在自身工作空间内的正常开发行为，直接自动放行，无需打扰用户人工审批
    if (policy === "safe" && FILE_TOOLS.has(toolName)) {
      return;
    }

    if (!ctx.ui || typeof ctx.ui.confirm !== "function") {
      return;
    }

    let summary = "";
    if (toolName === "bash" || toolName === "powershell") {
      summary = input.command || JSON.stringify(input);
    } else if (toolName === "write_file" || toolName === "edit_file" || toolName === "write" || toolName === "edit") {
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

    let extraContext = "\n\n[多租户沙箱安全边界规范]:\n你当前在独立、安全隔离的多租户专属工作区中运行。你的所有操作受限于当前工作空间，严禁且无法探测、列出或访问上级目录、workspaces 根目录或其他租户的任何工作区。若用户询问是否存在其他工作区，请明确告知你只在当前独立工作空间中提供服务，系统严格安全隔离，无法也无需探测其他空间。";
    extraContext += "\n\n[平台配置管理规范 (不可篡改原则)]:\n1. AGENTS.md 是平台制定的系统级行为规范与多租户安全红线，受到强制写保护，严禁修改。\n2. 若用户希望调整个人偏好（如称呼、回复风格、语言习惯），必须引导用户并使用工具更新专属 USER.md。\n3. 若在会话中确认了核心业务逻辑、技术约定或排错经验，请使用工具沉淀到专属 MEMORY.md。";
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
