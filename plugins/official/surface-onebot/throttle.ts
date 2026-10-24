/**
 * 出口节流：所有经 NapCat 「做出来」的事都过这一道门，按真人的手速一件一件来。
 *
 * 立场：
 * - 人只有一双手：在 A 群打字时不能同时在 B 群发东西。所以全局只有一条队列，按进队顺序出，
 *   不同会话之间也串行；每个会话自己的顺序自然保持。
 * - 任意两次操作之间隔一段「手速间隔」（minGapMs～maxGapMs 随机）；发文字再加打字时间
 *   （typingBaseMs + 字数 × msPerChar，夹在 maxTypingMs 内，带 jitter 抖动）。打字从手空下来那一刻算起；
 *   一段发言的第一条从发言开始算起（模型想词的时间也算在「打字」里）。
 * - 每分钟最多 perMinute 次操作，超了往后排，不丢。
 * - 打字时间够长（≥ inputStatusMinMs）的私聊，开始打字时先显示「正在输入」。
 * - 只读的接口（get_* / fetch_* / ocr …）和「正在输入」本身不过门：看一眼不需要手。
 * - 排队中的操作可以作废（发言被打断）：从队里拿掉，调用方收到 AbortError，什么都没发出去。
 *   已经交给 NapCat 的撤不回——那一条照常完成。
 */
import { setTimeout as sleep } from 'node:timers/promises'

export interface ThrottleConfig {
  minGapMs?: number
  maxGapMs?: number
  typingBaseMs?: number
  msPerChar?: number
  maxTypingMs?: number
  jitter?: number // 0.25 = 打字时间上下浮动 25%
  perMinute?: number
  inputStatusMinMs?: number
}

export interface GateJob {
  action: string
  params: Record<string, unknown>
  channel?: string
  chars?: number // 要打的字数；0 / 省略 = 不是打字（发图、群管…）
  since?: number // 打字最早从这个时刻算起（一段发言的第一条 = 发言开始）
  signal?: AbortSignal
}

interface Queued extends GateJob {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  at: number
}

/** 不过门的接口：只读，或者只是个状态提示 */
export function isRead(action: string): boolean {
  return /^(?:_?get_|fetch_|can_|check_|nc_get_|\.?ocr_image$|\.get_word_slices$)/.test(action) || action === 'set_input_status'
}

export class Gate {
  private queue: Queued[] = []
  private running = false
  private lastAt = 0 // 上一次操作完成的时刻
  private recent: number[] = [] // 最近一分钟内每次操作的时刻
  readonly timeline: { at: number, action: string, channel?: string, waitedMs: number, typingMs: number }[] = []

  constructor(
    private cfg: ThrottleConfig,
    private call: (action: string, params: Record<string, unknown>) => Promise<unknown>,
    private typingHint: (channel: string) => void,
  ) {}

  get pending(): number {
    return this.queue.length
  }

  run<T = unknown>(job: GateJob): Promise<T> {
    if (job.signal?.aborted)
      return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
      const q: Queued = { ...job, resolve: v => resolve(v as T), reject, at: Date.now() }
      this.queue.push(q)
      job.signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(q)
        if (i >= 0) {
          this.queue.splice(i, 1)
          reject(abortError())
        }
      }, { once: true })
      void this.pump()
    })
  }

  /** 卸载 / 断线：排队的全部作废 */
  clear(why: string): void {
    for (const q of this.queue.splice(0)) q.reject(new Error(why))
  }

  private typingMs(chars: number): number {
    const { typingBaseMs = 400, msPerChar = 180, maxTypingMs = 6000, jitter = 0.25 } = this.cfg
    const base = Math.min(maxTypingMs, typingBaseMs + chars * msPerChar)
    return Math.max(0, base * (1 + (Math.random() * 2 - 1) * jitter))
  }

  private gapMs(): number {
    const { minGapMs = 600, maxGapMs = 1400 } = this.cfg
    return minGapMs + Math.random() * Math.max(0, maxGapMs - minGapMs)
  }

  /** 每分钟上限：满了就等到最早那次滑出一分钟窗口 */
  private rateFree(now: number): number {
    const limit = this.cfg.perMinute ?? 20
    this.recent = this.recent.filter(t => now - t < 60_000)
    return this.recent.length < limit ? 0 : this.recent[this.recent.length - limit] + 60_000
  }

  private async pump(): Promise<void> {
    if (this.running)
      return
    this.running = true
    try {
      while (this.queue.length) {
        const job = this.queue[0]
        const now = Date.now()
        const handsFree = this.lastAt ? this.lastAt + this.gapMs() : 0
        const start = Math.max(handsFree, job.since ?? 0, this.rateFree(now))
        const typing = job.chars ? this.typingMs(job.chars) : 0
        const sendAt = Math.max(start + typing, now)
        try {
          if (start > now)
            await sleep(start - now, undefined, { signal: job.signal })
          if (job.channel && typing >= (this.cfg.inputStatusMinMs ?? 1500))
            this.typingHint(job.channel)
          const left = sendAt - Date.now()
          if (left > 0)
            await sleep(left, undefined, { signal: job.signal })
        }
        catch {
          continue // 等的时候被作废：run() 里的 abort 监听已经把它拿出队列并回了 AbortError
        }
        if (this.queue[0] !== job)
          continue
        this.queue.shift()
        try {
          job.resolve(await this.call(job.action, job.params))
        }
        catch (e) {
          job.reject(e instanceof Error ? e : new Error(String(e)))
        }
        this.lastAt = Date.now()
        this.recent.push(this.lastAt)
        this.timeline.push({ at: this.lastAt, action: job.action, channel: job.channel, waitedMs: this.lastAt - job.at, typingMs: Math.round(typing) })
        if (this.timeline.length > 50)
          this.timeline.shift()
      }
    }
    finally {
      this.running = false
    }
  }
}

function abortError(): Error {
  const e = new Error('已作废（发言被打断）')
  e.name = 'AbortError'
  return e
}
