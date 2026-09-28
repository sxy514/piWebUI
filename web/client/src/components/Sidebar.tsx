import { Bot, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { HistoryItem } from '@/lib/api'
import { cn } from '@/lib/utils'

interface SidebarProps {
  open: boolean
  onClose: () => void
  history: HistoryItem[]
  model: string
  busy: boolean
  onNewChat: () => void
  onSelect: (file: string) => void
}

function formatTime(mtime: number): string {
  const d = new Date(mtime * 1000)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (d >= startOfToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const yesterday = new Date(startOfToday.getTime() - 86400_000)
  if (d >= yesterday) return '昨天'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function Sidebar({
  open,
  onClose,
  history,
  model,
  busy,
  onNewChat,
  onSelect,
}: SidebarProps) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/50 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-white/8 bg-black/35 backdrop-blur-2xl transition-transform duration-200 lg:relative lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* 品牌 */}
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-400 to-fuchsia-500 shadow-md shadow-indigo-500/25">
            <Bot className="size-4.5 text-white" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Pi Chat</div>
            <div className="text-[10px] text-muted-foreground">AI Assistant</div>
          </div>
        </div>

        {/* 新建对话 */}
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onNewChat}
            disabled={busy}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/8 py-2.5 text-sm font-medium transition hover:border-primary/40 hover:bg-white/12 disabled:opacity-50"
          >
            <Plus className="size-4" />
            新建对话
          </button>
        </div>

        {/* 历史 */}
        <div className="px-4 pt-2 pb-1.5 text-[11px] tracking-wider text-muted-foreground">
          历史会话
        </div>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-2">
          {history.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground/60">
              暂无历史会话
            </p>
          )}
          {history.map((item) => (
            <button
              key={item.file}
              type="button"
              onClick={() => onSelect(item.file)}
              className={cn(
                'group w-full cursor-pointer rounded-xl px-3 py-2.5 text-left transition',
                item.current
                  ? 'bg-white/10 shadow-sm shadow-primary/10'
                  : 'hover:bg-white/6',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'truncate text-[13px]',
                    item.current ? 'text-foreground' : 'text-foreground/75',
                  )}
                >
                  {item.title}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {formatTime(item.mtime)}
                </span>
              </div>
            </button>
          ))}
        </nav>

        {/* 底部模型信息 */}
        <div className="border-t border-white/8 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Badge
              variant="secondary"
              className="max-w-[9.5rem] truncate bg-white/8 text-[11px]"
            >
              {model}
            </Badge>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Spinner className="size-3 text-emerald-400" />
              RPC 就绪
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
