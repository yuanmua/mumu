/**
 * 协议客户端：全部网络调用只在这个文件。契约见 docs/web-protocol.md。
 * 失败不抛给界面层，返回 undefined / false 并在控制台留痕；界面从连接状态感知异常。
 */
import type { Conversation, Incoming, Meta, Models, Persona } from './types.ts'

const BASE = '/api'

async function post(path: string, body?: unknown): Promise<Response | undefined> {
  try {
    return await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  catch (e) {
    console.warn(`[client] ${path} 失败:`, e)
    return undefined
  }
}

export function openEvents(handlers: {
  onIncoming: (e: Incoming) => void
  onOpen: () => void
  onError: () => void
}, channel?: string): () => void {
  // 指定频道 = 只订阅这一个对话（服务端从全量日志重放该对话）
  const es = new EventSource(`${BASE}/events${channel ? `?channel=${encodeURIComponent(channel)}` : ''}`)
  es.onmessage = (m) => {
    try {
      handlers.onIncoming(JSON.parse(m.data))
    }
    catch (e) {
      console.warn('[client] 坏事件，已忽略:', e) // 一条坏事件不该断掉整条流
    }
  }
  es.onopen = handlers.onOpen // 重连也触发：调用方据此清空投影，服务端会重放
  es.onerror = handlers.onError // EventSource 自带重连
  return () => es.close()
}

export async function fetchMeta(): Promise<Meta | undefined> {
  try {
    const res = await fetch(`${BASE}/meta`)
    return res.ok ? await res.json() : undefined
  }
  catch {
    return undefined // 后端没起：界面显示离线
  }
}

export async function fetchConversations(): Promise<Conversation[]> {
  try {
    const res = await fetch(`${BASE}/conversations`)
    return res.ok ? (await res.json()).conversations ?? [] : []
  }
  catch {
    return []
  }
}

export async function fetchPersona(): Promise<Persona | undefined> {
  try {
    const res = await fetch(`${BASE}/persona`)
    return res.ok ? await res.json() : undefined
  }
  catch {
    return undefined // 后端没起或没装 persona：面板显示读不到
  }
}

/** 保存人格；成功返回写入后的合并配置，失败返回 { error } 让面板原样显示原因 */
export async function savePersona(patch: Partial<Persona>): Promise<Persona | { error: string }> {
  const res = await post('/persona', patch)
  if (!res)
    return { error: '后端不可达' }
  const body = await res.json().catch(() => ({}))
  return res.ok ? body : { error: body.error ?? `HTTP ${res.status}` }
}

export async function fetchModels(): Promise<Models | undefined> {
  try {
    const res = await fetch(`${BASE}/models`)
    return res.ok ? await res.json() : undefined
  }
  catch {
    return undefined // 后端没起或没装 provider-openai：面板显示读不到
  }
}

/** 保存完整的角色绑定表；成功返回写入后的合并视图，失败返回 { error } 让面板原样显示原因 */
export async function saveModels(roles: Models['roles']): Promise<Models | { error: string }> {
  const res = await post('/models', { roles })
  if (!res)
    return { error: '后端不可达' }
  const body = await res.json().catch(() => ({}))
  return res.ok ? body : { error: body.error ?? `HTTP ${res.status}` }
}

export async function sendInput(text: string, channel?: string): Promise<boolean> {
  const res = await post('/input', { text, channel })
  return !!res && res.ok
}

export function reportDelivered(uttId: string, chars: number): void {
  void post('/delivered', { uttId, chars })
}

export async function clearMemory(): Promise<boolean> {
  const res = await post('/clear')
  return !!res && res.ok
}

export async function runCommand(line: string): Promise<string[]> {
  const res = await post('/command', { line })
  if (!res)
    return ['（后端不可达）']
  const body = await res.json().catch(() => ({}))
  return res.ok ? (body.lines ?? []) : [body.error ?? `HTTP ${res.status}`]
}

/** 一句话换一段音频；失败返回 undefined，调用方降级为无声字幕 */
export async function fetchSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer | undefined> {
  try {
    const res = await fetch(`${BASE}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    return res.ok ? await res.arrayBuffer() : undefined
  }
  catch {
    return undefined
  }
}

/** 流式感知（浏览器语音识别）句柄 */
export interface PerceptionHandle {
  update: (text: string, wake?: boolean) => void
  end: (text?: string) => void
  cancel: (reason?: string) => void
}

export async function startPerception(opts: { kind?: string, urgent?: boolean } = {}): Promise<PerceptionHandle | undefined> {
  const res = await post('/perception/start', opts)
  if (!res || !res.ok)
    return undefined
  const { id } = await res.json()
  return {
    update: (text, wake) => void post('/perception/update', { id, text, wake }),
    end: text => void post('/perception/end', { id, text }),
    cancel: reason => void post('/perception/cancel', { id, reason }),
  }
}
