import { useEffect, useRef, useState } from 'react'
import type { ModelItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Check, ChevronDown } from 'lucide-react'

interface ModelMenuProps {
  models: ModelItem[]
  current: string
  onSelect: (model: ModelItem) => void
}

export function ModelMenu({ models, current, onSelect }: ModelMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const [provider, id] = current.split('/')

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-[13px] transition hover:border-primary/40 hover:bg-white/10"
      >
        <span className="max-w-40 truncate font-medium">{id ?? current}</span>
        {provider && (
          <span className="text-[10px] text-muted-foreground">{provider}</span>
        )}
        <ChevronDown
          className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-2 max-h-80 w-72 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
          {models.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">加载中…</p>
          )}
          {models.map((m) => {
            const mid = `${m.provider}/${m.id}`
            const active = mid === current
            return (
              <button
                key={mid}
                type="button"
                onClick={() => {
                  onSelect(m)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-[13px] transition',
                  active ? 'bg-primary/15 text-foreground' : 'hover:bg-white/8',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{m.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {mid}
                  </span>
                </span>
                {active && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
