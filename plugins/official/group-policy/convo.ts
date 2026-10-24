/**
 * 「正在对话」：她和群里某个人聊起来之后，对方接着说的话不用再 @ 她。
 *
 * 原来聊一个问题不连贯，对方得 @ 她好多遍：只有 @ / 叫名字 / 回复她才算冲她说，
 * 对方第二句不带 @ 就回到普通打分（base 0.01），她多半就不接了。真人在群里和某人聊上了，对方的下一句默认是在跟自己说。
 *
 * 从真源投影（log.appended → Rooms → 这里），按「群 + 对方 id」记，不持第二份事实：
 * - 开 / 续：她回了某人（Rooms 记的 `to`：叫醒那拍大脑的原因里说话的人，不是她开口前后恰好说话的每个人）；或者某人 @ / 叫了她。
 * - 对方接着说（没 @ 别人、不是回复别人、不是收束句、不是纯表情 / 一两个字、不是无关的短闲话）→ 这句标 `convo`，**交给 judge.ts 的「在聊」分支打分**：
 *   起点就是 `followUp`（0.4，不用像旁人那样有共有的词才算接她的话），她在这段里每多接一句乘 topic.inTopicDecay——对方连说六句她接一到三句；
 *   她说话时到的那句（到达时 p=0「正在说话」）说完补判一次，同一套分，不再一律叫醒。
 *   原来是 pre-beat 直通 p=1：真群甲（2026-10-22 17:50–17:58）她回过灰灰子一句后，他每句短句（「为什么」「多押韵」）都 p=1 叫醒，
 *   大脑十二秒里三次「接住梗」，八分钟开口 14 次（太多了：不必大都接，比一句也不接稍高一点、有话题还是可以聊就够）。
 * - 结束（任一，日志 convo.ended 带原因）：对方说了收束句；对方连续 offAfter 句在跟别人说（@ 别人 / 回复别人）；
 *   idleSec 秒没人续（她和对方都没再说）；对方连说 maxUnanswered 句她一句没接（大脑不想聊了，别一直叫醒）；
 *   **她说了一句、对方没接**：对方在她这句之后的下一句（不算表情 / 一两个字 / 短闲话）和她这句没有共有的词、中间又隔着别人的话、
 *   也不是短的追问——他是在接着说自己的、或者在跟别人说；或者对方一直没吭声、旁人已经连着 topic.switchAfter 句在说和她这句无关的。
 *   真群乙（2026-10-22 23:21–23:29）：她回了青山一句，青山接着跟群里聊他的火箭项目、群友都在 @ 他，他一次没 @ 她、没回她，
 *   可他的每句白话都算「接着跟她说的」，她八分钟对他开口七次，被群友吐槽「这个机器人，他认为你在一直和他聊天」。
 *   像真人：说了一句对方没接、群里在聊别的，就放下；对方回头 @ 她、回复她，再聊上。没接的那段留给大脑看一会儿（renderConvos【你说了对方没接】）。
 * - 她问了他（问句：在回他、或 @ / 点名问他，index.ts askedOf）：他之后的第一句就是在答她，标 `asked`，judge 直接 p=1——问了就在等答案，
 *   不掷骰子；收束句、一两个字（「行」「好的」「发吧」）也算。只管这一句，之后照常。
 * 主人也走这一套，不特殊：他在跟别人聊（@ 别人、回复别人）就不算在跟她说。
 */
import type { Section } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import { toOther } from './bot-text.ts'
import { isQuestion, overlap, QUESTION_WORDS, stripEmoji } from './judge.ts'
import type { Entry } from './rooms.ts'
import { SELF } from './rooms.ts'
import { isCloser } from './topics.ts'
import type { TopicConfig } from './topics.ts'

export interface ConvoConfig {
  enabled?: boolean
  idleSec?: number // 多久没人续就算聊完
  offAfter?: number // 对方连续几句在跟别人说就算聊完
  maxUnanswered?: number // 对方连说几句她都没接就算聊完
  chatterMaxChars?: number // 不超过这么多字、不是问句、和这段对话没有共有双字词的（「摸鱼中」「困死了」）算无关闲话：不叫醒，交给普通打分
  lines?: number // 给大脑看的「刚才几句」
}

/** 给 judge.ts 的「正在和她聊」材料：对方这是她上次开口后的第几句、她在这段里已经接了几句、对方回过她几句；asked = 这句在答她刚问他的 */
export interface ConvoView { name?: string, herLines: number, nth: number, replies: number, asked?: boolean }

