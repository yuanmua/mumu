/**
 * 话题生命周期：一个话题可以聊，像正常人一样；聊完了就不接。
 *
 * 问题：「接她刚才的话」「和她上一句相关」两项加分只看时间窗，不知道话题已经结束——
 * 对方说完「哈哈好」、群里早换了话题、或者同一个人追着问第四遍，她还被叫醒、还在补一句「对了还有……」。
 *
 * 做法：每个群一个话题状态，从真源投影（log.appended → Rooms → 这里），不持第二份事实：
 * - 开：她在群里开口、而这个群没有进行中的话题 → 开一个，参与者 = 她回的那个人（rooms.ts 记的 `to`，不是她开口前恰好说话的人），
 *   关键词 = 那句话 + 她这句的双字词。例外：群里刚换走的话题（quietSec 内），她又主动回头接那里面的人——不另开，旧话题停在已收尾。
 * - 计轮：她每次「主动」接（回的不是 @ 她 / 叫她名字的话，也不是正在和她聊的人——convo.ts）记一轮。
 * - 收尾（任一）：
 *   1. 没人接：她说完 replyWindowSec 内话题里的人没再说话；
 *   2. 收束句：话题里的人说了 closers 里的话（整句就是它，或不超过 closerMaxChars 字且以它开头）；
 *   3. 换话题：连续 switchAfter 句和话题不相关（关键词不重合、也不是参与者紧接着她的回话）；
 *   4. 接够了：她在这个话题里主动接满 maxTurns 轮——只是安全上限（出厂 5 / 兴趣话题 8）。
 *      原来出厂 1 轮；进入一个话题之后不该只是被动回复，也可以主动发言。
 *      现在话题开着时她接不接看话题吸引力（judge.ts 的 inTopic，接得越多越收着），话题真结束了才退出。
 * - 收尾后 quietSec 内（judge.ts）：「接她的话」「和她上一句相关」不再加分；话题里的人或相关的话压到 afterClose——
 *   问句也一样，不追问、不补。@ 她 / 叫她名字照旧叫醒大脑（不经打分）。
 * 开关落日志 topic.opened / topic.closed（网页「接话判断」与读空气小字据此显示为什么）。
 */
import type { Entry } from './rooms.ts'
import { overlap, stripEmoji } from './judge.ts'

export interface TopicConfig {
  enabled?: boolean
  maxTurns?: number // 一个话题里最多主动接几轮（安全上限；平时由 inTopic 衰减自然收住）
  interestMaxTurns?: number // 聊到她感兴趣的话题时最多主动接几轮（可以连着聊）
  inTopic?: number // 她参与的话题还开着、这句在接它：接话概率（judge.ts），每主动接一轮 × inTopicDecay
  interestInTopic?: number // 同上，兴趣话题
  inTopicDecay?: number
  cooldownSec?: number // 话题刚收尾的这段时间，别人的新话题也先缓一缓
  cooldownFactor?: number // 缓的时候接话概率乘这个
  replyWindowSec?: number
  switchAfter?: number
  minOverlap?: number
  closers?: string[]
  closerMaxChars?: number
  quietSec?: number
  afterClose?: number
  atMaxTurns?: number // 同一个话题里被 @ 着接了几轮之后，再 @ 就不抢着回（交给大脑；主人、正在和她聊的人除外）
}

export interface Topic {
  id: number
  channel: string
  openedAt: number
  lastAt: number
  participants: Set<string>
  text: string // 话题里说过的话拼起来（关键词比对用，限长）
  herTurns: number
  atTurns: number // 回 @ 她 / 叫她名字的轮数（不算主动，但斗嘴也不能没完）
  interesting: boolean // 开话题时她接的那句离她的兴趣近（interests 的语义分，由 index.ts 传进来）
  offRun: number
  lastSelfAt: number
  repliedSinceSelf: boolean
  status: 'open' | 'closed'
  why?: string
  closedAt?: number
  switched?: boolean // 是群里换了话题收的尾（不是没人接 / 收束句 / 接够了）
}

