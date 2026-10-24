/**
 * 接话概率：一句群消息值不值得让大脑想一想。纯函数，状态由调用方（index.ts）从真源投影后传进来。
 *
 * p = 打分 × 兴趣（1 + k × 感兴趣程度）× talkValue × 群倍率（rates，手动）× 好感（affinity.ts，自动）× 心情 × 时段 × 专注 × 私聊优先。
 * 打分先分两种状态（像人一样：没在聊天状态时少回一点，看一眼就过去；在聊天状态就接着多聊几句，
 * 而不是机械地都用一个概率）：
 * - **在聊**（正在和她聊的人接着说；她参与的话题还开着、这句在接它；或她刚说完、这句在接她的话）：意愿是「接着多聊几句」的量级
 *   （topic.inTopic / followUp / related），按她接过的轮数衰减——正在和她聊的人按她在这段对话里接了几句（起点就是 followUp，不用看共有词），话题按她主动接过几轮。
 *   正在和她聊的人原来是 index.ts 直通 p=1（2026-10-22 真群八分钟开口 14 次），现在也在这里：只比没在聊高一档，不是每句都接。
 * - **没在聊**：像人刷群——`base` 是「偶尔看一眼」的量级，不是 0；有人在问往上。就这些，不再叠别的机制
 *   （叠的机制越多，她反而越傻）。要不要插话不在这里替大脑定，它自己有【群聊】规则，材料里写着这次是哪种状态（wakes.ts）。
 * 往上项取最高，往下项取最低且压过往上项（刷屏时问句也不该让她冒头）；带低俗词 / 机器人说的 / 同人连问只乘系数、不归零。
 * 剩下的硬 0 都不是对「这句话」的判断，而是她此刻的处境：正在这个群说话、群倍率被人设成 0、忙着做事。
 * 内容类的「不接」（低俗 / 机器人 / 反复 @）一律不在这里写死——材料给大脑（temper.ts【读空气】），接不接她自己定。
 */
import type { AffinityConfig, MoodConfig } from './affinity.ts'
import { hasWord, isCommand, toOther } from './bot-text.ts'
import type { BotsConfig } from './bots.ts'
import type { ConvoConfig, ConvoView } from './convo.ts'
import type { Entry } from './rooms.ts'
import { SELF } from './rooms.ts'
import type { TemperConfig } from './temper.ts'
import type { TopicConfig, TopicView } from './topics.ts'

export interface TimeRule { time: string, value: number }