export interface Line { at: number, who: string, name?: string, text: string, aside?: boolean, unseen?: boolean } // aside：表情 / 一两个字 / 无关闲话，不算「还没接」；unseen：到时她正在说话、谁都没看到

export interface Convo {
  channel: string
  who: string
  name?: string
  startedAt: number
  lastAt: number
  herLines: number
  answeredTo: number // 她最近一次开口的时刻：对方在这之前说的算她接过了
  offRun: number
  unanswered: number
  replies: number // 对方回过她几句（@ / 回复她，或她说完后他的下一句接得上她）
  heardAt: number // 她哪一句之后对方的回话已经看过了（接上了；没接上的话对话已经结束）
  herFrom: number // 她最近说给他的那段开口的时刻：从这时起旁人说的话，用来看他是在接她还是在接别人
  askedAt?: number // 她最近说给他的那句是问句（在回他、或点名问他）：那句的时刻；他之后的第一句就是在答她
  lines: Line[]
  status: 'open' | 'ended'
  why?: string
  endedAt?: number
  dropped?: { by: 'him' | 'others', text: string } // 她说了对方没接：对方 / 群里接着说的是什么（给大脑看一会儿）
}

const LINES_KEEP = 16
const CHATTER_KEEP = 30

export class Convos {
  private map = new Map<string, Convo>()
  private chatter = new Map<string, Line[]>() // 每个群最近别人说的正经话（不是冲她的、去掉引用和表情）：看对方是在接她还是在接别人

  constructor(
    private cfg: () => ConvoConfig,
    private topicCfg: () => TopicConfig,
    private emit: (type: 'convo.started' | 'convo.ended', c: Convo) => void,
  ) {}

  get enabled(): boolean {
    return this.cfg().enabled !== false
  }

  clear(): void {
    this.map.clear()
    this.chatter.clear()
  }

