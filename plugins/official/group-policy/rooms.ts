/**
 * 每个会话最近发生了什么：从真源（log.appended）投影，不持第二份事实。
 *
 * 所有频道都记（群、私聊、网页对话），因为「手机通知栏」要看全部会话；接话打分只用群的。
 * 每条记：谁说的、说了什么、是不是直接找她（kind 不是 group.message = @ / 叫名字 / 私聊）、
 * 这句有没有唤醒大脑（打分时回填）。她自己的话以 SELF 记，取实际送达的部分，并记下**她这句是在回谁**（`to`）：
 * 叫醒那一拍大脑的原因里有谁的话（mind.decision 的 reasons 带 sender）→ 那拍起的 reply → 它的 utterance。
 * 原来靠猜（上次开口后 @ 她的 / 对话中的 / 最后叫醒过她的那句的人，都没有就是她开口前别人那句）：真群甲（2026-10-22 17:53）
 * 她回灰灰子「多押韵」时 IIIBeta2III 恰好在她开口前说了句无关的话，就成了「正在和她聊」；汇报搜图结果那拍（原因只有 computer.result）
 * 也把一分钟前叫醒过她的路人算成了在回。靠猜的那套删了，只认事实；没有决策信息（脊椎兜底的应声）时只算冲她说的（direct）。
 */
import type { LogEvent } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'

export const SELF = '\u0000self'

export interface Entry {
  at: number
  who: string // sender.id；她自己是 SELF
  name?: string
  text: string
  direct?: boolean // 冲她说的（@、叫名字、私聊、网页）
  woke?: boolean
  convo?: boolean // 到达时她正和这人聊着、这句是接着跟她说的（convo.ts 回填）
  asked?: boolean // 她刚问了这人、这是他之后的第一句：在答她（convo.ts 回填；judge 不掷骰子）
  role?: string // 平台给的身份（NapCat sender.role），认机器人用
  bot?: boolean // 表现端标的机器人（surface-onebot 的 data.bot）
  to?: string[] // 她这句在回谁（sender.id）：叫醒那拍大脑的原因里说话的人；undefined = 不知道（没经大脑决策的开口）
}

export class Rooms {
  private rooms = new Map<string, Entry[]>()
  private starts = new Map<string, number[]>()
  // 决策 → reply 动作 → utterance 这条链上「她在回谁」的传递；每一环用完即删
  private decided = new Map<string, string[]>() // 频道 → 刚决定在这个频道 start reply 那拍里说话的人
  private replyTo = new Map<string, string[]>() // reply#n → 同上
  private uttTo = new Map<string, string[]>() // utt#n → 同上

  constructor(private keep: number) {}

  observe(e: LogEvent): void {
    const d = e.data ?? {}
    const ch = String(d.channel ?? MAIN_CHANNEL)
    if (e.type === 'percept.received' && d.sender && d.text) {
      this.push(ch, { at: e.at, who: String(d.sender.id), name: d.sender.name, text: String(d.text), direct: d.kind !== 'group.message', role: d.data?.role, ...(d.data?.bot === true ? { bot: true } : {}) })
    }
    else if (e.type === 'mind.decision' && Array.isArray(d.intents) && Array.isArray(d.reasons)) {
      for (const i of d.intents as { do?: string, action?: string, channel?: string }[]) {
        if (i.do !== 'start' || i.action !== 'reply' || !i.channel)
          continue
        const who = (d.reasons as { channel?: string, sender?: { id?: unknown } }[]).flatMap(r => r.channel === i.channel && r.sender?.id !== undefined ? [String(r.sender.id)] : [])
        this.decided.set(i.channel, [...new Set(who)])
      }
    }
    else if (e.type === 'action.started' && d.type === 'reply' && d.id) {
      const who = this.decided.get(ch)
      this.decided.delete(ch)
      if (who)
        this.replyTo.set(String(d.id), who)
    }
    else if (e.type === 'utterance.started') {
      this.starts.set(ch, [...(this.starts.get(ch) ?? []).filter(t => e.at - t < 3_600_000), e.at])
      const who = this.replyTo.get(String(d.action))
      this.replyTo.delete(String(d.action))
      if (who)
        this.uttTo.set(String(d.id), who)
    }
    else if (e.type === 'utterance.settled') {
      const to = this.uttTo.get(String(d.id))
      this.uttTo.delete(String(d.id))
      if (d.delivered)
        // 字面 <br>（模型把 <|br|> 写错留下的）进通知栏会再喂给大脑，换成空格
        this.push(ch, { at: e.at, who: SELF, text: String(d.delivered).split('<br />').join(' ').split('<br/>').join(' ').split('<br>').join(' '), ...(to ? { to } : {}) })
    }
    // 没走完的链（被打断、没开口）留下的残片不多，攒到一定量清掉就行
    if (this.replyTo.size > 50)
      this.replyTo.clear()
    if (this.uttTo.size > 50)
      this.uttTo.clear()
  }

  /** 日志被清空（/api/clear）时跟着清 */
  clear(): void {
    this.rooms.clear()
    this.starts.clear()
    this.decided.clear()
    this.replyTo.clear()
    this.uttTo.clear()
  }

  list(ch: string): Entry[] {
    return this.rooms.get(ch) ?? []
  }

  channels(): string[] {
    return [...this.rooms.keys()]
  }

  startsWithin(ch: string, now: number, ms: number): number {
    return (this.starts.get(ch) ?? []).filter(t => now - t < ms).length
  }

  /** 她在这个会话里最近一次开口（不晚于 at）的时刻 */
  lastStart(ch: string, at: number): number | undefined {
    return (this.starts.get(ch) ?? []).findLast(t => t <= at)
  }

  /** 她最近一次开口的频道（「你刚在」）；从开口时刻算，不是全局可变态 */
  lastSpoken(): { channel: string, at: number } | undefined {
    let best: { channel: string, at: number } | undefined
    for (const [channel, ts] of this.starts) {
      const at = ts[ts.length - 1]
      if (at !== undefined && (!best || at > best.at))
        best = { channel, at }
    }
    return best
  }

  /** 她在这个会话最后一次开口之后别人说的话 */
  unread(ch: string): Entry[] {
    const list = this.list(ch)
    const i = list.findLastIndex(e => e.who === SELF)
    return list.slice(i + 1)
  }

  private push(ch: string, e: Entry): void {
    const list = this.rooms.get(ch) ?? []
    list.push(e)
    if (list.length > this.keep)
      list.splice(0, list.length - this.keep)
    this.rooms.set(ch, list)
  }
}
