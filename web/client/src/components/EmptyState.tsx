import { Sparkles } from 'lucide-react'

const CARDS = [
  { title: '介绍一下你自己', desc: '了解 Pi 助手' },
  { title: '解释 SSE 流式接口', desc: '技术问题' },
  { title: '写一个 Python 快速排序', desc: '代码生成' },
  { title: '画一个 mermaid 流程图', desc: '图表渲染' },
]

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-7 text-center">
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-400 via-violet-500 to-fuchsia-500 shadow-xl shadow-violet-500/25">
          <Sparkles className="size-8 text-white" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">
          有什么可以帮您？
        </h2>
        <p className="text-sm text-muted-foreground">
          pi-agent-python-sdk 驱动 · 流式输出 · 工具调用
        </p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
        {CARDS.map((card) => (
          <button
            key={card.title}
            type="button"
            onClick={() => onPick(card.title)}
            className="glass-soft cursor-pointer rounded-2xl px-4 py-3.5 text-left transition hover:border-primary/40 hover:bg-white/8"
          >
            <div className="text-sm font-medium text-foreground/90">
              {card.title}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">{card.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
