import { useEffect, useState, type ReactNode } from 'react'
import { Markdown } from '@/components/Markdown'
import { Spinner } from '@/components/ui/spinner'
import type { Message, Part } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Check, ChevronRight, Copy, RefreshCw, TriangleAlert, Wrench } from 'lucide-react'

interface MessageItemProps {
  msg: Message
  isLastAssistant: boolean
  onRegenerate?: () => void
}

export function MessageItem({ msg, isLastAssistant, onRegenerate }: MessageItemProps) {
  if (msg.role === 'user') {
    const text = msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return (
      <div className="flex justify-end">
        <div className="bubble-user max-w-[82%] rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap text-white">
          {text}
        </div>
      </div>
    )
  }

  const hasContent = msg.parts.length > 0

  return (
    <div className="group flex flex-col">
      {!hasContent && msg.streaming && (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> 思考中…
        </span>
      )}

      {msg.parts.map((part, i) => (
        <PartView
          key={i}
          part={part}
          streaming={msg.streaming}
          isLastPart={i === msg.parts.length - 1}
        />
      ))}

      {msg.interrupted && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-400">
          <TriangleAlert className="size-3.5" /> 已停止生成
        </div>
      )}
      {msg.error && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5" /> {msg.error}
        </div>
      )}

      {!msg.streaming && (hasContent || msg.error) && (
        <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <ActionButton
            title="复制"
            onClick={() => void copyText(plainText(msg))}
          >
            <Copy className="size-3.5" />
          </ActionButton>
          {isLastAssistant && onRegenerate && (
            <ActionButton title="重新生成" onClick={onRegenerate}>
              <RefreshCw className="size-3.5" />
            </ActionButton>
          )}
          {msg.usage && (
            <span className="ml-1 text-[10px] text-muted-foreground/60">
              {msg.usage.input_tokens ?? 0}↑ {msg.usage.output_tokens ?? 0}↓
              {msg.elapsed ? ` · ${msg.elapsed}s` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function PartView({
  part,
  streaming,
  isLastPart,
}: {
  part: Part
  streaming: boolean
  isLastPart: boolean
}) {
  if (part.kind === 'thinking') {
    return <ThinkingView text={part.text} streaming={streaming} />
  }
  if (part.kind === 'tool') {
    return <ToolView part={part} />
  }
  return (
    <div className={cn('my-1', streaming && isLastPart && 'caret')}>
      <Markdown text={part.text} mermaidEnabled={!streaming} />
    </div>
  )
}

function ThinkingView({ text, streaming }: { text: string; streaming: boolean }) {
  // 流式时展开, 结束自动折叠 (用户手动点过则以手动状态为准)
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? streaming

  useEffect(() => {
    if (!streaming) setManual(null)
  }, [streaming])

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-white/6 bg-white/[0.04]">
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground transition hover:text-foreground/80"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
        思考过程
        {!streaming && (
          <span className="ml-auto text-[10px] text-muted-foreground/50">
            已折叠
          </span>
        )}
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto px-3.5 pt-0.5 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/75">
          {text}
        </div>
      )}
    </div>
  )
}

function ToolView({ part }: { part: Extract<Part, { kind: 'tool' }> }) {
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-white/6 bg-white/[0.04] font-mono text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <Wrench
          className={cn(
            'size-3.5 shrink-0',
            !part.done
              ? 'text-primary'
              : part.ok === false
                ? 'text-destructive'
                : 'text-emerald-400',
          )}
        />
        <span className="font-medium text-foreground/85">{part.name}</span>
        {part.args !== undefined && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
            {summarizeArgs(part.args)}
          </span>
        )}
        {!part.done && <Spinner className="size-3 shrink-0 text-primary" />}
        {part.done && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
              part.ok === false
                ? 'bg-destructive/20 text-destructive'
                : 'bg-emerald-500/15 text-emerald-400',
            )}
          >
            {part.ok === false ? '失败' : '完成'}
          </span>
        )}
      </div>
      {part.done && part.result && (
        <details className="border-t border-white/5">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-muted-foreground/70 select-none hover:text-foreground/70">
            查看输出
          </summary>
          <pre className="max-h-40 overflow-auto px-3 pb-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground/70">
            {part.result}
          </pre>
        </details>
      )}
    </div>
  )
}

function ActionButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: ReactNode
}) {
  const [done, setDone] = useState(false)

  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        onClick()
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
      className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition hover:bg-white/8 hover:text-foreground"
    >
      {done ? <Check className="size-3.5 text-emerald-400" /> : children}
    </button>
  )
}

function summarizeArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args)
    return text.length > 80 ? text.slice(0, 80) + '…' : text
  } catch {
    return String(args)
  }
}

function plainText(msg: Message): string {
  return msg.parts
    .map((p) => (p.kind === 'text' || p.kind === 'thinking' ? p.text : ''))
    .join('')
    .trim()
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* 剪贴板不可用时忽略 */
  }
}
