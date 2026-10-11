import { useCallback, useEffect, useRef, useState } from 'react'
import { Composer } from '@/components/Composer'
import { EmptyState } from '@/components/EmptyState'
import { MessageItem } from '@/components/MessageItem'
import { ModelMenu } from '@/components/ModelMenu'
import { Sidebar } from '@/components/Sidebar'
import { ThemeMenu } from '@/components/ThemeMenu'
import { Spinner } from '@/components/ui/spinner'
import {
  createSession,
  deleteSession,
  getHistory,
  getModels,
  interrupt,
  newSession,
  sendChat,
  setModel,
  switchSession,
  type HistoryItem,
  type Message,
  type ModelItem,
  type SessionInfo,
  type StreamEvent,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { CircleAlert, Menu, Plus } from 'lucide-react'

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
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [switching, setSwitching] = useState(false)

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

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    ;(async () => {
      try {
        const info = await createSession()
        setSession(info)
        await Promise.all([
          refreshHistory(info.client_id),
          getModels().then(setModels).catch(() => undefined),
        ])
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [refreshHistory])

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
        case 'done':
          patchLastAssistant((msg) => ({
            ...msg,
            streaming: false,
            usage: event.usage,
            elapsed: event.elapsed,
          }))
          break
        case 'interrupted':
          patchLastAssistant((msg) => ({ ...msg, streaming: false, interrupted: true }))
          break
        case 'error':
          patchLastAssistant((msg) => ({
            ...msg,
            streaming: false,
            error: event.message,
          }))
          break
      }
    },
    [patchLastAssistant],
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
        void refreshHistory(session.client_id)
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

  const regenerate = useCallback(() => {
    let lastUser: Message | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUser = messages[i]
        break
      }
    }
    if (!lastUser || streaming) return
    const text = lastUser.parts
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('')
      .trim()
    if (!text) return

    setMessages((prev) => {
      const next = [...prev]
      if (next.length && next[next.length - 1].role === 'assistant') next.pop()
      return next
    })
    void doSend(text, false)
  }, [messages, streaming, doSend])

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
              <p className="mt-2 text-center text-[11px] text-muted-foreground/60">
                内容由 AI 生成，请注意甄别 · Enter 发送
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