/** 给打分与显示用的快照 */
export interface TopicView {
  status: 'open' | 'closed'
  why?: string
  turns: number
  maxTurns: number
  atTurns: number
  closedAt?: number
  interesting: boolean
  /** 这句话是不是在接这个话题（参与者说的，或关键词重合） */
  related: boolean
}

const TEXT_KEEP = 400

export class Topics {
  private topics = new Map<string, Topic>()
  private seq = 0

  constructor(
    private cfg: () => TopicConfig,
    private emit: (type: 'topic.opened' | 'topic.closed', t: Topic) => void,
    private interesting: (text: string, channel: string) => boolean = () => false,
  ) {}

  private maxTurns(t: Topic): number {
    const c = this.cfg()
    return t.interesting ? (c.interestMaxTurns ?? 8) : (c.maxTurns ?? 5)
  }

  get enabled(): boolean {
    return this.cfg().enabled !== false
  }

  clear(): void {
    this.topics.clear()
  }

  /** 别人说了一句（群频道）；before 不含这句 */
  onOther(ch: string, e: Entry): void {
    const t = this.topics.get(ch)
    if (!this.enabled || !t || t.status !== 'open')
      return
    this.expire(t, e.at)
    if (t.status !== 'open')
      return
    const c = this.cfg()
    const isParticipant = t.participants.has(e.who)
    if (isParticipant && isCloser(e.text, c)) {
      t.lastAt = e.at
      return this.close(t, e.at, `${e.name ?? '对方'} 收尾了：「${e.text.slice(0, 12)}」`)
    }
    if (this.relates(t, e)) {
      t.offRun = 0
      t.lastAt = e.at
      t.participants.add(e.who)
      t.text = (t.text + e.text).slice(-TEXT_KEEP)
      t.repliedSinceSelf = true // 有人接着她的话说了，「没人接」不成立
      return
    }
    t.offRun++
    if (t.offRun >= (c.switchAfter ?? 3)) {
      t.switched = true
      this.close(t, e.at, `群里换话题了（连续 ${t.offRun} 句不相关）`)
    }
  }

  /** 她在群里说完一段（实际送达的部分）；replyTo = 她这段在回的那句（index.ts replyTargets，不知道就是 undefined）；answering = 她在回正在和她聊的人 */
  onSelf(ch: string, e: Entry, replyTo: Entry | undefined, answering = false): void {
    if (!this.enabled)
      return
    const c = this.cfg()
    let t = this.topics.get(ch)
    if (t?.status === 'open')
      this.expire(t, e.at)
    const proactive = !replyTo?.direct && !answering // 回 @ 她 / 叫她名字 / 正在和她聊的人的话不算主动接
    // 群里已经换了话题，她又主动回头接旧话题里的人：不给旧话题另开一轮。原来她这句一出口就开个新话题，旧话题的人和词又成了
    // 「她参与的话题还在聊」——真群乙 23:21:54 火箭话题判「换话题了」，5 秒后她接青山的旧话，新话题把群里还在聊火箭的人全算进来加分。
    // 旧话题停在「已收尾」：quietSec 内碰着它的话压到 afterClose（judge.ts），对方真接了她的话由 convo.ts 认
    if (t && t.status !== 'open' && t.switched && proactive && replyTo && t.participants.has(replyTo.who) && e.at - (t.closedAt ?? 0) < (c.quietSec ?? 900) * 1000)
      return
    if (!t || t.status !== 'open') {
      t = {
        id: ++this.seq,
        channel: ch,
        openedAt: e.at,
        lastAt: e.at,
        participants: new Set(replyTo ? [replyTo.who] : []),
        text: `${replyTo?.text ?? ''}${e.text}`.slice(-TEXT_KEEP),
        herTurns: 0,
        atTurns: 0,
        interesting: this.interesting(`${replyTo?.text ?? ''}${e.text}`, ch),
        offRun: 0,
        lastSelfAt: e.at,
        repliedSinceSelf: false,
        status: 'open',
      }
      this.topics.set(ch, t)
      this.emit('topic.opened', t)
    }
    if (proactive)
      t.herTurns++
    else
      t.atTurns++
    t.lastSelfAt = e.at
    t.lastAt = e.at
    t.repliedSinceSelf = false
    t.offRun = 0
    t.text = (t.text + e.text).slice(-TEXT_KEEP)
    if (t.herTurns >= this.maxTurns(t))
      this.close(t, e.at, `她在这个话题里已经主动接了 ${t.herTurns} 轮`)
  }

