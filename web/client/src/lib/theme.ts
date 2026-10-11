export type Theme = 'dark' | 'light' | 'midnight' | 'emerald'

export interface ThemeOption {
  id: Theme
  label: string
  hint: string
  color: string
}

export const THEMES: ThemeOption[] = [
  { id: 'dark', label: '暗黑霓虹', hint: '深邃紫夜', color: 'oklch(0.72 0.14 285)' },
  { id: 'light', label: '明亮晨曦', hint: '清新素雅', color: 'oklch(0.55 0.2 285)' },
  { id: 'midnight', label: '极夜纯黑', hint: 'OLED 极简', color: 'oklch(0.7 0.12 220)' },
  { id: 'emerald', label: '极光翡翠', hint: '青绿科技', color: 'oklch(0.75 0.16 160)' },
]

const THEME_KEY = 'pi-theme'

export function getSavedTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  const saved = localStorage.getItem(THEME_KEY) as Theme | null
  if (saved && ['dark', 'light', 'midnight', 'emerald'].includes(saved)) {
    return saved
  }
  return 'dark'
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* ignore */
  }
}