  /**
   * 别人说了一句（群频道，已去掉机器人）；在对话中的、接着跟她说的，回填 e.convo。
   * speaking = 这句到时她正在这个群说话：这句谁都没看到（打分是硬 0、大脑没醒），她说完要补判一次（pending）；
   * 不在说话时到的句子走正常打分，掷骰子没中就是没中，不再挂成「还没接」（模拟器里她两分钟后被 timer 叫醒，看到挂着的「还没接」又回头去答）
   */
  onOther(ch: string, e: Entry, speaking = false): void {
    if (!this.enabled)
      return
    if (!e.direct)
      this.drifting(ch, e)
    const c = this.active(ch, e.who, e.at)
    const cfg = this.cfg()
    if (c && !e.direct) {
      // 她刚问了他、这是他之后的第一句、接得上她（同下面 answers：不是隔着别人在接旁人的话）：就是在答她（问了就在等答案），
      // 「好的」「行」「发吧」这种收束句、一两个字也算，judge 不掷骰子。
      // 真群甲（2026-10-23 16:12）：她问主人「要我发群里吗」，主人回「确认，发吧」按在聊打分 p=0.407 没叫醒，120 秒后才醒
      const asked = c.askedAt !== undefined && c.askedAt > c.heardAt ? c.lines.findLast(l => l.who === SELF && l.at === c.askedAt) : undefined
      const own = stripEmoji(e.text).replace(/\[[^\]]*\]/g, '').trim()
      if (asked && !toOther(e.text) && answers(asked.text, own, own.replace(/[\s\p{P}\p{S}]/gu, '').length, this.since(ch, c, e.at), cfg)) {
        c.heardAt = asked.at
        e.convo = true
        e.asked = true
        c.offRun = 0
        c.unanswered++
        c.replies++
        c.lastAt = e.at
        this.push(c, e, false, speaking)
        return
      }
      if (isCloser(e.text, this.topicCfg())) {
        this.push(c, e)
        return this.end(c, e.at, `${e.name ?? '对方'} 收尾了：「${e.text.slice(0, 12)}」`)
      }
      if (toOther(e.text)) {
        c.offRun++
        if (c.offRun >= (cfg.offAfter ?? 2))
          this.end(c, e.at, `${e.name ?? '对方'} 转去跟别人说了（连续 ${c.offRun} 句）`)
        return
      }
      if (c.unanswered >= (cfg.maxUnanswered ?? 3))
        return this.end(c, e.at, `${e.name ?? '对方'} 说了 ${c.unanswered} 句她都没接`)
      // 纯表情包、一两个字（「6」「嗯」）：人还在，但没说什么要她接的——不叫醒，交给普通打分。
      // 真群：有人和她聊着发了张冷淡表情包，被当成在跟她说，大脑 quick 了一句碎话
      const bare = stripEmoji(e.text).replace(/\[[^\]]*\]/g, '').trim()
      const chars = bare.replace(/[\s\p{P}\p{S}]/gu, '').length
      if (!bare || (chars <= 2 && !isQuestion(bare, []))) {
        c.lastAt = e.at
        this.push(c, e, true)
        return
      }
      // 转去说无关的短闲话（「摸鱼中」「困死了」「外卖到了」）：不是问句、很短、和这段对话最近几句没有共有的双字词——人还在、对话不断，
      // 但这句不算在跟她说，交给普通打分。全量测试 2026-10-22 boring-rocket：她答完火箭提问后对方的灌水被当成在跟她说，她又接了两句
      if (chars <= (cfg.chatterMaxChars ?? 6) && !isQuestion(bare, QUESTION_WORDS) && overlap(c.lines.slice(-6).map(l => l.text).join(' '), bare) < 1) {
        c.lastAt = e.at
        this.push(c, e, true)
        return
      }
      // 她说了一句之后，对方这是第一句正经话：接没接上她那句。没接上就放下（见文件头），这句交给普通打分
      const her = c.lines.findLast(l => l.who === SELF)
      if (her && her.at > c.heardAt) {
        c.heardAt = her.at
        if (!answers(her.text, bare, chars, this.since(ch, c, e.at), cfg)) {
          this.push(c, e, true)
          c.dropped = { by: 'him', text: e.text }
          return this.end(c, e.at, `${e.name ?? '对方'} 没接她的话（她说完他接着说的是「${e.text.slice(0, 12)}」）`)
        }
      }
      e.convo = true
      c.offRun = 0
      c.unanswered++
      c.replies++
      c.lastAt = e.at
      this.push(c, e, false, speaking)
      return
    }
    if (e.direct) {
      e.convo = !!c // 之前就在聊：这次 @ 是接着聊，不算「刚 @ 过又 @」
      this.touch(ch, e, c, speaking)
    }
  }

  /**
   * 她在这个群开口了（utterance.started）：这个群里所有正在聊的人在这之前说的话都算看过了——大脑决定、发言者写这段时历史里都有它，
   * 接没接是她的选择；「还没接」只留她说话那会儿才到的（谁都没看到的那几句）。对方有没看过的话、她接着开口了，就算她又接了他一句（herLines，决定衰减）。
   * 账在开口那刻销，不等说完：她一段话要说二三十秒，对方这期间的第三句到时，前两句其实已经在她正说的这段里接了——
   * 原来按说完那刻算，unanswered 累到 3 就判「说了 3 句她都没接」把对话结束了（模拟器 convo-follow 复测抓到）；
   * 也不只给她这段「在回」的人销账：复测 2026-10-22 flood / group-feel 里她用 append 接住了小林说话时追的那句，这段却被算成回了阿哲，
   * 小林的账没销，convo.pending 又补叫一次大脑，「取号」说了三遍、「最喜欢哪首」问了两遍
   */
  onSpeak(ch: string, at: number): void {
    if (!this.enabled)
      return
    for (const c of this.list(at, ch)) {
      if (c.lines.some(l => l.who === c.who && l.at > c.answeredTo && !l.aside)) {
        c.herLines++
        c.offRun = 0
        c.lastAt = at
      }
      c.answeredTo = Math.max(c.answeredTo, at)
      c.unanswered = c.lines.filter(l => l.who === c.who && l.at > c.answeredTo).length
    }
  }

  /**
   * 她在群里说完一段；to = 她这次是在回谁（index.ts 按叫醒那拍大脑的原因算）；startedAt = 这段开口的时刻。
   * 回的人里还没聊上的，从这句起聊上（账的事在 onSpeak 已经做了）
   */
  onSelf(ch: string, e: Entry, to: Entry[], startedAt = e.at): void {
    if (!this.enabled)
      return
    for (const who of new Set(to.filter(x => x.who !== SELF).map(x => x.who))) {
      const last = to.findLast(x => x.who === who)!
      let c = this.active(ch, who, e.at)
      if (!c) {
        c = this.open(ch, last, e.at)
        c.herLines = 1
        c.answeredTo = startedAt
      }
      c.lastAt = e.at
      c.herFrom = startedAt
      c.askedAt = asks(e.text) ? e.at : undefined
      this.push(c, e)
      // 她说这段时对方又说的（还没接）：说完才知道她说了什么，按同一条判他是在接她还是在接别人。接别人的不挂「还没接」，
      // 不然说完补判 / 大脑材料会推她去接一句冲别人说的话（模拟器 real-ignored：她答青山时，青山接着 KT77 的「上游」说了一句，她说完又去回它）
      for (const l of c.lines) {
        if (l.who !== c.who || !l.unseen || l.at < startedAt)
          continue
        const bare = stripEmoji(l.text).replace(/\[[^\]]*\]/g, '').trim()
        if (answers(e.text, bare, bare.replace(/[\s\p{P}\p{S}]/gu, '').length, this.since(ch, c, l.at), this.cfg())) {
          c.heardAt = e.at
        }
        else {
          delete l.unseen
          c.replies = Math.max(0, c.replies - 1)
        }
      }
    }
  }

  /** 她说给 c 的那段开口之后（到 until 之前），别人（不是 c 的对方）说的正经话 */
  private since(ch: string, c: Convo, until: number): Line[] {
    return (this.chatter.get(ch) ?? []).filter(l => l.who !== c.who && l.at >= c.herFrom && l.at < until)
  }

  /**
   * 旁人说了一句（不是 @ 她的）：记进这个群的 chatter；她说给某人的那段开口之后，对方还没吭声、旁人已经说了 topic.switchAfter 句（和话题「换了」同一个数）
   * 和她那段无关的，就算群里在聊别的、对方没接——放下。表情 / 一两个字不算在聊别的；和她那段有共有词的是旁人在接她的话，也不算。
   * 从她**开口**那刻算，不是说完：她一段说二三十秒，这期间群里照样在往下聊（模拟器 real-ignored）。
   * 比的是这人自己说的部分：「[回复 X「…」]」里引的是别人的话，真群里引用一句带「群友」的就会被误算成在接她的「群友基金」
   */
  private drifting(ch: string, e: Entry): void {
    const own = stripEmoji(e.text).replace(/\[[^\]]*\]/g, '').trim()
    if (own.replace(/[\s\p{P}\p{S}]/gu, '').length <= 2 || this.active(ch, e.who, e.at))
      return
    const list = this.chatter.get(ch) ?? []
    list.push({ at: e.at, who: e.who, name: e.name, text: own })
    if (list.length > CHATTER_KEEP)
      list.splice(0, list.length - CHATTER_KEEP)
    this.chatter.set(ch, list)
    for (const c of this.list(e.at, ch)) {
      const her = c.lines.findLast(l => l.who === SELF)
      if (c.who === e.who || !her || her.at <= c.heardAt)
        continue
      const off = this.since(ch, c, e.at + 1).filter(l => overlap(her.text, l.text) < 1).length
      if (off >= (this.topicCfg().switchAfter ?? 3)) {
        c.dropped = { by: 'others', text: e.text }
        this.end(c, e.at, `${c.name ?? '对方'} 没接她的话，群里在聊别的了（${off} 句）`)
      }
    }
  }

  /** 刚因为「她说了对方没接」放下的对话：给大脑看一会儿（idleSec 内）；对方回头 @ 她、她又回他，就被新的一段换掉 */
  dropped(now: number, ch?: string): Convo[] {
    const idle = (this.cfg().idleSec ?? 120) * 1000
    return [...this.map.values()].filter(c => c.status === 'ended' && c.dropped && (!ch || c.channel === ch) && now - (c.endedAt ?? 0) < idle)
  }

  /**
   * 对方在她说话时说的、谁都还没看到的几句（她开口之后到的、到时她正在说）。表情 / 一两个字 / 无关闲话（aside）不算：
   * 模拟器 flood 里糖糖一句「好耶」挂成「还在等你接」，大脑每说完一段就再 append 一段去「接」它，一分钟里补了五次。
   * 不在她说话时到的、正常打分没掷中的也不算：那是她「看一眼就过」了，不是没看到
   */
  pending(c: Convo): Line[] {
    return c.lines.filter(l => l.who === c.who && l.at > c.answeredTo && !l.aside && l.unseen)
  }

  /** 此刻在不在和这个人聊 */
  isIn(ch: string, who: string, now: number): boolean {
    return !!this.active(ch, who, now)
  }

  /** 这人刚说的一句（已 onOther、标了 convo）在这段对话里的位置，给 judge 打分用 */
  view(ch: string, who: string, now: number): ConvoView | undefined {
    const c = this.active(ch, who, now)
    return c ? { name: c.name, herLines: c.herLines, nth: Math.max(1, c.unanswered), replies: c.replies } : undefined
  }

  /** 进行中的对话（大脑材料、发言者窗口、网页用） */
  list(now: number, ch?: string): Convo[] {
    const out: Convo[] = []
    for (const c of [...this.map.values()]) {
      if ((!ch || c.channel === ch) && this.active(c.channel, c.who, now))
        out.push(c)
    }
    return out
  }

  private active(ch: string, who: string, now: number): Convo | undefined {
    const c = this.map.get(`${ch}|${who}`)
    if (!c || c.status !== 'open')
      return undefined
    const idle = (this.cfg().idleSec ?? 120) * 1000
    if (now - c.lastAt > idle) {
      this.end(c, c.lastAt + idle, `${Math.round(idle / 1000)} 秒没人续`)
      return undefined
    }
    return c
  }

  /** 被 @ / 叫名字：开一段或续上 */
  private touch(ch: string, e: Entry, c: Convo | undefined, speaking = false): void {
    const cur = c ?? this.open(ch, e, e.at)
    cur.offRun = 0
    cur.unanswered++
    cur.replies++ // @ 她 / 回复她：冲她说的，当然算回她
    cur.heardAt = Math.max(cur.heardAt, cur.lines.findLast(l => l.who === SELF)?.at ?? 0)
    cur.lastAt = e.at
    if (e.name)
      cur.name = e.name
    this.push(cur, e, false, speaking)
  }

  private open(ch: string, by: Entry, at: number): Convo {
    const c: Convo = { channel: ch, who: by.who, name: by.name, startedAt: at, lastAt: at, herLines: 0, answeredTo: 0, offRun: 0, unanswered: 0, replies: 0, heardAt: 0, herFrom: 0, lines: [], status: 'open' }
    // 开对话那句（她回的、或 @ 她的）也算进「刚才几句」：接得上的前提是知道在聊什么
    if (by.at < at)
      this.push(c, by)
    this.map.set(`${ch}|${by.who}`, c)
    this.emit('convo.started', c)
    return c
  }

  private push(c: Convo, e: Entry, aside = false, unseen = false): void {
    if (c.lines.some(l => l.at === e.at && l.who === e.who))
      return
    c.lines.push({ at: e.at, who: e.who, name: e.name, text: e.text, ...(aside ? { aside } : {}), ...(unseen ? { unseen } : {}) })
    if (c.lines.length > LINES_KEEP)
      c.lines.splice(0, c.lines.length - LINES_KEEP)
  }

  private end(c: Convo, at: number, why: string): void {
    if (c.status !== 'open')
      return
    c.status = 'ended'
    c.endedAt = at
    c.why = why
    this.emit('convo.ended', c)
  }
}

