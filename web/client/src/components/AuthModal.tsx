import { useState } from 'react'
import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, User, UserPlus } from 'lucide-react'
import { loginUser, registerUser, type UserInfo } from '@/lib/api'
import { cn } from '@/lib/utils'

interface AuthModalProps {
  onSuccess: (user: UserInfo) => void
  hasUsers: boolean
  rememberMode?: string
}

export function AuthModal({ onSuccess, hasUsers, rememberMode = 'true' }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'register'>(hasUsers ? 'login' : 'register')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isRegister = mode === 'register'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedUser = username.trim()
    const trimmedPass = password.trim()

    if (!trimmedUser) {
      setError('请输入用户名')
      return
    }
    if (trimmedUser.length < 3) {
      setError('用户名长度不能少于 3 个字符')
      return
    }
    if (!trimmedPass) {
      setError('请输入密码')
      return
    }
    if (trimmedPass.length < 6) {
      setError('密码长度不能少于 6 位')
      return
    }

    if (isRegister && trimmedPass !== confirmPassword.trim()) {
      setError('两次输入的密码不一致，请重新输入')
      return
    }

    setLoading(true)
    setError(null)
    try {
      if (isRegister) {
        const user = await registerUser(trimmedUser, trimmedPass)
        onSuccess(user)
      } else {
        const user = await loginUser(trimmedUser, trimmedPass)
        onSuccess(user)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-card p-6 shadow-2xl transition-all">
        {/* 顶部图标与标题 */}
        <div className="flex flex-col items-center text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary mb-3 ring-8 ring-primary/5">
            {isRegister ? <UserPlus className="size-7" /> : <Lock className="size-7" />}
          </div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            {isRegister ? '注册账号' : '欢迎登录 piWebUI'}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {isRegister
              ? (!hasUsers ? '首次启动系统，注册的首个账号将自动成为系统管理员' : '创建个人账号，开启独立私有代码工作区')
              : '输入您的账号密码进入私有 Agent 会话'}
          </p>
        </div>

        {/* 登录 / 注册 Tab 切换 */}
        <div className="mt-5 grid grid-cols-2 rounded-xl bg-muted/60 p-1 text-xs font-medium">
          <button
            type="button"
            onClick={() => {
              setMode('login')
              setError(null)
            }}
            className={cn(
              'cursor-pointer rounded-lg py-2 transition-all',
              mode === 'login'
                ? 'bg-background text-foreground shadow-sm font-semibold'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            账号登录
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register')
              setError(null)
            }}
            className={cn(
              'cursor-pointer rounded-lg py-2 transition-all',
              mode === 'register'
                ? 'bg-background text-foreground shadow-sm font-semibold'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            注册新账号 {!hasUsers && ' (首创)'}
          </button>
        </div>

        {/* 表单区域 */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5">
          {/* 用户名 */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              用户名
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted-foreground">
                <User className="size-4" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value)
                  setError(null)
                }}
                placeholder="请输入用户名..."
                autoFocus
                className="w-full rounded-xl border border-input bg-background/50 pl-10 pr-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>

          {/* 密码 */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              密码
            </label>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted-foreground">
                <KeyRound className="size-4" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setError(null)
                }}
                placeholder="请输入密码..."
                className="w-full rounded-xl border border-input bg-background/50 pl-10 pr-10 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {/* 确认密码（仅在注册模式展示） */}
          {isRegister && (
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                确认密码
              </label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-muted-foreground">
                  <KeyRound className="size-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value)
                    setError(null)
                  }}
                  placeholder="请再次输入密码确认..."
                  className="w-full rounded-xl border border-input bg-background/50 pl-10 pr-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-destructive/15 border border-destructive/20 p-2.5 text-center text-xs font-medium text-destructive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground shadow-md transition hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? (
              '正在处理…'
            ) : isRegister ? (
              <>
                <UserPlus className="size-4" /> 注册并进入
              </>
            ) : (
              <>
                <ShieldCheck className="size-4" /> 登录进入
              </>
            )}
          </button>
        </form>

        <div className="mt-4 text-center">
          <span className="text-[11px] text-muted-foreground/75">
            {rememberMode === 'false' || rememberMode === 'none'
              ? '服务未开启客户端持久化，关闭浏览器或刷新页面后需重新登录'
              : rememberMode === 'session'
                ? '当前为标签页临时会话，关闭浏览器后失效'
                : '登录成功后将在此设备保持登录，无需重复输入密码'}
          </span>
        </div>
      </div>
    </div>
  )
}
