import { useEffect, useRef, useState } from 'react'
import { Check, Moon, Palette, Sparkles, Sun } from 'lucide-react'
import { applyTheme, getSavedTheme, THEMES, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

export function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>('dark')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const initial = getSavedTheme()
    setTheme(initial)
    applyTheme(initial)
  }, [])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleSelect = (t: Theme) => {
    setTheme(t)
    applyTheme(t)
    setOpen(false)
  }

  const currentTheme = THEMES.find((item) => item.id === theme) ?? THEMES[0]

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={`切换主题（当前：${currentTheme.label}）`}
        aria-label="切换主题"
        className="flex size-9 cursor-pointer items-center justify-center rounded-xl border border-white/10 bg-white/6 text-muted-foreground transition hover:border-primary/40 hover:bg-white/10 hover:text-foreground"
      >
        {theme === 'light' ? (
          <Sun className="size-4 text-amber-500" />
        ) : theme === 'midnight' ? (
          <Moon className="size-4 text-sky-400" />
        ) : theme === 'emerald' ? (
          <Sparkles className="size-4 text-emerald-400" />
        ) : (
          <Palette className="size-4 text-primary" />
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 z-40 mt-2 w-48 overflow-hidden rounded-2xl border border-border bg-[var(--popover)] p-1.5 shadow-2xl backdrop-blur-xl">
          <div className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            页面主题风格
          </div>
          <div className="space-y-0.5">
            {THEMES.map((item) => {
              const active = item.id === theme
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition',
                    active ? 'bg-white/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-white/6 hover:text-foreground',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full ring-1 ring-white/20"
                      style={{ background: item.color }}
                    />
                    <span>{item.label}</span>
                    <span className="text-[10px] text-muted-foreground/60">{item.hint}</span>
                  </div>
                  {active && <Check className="size-3.5 text-primary" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
