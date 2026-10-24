export interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
  streaming: boolean
  usage?: UsageInfo | null
  elapsed?: number
  interrupted?: boolean
  error?: string
}

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; args?: unknown; done: boolean; ok?: boolean; result?: string }
  | {
      kind: 'confirm'
      confirm_id: string
      title: string
      message: string
      status: 'pending' | 'approved' | 'denied' | 'expired'
      is_dangerous?: boolean
    }

export interface UsageInfo {
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  cost?: number | null
}

export interface UserInfo {
  id: string
  username: string
  role: string
  status: string
  created_at: number
}

export interface SessionInfo {
  client_id: string
  model: string
  session_id: string | null
  user?: UserInfo
  context_window?: number
}

export interface HistoryItem {
  file: string
  title: string
  mtime: number
  current: boolean
}

export interface ModelItem {
  id: string
  name: string
  provider: string
  context_window?: number
}

export interface ContextUsageInfo {
  tokens: number
  contextWindow: number
  percent: number
}

export interface SessionStatsPayload {
  sessionFile: string | null
  sessionId: string | null
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    total: number
  }
  cost: number
  contextUsage: ContextUsageInfo
}

export interface MessagesPayload {
  messages: Message[]
  session_file: string | null
  session_id: string | null
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
  | {
      type: 'confirm_request'
      confirm_id: string
      title: string
      message: string
      is_dangerous?: boolean
    }
  | { type: 'interrupted' }
  | { type: 'confirm_timeout'; confirm_id: string }
  | { type: 'error'; message: string }

let authToken = ''
let authRememberMode = 'true'

export function setAuthToken(token: string, mode: string = authRememberMode) {
  authToken = token.trim()
  authRememberMode = mode
  if (authToken) {
    if (mode === 'true' || mode === 'local') {
      localStorage.setItem('pi_auth_token', authToken)
      sessionStorage.removeItem('pi_auth_token')
    } else if (mode === 'session') {
      sessionStorage.setItem('pi_auth_token', authToken)
      localStorage.removeItem('pi_auth_token')
    } else {
      localStorage.removeItem('pi_auth_token')
      sessionStorage.removeItem('pi_auth_token')
    }
  } else {
    localStorage.removeItem('pi_auth_token')
    sessionStorage.removeItem('pi_auth_token')
  }
}

export function initAuthToken(mode: string = 'true') {
  authRememberMode = mode
  if (mode === 'true' || mode === 'local') {
    authToken = localStorage.getItem('pi_auth_token') || ''
  } else if (mode === 'session') {
    authToken = sessionStorage.getItem('pi_auth_token') || ''
    localStorage.removeItem('pi_auth_token')
  } else {
    authToken = ''
    localStorage.removeItem('pi_auth_token')
    sessionStorage.removeItem('pi_auth_token')
  }
}

export function getAuthToken(): string {
  return authToken
}

export async function getAuthStatus(): Promise<{
  auth_mode: string
  auth_required: boolean
  has_users: boolean
  auth_remember?: string
}> {
  try {
    const res = await fetch('/api/auth/status')
    if (res.ok) {
      return res.json()
    }
  } catch {
    /* ignore network error */
  }
  return { auth_mode: 'user', auth_required: true, has_users: false }
}

export async function loginUser(username: string, password: string): Promise<UserInfo> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '登录失败，请检查用户名与密码')
  }
  const data = await res.json()
  setAuthToken(data.token, authRememberMode)
  return data.user
}

export async function registerUser(username: string, password: string): Promise<UserInfo> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '注册失败')
  }
  const data = await res.json()
  setAuthToken(data.token, authRememberMode)
  return data.user
}

export async function getMe(): Promise<UserInfo | null> {
  try {
    const res = await authFetch('/api/auth/me')
    if (res.ok) {
      const data = await res.json()
      return data.user
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function logoutUser(): Promise<void> {
  try {
    await authFetch('/api/auth/logout', { method: 'POST' })
  } catch {
    /* ignore */
  }
  setAuthToken('')
}

export async function verifyAuthToken(_token: string): Promise<boolean> {
  return false
}

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`)
  }
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('pi-unauthorized'))
  }
  return res
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    if (resp.status === 401) {
      window.dispatchEvent(new CustomEvent('pi-unauthorized'))
    }
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

export function createSession(clientId?: string): Promise<SessionInfo> {
  return postJson<SessionInfo>('/api/session', { client_id: clientId ?? null })
}

export function closeSession(clientId: string): Promise<{ ok: boolean }> {
  return postJson('/api/session/close', { client_id: clientId })
}

export function newSession(
  clientId: string,
): Promise<{ session_id: string | null; session_file: string | null }> {
  return postJson('/api/new', { client_id: clientId })
}

export function forkSession(clientId: string): Promise<{
  ok: boolean
  prompt: string
  messages: Message[]
  session_file: string | null
  session_id: string | null
}> {
  return postJson('/api/fork', { client_id: clientId })
}

export function getHistory(
  clientId: string,
): Promise<{ current: string | null; items: HistoryItem[] }> {
  return authFetch(`/api/history?client_id=${encodeURIComponent(clientId)}`).then(
    (r) => r.json(),
  )
}

export function getMessages(clientId: string): Promise<MessagesPayload> {
  return authFetch(`/api/messages?client_id=${encodeURIComponent(clientId)}`).then(
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
  return authFetch('/api/models').then((r) => r.json())
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

export function sendConfirm(
  clientId: string,
  confirmId: string,
  approved: boolean,
): Promise<{ ok: boolean; expired?: boolean }> {
  return postJson('/api/confirm', {
    client_id: clientId,
    confirm_id: confirmId,
    approved,
  })
}

export async function sendChat(
  clientId: string,
  message: string,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const resp = await authFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, message }),
  })
  if (!resp.ok || !resp.body) {
    if (resp.status === 401) {
      window.dispatchEvent(new CustomEvent('pi-unauthorized'))
    }
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

export async function getSessionStats(clientId: string): Promise<SessionStatsPayload | null> {
  try {
    const res = await authFetch(`/api/stats?client_id=${encodeURIComponent(clientId)}`)
    if (res.ok) {
      return await res.json()
    }
  } catch {
    /* ignore */
  }
  return null
}


export interface WorkspaceItem {
  name: string
  path: string
  is_dir: boolean
  size: number
  size_formatted: string
  mtime: number
  extension: string
}

export interface WorkspaceFilesResponse {
  workspace: string
  total_files: number
  total_size: number
  total_size_formatted: string
  items: WorkspaceItem[]
}

export async function getWorkspaceFiles(): Promise<WorkspaceFilesResponse> {
  const res = await authFetch('/api/workspace/files')
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || '获取工作区文件失败')
  }
  return res.json()
}

export function getWorkspaceDownloadUrl(filePath: string, preview = false): string {
  const token = getAuthToken()
  const params = new URLSearchParams({
    path: filePath,
    preview: preview ? 'true' : 'false',
  })
  if (token) {
    params.set('token', token)
  }
  return `/api/workspace/file/download?${params.toString()}`
}

export function getWorkspaceArchiveUrl(): string {
  const token = getAuthToken()
  const params = new URLSearchParams()
  if (token) {
    params.set('token', token)
  }
  const q = params.toString()
  return `/api/workspace/archive${q ? `?${q}` : ''}`
}