export interface PolicyConfig {
  channelPrefixes?: string[]
  kinds?: string[]
  names?: string[]
  talkValue?: number
  capNonDirect?: number // 没 @ / 没叫名字的话（本函数打的都是）乘完兴趣、状态后的上限：p=1 只留给被叫到
  groups?: Record<string, Partial<PolicyConfig>>
  timeRules?: TimeRule[]
  timeZone?: string
  base?: number // 没在聊时一句普通话的意愿：「偶尔看一眼」的量级
  question?: number // 有人在问（长短不限，是不是认真问交给大脑；原来有 questionMinChars 6 字的硬门槛，已去掉）
  questionWords?: string[]
  related?: number // 在聊：这句和她参与的话题线对得上
  relatedWindowSec?: number
  relatedMinOverlap?: number
  followUp?: number
  followWindowSec?: number
  followMaxBetween?: number
  cold?: number
  coldSec?: number
  spam?: number
  spamCount?: number
  spamWindowSec?: number
  flood?: number
  floodPerMinute?: number
  emojiOnly?: number
  shortChat?: number // 灌水：去掉标点只剩一两个字、又不是问句（「6」「草」「哈哈」）
  repeat?: number // 复读：和前面几句别人的话一字不差
  command?: number // 发给机器人的指令（/打卡、@幻梦 /今日老婆）
  atOther?: number // @ 别人 / 引用别人的话：是在跟别人说
  chatter?: number
  chatterWindow?: number
  chatterWindowSec?: number
  maxPerMinute?: number
  tabooFactor?: number // 涉黄 / 低俗 / 骂战 / 政治的词：接话概率乘它（不归零——接不接是她的事，这里只把「带这类词」当材料记在 why 里）
  tabooWords?: string[]
  tabooWindowSec?: number // 前面几句（这么多秒内）别人刚说过这类话，也算还在那个话题里
  sameSenderOnce?: boolean
  sameSenderFactor?: number // 同一个人接着说、前一句刚叫醒过她还没开口：乘它（原来硬 0）
  sameSenderWindowSec?: number
  focus?: number
  privateFirst?: number
  privateWaitSec?: number
  busyActions?: string[]
  busy?: number
  reading?: ReadingConfig
  phone?: { windowSec?: number, lines?: number, max?: number }
  queue?: { enabled?: boolean, maxWaitSec?: number }
  topic?: TopicConfig
  convo?: ConvoConfig // 正在和某人聊：对方接着说的话不用 @ 也叫醒大脑（convo.ts）
  interest?: { k?: number } // 兴趣：interests 插件给 0～1 的感兴趣程度（水线 interests/score，语义相近度 × 兴趣分），话题吸引力 × (1 + k × 分)
  at?: { base?: number, sensitivity?: number, onceSec?: number, onceBelow?: number, perPersonSec?: number } // @ 她 / 叫名字：不是 100% 必答，按好感 × 心情打折（主人除外）
  feel?: { coldBelow?: number, warmAbove?: number } // 此刻意愿低于 / 高于多少算「懒得理 / 想聊」
  owners?: string[] // 主人（和 guard 的 owners 并在一起），@ 她必答
  rates?: Record<string, number> // 每群手动倍率（频道 → 倍率），0 = 只在被 @ 时答；她自己也能用 group.rate 调
  affinity?: AffinityConfig
  mood?: MoodConfig
  bots?: BotsConfig
  temper?: TemperConfig // 按人累积的脾气（temper.ts）
  keep?: number
}

export interface ReadingConfig {
  recent?: number
  dense?: number
  densePerMinute?: number
  mentions?: number
  threads?: number
  convo?: number // 正在和她聊的那段最多带几条（convo.ts）
  limit?: number
  pool?: number // 大脑那边的候选池：从日志取这个群最近几条再挑（发言者的候选池是 action-reply 的 historyPool）
  people?: number // 「群里在说话的人」最多列几个（people.ts）
  earlier?: number // 每人带几句窗口里没带上的更早的话
  peopleWindowSec?: number // 「最近 N 分钟说了几句」数多久以内的
}

/** 此刻别处的状况：她在不在别的会话里说话、有没有私聊等她、忙不忙 */
export interface Elsewhere {
  replyHere: boolean
  replyElsewhere: boolean
  privateWaiting: boolean
  busy?: string // 正在跑的忙碌动作 id
  startsLastMinute: number
  topic?: TopicView // 这个群当前 / 刚收尾的话题（topics.ts）
  rate?: number // 这个群的手动倍率
  affinity?: number // 她对这个群的好感（affinity.ts）
  mood?: number // 心情系数（affinity.ts moodFactor）
  interest?: { word: string, near: number, score: number } // 这句离她哪条兴趣最近（interests 插件）：near 相近度、score 感兴趣程度，都是 0～1；没有 = 不相近
  bot?: number // 说话的是群里的机器人：吸引力乘它（bots.attraction，不归零；主人解锁时不乘）
  convo?: ConvoView // 说话的人正在和她聊、这句是接着跟她说的（convo.ts）：在聊，起点 followUp，按她在这段里接过几句衰减
}

/** 在聊：她参与的话题还开着、这句在接它，或这句在接她刚才的话；没在聊：像人刷群，看一眼就过 */
export type ChatState = 'chatting' | 'idle'

export interface Verdict {
  p: number
  why: string[]
  factors: Record<string, number>
  state?: ChatState // 硬闸提前返回时没有
  topic?: { status: 'open' | 'closed', why?: string, turns: number, maxTurns: number }
}

/** 群覆盖打在全局配置上：groups.<频道> 里写了哪个键就用哪个 */
export function forChannel(cfg: PolicyConfig, channel: string): PolicyConfig {
  return { ...cfg, ...cfg.groups?.[channel] }
}

