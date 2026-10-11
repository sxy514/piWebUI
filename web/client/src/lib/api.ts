export interface SessionInfo {
  client_id: string
  model: string
  session_id: string | null
}

export interface UsageInfo {
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  cost: number | null
}

export interface ToolPart {
  kind: 'tool'
  name: string
  args?: unknown
  result?: string
  ok?: boolean
  done: boolean
}

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | ToolPart

export interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  streaming: boolean
  error?: string
  interrupted?: boolean
  usage?: UsageInfo | null
  elapsed?: number
}

export interface HistoryItem {
  file: string
  title: string
  mtime: number
  current: boolean
}

export interface MessagesPayload {
  messages: Message[]
  session_file: string | null
  session_id: string | null
}

export interface ModelItem {
  id: string
  name: string
  provider: string
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; name: string | null }
  | { type: 'tool_exec'; name: string | null; args: unknown }
  | { type: 'tool_end'; name: string | null; ok: boolean; result: string }
  | {
      type: 'done'
      stop_reason: string | null
      elapsed: number
      usage: UsageInfo | null
      session_id: string | null
    }
  | { type: 'interrupted' }
  | { type: 'error'; message: string }

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    let detail = resp.statusText
    try {
      const data = await resp.json()
      detail = data.detail ?? detail
    } catch {
      /* keep statusText */
    }
    throw new Error(detail)
  }
  return resp.json() as Promise<T>
}

export function createSession(): Promise<SessionInfo> {
  return postJson<SessionInfo>('/api/session', {})
}

export function newSession(
  clientId: string,
): Promise<{ session_id: string | null; session_file: string | null }> {
  return postJson('/api/new', { client_id: clientId })
}

export function getHistory(
  clientId: string,
): Promise<{ current: string | null; items: HistoryItem[] }> {
  return fetch(`/api/history?client_id=${encodeURIComponent(clientId)}`).then(
    (r) => r.json(),
  )
}

export function getMessages(clientId: string): Promise<MessagesPayload> {
  return fetch(`/api/messages?client_id=${encodeURIComponent(clientId)}`).then(
    (r) => r.json(),
  )
}

export function switchSession(
  clientId: string,
  file: string,
): Promise<MessagesPayload> {
  return postJson('/api/switch', { client_id: clientId, session_file: file })
}

export function deleteSession(
  clientId: string,
  file: string,
): Promise<{ ok: boolean; was_current: boolean }> {
  return postJson('/api/history/delete', { client_id: clientId, session_file: file })
}

export function getModels(): Promise<ModelItem[]> {
  return fetch('/api/models').then((r) => r.json())
}

export function setModel(
  clientId: string,
  provider: string,
  modelId: string,
): Promise<{ model: string }> {
  return postJson('/api/model', {
    client_id: clientId,
    provider,
    model_id: modelId,
  })
}

export function interrupt(clientId: string): Promise<{ ok: boolean }> {
  return postJson('/api/interrupt', { client_id: clientId })
}

export async function sendChat(
  clientId: string,
  message: string,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, message }),
  })
  if (!resp.ok || !resp.body) {
    let detail = resp.statusText
    try {
      const data = await resp.json()
      detail = data.detail ?? detail
    } catch {
      /* keep statusText */
    }
    throw new Error(detail)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          onEvent(JSON.parse(line.slice(6)) as StreamEvent)
        } catch {
          /* skip malformed frame */
        }
      }
    }
  }
}