/**
 * 她这句是在问人（等对方答）：问号、「吗」、「X不X」（要不要 / 行不行 / 发不发）、一小句以「不 / 没」收尾（「能发群里不」「发不」）、「可不可以」。
 * 比 isQuestion 窄——「看搞什么吧」带「什么」但不是在问。「不」收尾是复测抓到的：她问主人「阿哲想听七里香，能发群里不」，没算成问，主人「发吧」p=0.01
 */
export function asks(text: string): boolean {
  const t = stripEmoji(text)
  return /[?？]|吗|(.)[不没]\1|可不可以/u.test(t) || t.split(/[，,。.！!\n]|\s+/).some(s => /(?<![还也都才就并])[不没]$/u.test(s.replace(/[~～…呀啊呢嘛]+$/u, ''))) // 「我还没」「我才不」是在说
}

const who = (c: Convo, l: Line): string => l.who === SELF ? '你' : (l.name ?? c.name ?? '对方')

/**
 * 她说完一段，对方的下一句算不算接上了她。others = 她开口之后旁人说的正经话。
 * - 短的追问（「为什么」「真的假的？」）：算。长问句不算数——可能是在问别人（真群 23:27 青山「能不能不要老是说这些倭寇的语言」是冲另一个群友说的，她当成说自己）；
 * - 和她那段有共有的词，而且不比和旁人哪句的共有词少：算。他接的是旁人的词就是在跟旁人说
 *   （模拟器 real-ignored：她说完 1 秒，青山接着 KT77 的「不如搞上游」说「上游那些子系统配套我们也搞不定」）；
 * - 一个共有词都没有：只有她开口后旁人没插过无关的话才算（「对吧，我还录屏了」紧接着「看了！升空那一下好震撼」）。
 */