export function judge(c: PolicyConfig, cur: Entry, before: Entry[], s: Elsewhere): Verdict {
  const now = cur.at
  const factors: Record<string, number> = {}
  // 她刚问了这人（convo.ts asked），这句是他接着的回答：和被叫到一样不掷骰子，忙着也接（她问了就在等）；正在这个群说话时照旧等说完补判。
  // 真群甲（2026-10-23 16:12）：她问主人「要我发群里吗」，主人回「确认，发吧」p=0.407 没叫醒，120 秒后才醒
  if (s.convo?.asked && !s.replyHere)
    return { p: 1, why: [`她刚问了 ${s.convo.name ?? '对方'}，这句是 TA 的回答`], factors, state: 'chatting' }
  if (s.busy && (c.busy ?? 0) <= 0)
    return { p: 0, why: [`她正忙着（${s.busy}），群里只回必答`], factors }
  if (s.replyHere)
    return { p: 0, why: ['她正在这个群里说话'], factors }
  if (s.rate === 0)
    return { p: 0, why: ['这个群倍率 0：只在被 @ 时答'], factors }
  // 每分钟开口上限默认关（0）：节奏交给 surface-onebot 的出口节流（打字速度本身就限制了）
  if ((c.maxPerMinute ?? 0) > 0 && s.startsLastMinute >= (c.maxPerMinute ?? 0))
    return { p: 0, why: [`这个群一分钟内她已开口 ${s.startsLastMinute} 次`], factors }
  const why: string[] = []
  // 涉黄 / 低俗 / 骂战 / 政治的词（这句带、或前面几句别人刚说过）：不再硬判 0：和真人一样，这种话也不是完全不接，不写死在代码里，让她自己判断。
  // 只把「带这类词」记进 why、乘一个系数；接不接、怎么接由大脑按她的人设定（beat/gather 的【读空气】块把词摆给它）
  const own = tabooIn(cur.text, c)
  const taboo = own ?? before.filter(e => e.who !== SELF && now - e.at < (c.tabooWindowSec ?? 120) * 1000).slice(-3).map(e => tabooIn(e.text, c)).find(Boolean)
  if (taboo) {
    factors.taboo = c.tabooFactor ?? 0.5
    why.push(own ? `带低俗 / 骂人 / 政治的词（${taboo}），接不接她自己定` : `前面几句刚聊过低俗 / 骂战 / 政治（${taboo}）`)
  }
  const lastSelf = before.findLastIndex(e => e.who === SELF)
  // 同一个人接着说、前一句刚叫醒过她、她还没开口：原来硬 0（「连问只答一次」）；现在只是降一截——她没接的追问值不值得再想一下，还是让她自己看
  if (c.sameSenderOnce !== false) {
    const window = (c.sameSenderWindowSec ?? 120) * 1000
    if (before.slice(lastSelf + 1).some(e => e.who === cur.who && e.woke && now - e.at < window)) {
      factors.sameSender = c.sameSenderFactor ?? 0.3
      why.push('同一个人接着说，前面那句已经叫醒过她、她还没开口')
    }
  }
  if (s.bot !== undefined) {
    factors.bot = s.bot
    why.push('说话的是群里的机器人（程序的套话）')
  }
  // 两种状态（见文件头）。在聊 = 她参与的话题还开着、这句在接它（topics.ts）；或她刚说完、这句在接她的话（followUp）；
  // 或这句和「她上一句 + 她接的前两句」对得上（related，不限中间隔几句）。话题刚收尾（quietSec 内）这些都不算：碰着旧话题的压到 afterClose
  const tv = s.topic
  const closed = tv?.status === 'closed' && tv.closedAt !== undefined && now - tv.closedAt < (c.topic?.quietSec ?? 900) * 1000
  const inTopic = tv?.status === 'open' && tv.related
  const mine = lastSelf >= 0 && !closed ? before[lastSelf] : undefined
  const asking = isQuestion(cur.text, c.questionWords ?? [])
  // 接她刚才的话：她说完不久、中间没隔几句，**而且**这句像是冲着她那句来的（有共有的双字词，或是在问）。
  // 光靠时间挨着不行：模拟器 boring-rocket 里她应了一声「在」，之后 90 秒内每句无关灌水都成了「接她的话」，她越聊越多
  const following = !!mine && now - mine.at < (c.followWindowSec ?? 90) * 1000 && before.length - 1 - lastSelf <= (c.followMaxBetween ?? 1)
    && (asking || overlap(mine.text, cur.text) >= 1)
  const thread = mine ? [mine.text, ...before.slice(Math.max(0, lastSelf - 2), lastSelf).filter(e => e.who !== SELF).map(e => e.text)].join(' ') : ''
  const related = !!mine && now - mine.at < (c.relatedWindowSec ?? 600) * 1000 && overlap(thread, cur.text) >= (c.relatedMinOverlap ?? 2)
  const state: ChatState = s.convo || inTopic || following || related ? 'chatting' : 'idle'

  let p = c.base ?? 0.08
  const up = (v: number | undefined, d: number, reason: string): void => {
    if ((v ?? d) > p) {
      p = v ?? d
      why.push(reason)
    }
  }
  if (state === 'chatting') {
    // 在聊：接着多聊几句。几个信号取最高，再按她已经接过几轮衰减（× inTopicDecay^轮数）——
    // 接得越多越收着（进了话题不只是被动回复，也可以主动发言；聊到感兴趣的可以多聊几句，普通话题聊一两句就放下），
    // 兴趣话题起点高；轮数上限（topic.maxTurns）只是安全网。灌水、表情、@ 别人这些往下项照样压得住它
    const t = c.topic ?? {}
    const decay = t.inTopicDecay ?? 0.75
    const turns = tv?.status === 'open' ? tv.turns : 0
    const reasons: string[] = []
    let v = 0
    // 正在和她聊的人接着说：不用看有没有共有的词就算「接她的话」（followUp），按她在这段对话里接了几句衰减——
    // 不必大都接，但要比一句也不接稍高一点，有话题还是可以聊，所以起点就是 followUp（0.4），
    // 对方连说六句她接一到三句的量级；衰减按这段对话算，不按话题轮数（回正在聊的人不计主动轮）
    // 她说的比对方回的多（她接了 M 句、他只回了 R 句）：每多一句再乘一次衰减——对方不回，她不该一句接一句往上凑
    // （真群乙 23:21–23:29：青山一次没回她，她八分钟对他开口七次）。对方没接她那句时对话已在 convo.ts 结束，这里管的是她连着说、他才回一句
    const ahead = s.convo ? Math.max(0, s.convo.herLines - s.convo.replies) : 0
    let w = s.convo ? Math.round((c.followUp ?? 0.4) * decay ** (Math.max(0, s.convo.herLines - 1) + ahead) * 1000) / 1000 : 0
    if (s.convo)
      reasons.push(`正在和她聊的 ${s.convo.name ?? '对方'} 接着说（他这是第 ${s.convo.nth} 句，她在这段里已经接了 ${s.convo.herLines} 句、他回了她 ${s.convo.replies} 句）`)
    if (inTopic) {
      v = Math.max(v, tv.interesting ? t.interestInTopic ?? 0.6 : t.inTopic ?? 0.3)
      reasons.push(`她参与的话题还在聊（${tv.interesting ? '兴趣话题，' : ''}她主动接了 ${turns} 轮）`)
    }
    if (following) {
      v = Math.max(v, c.followUp ?? 0.4)
      reasons.push('接她刚才的话')
    }
    if (related) {
      v = Math.max(v, c.related ?? 0.4)
      reasons.push('还在聊她参与的话题')
    }
    w = Math.max(w, Math.round(v * decay ** turns * 1000) / 1000)
    up(w, 0, `在聊：${reasons.join('，')}`)
  }
  // 问句长短不限（原来要 ≥ questionMinChars 6 个字才算「认真在问」，已去掉）：是不是认真问、值不值得答交给大脑；
  // 「在吗」「哪家」这种一两个字的仍被下面的灌水项压住
  if (asking)
    up(c.question, 0.3, '有人在问')
  // 冷场后第一句：默认关（cold 0）。不是每隔多少句就一定要回——冷场本身不是开口的理由，话题才是
  const last = before[before.length - 1]
  if ((c.cold ?? 0) > 0 && (!last || now - last.at > (c.coldSec ?? 900) * 1000))
    up(c.cold, 0, '冷场后第一句')

  const down = (v: number | undefined, d: number, reason: string): void => {
    if ((v ?? d) < p) {
      p = v ?? d
      why.push(reason)
    }
  }
  // 正在和她聊的人接着说不受话题收尾影响：话题是群里的事（三句不相关就算换了），对话是她和这个人的事
  if (closed && tv?.related && !s.convo)
    down(c.topic?.afterClose, 0.03, `话题已收尾（${tv.why}），不再接`)
  else if (closed && !s.convo && tv?.closedAt !== undefined && now - tv.closedAt < (c.topic?.cooldownSec ?? 60) * 1000) {
    // 刚聊完一个话题，别立刻跳进别人的下一个话题（像真人：放下手机缓一会儿）
    p *= c.topic?.cooldownFactor ?? 0.3
    why.push('刚聊完一个话题，缓一会儿')
  }
  // 刷屏 = 同一个人连着发、中间没人插话；和别人正常一来一往不算
  let burst = 1
  for (let i = before.length - 1; i >= 0 && before[i].who === cur.who && now - before[i].at < (c.spamWindowSec ?? 30) * 1000; i--)
    burst++
  if (burst >= (c.spamCount ?? 4))
    down(c.spam, 0.03, `同一人刷屏（${burst} 句）`)
  const lastMinute = before.filter(e => e.who !== SELF && now - e.at < 60_000).length + 1
  if (lastMinute > (c.floodPerMinute ?? 20))
    down(c.flood, 0.03, `群里刷屏（一分钟 ${lastMinute} 句）`)
  const bare = stripEmoji(cur.text)
  if (!bare)
    down(c.emojiOnly, 0.03, '纯表情')
  // 一两个字的（「6」「草」「在吗」「哪家」）：是不是问句都算灌水——群里没人对着「在吗」认真答；正在和她聊的人的一两个字 convo.ts 已当闲话、不进在聊
  else if (bare.replace(/[\s\p{P}\p{S}]/gu, '').length <= 2)
    down(c.shortChat, 0.01, '灌水（一两个字）')
  if (before.slice(-5).some(e => e.who !== SELF && e.text === cur.text))
    down(c.repeat, 0.01, '复读')
  if (isCommand(cur.text))
    down(c.command, 0.01, '给机器人发的指令')
  else if (toOther(cur.text))
    down(c.atOther, 0.03, '在跟别人说（@ / 引用别人）')
  const win = before.slice(-(c.chatterWindow ?? 6)).filter(e => now - e.at < (c.chatterWindowSec ?? 180) * 1000)
  const people = new Set(win.map(e => e.who))
  if (win.length >= 3 && !people.has(SELF) && people.size === 2 && people.has(cur.who))
    down(c.chatter, 0.05, '别人两个在对聊')

  factors.talkValue = c.talkValue ?? 1
  factors.rate = s.rate ?? 1
  factors.affinity = s.affinity ?? 1
  factors.mood = s.mood ?? 1
  factors.time = timeFactor(c.timeRules ?? [], c.timeZone ?? 'Asia/Shanghai', new Date(now))
  if (s.replyElsewhere)
    factors.focus = c.focus ?? 0.3
  if (s.privateWaiting)
    factors.privateFirst = c.privateFirst ?? 0.3
  // 是她喜欢的话题就乘上唤醒概率：两态算完的基础意愿 × (1 + k × 感兴趣程度)，
  // 灌水、刷屏压低的照样低，在聊、有人在问的往上翻。感兴趣程度 = 语义相近度 × 兴趣分（interests 插件），不是关键词命中
  const liked = s.interest
  if (liked && liked.score > 0) {
    factors.interest = Math.round((1 + (c.interest?.k ?? 3) * Math.min(1, liked.score)) * 100) / 100
    why.push(`聊到她感兴趣的（${liked.word}，相近 ${liked.near}）×${factors.interest}`)
  }
  // 话题吸引力：只看这句话本身（往上项 / 往下项，含兴趣 / 低俗词 / 机器人 / 连问这几个乘数），还没乘她此刻的状态；夹在 1 以内
  const inner = ['interest', 'taboo', 'sameSender', 'bot']
  for (const k of inner) {
    if (factors[k] !== undefined)
      p *= factors[k]
  }
  p = Math.min(1, p)
  const attraction = Math.round(p * 1000) / 1000
  for (const [k, f] of Object.entries(factors)) {
    if (!inner.includes(k))
      p *= f
  }
  factors.attraction = attraction
  const topic = tv ? { status: tv.status, why: tv.why, turns: tv.turns, maxTurns: tv.maxTurns } : undefined
  // 封顶：这里打的都是没 @ 她、没叫她名字的话，再像在接她、再是她喜欢的话题也不是「每句必接」——p=1 只留给被叫到（cold.ts）。
  // 「在聊 0.5 × 兴趣 ×2」就能乘到 1，真群甲 那段八分钟开口 14 次就是每句 p=1（2026-10-23 定）
  return { p: Math.min(c.capNonDirect ?? 0.9, Math.round(p * 1000) / 1000), why: why.length ? why : ['没在聊这个群，普通一句'], factors, state, topic }
}