  /** 最近 windowMs 内有动静的话题（大脑材料、网页用） */
  recent(now: number, windowMs: number): Topic[] {
    const out: Topic[] = []
    for (const t of this.topics.values()) {
      if (t.status === 'open')
        this.expire(t, now)
      if (now - (t.closedAt ?? t.lastAt) < windowMs)
        out.push(t)
    }
    return out
  }

  view(ch: string, cur: Entry | undefined, now: number): TopicView | undefined {
    const t = this.topics.get(ch)
    if (!this.enabled || !t)
      return undefined
    if (t.status === 'open')
      this.expire(t, now)
    return {
      status: t.status,
      why: t.why,
      turns: t.herTurns,
      maxTurns: this.maxTurns(t),
      atTurns: t.atTurns,
      closedAt: t.closedAt,
      interesting: t.interesting,
      related: cur ? (t.status === 'open' ? this.relates(t, cur) : this.touches(t, cur)) : false,
    }
  }

  /**
   * 还在接这个话题：关键词重合，或参与者紧接着她那句的第一句回话（「真的假的」没有关键词也是在接）。
   * 「紧接着」= 她说完之后中间没隔着无关的话（offRun 0）：原来只看「参与者在她说完后的第一句」，隔着几句别人的闲话、他冲别人说的也算——
   * 模拟器 real-ignored 里青山冲白石说「能不能不要老是说这些倭寇的语言」，被算成「她参与的话题还在聊」p=0.31（真群 23:27 她回「倭寇是在说谁啊」）
   */
  private relates(t: Topic, e: Entry): boolean {
    return overlap(t.text, stripEmoji(e.text)) >= (this.cfg().minOverlap ?? 2)
      || (t.participants.has(e.who) && !t.repliedSinceSelf && t.offRun === 0)
  }

  /** 收尾后还碰着它：话题里的人说的，或关键词重合——这些都不再接 */
  private touches(t: Topic, e: Entry): boolean {
    return t.participants.has(e.who) || overlap(t.text, stripEmoji(e.text)) >= (this.cfg().minOverlap ?? 2)
  }

  /** 收尾条件 1：她说完窗口内话题里的人没再说话 */
  private expire(t: Topic, now: number): void {
    const win = (this.cfg().replyWindowSec ?? 120) * 1000
    if (!t.repliedSinceSelf && now - t.lastSelfAt > win)
      this.close(t, t.lastSelfAt + win, `她说完 ${Math.round(win / 1000)} 秒没人接`)
  }

  private close(t: Topic, at: number, why: string): void {
    if (t.status !== 'open')
      return
    t.status = 'closed'
    t.closedAt = at
    t.why = why
    this.emit('topic.closed', t)
  }
}

/** 收束句：整句（去掉标点和表情占位）就是词表里的，或很短且以它开头（「哈哈好」「好的谢谢」） */
export function isCloser(text: string, c: TopicConfig): boolean {
  const t = stripEmoji(text).replace(/[\s\p{P}\p{S}~～]/gu, '')
  if (!t)
    return false
  const words = c.closers ?? []
  if (words.includes(t))
    return true
  return t.length <= (c.closerMaxChars ?? 6) && words.some(w => w.length >= 1 && (t.startsWith(w) || t.endsWith(w)) && /^[哈嘿嗯哦噢好行对是谢晚拜收了啦嘛呀吧的OKok]+$/u.test(t))
}
