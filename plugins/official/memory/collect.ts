/**
 * 从真源攒「还没压成摘要」的对话，按会话分桶；顺手记人（名字、跟她打过交道没有）。
 *
 * 跟她打过交道 = 直接冲她说的（@、叫名字、私聊、网页，即 kind 不是 group.message），
 * 或者她开口前最后说话的那个人（她在接谁的话）。只有这些人进摘要的人物更新——几万人的群，其他人只记名字。
 * 重启后从日志里 mem_cursor 之后的部分接着攒；日志被清空（序号倒退）就把桶清掉，已压好的记忆不动。
 */
import type { LogEvent, Sender } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'
import type { MemoryStore } from './store.ts'

export const SELF = '\u0000self'

export interface Turn {
  at: number
  channel: string
  who: string // 人的 id；她自己是 SELF
  name: string
  text: string
  direct: boolean
}

export interface CollectConfig {
  chunk: number // 一对一会话攒多少条压一次
  groupChunk: number
  minTurns: number // 安静下来时至少攒了这么多条才压
  idleSec: number
}

export class Collector {
  private buffers = new Map<string, Turn[]>()
  private engaged = new Map<string, Set<string>>() // 频道 → 这一段里跟她打过交道的人

  constructor(
    private store: MemoryStore,
    private cfg: CollectConfig,
    readonly personOf: (sender: Sender, channel: string) => { id: string, name: string },
    readonly isGroup: (channel: string) => boolean,
  ) {}

  /** 启动时从日志里接着攒：只要每个会话 cursor 之后的 */
  replay(events: readonly LogEvent[]): void {
    const cursors = this.store.cursors()
    for (const e of events) {
      const ch = String(e.data?.channel ?? MAIN_CHANNEL)
      if (e.at > (cursors.get(ch) ?? 0))
        this.observe(e, false)
    }
  }

  /** 日志清空：桶里的东西已不在真源里了（已压好的记忆不动） */
  reset(): void {
    this.buffers.clear()
    this.engaged.clear()
  }

  observe(e: LogEvent, live = true): void {
    const d = e.data ?? {}
    const channel = String(d.channel ?? MAIN_CHANNEL)
    if (e.type === 'percept.received' && d.sender && d.text) {
      const who = this.personOf(d.sender, channel)
      const direct = d.kind !== 'group.message'
      this.push({ at: e.at, channel, who: who.id, name: who.name, text: String(d.text), direct })
      if (live)
        this.store.seen(who.id, who.name, channel, e.at, direct || !this.isGroup(channel))
      if (direct || !this.isGroup(channel))
        this.engage(channel, who.id)
    }
    else if (e.type === 'utterance.settled' && d.delivered) {
      const list = this.buffers.get(channel) ?? []
      // 她在接谁的话：她开口前最后一个说话的人
      const last = [...list].reverse().find(t => t.who !== SELF && e.at - t.at < 180_000)
      if (last) {
        this.engage(channel, last.who)
        if (live)
          this.store.seen(last.who, last.name, channel, last.at, true)
      }
      // 她以前说出去的字面 <br>（模型把 <|br|> 写错了留下的）别带进记忆再喂回模型
      const text = String(d.delivered).split('<br />').join(' ').split('<br/>').join(' ').split('<br>').join(' ')
      this.push({ at: e.at, channel, who: SELF, name: '你', text, direct: false })
    }
  }

  /** 该压的会话：攒够一段，或安静了 idleSec 且攒了 minTurns 条以上 */
  due(now: number): string[] {
    const out: string[] = []
    for (const [ch, list] of this.buffers) {
      const size = this.isGroup(ch) ? this.cfg.groupChunk : this.cfg.chunk
      const last = list[list.length - 1]
      if (!last)
        continue
      // 群里没人跟她打过交道的段落不急着压：攒满一大段再说（几万人的群不为路人的闲聊花钱）
      const engaged = (this.engaged.get(ch)?.size ?? 0) > 0
      const quiet = now - last.at > this.cfg.idleSec * 1000 && list.length >= this.cfg.minTurns && (engaged || !this.isGroup(ch))
      if (list.length >= size || quiet)
        out.push(ch)
    }
    return out
  }

  /** 取走一个会话攒的全部，连同这段里跟她打过交道的人 */
  take(channel: string): { turns: Turn[], engaged: string[] } {
    const turns = this.buffers.get(channel) ?? []
    const engaged = [...(this.engaged.get(channel) ?? [])]
    this.buffers.delete(channel)
    this.engaged.delete(channel)
    return { turns, engaged }
  }

  /** 某人最近的另一个一对一会话里还没压的最后几句（新对话开头「上次聊到」用） */
  tailWith(person: string, except: string, n: number): Turn[] {
    let best: Turn[] | undefined
    for (const [ch, list] of this.buffers) {
      if (ch === except || this.isGroup(ch) || !list.some(t => t.who === person))
        continue
      if (!best || list[list.length - 1].at > best[best.length - 1].at)
        best = list
    }
    return best ? best.slice(-n) : []
  }

  pending(): { channel: string, turns: number }[] {
    return [...this.buffers].map(([channel, list]) => ({ channel, turns: list.length }))
  }

  private push(t: Turn): void {
    const list = this.buffers.get(t.channel) ?? []
    list.push(t)
    // 防失控：压摘要一直失败时桶不能无限长，只留最近的
    if (list.length > this.cfg.groupChunk * 4)
      list.splice(0, list.length - this.cfg.groupChunk * 4)
    this.buffers.set(t.channel, list)
  }

  private engage(channel: string, who: string): void {
    const set = this.engaged.get(channel) ?? new Set<string>()
    set.add(who)
    this.engaged.set(channel, set)
  }
}
