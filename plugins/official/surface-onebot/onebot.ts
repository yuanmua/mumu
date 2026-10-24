/**
 * OneBot v11 正向 WebSocket 客户端（零依赖，用 Node 自带的 WebSocket）。
 *
 * 只做协议层：连上、断了重连、事件分发、`{action, params, echo}` 调用与应答配对。
 * 不认识沐沐的任何概念——感知、频道、回执都在 index.ts。
 *
 * NapCat 的「WebSocket 服务端」同一个口既推事件也收调用，所以一条连接就够了。
 */

import type { OneBotEvent } from './segments.ts'

// 类型定义在 segments.ts（对外稳定层）；这里转出，老的 import 路径照常可用
export type { OneBotEvent, Segment } from './segments.ts'

interface Reply {
  status: string
  retcode: number
  data?: unknown
  message?: string
  wording?: string
  echo?: string
}

export interface OneBotOptions {
  url: string
  token?: () => string | undefined // 每次连接时现取：改了密钥下次重连生效
  reconnectMs: number
  callTimeoutMs: number
  onEvent: (e: OneBotEvent) => void
  onOpen: () => void
  onClose: (reason: string) => void
}

export class OneBot {
  private ws?: WebSocket
  private seq = 0
  private pending = new Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>()
  private retry?: NodeJS.Timeout
  private closed = false
  private everOpened = false

  constructor(private opts: OneBotOptions) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start(): void {
    this.closed = false
    this.connect()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.retry)
    this.failAll('连接关闭')
    this.ws?.close()
    this.ws = undefined
  }

  /** 调一个 OneBot 动作；失败（retcode 非 0、超时、断线）一律抛错，调用方决定怎么降级 */
  call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('NapCat 没连上'))
    const echo = `mumu-${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`${action} 超时`))
      }, this.opts.callTimeoutMs)
      this.pending.set(echo, { resolve: v => resolve(v as T), reject, timer })
      ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  private connect(): void {
    if (this.closed)
      return
    const token = this.opts.token?.()
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)
    }
    catch (e) {
      // 地址写错（不是 ws:// 之类）时构造函数同步抛错；按断线处理，等用户改配置
      this.opts.onClose(e instanceof Error ? e.message : String(e))
      this.scheduleRetry()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.everOpened = true
      this.opts.onOpen()
    })
    ws.addEventListener('message', (m) => {
      let obj: (OneBotEvent & Partial<Reply>) | undefined
      try {
        obj = JSON.parse(String(m.data))
      }
      catch {
        return // 非 JSON 帧不是 OneBot 的东西，丢掉不影响后续
      }
      if (!obj)
        return
      if (typeof obj.echo === 'string' && this.pending.has(obj.echo)) {
        const p = this.pending.get(obj.echo)!
        this.pending.delete(obj.echo)
        clearTimeout(p.timer)
        if (obj.status === 'ok' || obj.retcode === 0)
          p.resolve(obj.data)
        else p.reject(new Error(`retcode ${obj.retcode}${obj.wording || obj.message ? `：${obj.wording || obj.message}` : ''}`))
        return
      }
      if (typeof obj.post_type === 'string')
        this.opts.onEvent(obj as OneBotEvent)
    })
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws)
        return
      this.ws = undefined
      this.failAll('连接断开')
      this.opts.onClose(e.reason || `code ${e.code}`)
      this.scheduleRetry()
    })
    // error 之后必有 close，重连统一在 close 里做；这里只防止未处理的 error 事件
    ws.addEventListener('error', () => {})
  }

  private scheduleRetry(): void {
    if (this.closed)
      return
    clearTimeout(this.retry)
    // 从没连上过时重试慢一点：多半是 NapCat 还没起，不必刷屏
    const delay = this.everOpened ? this.opts.reconnectMs : this.opts.reconnectMs * 2
    this.retry = setTimeout(() => this.connect(), delay)
    this.retry.unref()
  }

  private failAll(why: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(why))
    }
    this.pending.clear()
  }
}