/** 时段系数：落在哪段用哪段的 value，段可以跨午夜（23:00-02:00）；都不落在就是 1 */
export function timeFactor(rules: TimeRule[], timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at)
  const h = Number(parts.find(x => x.type === 'hour')?.value ?? 0) % 24
  const m = Number(parts.find(x => x.type === 'minute')?.value ?? 0)
  const now = h * 60 + m
  for (const r of rules) {
    const [a, b] = r.time.split('-').map(minutes)
    if (a === undefined || b === undefined)
      continue
    if (a <= b ? now >= a && now <= b : now >= a || now <= b)
      return r.value
  }
  return 1
}

function minutes(s: string | undefined): number | undefined {
  const [h, m] = (s ?? '').trim().split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined
}

/** 这句里有没有涉黄 / 低俗 / 骂战 / 政治的词；有就返回那个词（英文整词，ccb 不误中别的） */
export function tabooIn(text: string, c: PolicyConfig): string | undefined {
  return (c.tabooWords ?? []).find(w => hasWord(text, w))
}

/** 被 @ / 叫名字时接的概率：base × (好感 × 心情)^sensitivity，夹在 0～1 */
export function atChance(c: PolicyConfig, affinity: number, mood: number): number {
  const p = (c.at?.base ?? 0.95) * (Math.max(0, affinity * mood) ** (c.at?.sensitivity ?? 1))
  return Math.round(Math.min(1, p) * 1000) / 1000
}

/** 出厂的问句词表（与清单 questionWords 一致）：没拿到配置的地方（convo.ts）判「是不是在问」用它 */
export const QUESTION_WORDS = ['吗', '呢', '什么', '怎么', '为啥', '为什么', '咋', '谁', '哪', '几点', '多少', '是不是', '有没有', '能不能', '要不要', '有人']

export function isQuestion(text: string, words: string[]): boolean {
  return text.includes('?') || text.includes('？') || words.some(w => text.includes(w))
}

/** 去掉表情类占位（surface 渲染的「[表情]」「[表情包：…]」），剩下空的就是纯表情 */
export function stripEmoji(text: string): string {
  return text.replace(/\[(?:表情|表情包|动画表情|戳一戳)[^\]]*\]/g, '').trim()
}

/** 两句话共有的双字词个数（只看汉字、字母、数字）——够判断「在接同一个话题」，不调模型 */
export function overlap(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/[^\p{L}\p{N}]/gu, '')
    const out = new Set<string>()
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const x = grams(a)
  let n = 0
  for (const g of grams(b)) {
    if (x.has(g))
      n++
  }
  return n
}
