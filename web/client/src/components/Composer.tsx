import { forwardRef } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Send, Square } from 'lucide-react'

interface ComposerProps {
  value: string
  streaming: boolean
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(
  function Composer({ value, streaming, onChange, onSend, onStop }, ref) {
    return (
      <div className="glass rounded-3xl px-3 pt-2 pb-2.5">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder={streaming ? '生成中… 可点击右侧按钮停止' : '输入消息，Enter 发送'}
          className="min-h-11 max-h-44 flex-1 resize-none border-none bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
          rows={1}
        />
        <div className="mt-1 flex items-center justify-between px-1">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
            <span className="rounded-md bg-white/6 px-1.5 py-0.5">Markdown</span>
            <span className="rounded-md bg-white/6 px-1.5 py-0.5">LaTeX</span>
            <span className="hidden rounded-md bg-white/6 px-1.5 py-0.5 sm:inline">
              mermaid
            </span>
            {streaming && (
              <span className="flex items-center gap-1 text-primary">
                <Spinner className="size-3" /> 生成中
              </span>
            )}
          </div>
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              title="停止生成"
              className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-destructive text-white shadow-lg shadow-destructive/30 transition hover:brightness-110"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!value.trim()}
              title="发送 (Enter)"
              className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Send className="size-4" />
            </button>
          )}
        </div>
      </div>
    )
  },
)
