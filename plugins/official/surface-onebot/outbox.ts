/**
 * 发件箱：把一条流式发言（Utterance）切成几条 QQ 消息，按顺序交给出口节流（throttle.ts）逐条发出。
 *
 * 立场：
 * - 切分点只有两种：模型显式分段（Part kind 'break'，即 <|br|>）与句末标点。
 *   句末标点要攒够 minChars 才切——「嗯。」「好。」单独成条太碎，像机器人。
 * - 打字节奏、手速间隔、每分钟上限都归节流层（全局一双手）；这里只告诉它「这条有几个字」
 *   和「第一条从发言开始算起」（模型想词的时间也算在打字里）。
 * - 回执只在一条真正发送成功后才报（内核不变量 I2）：报的是累计消费掉的 Part.text 字数，
 *   切出来的每一段是流的连续前缀，所以累计字数就是「对方实际看到的前缀」。
 * - 被打断（stop）时：本地队列清空、节流层里排着的那条作废、没发出去的永远不发。
 *   已经交给 NapCat 的那一条撤不回，它不会再被回执——日志按内核结算的前缀记。
 * - 表情 / 动作 marker（emo / act）在 QQ 上没有身体可演，直接吞掉（要不要顺手配一张表情包由 extra 决定）。
 * - 表情包可能要找一会儿（库里挑、联网找）：extra 返回 Promise 时按出现位置占一格，后面的话等它；落空就跳过。
 *   等待期间被打断照常作废。
 */
import type { Expression } from '../../../src/index.ts'
import type { Segment } from './segments.ts'

export interface SplitConfig {
  minChars?: number
  stripTrailingPeriod?: boolean // QQ 上很少有人在句尾打句号
}

/**
 * 一条要发出的东西；raw = 它消费掉的 Part.text 字数（回执用）。
 * msg：夹了引用 / @ 的整条消息段（按出现位置排好，引用在最前）；没有就是纯文字 text。
 */
export type OutItem = { kind: 'text', text: string, raw: number, msg?: Segment[] } | { kind: 'extra', part: { kind: string, data?: Record<string, unknown> }, raw: 0 }

/** 还在找的那条（表情包库里挑、联网找）：占住队里的位置，找到了换成真的那条，落空就跳过；后面的话等它 */
type Queued = OutItem | { kind: 'later', wait: Promise<OutItem | undefined>, raw: 0 }

export interface OutboxDeps {
  split: SplitConfig
  /**
   * 交给节流层发出一条：'ok' 发出去了；'aborted' 排队时被打断作废（什么都没发）；
   * 'failed' 发不出去，发件箱放弃这条发言剩下的部分。since = 打字最早从何时算起。
   */
  send: (channel: string, item: OutItem, opts: { since?: number, signal: AbortSignal, uttId: string }) => Promise<'ok' | 'aborted' | 'failed'>
  report: (uttId: string, chars: number) => void
  /** 发送失败：剩下的发不出去了，由上层把发言停掉，让内核按已回执的前缀结算 */
  failed: (uttId: string, error: string) => void
  /** 非文本片段要不要单独成条发出（如表情包）；返回 undefined = 吞掉；Promise = 还要找一会儿，按位置排队等它 */
  extra?: (channel: string, part: { kind: string, data?: Record<string, unknown> }, uttId: string) => OutItem | Promise<OutItem | undefined> | undefined
  /** 并进下一条消息的片段（<|quote|> → 引用段，<|at:名字|> → @ 段）；不认识返回 undefined */
  inline?: (channel: string, part: { kind: string, data?: Record<string, unknown> }) => Segment | undefined
}

interface Pending {
  id: string
  channel: string
  buf: string
  queue: Queued[]
  inl: { pos: number, seg: Segment }[] // 引用 / @ 及其在 buf 里的位置
  delivered: number // 已回执的累计字数
  consumed: number // 已切进队列的累计字数
  startedAt: number
  sentAny: boolean
  ended: boolean
  stopped: boolean
  running: boolean
  abort: AbortController
}

