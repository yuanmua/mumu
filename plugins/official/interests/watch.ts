/**
 * 从日志投影「她这段聊得投不投入」与「聊到她的兴趣她却没接」，纯数据、不调模型（测试直接喂事件）。
 *
 * 一段（Segment）：她在某个会话里开口就开一段，她在那里安静 settleSec 秒就收。收的时候看信号——
 * 主动接了 ≥ minTurns 轮、追问过（她的话里带问号或疑问词）、说话时带正向表情（emo 开心 / 好奇 / 心动…）、
 * 说了「喜欢 / 迷上 / 不感兴趣」一类的词——有一个就交出一份 Job（这段的原话 + 信号），
 * 由 index.ts 用一次模型调用认出话题是什么、她到底投不投入、有没有表态。
 * 词只当「要不要去问模型」的扳机，不从她的话里抠内容（handbook §9.2 不用正则解析模型输出）。
 *
 * 没接（Miss）：别人的话里提到表里的兴趣（「提到」由调用方用语义打分认出、随事件传进来，这里不做匹配）→ 记一笔待定；missWindowSec 内她在那里开口了 = 接了；
 * 没开口、但叫醒大脑的就是这句（beat.opened 的原因里是这句话本身：读空气掷中了它、@ 了她、说完补判）= 看到了没接。
 * 大脑没被这句叫醒（群里被接话概率压掉了）不算——她根本没看到，算没接会让「分低 → 不唤醒 → 更低」越滚越低。
 * 原来只要这期间大脑因为这个会话醒过一次（不管是被哪句叫醒的）就算看到了：热闹的群里三分钟总会因为别的话醒一回，
 * 提到兴趣的话几乎全被算成「没接」，真群 10-22 一天把人设的猫从 0.65 扣到 0、航天从 0.63 扣到 0.38（2026-10-23 真群回放）。
 */
import type { LogEvent } from '../../../src/index.ts'

export interface Line { who: string, text: string, at: number, self: boolean }

export interface Signals {
  turns: number // 她这段开口几次
  questions: number // 她的话里带问号几次
  emo: string[] // 正向表情
  words: string[] // 命中的表态词
}

export interface Job { channel: string, lines: Line[], signals: Signals, from: number, to: number }

export interface WatchConfig {
  settleSec: number
  minTurns: number
  missWindowSec: number
  positiveEmo: string[]
  questionWords: string[] // 她的话里带这些（或问号）算追问：她口语里的追问多半不打问号（「成色咋样」「天上是什么颜色呀」）
  words: string[] // likeWords ∪ dislikeWords：只当扳机
  keepLines: number
}

interface Segment { channel: string, from: number, lastSelf: number, signals: Signals }
interface Pending { names: string[], at: number, text: string, seen: boolean }

/** 叫醒原因说的是不是这句：原因文字就是感知原文，说完补判那种把原文引在「…」里；两边都可能被截，各取前 40 字互相找 */
const sameLine = (reason: string, text: string): boolean =>
  !!reason && !!text && (reason.includes(text.slice(0, 40)) || text.includes(reason.slice(0, 40)))

/** 这条事件里要看「提没提到兴趣」的那句话：别人说的（percept.received）、她说出口的（utterance.settled）；别的事件没有 */
export function textOf(e: LogEvent): string | undefined {
  const d = (e.data ?? {}) as Record<string, unknown>
  if (e.type === 'percept.received' && typeof d.text === 'string' && d.sender)
    return d.text || undefined
  if (e.type === 'utterance.settled')
    return String(d.delivered ?? '').trim() || undefined
  return undefined
}

const isQuestion = (s: string, words: string[]): boolean => s.includes('？') || s.includes('?') || words.some(w => w && s.includes(w))

export class Watcher {
  private recent = new Map<string, Line[]>() // 会话 → 最近的原话（含她开口前的几句，给模型看上下文）
  private segs = new Map<string, Segment>()
  private utt = new Map<string, { channel: string, emo: string[] }>() // 发言 id → 频道、说话时带的表情
  private pending = new Map<string, Pending[]>() // 会话 → 提到兴趣、还没定接没接的
  /**
   * 看到哪了（存库，重载 / 重启后回放最近的日志时不重复算）：
   * closed = 每个会话最后收掉的那段她最后开口的时刻，这之前她的话不再开段；missedUntil 之前提到的兴趣已经判过接没接。
   */
  closed: Record<string, number>
  missedUntil: number

  constructor(private cfg: () => WatchConfig, seen: { closed?: Record<string, number>, missedUntil?: number } = {}) {
    this.closed = { ...seen.closed }
    this.missedUntil = seen.missedUntil ?? 0
  }

  private push(channel: string, line: Line): void {
    const list = this.recent.get(channel) ?? []
    list.push(line)
    const keep = this.cfg().keepLines
    if (list.length > keep)
      list.splice(0, list.length - keep)
    this.recent.set(channel, list)
  }

