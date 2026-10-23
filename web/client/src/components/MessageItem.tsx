import { useEffect, useState, type ReactNode } from 'react'
import { Markdown } from '@/components/Markdown'
import { Spinner } from '@/components/ui/spinner'
import type { Message, Part } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Check, ChevronRight, Copy, RefreshCw, ShieldAlert, TriangleAlert, Wrench, X } from 'lucide-react'

interface MessageItemProps {
  msg: Message
  isLastAssistant: boolean
  onRegenerate?: () => void
  onConfirm?: (confirmId: string, approved: boolean) => void
}

export function MessageItem({
  msg,
  isLastAssistant,
  onRegenerate,
  onConfirm,
}: MessageItemProps) {
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
          onConfirm={onConfirm}
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
  onConfirm,
}: {
  part: Part
  streaming: boolean
  isLastPart: boolean
  onConfirm?: (confirmId: string, approved: boolean) => void
}) {
  if (part.kind === 'thinking') {
    return <ThinkingView text={part.text} streaming={streaming} />
  }
  if (part.kind === 'tool') {
    return <ToolView part={part} />
  }
  if (part.kind === 'confirm') {
    return <ConfirmView part={part} onConfirm={onConfirm} />
  }
  return (
    <div className={cn('my-1', streaming && isLastPart && 'caret')}>
      <Markdown text={part.text} mermaidEnabled={!streaming} />
    </div>
  )
}

function ConfirmView({
  part,
  onConfirm,
}: {
  part: Extract<Part, { kind: 'confirm' }>
  onConfirm?: (confirmId: string, approved: boolean) => void
}) {
  const isDangerous = part.is_dangerous
  const isPending = part.status === 'pending'
  const isApproved = part.status === 'approved'
  const isDenied = part.status === 'denied'
  const isExpired = part.status === 'expired'

  return (
    <div
      className={cn(
        'mb-3 overflow-hidden rounded-xl border p-4 text-xs transition-all',
        isPending && (isDangerous ? 'border-amber-500/40 bg-amber-500/10' : 'border-blue-500/30 bg-blue-500/10'),
        isApproved && 'border-emerald-500/30 bg-emerald-500/5',
        isDenied && 'border-destructive/30 bg-destructive/5',
        isExpired && 'border-white/10 bg-white/[0.02] opacity-75',
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert
          className={cn(
            'size-4 shrink-0',
            isDangerous ? 'text-amber-400' : 'text-blue-400',
            isApproved && 'text-emerald-400',
            isDenied && 'text-destructive',
            isExpired && 'text-muted-foreground',
          )}
        />
        <span className="font-semibold text-foreground/90">
          {part.title || (isDangerous ? '高危命令执行确认' : '工具执行确认')}
        </span>
        <div className="ml-auto">
          {isApproved && (
            <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
              已允许
            </span>
          )}
          {isDenied && (
            <span className="rounded bg-destructive/20 px-2 py-0.5 text-[11px] font-medium text-destructive">
              已拒绝
            </span>
          )}
          {isExpired && (
            <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              已超时 (已取消)
            </span>
          )}
          {isPending && (
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              等待审核
            </span>
          )}
        </div>
      </div>

      {part.message && (
        <div className="mt-2.5 rounded-lg border border-white/6 bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/80">
          {part.message}
        </div>
      )}

      {isPending && onConfirm && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onConfirm(part.confirm_id, false)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
          >
            <X className="size-3.5" /> 拒绝
          </button>
          <button
            type="button"
            onClick={() => onConfirm(part.confirm_id, true)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow transition hover:bg-emerald-500"
          >
            <Check className="size-3.5" /> 允许执行
          </button>
        </div>
      )}
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
    .map((p) => (p.kind === 'text' ? p.text : ''))
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
