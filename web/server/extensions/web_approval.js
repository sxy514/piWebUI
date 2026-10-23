export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const policy = (process.env.PI_AUTO_APPROVE_POLICY || "safe").toLowerCase();
    // 1. 全自动模式：直接放行
    if (policy === "allow_all") {
      return;
    }

    if (!ctx.ui || typeof ctx.ui.confirm !== "function") {
      return;
    }

    const toolName = event.toolName || "tool";
    const input = event.input || {};

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
        block: {
          reason: `用户拒绝执行此操作 [${toolName}]，本次任务已中止`,
          terminate: true,
        },
        terminate: true,
      };
    }
  });
}