function answers(herText: string, bare: string, chars: number, others: Line[], cfg: ConvoConfig): boolean {
  if (isQuestion(bare, QUESTION_WORDS) && chars <= (cfg.chatterMaxChars ?? 6))
    return true
  const mine = overlap(herText, bare)
  const theirs = Math.max(0, ...others.map(l => overlap(l.text, bare)))
  if (mine >= 1)
    return mine >= theirs
  return theirs === 0 && others.every(l => overlap(herText, l.text) >= 1)
}

/** 给大脑的「你正在和人聊」：和谁、刚才几句、哪句还没接；以及刚放下的「你说了对方没接」 */
export function renderConvos(convos: Convos, now: number, lines: number): string {
  const list = convos.list(now)
  const dropped = renderDropped(convos.dropped(now))
  if (!list.length)
    return dropped
  // 还没接的单列在最前：她说话那会儿到的追问，reply 一结束大脑多半判「刚说完不用补」就漏了（模拟器 convo-bot-noise 抓到）。
  // 但只提醒「你没看过这句」，不逼它再说一遍：是问你的、要紧的才接，附和 / 起哄看一眼就过（复测里它把刚说过的又说一遍）
  const waiting = list.flatMap(c => convos.pending(c).length
    ? [`- 群 ${c.channel.split(':').pop()} ${c.name ?? c.who} 在你说话时又说了：${convos.pending(c).map(l => `「${l.text.slice(0, 40)}」`).join('')}——你刚才那段没看到这句；是在问你、要紧的就 start reply 接上，只是附和 / 你刚才已经说到了就别再说一遍`]
    : [])
  const out = list.map((c) => {
    const pending = new Set(convos.pending(c))
    const mins = Math.max(1, Math.round((now - (c.lines[0]?.at ?? c.startedAt)) / 60_000))
    const body = c.lines.slice(-lines).map(l => `    ${who(c, l)}：${l.text.slice(0, 60)}${pending.has(l) ? '  ← 还没接' : ''}`)
    return `- 群 ${c.channel.split(':').pop()} 和 ${c.name ?? c.who}（聊了 ${mins} 分钟，你说了 ${c.herLines} 句）：\n${body.join('\n')}`
  })
  const block = `【你正在和人聊】（对方接着说的话没 @ 你也是在跟你说：接得上就 start reply 接着聊，别让人再 @ 你，也别用 quick 应一声打发；标「还没接」的是你开口之后对方又说的。对方转去跟别人说了、说了收尾的话、或者没什么可接的，就放下；连着接了两三句就停一停，不用句句都接）\n${[...waiting, ...out].join('\n')}`
  return dropped ? `${block}\n\n${dropped}` : block
}