const ENDERS = new Set(['。', '！', '？', '!', '?', '…', '~', '～', '\n'])
const HTML_BR = ['<br>', '<br/>', '<br />']
const CLOSERS =new Set(['」', '』', '”', '"', '）', ')', '~', '～', '…', '！', '？', '!', '?', '。'])

export class Outbox {
  private live = new Map<string, Pending>()

  constructor(private deps: OutboxDeps) {}

  handle(e: Expression): void {
    if (e.type === 'stop') {
      const u = this.live.get(e.uttId)
      if (u) {
        u.stopped = true
        u.queue.length = 0
        u.abort.abort()
        this.live.delete(e.uttId)
      }
      return
    }
    const u = this.get(e.uttId, e.channel)
    if (e.type === 'end') {
      this.flush(u)
      u.ended = true
      void this.pump(u)
      return
    }
    const part = e.part
    if (part.text) {
      u.buf += part.text
      this.cut(u)
    }
    else if (part.kind === 'break') {
      this.flush(u)
    }
    else if (this.inlineOf(u, part)) {
      // 已记进 u.inl，随它所在的那条消息发出
    }
    else {
      const item = this.deps.extra?.(u.channel, part, u.id)
      if (item) {
        this.flush(u)
        u.queue.push(item instanceof Promise ? { kind: 'later', wait: item.catch(() => undefined), raw: 0 } : item)
      }
    }
    void this.pump(u)
  }

  /** 停掉全部在途发言（断线、卸载）；返回它们的 id 供上层停动作 */
  drop(): string[] {
    const ids = [...this.live.keys()]
    for (const u of this.live.values()) {
      u.stopped = true
      u.abort.abort()
    }
    this.live.clear()
    return ids
  }

  private get(id: string, channel: string): Pending {
    let u = this.live.get(id)
    if (!u) {
      u = { id, channel, buf: '', queue: [], inl: [], delivered: 0, consumed: 0, startedAt: Date.now(), sentAny: false, ended: false, stopped: false, running: false, abort: new AbortController() }
      this.live.set(id, u)
    }
    return u
  }

  /** 在句末标点处切；标点后紧跟的收尾符号（引号、省略号、连串问号）一起带走 */
  private cut(u: Pending): void {
    const min = this.deps.split.minChars ?? 6
    for (;;) {
      let at = -1
      for (let i = 0; i < u.buf.length; i++) {
        // 模型偶尔把 <|br|> 写成 HTML 的 <br>：在 QQ 上原样发出去很出戏，当分段处理
        const br = HTML_BR.find(t => u.buf.startsWith(t, i))
        if (br) {
          at = i + br.length
          break
        }
        if (!ENDERS.has(u.buf[i]))
          continue
        let j = i + 1
        while (j < u.buf.length && CLOSERS.has(u.buf[j])) j++
        if (j >= u.buf.length && u.buf[i] !== '\n')
          break // 标点在末尾：下一块可能还有收尾符号，等等再切
        if (u.buf[i] === '\n' || u.buf.slice(0, j).trim().length >= min) {
          at = j
          break
        }
        i = j - 1
      }
      if (at < 0)
        return
      this.take(u, at)
    }
  }

  private flush(u: Pending): void {
    if (u.buf || u.inl.length)
      this.take(u, u.buf.length, true)
  }

  private take(u: Pending, n: number, all = false): void {
    const raw = u.buf.slice(0, n)
    u.buf = u.buf.slice(n)
    u.consumed += raw.length
    // 正好落在切点上的 @ 属于下一条（它在修饰后面的话），除非这是最后一把
    const mine = u.inl.filter(x => x.pos < n || (all && x.pos === n))
    u.inl = u.inl.filter(x => !mine.includes(x)).map(x => ({ pos: x.pos - n, seg: x.seg }))
    if (!mine.length) {
      u.queue.push({ kind: 'text', text: this.clean(raw), raw: raw.length })
      return
    }
    const msg = this.compose(raw, mine)
    const text = msg.filter(x => x.type === 'text').map(x => String(x.data.text)).join('')
    u.queue.push({ kind: 'text', text, raw: raw.length, msg })
  }

