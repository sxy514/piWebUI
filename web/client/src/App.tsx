import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from '@/components/Composer'
import { EmptyState } from '@/components/EmptyState'
import { MessageItem } from '@/components/MessageItem'
import { ModelMenu } from '@/components/ModelMenu'
import { Sidebar } from '@/components/Sidebar'
import { ThemeMenu } from '@/components/ThemeMenu'
import { Spinner } from '@/components/ui/spinner'
import { AuthModal } from '@/components/AuthModal'
import { WorkspaceDrawer } from '@/components/WorkspaceDrawer'
import { SessionUsage, formatTokens, type SessionStats } from '@/components/SessionUsage'
import {
  createSession,
  getAuthStatus,
  initAuthToken,
  deleteSession,
  forkSession,
  getHistory,
  getMessages,
  getModels,
  interrupt,
  newSession,
  sendChat,
  sendConfirm,
  getMe,
  logoutUser,
  type UserInfo,
  setModel,
  switchSession,
  type HistoryItem,
  type Message,
  type ModelItem,
  type SessionInfo,
  type StreamEvent,
  getSessionStats,
  type ContextUsageInfo,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { CircleAlert, LogOut, Menu, Plus, User as UserIcon, FolderArchive } from 'lucide-react'

let msgSeq = 0
const newId = () => `m${++msgSeq}`

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [models, setModels] = useState<ModelItem[]>([])
  const [workspaceDrawerOpen, setWorkspaceDrawerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [needAuth, setNeedAuth] = useState(false)
  const [authRemember, setAuthRemember] = useState<string>('true')
  const [currentUser, setCurrentUser] = useState<UserInfo | null>(null)
  const [hasUsers, setHasUsers] = useState<boolean>(true)

  const [liveContextUsage, setLiveContextUsage] = useState<ContextUsageInfo | null>(null)

  const refreshStats = useCallback(async (clientId: string) => {
    try {
      const data = await getSessionStats(clientId)
      if (data?.contextUsage) {
        setLiveContextUsage(data.contextUsage)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const sessionStats: SessionStats = useMemo(() => {
    let totalTokens = 0
    let inputTokens = 0
    let outputTokens = 0
    let totalCost = 0
    let totalElapsed = 0
    let turns = 0
    let lastContextTokens = 0

    for (const m of messages) {
      if (m.role === 'assistant') {
        if (m.usage) {
          const inp = m.usage.input_tokens || 0
          const out = m.usage.output_tokens || 0
          const tot = m.usage.total_tokens || (inp + out)
          totalTokens += tot
          inputTokens += inp
          outputTokens += out
          totalCost += m.usage.cost || 0
          lastContextTokens = inp + out
        }
        if (m.elapsed) {
          totalElapsed += m.elapsed
        }
        turns += 1
      }
    }

    const contextWindow = liveContextUsage?.contextWindow || session?.context_window || 262144
    const contextUsed = liveContextUsage?.tokens || lastContextTokens || 0
    const remainingTokens = Math.max(0, contextWindow - contextUsed)
    const usedPercent = contextWindow > 0
      ? Math.max(0, Math.min(100, Math.round((contextUsed / contextWindow) * 100)))
      : 0
    const remainingPercent = Math.max(0, 100 - usedPercent)

    return {
      turns,
      totalTokens,
      inputTokens,
      outputTokens,
      totalCost,
      totalElapsed: Math.round(totalElapsed * 10) / 10,
      contextWindow,
      contextUsed,
      remainingTokens,
      remainingPercent,
      usedPercent,
    }
  }, [messages, liveContextUsage, session])

  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const booted = useRef(false)

  const refreshHistory = useCallback(async (clientId: string) => {
    try {
      const data = await getHistory(clientId)
      setHistory(data.items)
    } catch {
      /* 历史加载失败不阻塞对话 */
    }
  }, [])

  const bootSession = useCallback(async () => {
    try {
      setBootError(null)
      const auth = await getAuthStatus()
      setHasUsers(auth.has_users)
      const mode = auth.auth_remember || 'true'
      setAuthRemember(mode)
      initAuthToken(mode)

      // 获取并验证当前用户信息
      const user = await getMe()
      if (!user) {
        setNeedAuth(true)
        return
      }
      setCurrentUser(user)
      setNeedAuth(false)

      const storedClientId = localStorage.getItem('pi_client_id') || undefined
      const info = await createSession(storedClientId)
      localStorage.setItem('pi_client_id', info.client_id)
      setSession(info)
      void refreshStats(info.client_id)

      const [msgsRes] = await Promise.all([
        getMessages(info.client_id).catch(() => null),
        refreshHistory(info.client_id),
        getModels().then(setModels).catch(() => undefined),
      ])
      if (msgsRes && msgsRes.messages && msgsRes.messages.length > 0) {
        setMessages(msgsRes.messages)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('401') || msg.includes('登录') || msg.includes('凭证')) {
        setNeedAuth(true)
      } else {
        setBootError(msg)
      }
    }
  }, [refreshHistory])

  const handleLogout = useCallback(async () => {
    await logoutUser()
    setCurrentUser(null)
    setSession(null)
    setMessages([])
    setNeedAuth(true)
  }, [])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void bootSession()

    const onUnauthorized = () => setNeedAuth(true)
    window.addEventListener('pi-unauthorized', onUnauthorized)
    return () => window.removeEventListener('pi-unauthorized', onUnauthorized)
  }, [bootSession])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const patchLastAssistant = useCallback(
    (patch: (msg: Message) => Message) => {
      setMessages((prev) => {
        const next = [...prev]
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === 'assistant') {
            next[i] = patch(next[i])
            break
          }
        }
        return next
      })
    },
    [],
  )

  const applyEvent = useCallback(
    (event: StreamEvent) => {
      switch (event.type) {
        case 'text':
          patchLastAssistant((msg) => {
            const parts = [...msg.parts]
            const last = parts[parts.length - 1]
            if (last?.kind === 'text') {
              parts[parts.length - 1] = { kind: 'text', text: last.text + event.delta }
            } else {
              parts.push({ kind: 'text', text: event.delta })
            }
            return { ...msg, parts }
          })
          break
        case 'thinking':
          patchLastAssistant((msg) => {
            const parts = [...msg.parts]
            const last = parts[parts.length - 1]
            if (last?.kind === 'thinking') {
              parts[parts.length - 1] = { kind: 'thinking', text: last.text + event.delta }
            } else {
              parts.push({ kind: 'thinking', text: event.delta })
            }
            return { ...msg, parts }
          })
          break
        case 'tool_start':
          patchLastAssistant((msg) => ({
            ...msg,
            parts: [...msg.parts, { kind: 'tool', name: event.name ?? 'tool', done: false }],
          }))
          break
        case 'tool_exec':
          patchLastAssistant((msg) => {
            const parts = [...msg.parts]
            for (let i = parts.length - 1; i >= 0; i--) {
              const part = parts[i]
              if (part.kind === 'tool' && !part.done) {
                parts[i] = { ...part, name: event.name ?? part.name, args: event.args }
                break
              }
            }
            return { ...msg, parts }
          })
          break
        case 'tool_end':
          patchLastAssistant((msg) => {
            const parts = [...msg.parts]
            for (let i = parts.length - 1; i >= 0; i--) {
              const part = parts[i]
              if (part.kind === 'tool') {
                parts[i] = {
                  ...part,
                  done: true,
                  ok: event.ok,
                  result: event.result,
                  name: event.name ?? part.name,
                }
                break
              }
            }
            return { ...msg, parts }
          })
          break
        case 'confirm_request':
          patchLastAssistant((msg) => ({
            ...msg,
            parts: [
              ...msg.parts,
              {
                kind: 'confirm',
                confirm_id: event.confirm_id,
                title: event.title,
                message: event.message,
                status: 'pending',
                is_dangerous: event.is_dangerous,
              },
            ],
          }))
          break
        case 'confirm_timeout':
          patchLastAssistant((msg) => ({
            ...msg,
            parts: msg.parts.map((p) =>
              p.kind === 'confirm' && p.confirm_id === event.confirm_id
                ? { ...p, status: 'expired' as const }
                : p,
            ),
          }))
          break
        case 'done':
          patchLastAssistant((msg) => ({
            ...msg,
            streaming: false,
            usage: event.usage,
            elapsed: event.elapsed,
            parts: msg.parts.map((p) =>
              p.kind === 'confirm' && p.status === 'pending'
                ? { ...p, status: 'expired' as const }
                : p,
            ),
          }))
          break
        case 'interrupted':
          patchLastAssistant((msg) => ({
            ...msg,
            streaming: false,
            interrupted: true,
            parts: msg.parts.map((p) =>
              p.kind === 'confirm' && p.status === 'pending'
                ? { ...p, status: 'expired' as const }
                : p,
            ),
          }))
          break
        case 'error':
          patchLastAssistant((msg) => ({
            ...msg,
            streaming: false,
            error: event.message,
            parts: msg.parts.map((p) =>
              p.kind === 'confirm' && p.status === 'pending'
                ? { ...p, status: 'expired' as const }
                : p,
            ),
          }))
          break
      }
    },
    [patchLastAssistant],
  )

  const handleConfirm = useCallback(
    async (confirmId: string, approved: boolean) => {
      if (!session) return
      try {
        const res = await sendConfirm(session.client_id, confirmId, approved)
        if (res.expired) {
          setMessages((prev) =>
            prev.map((msg) => ({
              ...msg,
              parts: msg.parts.map((p) =>
                p.kind === 'confirm' && p.confirm_id === confirmId
                  ? { ...p, status: 'expired' as const }
                  : p,
              ),
            })),
          )
          return
        }
        setMessages((prev) =>
          prev.map((msg) => {
            const hasConfirm = msg.parts.some(
              (p) => p.kind === 'confirm' && p.confirm_id === confirmId,
            )
            if (!hasConfirm) return msg
            return {
              ...msg,
              parts: msg.parts.map((p) =>
                p.kind === 'confirm' && p.confirm_id === confirmId
                  ? { ...p, status: approved ? ('approved' as const) : ('denied' as const) }
                  : p,
              ),
            }
          }),
        )
      } catch (err) {
        console.error('Failed to send confirm decision:', err)
      }
    },
    [session],
  )

  const doSend = useCallback(
    async (text: string, echo: boolean) => {
      if (!session || streaming) return

      setStreaming(true)
      setMessages((prev) => {
        const userMsg: Message | null = echo
          ? { id: newId(), role: 'user', parts: [{ kind: 'text', text }], streaming: false }
          : null
        const assistantMsg: Message = {
          id: newId(),
          role: 'assistant',
          parts: [],
          streaming: true,
        }
        return [...(userMsg ? [...prev, userMsg] : prev), assistantMsg]
      })

      try {
        await sendChat(session.client_id, text, applyEvent)
        setMessages((prev) => {
          const stillOpen = prev.some((m) => m.role === 'assistant' && m.streaming)
          if (!stillOpen) return prev
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            if (next[i].role === 'assistant' && next[i].streaming) {
              next[i] = { ...next[i], streaming: false, error: next[i].error ?? '连接中断' }
              break
            }
          }
          return next
        })
      } catch (err) {
        patchLastAssistant((msg) => ({
          ...msg,
          streaming: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        setStreaming(false)
        patchLastAssistant((msg) => ({
          ...msg,
          parts: msg.parts.map((p) =>
            p.kind === 'confirm' && p.status === 'pending'
              ? { ...p, status: 'expired' as const }
              : p,
          ),
        }))
        void refreshHistory(session.client_id)
        void refreshStats(session.client_id)
      }
    },
    [session, streaming, applyEvent, patchLastAssistant, refreshHistory],
  )

  const send = useCallback(() => {
    const text = input.trim()
    if (!text) return
    setInput('')
    void doSend(text, true)
  }, [input, doSend])

  const regenerate = useCallback(async () => {
    if (!session || streaming) return

    let lastUser: Message | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = messages[i]
        break
      }
    }
    if (!lastUser) return
    const fallbackText = lastUser.parts
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('')
      .trim()
    if (!fallbackText) return

    try {
      // 通过 pi 原生 fork 分叉，将当前会话切到该 user 提问节点，丢弃旧的 assistant 回复分支
      const forkRes = await forkSession(session.client_id)
      if (forkRes.messages?.length) {
        setMessages(forkRes.messages)
      } else {
        setMessages((prev) => {
          const next = [...prev]
          if (next.length && next[next.length - 1].role === 'assistant') next.pop()
          return next
        })
      }
      await refreshHistory(session.client_id)
      const promptToRun = forkRes.prompt || fallbackText
      void doSend(promptToRun, false)
    } catch {
      // 兜底降级处理
      setMessages((prev) => {
        const next = [...prev]
        if (next.length && next[next.length - 1].role === 'assistant') next.pop()
        return next
      })
      void doSend(fallbackText, false)
    }
  }, [session, messages, streaming, doSend, refreshHistory])

  const handleStop = useCallback(async () => {
    if (!session) return
    try {
      await interrupt(session.client_id)
    } catch {
      /* 流可能已结束 */
    }
  }, [session])

  const handleNewChat = useCallback(async () => {
    if (!session || streaming) return
    try {
      await newSession(session.client_id)
      setMessages([])
      setInput('')
      await refreshHistory(session.client_id)
      setSidebarOpen(false)
      textareaRef.current?.focus()
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }, [session, streaming, refreshHistory])

  const handleSelectHistory = useCallback(
    async (file: string) => {
      if (!session || streaming) return
      setSidebarOpen(false)
      const isCurrent = history.find((h) => h.file === file)?.current
      if (isCurrent) return

      try {
        setSwitching(true)
        const res = await switchSession(session.client_id, file)
        setMessages(res.messages)
        await refreshHistory(session.client_id)
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      } finally {
        setSwitching(false)
      }
    },
    [session, streaming, history, refreshHistory],
  )

  const handleDeleteHistory = useCallback(
    async (file: string) => {
      if (!session || streaming || switching) return
      if (!window.confirm('确定要删除该历史会话吗？此操作无法撤销。')) return
      try {
        const res = await deleteSession(session.client_id, file)
        if (res.was_current) {
          setMessages([])
          setInput('')
        }
        await refreshHistory(session.client_id)
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      }
    },
    [session, streaming, switching, refreshHistory],
  )

  const handleModelSelect = useCallback(
    async (model: ModelItem) => {
      if (!session) return
      try {
        const res = await setModel(session.client_id, model.provider, model.id)
        setSession({ ...session, model: res.model })
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      }
    },
    [session],
  )

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="glass max-w-md rounded-3xl p-6 text-center">
          <CircleAlert className="mx-auto mb-3 size-8 text-destructive" />
          <p className="text-sm text-muted-foreground">
            后端连接失败，请确认 FastAPI 已启动：
          </p>
          <code className="mt-2 block rounded-lg bg-black/40 p-2 text-xs">
            python -m uvicorn server:app --port 8000
          </code>
          <p className="mt-2 text-xs text-muted-foreground">{bootError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 cursor-pointer rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (needAuth && !session) {
    return (
      <div className="flex h-full items-center justify-center">
        <AuthModal
          hasUsers={hasUsers}
          rememberMode={authRemember}
          onSuccess={(user) => {
            setCurrentUser(user)
            setNeedAuth(false)
            void bootSession()
          }}
        />
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6 text-primary" />
      </div>
    )
  }

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant')?.id

  return (
    <div className="relative h-full overflow-hidden">
      {/* 背景光斑 */}
      <div className="orb -top-32 -left-24 size-96" style={{ background: 'var(--orb-1)', opacity: 'var(--orb-opacity)' }} />
      <div className="orb top-1/3 -right-32 size-[28rem]" style={{ background: 'var(--orb-2)', opacity: 'var(--orb-opacity)', animationDelay: '-6s' }} />
      <div className="orb -bottom-40 left-1/3 size-80" style={{ background: 'var(--orb-3)', opacity: 'var(--orb-opacity)', animationDelay: '-12s' }} />

      <div className="relative z-10 flex h-full">
        <Sidebar
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          history={history}
          model={session.model}
          busy={streaming || switching}
          currentUser={currentUser}
          onLogout={() => void handleLogout()}
          onNewChat={() => void handleNewChat()}
          onSelect={(file) => void handleSelectHistory(file)}
          onDelete={(file) => void handleDeleteHistory(file)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶栏 */}
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/6 px-3 sm:px-5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="flex size-9 cursor-pointer items-center justify-center rounded-xl text-muted-foreground transition hover:bg-white/8 hover:text-foreground lg:hidden"
                title="历史会话"
              >
                <Menu className="size-5" />
              </button>
              <ModelMenu
                models={models}
                current={session.model}
                onSelect={(m) => void handleModelSelect(m)}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-full bg-white/6 px-3 py-1.5 text-[11px] text-muted-foreground sm:flex">
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    streaming ? 'animate-pulse bg-amber-400' : 'bg-emerald-400',
                  )}
                />
                {streaming ? '生成中' : '就绪'}
              </span>
              <SessionUsage stats={sessionStats} />
              <button
                type="button"
                onClick={() => setWorkspaceDrawerOpen(true)}
                className="group flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-white/10 hover:text-foreground"
                title="查看与下载工作区生成的文件"
              >
                <FolderArchive className="size-3.5 text-primary group-hover:scale-110 transition-transform" />
                <span className="hidden sm:inline font-medium text-foreground/90">成果文件</span>
              </button>
              {currentUser && (
                <div className="hidden items-center gap-1.5 rounded-full border border-white/10 bg-white/6 px-2.5 py-1 text-xs sm:flex">
                  <UserIcon className="size-3.5 text-primary" />
                  <span className="font-medium text-foreground/90">{currentUser.username}</span>
                  {currentUser.role === 'admin' && (
                    <span className="rounded bg-primary/20 px-1 py-0.2 text-[10px] font-semibold text-primary">
                      管理员
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleLogout()}
                    title="退出登录"
                    className="ml-1 cursor-pointer text-muted-foreground transition hover:text-destructive"
                  >
                    <LogOut className="size-3.5" />
                  </button>
                </div>
              )}
              <ThemeMenu />
              <button
                type="button"
                onClick={() => void handleNewChat()}
                disabled={streaming || switching}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs transition hover:border-primary/40 hover:bg-white/10 disabled:opacity-50"
              >
                <Plus className="size-3.5" />
                新对话
              </button>
            </div>
          </header>

          {/* 对话区 */}
          <div className="min-h-0 flex-1">
            <div ref={scrollRef} className="h-full overflow-y-auto">
              <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
                {messages.length === 0 ? (
                  <div className="flex-1">
                    <EmptyState
                      onPick={(t) => {
                        setInput(t)
                        textareaRef.current?.focus()
                      }}
                    />
                  </div>
                ) : (
                  <div className="space-y-6">
                    {messages.map((msg) => (
                      <MessageItem
                        key={msg.id}
                        msg={msg}
                        isLastAssistant={msg.id === lastAssistantId}
                        onConfirm={handleConfirm}
                        onRegenerate={
                          msg.role === 'assistant' && msg.id === lastAssistantId
                            ? regenerate
                            : undefined
                        }
                      />
                    ))}
                    {switching && (
                      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                        <Spinner className="size-4" /> 切换会话中…
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 输入区 */}
          <div className="shrink-0 px-4 pb-3 sm:px-6">
            <div className="mx-auto w-full max-w-3xl">
              <Composer
                ref={textareaRef}
                value={input}
                streaming={streaming}
                onChange={setInput}
                onSend={send}
                onStop={() => void handleStop()}
              />
              <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground/60">
                <span>内容由 AI 生成，请注意甄别 · Enter 发送</span>
                {sessionStats.totalTokens > 0 && (
                  <span className="hidden font-mono sm:inline">
                    会话消耗: {formatTokens(sessionStats.totalTokens)} tokens (↓{formatTokens(sessionStats.inputTokens)} ↑{formatTokens(sessionStats.outputTokens)})
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <WorkspaceDrawer
        open={workspaceDrawerOpen}
        onClose={() => setWorkspaceDrawerOpen(false)}
      />

      {needAuth && (
        <AuthModal
          hasUsers={hasUsers}
          rememberMode={authRemember}
          onSuccess={(user) => {
            setCurrentUser(user)
            setNeedAuth(false)
            void bootSession()
          }}
        />
      )}
    </div>
  )
}