/** 「你说了对方没接」：她上一句说给谁、对方 / 群里接着说的是什么——像真人一样放下，别追着说 */
function renderDropped(list: Convo[]): string {
  if (!list.length)
    return ''
  const out = list.map((c) => {
    const her = c.lines.findLast(l => l.who === SELF)?.text ?? ''
    const name = c.name ?? c.who
    const then = c.dropped?.by === 'him'
      ? `${name} 没理你，接着说的是「${c.dropped.text.slice(0, 40)}」（不是在回你）`
      : `${name} 没吭声，群里已经在聊别的了（「${c.dropped?.text.slice(0, 40) ?? ''}」）`
    return `- 群 ${c.channel.split(':').pop()}：你上一句说给 ${name}：「${her.slice(0, 40)}」——${then}`
  })
  return `【你说了对方没接】（说了一句对方没接、群里在聊别的，就放下：别追着 TA 说，别把 TA 后来的话当成在跟你说；TA @ 你、回复你了再接）\n${out.join('\n')}`
}

/** 给发言者：这次是在和谁聊、他还没被接的话——群里热闹时最近几条全是别人，她容易接到别人的话上 */
export function convoSection(convos: Convos, talks: Convo[]): Section | undefined {
  if (!talks.length)
    return undefined
  const lines = talks.map((c) => {
    const p = convos.pending(c).map(l => `「${l.text.slice(0, 40)}」`).join('')
    return `你正在和 ${c.name ?? c.who} 聊：对方接着说的话没 @ 你也是在跟你说${p ? `，还在等你接：${p}` : ''}。`
  })
  const text = `【正在聊】${lines.join('')}接着你们这段往下说，别接到旁人的话上；你上一段已经说过的意思别换个说法再说一遍。`
  return { id: 'group-convo', audience: 'performer', order: PROMPT_ORDER.thought, render: () => text }
}
