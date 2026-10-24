import { useState, useRef, useEffect } from 'react'
import { Zap, Clock, ArrowDown, ArrowUp, MessageSquare, ChevronDown, Gauge } from 'lucide-react'

export interface SessionStats {
  turns: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  totalCost: number
  totalElapsed: number
  contextWindow: number
  contextUsed: number
  remainingTokens: number
  remainingPercent: number
  usedPercent: number
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toLocaleString()
}

export function SessionUsage({ stats }: { stats: SessionStats }) {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // 点击外部自动关闭
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  if (stats.totalTokens === 0 && stats.turns === 0) {
    return null
  }

  const usedPercent = stats.usedPercent ?? Math.max(0, Math.min(100, 100 - stats.remainingPercent))

  return (
    <div className="relative" ref={popoverRef}>
      {/* 顶栏胶囊按钮 */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="group flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-white/10 hover:text-foreground"
        title="查看当前会话消耗与上下文窗口占用"
      >
        <Zap className="size-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
        <span
          className={`font-mono text-[11px] font-semibold ${
            usedPercent > 85
              ? 'text-destructive'
              : usedPercent > 60
                ? 'text-amber-400'
                : 'text-emerald-400'
          }`}
        >
          {usedPercent}%
        </span>
        <ChevronDown
          className={`size-3 text-muted-foreground/60 transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* 展开的消耗与上下文窗口详情弹层 */}
      {open && (
        <div className="glass absolute right-0 top-full z-50 mt-2 w-72 rounded-2xl border border-white/10 bg-background/95 p-4 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between border-b border-white/8 pb-2.5">
            <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Gauge className="size-3.5 text-primary" />
              上下文窗口与资源消耗
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {stats.turns} 轮对话
            </span>
          </div>

          <div className="mt-3 space-y-3">
            {/* 上下文窗口已占用卡片 */}
            <div className="rounded-xl border border-white/8 bg-white/4 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">上下文已占用</span>
                <span
                  className={`font-mono font-bold text-xs ${
                    usedPercent > 85
                      ? 'text-destructive'
                      : usedPercent > 60
                        ? 'text-amber-400'
                        : 'text-emerald-400'
                  }`}
                >
                  {usedPercent}% ({formatTokens(stats.contextUsed)})
                </span>
              </div>

              {/* 上下文占用进度条 */}
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-black/40">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    usedPercent > 85
                      ? 'bg-destructive'
                      : usedPercent > 60
                        ? 'bg-amber-400'
                        : 'bg-emerald-400'
                  }`}
                  style={{ width: `${Math.max(2, usedPercent)}%` }}
                />
              </div>

              <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground/70">
                <span>占用 {formatTokens(stats.contextUsed)}</span>
                <span>上限 {formatTokens(stats.contextWindow)}</span>
              </div>
            </div>

            {/* Token 消耗明细 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>会话累计消耗</span>
                <span className="font-mono font-bold text-foreground">
                  {stats.totalTokens.toLocaleString()} tokens
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg border border-white/6 bg-black/20 p-2">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <ArrowDown className="size-3 text-blue-400" />
                    <span>提示词输入</span>
                  </div>
                  <div className="mt-1 font-mono font-semibold text-foreground/90">
                    {stats.inputTokens.toLocaleString()}
                  </div>
                </div>

                <div className="rounded-lg border border-white/6 bg-black/20 p-2">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <ArrowUp className="size-3 text-emerald-400" />
                    <span>模型生成</span>
                  </div>
                  <div className="mt-1 font-mono font-semibold text-foreground/90">
                    {stats.outputTokens.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* 耗时与对话效率 */}
            <div className="space-y-1.5 border-t border-white/6 pt-2.5 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Clock className="size-3 text-muted-foreground/80" />
                  累计生成耗时
                </span>
                <span className="font-mono font-medium text-foreground/80">
                  {stats.totalElapsed}s
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <MessageSquare className="size-3 text-muted-foreground/80" />
                  平均单轮消耗
                </span>
                <span className="font-mono font-medium text-foreground/80">
                  {stats.turns > 0
                    ? Math.round(stats.totalTokens / stats.turns).toLocaleString()
                    : 0}{' '}
                  t/轮
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