  /** 文字按 @ 的位置切开、穿插；引用挪到最前；首尾照常清理，@ 后面补个空格 */
  private compose(raw: string, inl: { pos: number, seg: Segment }[]): Segment[] {
    const pieces: (string | Segment)[] = []
    let prev = 0
    for (const x of inl) {
      pieces.push(raw.slice(prev, x.pos), x.seg)
      prev = x.pos
    }
    pieces.push(raw.slice(prev))
    const strip = (t: string): string => HTML_BR.reduce((acc, br) => acc.replaceAll(br, ''), t)
    const out: Segment[] = []
    const replies: Segment[] = []
    for (const p of pieces) {
      if (typeof p !== 'string') {
        if (p.type === 'reply')
          replies.length || replies.push(p)
        else out.push(p)
        continue
      }
      let t = strip(p)
      if (!out.length)
        t = t.trimStart()
      if (t && out.at(-1)?.type === 'at' && !t.startsWith(' '))
        t = ` ${t}`
      if (t)
        out.push({ type: 'text', data: { text: t } })
    }
    const last = out.at(-1)
    if (last?.type === 'text') {
      const t = this.clean(String(last.data.text))
      if (t)
        last.data.text = t
      else out.pop()
    }
    return [...replies, ...out]
  }

  /** 引用 / @ 记下它在文字里的位置，切条时再穿插进去 */
  private inlineOf(u: Pending, part: { kind: string, data?: Record<string, unknown> }): boolean {
    const s = this.deps.inline?.(u.channel, part)
    if (!s)
      return false
    u.inl.push({ pos: u.buf.length, seg: s })
    return true
  }

  private clean(s: string): string {
    let t = s
    for (const br of HTML_BR) t = t.replaceAll(br, '')
    t = t.trim()
    if (this.deps.split.stripTrailingPeriod !== false && t.endsWith('。') && !t.endsWith('。。'))
      t = t.slice(0, -1)
    return t
  }

  private async pump(u: Pending): Promise<void> {
    if (u.running)
      return
    u.running = true
    try {
      while (!u.stopped && u.queue.length) {
        const head = u.queue[0]
        if (head.kind === 'later') {
          const found = await Promise.race([head.wait, aborted(u.abort.signal)])
          if (u.stopped)
            return
          if (found)
            u.queue[0] = found
          else u.queue.shift() // 没找到：跳过，不占字数
          continue
        }
        const item = head
        const skip = item.kind === 'text' && !item.text && !item.msg?.some(x => x.type !== 'reply') // 纯空白 / 单独的 <br>：不发，但字数照算
        if (!skip) {
          const r = await this.deps.send(u.channel, item, { since: u.sentAny ? undefined : u.startedAt, signal: u.abort.signal, uttId: u.id })
          if (r === 'aborted' || u.stopped)
            return // 被打断：排着的作废没发；已交给 NapCat 的撤不回，但内核已结算，不再回执
          if (r === 'failed') {
            this.live.delete(u.id)
            u.stopped = true
            this.deps.failed(u.id, '发送失败')
            return
          }
          u.sentAny = true
        }
        u.queue.shift()
        u.delivered += item.raw
        this.deps.report(u.id, u.delivered)
      }
      if (u.ended && !u.stopped && !u.queue.length) {
        this.live.delete(u.id)
        this.deps.report(u.id, u.consumed) // 兜底：全部发完，确保内核能结算
      }
    }
    finally {
      u.running = false
    }
  }
}

/** 被打断时不再等那张还在找的表情包 */
function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted)
      return resolve(undefined)
    signal.addEventListener('abort', () => resolve(undefined), { once: true })
  })
}