  /** 喂一条日志事件 + 这条话里提到的兴趣（textOf 取出的文字经语义打分认出的）；返回提到的兴趣（给调用方记「最近触发」） */
  observe(e: LogEvent, names: string[] = []): { channel: string, names: string[] } | undefined {
    const d = (e.data ?? {}) as Record<string, any>
    if (e.type === 'percept.received' && typeof d.text === 'string' && d.text && d.sender && typeof d.channel === 'string') {
      this.push(d.channel, { who: String(d.sender.name ?? d.sender.id ?? '对方'), text: d.text, at: e.at, self: false })
      if (names.length && e.at > this.missedUntil) {
        const list = this.pending.get(d.channel) ?? []
        list.push({ names, at: e.at, text: d.text, seen: false })
        this.pending.set(d.channel, list)
        return { channel: d.channel, names }
      }
      return undefined
    }
    if (e.type === 'beat.opened' && Array.isArray(d.reasons)) {
      for (const r of d.reasons as { channel?: string, text?: string }[]) {
        for (const p of (r.channel && this.pending.get(r.channel)) || []) {
          if (sameLine(String(r.text ?? ''), p.text))
            p.seen = true
        }
      }
      return undefined
    }
    if (e.type === 'utterance.started' && typeof d.id === 'string') {
      this.utt.set(d.id, { channel: String(d.channel ?? ''), emo: [] })
      return undefined
    }
    if (e.type === 'utterance.part' && d.part?.kind === 'marker' && d.part.data?.track === 'emo') {
      this.utt.get(String(d.id))?.emo.push(String(d.part.data.value ?? ''))
      return undefined
    }
    if (e.type === 'utterance.settled' && typeof d.id === 'string') {
      const u = this.utt.get(d.id)
      this.utt.delete(d.id)
      const channel = String(d.channel ?? u?.channel ?? '')
      const text = String(d.delivered ?? '').trim()
      if (!channel || !text)
        return undefined
      this.push(channel, { who: '她', text, at: e.at, self: true })
      this.pending.delete(channel) // 她开口了：这个会话里待定的都算接了
      const touched = names.length ? { channel, names } : undefined
      if (e.at <= (this.closed[channel] ?? 0))
        return touched // 这段已经看过了（回放）
      const c = this.cfg()
      const seg = this.segs.get(channel) ?? { channel, from: e.at, lastSelf: e.at, signals: { turns: 0, questions: 0, emo: [], words: [] } }
      seg.lastSelf = e.at
      seg.signals.turns++
      if (isQuestion(text, c.questionWords))
        seg.signals.questions++
      for (const m of u?.emo ?? []) {
        if (c.positiveEmo.includes(m) && !seg.signals.emo.includes(m))
          seg.signals.emo.push(m)
      }
      for (const w of c.words) {
        if (w && text.includes(w) && !seg.signals.words.includes(w))
          seg.signals.words.push(w)
      }
      this.segs.set(channel, seg)
      return touched
    }
    return undefined
  }

  /** 到点的段收掉：有投入信号的交出 Job；没信号的丢掉 */
  due(now: number): Job[] {
    const c = this.cfg()
    const out: Job[] = []
    for (const [ch, seg] of this.segs) {
      if (now - seg.lastSelf < c.settleSec * 1000)
        continue
      this.segs.delete(ch)
      this.closed[ch] = seg.lastSelf
      if (engaged(seg.signals, c.minTurns))
        out.push(this.jobOf(seg))
    }
    return out
  }

  /** 不等安静，现在就把进行中的段全收掉（命令 / 网页「现在就看」） */
  flush(): Job[] {
    const c = this.cfg()
    const out = [...this.segs.values()].filter(s => engaged(s.signals, c.minTurns)).map(s => this.jobOf(s))
    for (const s of this.segs.values()) this.closed[s.channel] = s.lastSelf
    this.segs.clear()
    return out
  }

  /** 要存库的游标：一天前收掉的会话不必记（回放只看最近一小时） */
  seen(now: number): { closed: Record<string, number>, missedUntil: number } {
    for (const [ch, at] of Object.entries(this.closed)) {
      if (now - at > 86_400_000)
        delete this.closed[ch]
    }
    return { closed: this.closed, missedUntil: this.missedUntil }
  }

  private jobOf(seg: Segment): Job {
    // 段内的话 + 她开口前的几句（别人起的话头）
    const lines = (this.recent.get(seg.channel) ?? []).filter(l => l.at >= seg.from - 10 * 60_000 && l.at <= seg.lastSelf)
    return { channel: seg.channel, lines, signals: seg.signals, from: seg.from, to: seg.lastSelf }
  }

  /** 到点没接的：返回每个兴趣名（一条话里提到几个就各算一次） */
  misses(now: number): string[] {
    const win = this.cfg().missWindowSec * 1000
    this.missedUntil = Math.max(this.missedUntil, now - win)
    const out: string[] = []
    for (const [ch, list] of this.pending) {
      const left = list.filter((p) => {
        if (now - p.at < win)
          return true
        if (p.seen)
          out.push(...p.names)
        return false
      })
      if (left.length)
        this.pending.set(ch, left)
      else this.pending.delete(ch)
    }
    return out
  }

  /** 正在攒的段（状态卡 / 命令看） */
  open(): { channel: string, turns: number }[] {
    return [...this.segs.values()].map(s => ({ channel: s.channel, turns: s.signals.turns }))
  }
}

export function engaged(s: Signals, minTurns: number): boolean {
  return s.turns >= minTurns || s.questions > 0 || s.emo.length > 0 || s.words.length > 0
}
