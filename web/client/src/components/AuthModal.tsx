import { useState } from 'react'
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck } from 'lucide-react'

interface AuthModalProps {
  onSuccess: () => void
  onVerify: (token: string) => Promise<boolean>
  rememberMode?: string
}

export function AuthModal({ onSuccess, onVerify, rememberMode = 'true' }: AuthModalProps) {
  const [token, setToken] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = token.trim()
    if (!trimmed) {
      setError('请输入访问密码')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const ok = await onVerify(trimmed)
      if (ok) {
        onSuccess()
      } else {
        setError('密码错误，请重新输入')
      }
    } catch {
      setError('验证失败，请检查网络连接')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl transition-all">
        <div className="flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-4 ring-8 ring-primary/5">
            <Lock className="size-7" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            需要访问密码
          </h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            服务已开启局域网安全保护，请输入访问密码继续使用。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted-foreground">
              <KeyRound className="size-4" />
            </div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setError(null)
              }}
              placeholder="请输入自定义访问密码..."
              autoFocus
              className="w-full rounded-xl border border-input bg-background/50 pl-10 pr-10 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>

          {error && (
            <p className="text-center text-xs font-medium text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? '正在验证…' : (
              <>
                <ShieldCheck className="size-4" /> 验证并进入
              </>
            )}
          </button>
        </form>

        <div className="mt-4 text-center">
          <span className="text-xs text-muted-foreground">
            {rememberMode === 'false' || rememberMode === 'none'
              ? '服务未启用客户端密码保存，刷新页面后需重新输入'
              : rememberMode === 'session'
                ? '当前为会话临时授权，关闭浏览器或标签页后失效'
                : '输入成功后将在此设备自动保存，无需重复输入'}
          </span>
        </div>
      </div>
    </div>
  )
}
