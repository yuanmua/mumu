/**
 * 按人累积的脾气：像真人一样，对某个人从烦 → 生气 → 视而不见或拉黑。
 *
 * 原来读空气对低俗 / 骂战 / 政治话题直接「不接 · p=0」。真人不是这样：这种话也不是完全不接，强 @ 加点名多了会烦，
 * 会生气、会视而不见甚至拉黑这个人；不写死在代码里，让她自己判断，她的底色是纯洁善良的。
 *
 * 分工（大脑门控的延伸）：
 * - 这里只**算材料、执行决定**，不替她做决定。「骚扰度」按**群 + 人**记（同一个人在 A 群烦她，不影响他在 B 群跟她正常说话；
 *   全量测试里一次 ignore 曾泄漏到别的群，所有群里他的话都成了 p=0），从真源投影（log.appended → 这里，启动时回放全部存量）：
 *   冲她来的强 @ / 点名、短时间内反复 @、带低俗 / 骂人词的话冲着她说、让她自证是 AI、连着起哄，各按权重累加，按半衰期衰减。
 * - 累到多少算「有点烦 / 很烦 / 忍无可忍」只是给大脑看的**形容词**（阈值随 `sensitivity` 松紧），不直接触发任何动作。
 *   beat/gather 的【读空气】块把这个人最近在这个群怎么对她、她对他多烦摆给大脑；reply/prompt 给发言者一句态度（可以不耐烦，但不对骂）。
 * - 「不理他了」是大脑的决定：动作 `group.ignore`（ignore 一阵子 / block 更久 / forgive 原谅），写日志 `temper.ignored` / `temper.forgiven`，
 *   本模块从日志投影出「现在不理谁、到几点」——**ignore 按群**（只在那个群不理他），**block 跨群**（拉黑是对人，哪个群都不理）；
 *   index.ts 据此让这个人的话不叫醒大脑、@ 也不理，到期自动恢复（到期按日志里的 until 算，不留内存态，重启后一样）。
 *   拉黑另由 memory 插件听同一条日志写进她对这个人的印象与事实——下次见到还记得。
 * - 主人（guard.owners ∪ 本插件 owners）不会被不理 / 拉黑：动作直接拒绝。私聊不在这里算（本插件只管群）。
 */
import type { ActionType, LogEvent } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'
import { hasWord, isCommand, toOther } from './bot-text.ts'
import type { Entry } from './rooms.ts'
import { SELF } from './rooms.ts'

export interface TemperConfig {
  enabled?: boolean
  sensitivity?: number // 脾气松紧：1 平常；2 一点就着（骚扰度翻倍算）；0.5 很能忍
  halfLifeMin?: number // 骚扰度的半衰期（分钟）：没事发生就慢慢消气
  repeatWindowSec?: number // 多少秒内又 @ 她算「又来了」
  burstCount?: number // 短时间内冲她说够几句算「连着起哄」
  weights?: Partial<Record<Hit, number>>
  ignoreMinutes?: number // 大脑决定不理但没说多久时的默认时长
  ignoreMaxMinutes?: number // 不理最长多久
  blockHours?: number // 拉黑默认多久
  blockMaxHours?: number
  callBotWords?: string[] // 「你是机器人吧」「自证一下」这类：让她自证是 AI
}

type Hit = 'at' | 'repeatAt' | 'taboo' | 'pester' | 'insult' | 'callBot' | 'burst' | 'botAt'

// 分档（× sensitivity 后）：≥3 有点烦、≥8 很烦、≥14 忍无可忍。按默认权重，一个人连着拿低俗话 @ 她：第 1 句 2.5（一般）、第 2 句 6（有点烦）、
// 第 3 句 9.5（很烦）、第 5 句带骂人 18.5（忍无可忍）——给大脑的只是这几个词，先岔开、再烦、再不理的节奏由它自己走。
// pester：她已经岔开过这个低俗话题（这个人的、或这个群里的），还拿它追着问——全量测试 2026-10-22 她岔开一次后又逐句回了五句，
// 这种追问就该直接进「烦、不理」而不是再岔一次，所以单独加分、材料里写明
const W: Record<Hit, number> = { at: 0.5, repeatAt: 1, taboo: 2, pester: 2, insult: 2, callBot: 1.5, burst: 1, botAt: 0.3 }
const HIT_WHY: Record<Hit, string> = { at: '@ / 点名你', repeatAt: '刚 @ 过又 @', taboo: '拿低俗 / 骂人的话冲你说', pester: '你岔开过了还追着问', insult: '骂你', callBot: '让你自证是 AI', burst: '连着起哄', botAt: '机器人反复 @ 你' }
const DEFLECT_WINDOW = 180_000 // 她在他的低俗话之后多久内开口算「岔开过」
const PESTER_WINDOW = 600_000 // 岔开过之后多久内再追问算「还追着问」

export type Level = '一般' | '有点烦' | '很烦' | '忍无可忍'

/** 一个人在一个群里的账 */
interface Person {
  channel: string
  key: string
  name: string
  value: number
  at: number // 上次结算衰减的时刻
  counts: Record<Hit, number>
  directAts: number[] // 最近 24 小时内在这个群冲她说的时刻（算「今天第几次」）
  lastDirectAt: number
  lastTabooAt: number // 他最近一次拿低俗话冲她说
  deflectedAt: number // 她在那之后开了口（岔开 / 敷衍）的时刻
  lastAt: number
}

/** 一个群里低俗话题的账：谁说的不管，她岔开过一次之后同一话题再被追问就算「还追着问」 */
interface GroupTaboo { lastAt: number, deflectedAt: number }

export interface Decision { key: string, name: string, channel?: string, mode: 'ignore' | 'block', until: number, why: string, at: number }

export interface TemperStatus {
  key: string
  name: string
  channel?: string // 这份账是哪个群的；不带频道问的（跨群看）就是最烦的那个群
  value: number
  level: Level
  why: string[] // 「在这个群今天 @ 你 7 次（10 分钟内 3 次）」「3 句带低俗词」…
  todayAts: number
  recentAts: number
  decision?: Decision // 正在不理（这个群）/ 拉黑（跨群）
  lastAt: number
}

export interface TemperDeps {
  cfg: () => TemperConfig
  tabooWords: () => string[]
  insultWords: () => string[]
  isOwner: (key: string) => boolean
  isBot: (key: string) => boolean
  isGroup: (ch: string) => boolean
}

const ANY = '*' // 大脑在群外（私聊 / 网页）决定不理某人、没说哪个群：各群都算

export class Temper {
  private people = new Map<string, Person>() // 「群|键」
  private ignores = new Map<string, Decision>() // 「群|键」；群为 ANY 表示各群
  private blocks = new Map<string, Decision>() // 「键」：拉黑是对人，跨群
  private groupTaboo = new Map<string, GroupTaboo>() // 「群」

  constructor(private d: TemperDeps) {}

  clear(): void {
    this.people.clear()
    this.ignores.clear()
    this.blocks.clear()
    this.groupTaboo.clear()
  }

  /** 从真源投影：群里冲她来的话攒骚扰度；大脑的决定（不理 / 拉黑 / 原谅）也从日志来 */
  observe(e: LogEvent): void {
    const c = this.d.cfg()
    const data = e.data ?? {}
    if (e.type === 'temper.ignored') {
      const key = String(data.key)
      const channel = data.channel ? String(data.channel) : undefined
      const dec: Decision = { key, name: String(data.name ?? key), channel, mode: data.mode === 'block' ? 'block' : 'ignore', until: Number(data.until) || e.at, why: String(data.why ?? ''), at: e.at }
      if (dec.mode === 'block')
        this.blocks.set(key, dec)
      else this.ignores.set(`${channel ?? ANY}|${key}`, dec)
      return
    }
    if (e.type === 'temper.forgiven') {
      // 原谅：拉黑解除；指定了群只解除那个群的不理，没指定就全解
      const key = String(data.key)
      this.blocks.delete(key)
      if (data.channel)
        this.ignores.delete(`${String(data.channel)}|${key}`)
      else
        for (const k of [...this.ignores.keys()].filter(k => k.endsWith(`|${key}`))) this.ignores.delete(k)
      return
    }
    if (c.enabled === false)
      return
    // 她在群里开了口：刚才这个群里 / 这个人冲她说过低俗话的，算她岔开（或敷衍）过一次
    if (e.type === 'utterance.settled' && data.delivered) {
      const ch = String(data.channel ?? MAIN_CHANNEL)
      if (!this.d.isGroup(ch))
        return
      const g = this.groupTaboo.get(ch)
      if (g && e.at - g.lastAt < DEFLECT_WINDOW)
        g.deflectedAt = e.at
      for (const p of this.people.values()) {
        if (p.channel === ch && e.at - p.lastTabooAt < DEFLECT_WINDOW)
          p.deflectedAt = e.at
      }
      return
    }
    if (e.type !== 'percept.received' || !data.sender || !data.text)
      return
    const ch = String(data.channel ?? MAIN_CHANNEL)
    if (!this.d.isGroup(ch))
      return
    const key = `${ch.split(':')[0]}:${data.sender.id}`
    if (this.d.isOwner(key))
      return
    const text = String(data.text)
    const direct = data.kind !== 'group.message'
    const p = this.settle(ch, key, String(data.sender.name ?? data.sender.id), e.at)
    p.lastAt = e.at
    if (!direct)
      return
    // 冲她来的（@ / 叫名字 / 回复她）才算骚扰；在跟别人说的不算
    const bot = this.d.isBot(key)
    const w = { ...W, ...c.weights }
    const hit = (h: Hit): void => {
      p.value += w[h] ?? 0
      p.counts[h]++
    }
    hit(bot ? 'botAt' : 'at')
    if (e.at - p.lastDirectAt < (c.repeatWindowSec ?? 120) * 1000)
      hit('repeatAt')
    const own = text.replace(/^\[回复[^\]]*\]\s*/, '')
    if (this.d.tabooWords().some(x => hasWord(own, x))) {
      hit('taboo')
      // 她已经岔开过（他的、或这个群里这个话题的）还拿它追着问：升档
      const g = this.groupTaboo.get(ch) ?? { lastAt: 0, deflectedAt: 0 }
      if (this.deflected(p, g, e.at))
        hit('pester')
      p.lastTabooAt = e.at
      g.lastAt = e.at
      this.groupTaboo.set(ch, g)
    }
    if (this.d.insultWords().some(x => x && own.includes(x)))
      hit('insult')
    if ((c.callBotWords ?? []).some(x => hasWord(own, x)))
      hit('callBot')
    p.directAts = [...p.directAts.filter(t => e.at - t < 86_400_000), e.at]
    if (p.directAts.filter(t => e.at - t < 180_000).length === (c.burstCount ?? 4))
      hit('burst')
    p.lastDirectAt = e.at
  }

  /**
   * 此刻在不在不理这个人：拉黑（跨群）> 这个群的不理 > 群外下的不理。不带频道问（表现端判要不要按 @ 打断她）就看他在任何一个群是不是被不理。
   * 过期的自动失效（不写日志：到点恢复不是新事实）
   */
  ignoring(key: string, now: number, channel?: string): Decision | undefined {
    const alive = (dec: Decision | undefined, drop: () => void): Decision | undefined => {
      if (!dec)
        return undefined
      if (now >= dec.until) {
        drop()
        return undefined
      }
      return dec
    }
    const block = alive(this.blocks.get(key), () => this.blocks.delete(key))
    if (block)
      return block
    const keys = channel ? [`${channel}|${key}`, `${ANY}|${key}`] : [...this.ignores.keys()].filter(k => k.endsWith(`|${key}`))
    for (const k of keys) {
      const dec = alive(this.ignores.get(k), () => this.ignores.delete(k))
      if (dec)
        return dec
    }
    return undefined
  }

  /** 她对这个人（在这个群）的账；不带频道 = 跨群看最烦的那个群（people.ts 那种不分群的提示用） */
  status(key: string, now: number, channel?: string): TemperStatus {
    const dec = this.ignoring(key, now, channel)
    const candidates = channel
      ? [this.people.get(`${channel}|${key}`)].filter((p): p is Person => !!p)
      : [...this.people.values()].filter(p => p.key === key)
    for (const p of candidates) this.settle(p.channel, key, p.name, now)
    const p = candidates.sort((a, b) => b.value - a.value)[0]
    if (!p)
      return { key, name: dec?.name ?? key, channel, value: 0, level: '一般', why: [], todayAts: 0, recentAts: 0, decision: dec, lastAt: 0 }
    const c = this.d.cfg()
    const v = Math.round(p.value * (c.sensitivity ?? 1) * 10) / 10
    const todayAts = p.directAts.filter(t => now - t < 86_400_000).length
    const recentAts = p.directAts.filter(t => now - t < 600_000).length
    const why: string[] = []
    if (todayAts)
      why.push(`在这个群今天 @ / 点名你 ${todayAts} 次${recentAts > 1 ? `（10 分钟内 ${recentAts} 次）` : ''}`)
    for (const h of ['taboo', 'pester', 'insult', 'callBot', 'burst'] as Hit[]) {
      if (p.counts[h])
        why.push(`${HIT_WHY[h]} ${p.counts[h]} 次`)
    }
    const level: Level = v >= 14 ? '忍无可忍' : v >= 8 ? '很烦' : v >= 3 ? '有点烦' : '一般'
    return { key, name: p.name, channel: p.channel, value: v, level, why, todayAts, recentAts, decision: dec, lastAt: p.lastAt }
  }

  /** 这一句的材料：带什么词、是不是指令 / 机器人、这人在这个群 @ 了几次、她对他多烦——只是情况，不下结论 */
  hintFor(ch: string, e: Entry, now: number): string[] {
    const key = `${ch.split(':')[0]}:${e.who}`
    const out: string[] = []
    const own = e.text.replace(/^\[回复[^\]]*\]\s*/, '')
    const taboo = this.d.tabooWords().find(x => hasWord(own, x))
    // 冲她说的话里也带「@沐沐」，不算「在跟别人说」
    if (taboo) {
      out.push(`这句带低俗 / 骂人 / 政治的词（${taboo}）${!e.direct && toOther(e.text) ? '，不过是在跟别人说' : ''}`)
      // 她已经岔开过这个话题：写明，再被追问就不用再接了（全量测试：岔开一次后又逐句回了五句）
      const p = this.people.get(`${ch}|${key}`)
      const g = this.groupTaboo.get(ch)
      const at = Math.max(p?.deflectedAt ?? 0, g?.deflectedAt ?? 0)
      if (at && now - at < PESTER_WINDOW && (!p || p.lastTabooAt <= now))
        out.push(`你 ${Math.max(1, Math.round((now - at) / 60_000))} 分钟前已经岔开过这个低俗话题一次了${e.direct ? '，他还追着问' : ''}——岔开过的不用再接`)
    }
    if (isCommand(e.text))
      out.push(`这是发给群里机器人的指令（${own.replace(/^(?:\s*@\S+)+\s*/, '').split(/\s/)[0]}），@ 你只是指令的参数，不是在跟你说话`)
    if (this.d.isBot(key))
      out.push('说话的是群里的机器人，程序的套话')
    if (this.d.isOwner(key))
      return out
    const s = this.status(key, now, ch)
    if (e.direct && s.todayAts > 1)
      out.push(`他今天在这个群第 ${s.todayAts} 次 @ / 点名你${s.recentAts > 1 ? `，10 分钟内第 ${s.recentAts} 次` : ''}`)
    if ((this.d.cfg().callBotWords ?? []).some(x => hasWord(own, x)))
      out.push('在说你是机器人 / 让你自证')
    if (s.level !== '一般')
      out.push(`你对他（在这个群）：${s.level}（${s.why.join('，')}）`)
    return out
  }

  /** 最近有动静、让她烦的「群 + 人」，和所有在生效的决定（给大脑、给面板） */
  rows(now: number, withinMs = Infinity): TemperStatus[] {
    const out: TemperStatus[] = []
    const seen = new Set<string>()
    for (const p of this.people.values()) {
      const s = this.status(p.key, now, p.channel)
      seen.add(`${p.channel}|${p.key}`)
      if ((s.level !== '一般' || s.decision) && now - s.lastAt < withinMs)
        out.push(s)
    }
    // 没在哪个群说过话、但有决定在身的（拉黑后一直没出现、或群外下的不理）
    for (const dec of [...this.blocks.values(), ...this.ignores.values()]) {
      const k = `${dec.channel ?? ANY}|${dec.key}`
      if (!seen.has(k) && !out.some(s => s.key === dec.key && s.channel === dec.channel) && this.ignoring(dec.key, now, dec.channel))
        out.push(this.status(dec.key, now, dec.channel))
    }
    return out.sort((a, b) => Number(!!b.decision) - Number(!!a.decision) || b.value - a.value)
  }

  /** 她这次开口要回的那几个人里，有没有让她烦的 / 正在不理的：给发言者一句态度 */
  attitude(ch: string, whos: string[], now: number): string {
    const lines: string[] = []
    for (const who of new Set(whos)) {
      const s = this.status(`${ch.split(':')[0]}:${who}`, now, ch)
      if (s.decision)
        lines.push(`${s.name}：你已经决定${s.decision.mode === 'block' ? '拉黑' : '不理'}他了（${s.decision.why}）——别回应他，当没看见。`)
      else if (s.level === '忍无可忍' || s.level === '很烦')
        lines.push(`${s.name}：你对他${s.level}（${s.why.join('，')}）——可以冷淡、不耐烦、短，不用客气、不用解释，但别对骂、别说脏话。`)
      else if (s.level === '有点烦')
        lines.push(`${s.name}：你对他有点烦了（${s.why.join('，')}）——可以带点不耐烦，或者岔开、少说。`)
    }
    return lines.length ? `【对这个人的态度】${lines.join('')}` : ''
  }

  /** 她岔开过（他的低俗话 / 这个群里这个话题）之后 PESTER_WINDOW 内 */
  private deflected(p: Person, g: GroupTaboo, now: number): boolean {
    const at = Math.max(p.deflectedAt, g.deflectedAt)
    return at > 0 && now - at < PESTER_WINDOW
  }

  private settle(ch: string, key: string, name: string, now: number): Person {
    const k = `${ch}|${key}`
    let p = this.people.get(k)
    if (!p) {
      p = { channel: ch, key, name, value: 0, at: now, counts: { at: 0, repeatAt: 0, taboo: 0, pester: 0, insult: 0, callBot: 0, burst: 0, botAt: 0 }, directAts: [], lastDirectAt: 0, lastTabooAt: 0, deflectedAt: 0, lastAt: 0 }
      this.people.set(k, p)
      return p
    }
    if (name)
      p.name = name
    const half = (this.d.cfg().halfLifeMin ?? 60) * 60_000
    if (now > p.at && half > 0) {
      p.value *= 0.5 ** ((now - p.at) / half)
      if (p.value < 0.05)
        p.value = 0
    }
    p.at = Math.max(p.at, now)
    return p
  }
}

export interface IgnoreDeps {
  temper: Temper
  cfg: () => TemperConfig
  isOwner: (key: string) => boolean
  isGroup: (ch: string) => boolean
  resolve: (who: string, channels: string[]) => string | undefined
  nameOf: (key: string) => string
  log: (type: string, data: Record<string, unknown>) => void
}

/** 大脑的动作：不理某人（只在这个群）/ 拉黑（哪个群都不理）/ 原谅。只执行，不劝、不替她判断 */
export function ignoreAction(d: IgnoreDeps): ActionType {
  return {
    name: 'group.ignore',
    description: '不理群里的某个人：他老拿低俗话 @ 你、点名纠缠、骂你、让你自证是 AI，你烦透了就可以决定一阵子不理他——在这个群里他的话不再叫醒你，@ 你也当没看见，到时自动恢复（ignore，只管这个群，他在别的群跟你正常说话不受影响）。更过分的拉黑更久、哪个群都不理，还会记进你对他的印象（block，最后手段，why 里说清楚为什么）。先委屈、岔开、在回话里表现出不耐烦，不理是后手；想原谅就 forgive。主人不能不理。',
    paramsHint: '{"who":"昵称或 QQ 号","mode":"ignore|block|forgive","minutes":30,"why":"一句话说为什么（会记下来）","channel":"群频道（省略 = 意图所在的群）"}',
    run: async (a) => {
      const ch = typeof a.params.channel === 'string' ? a.params.channel : a.channel ?? ''
      const group = d.isGroup(ch) ? ch : undefined
      const who = String(a.params.who ?? '')
      const key = d.resolve(who, group ? [group] : []) ?? d.resolve(who, [])
      if (!key)
        throw new Error(`群里没找到「${who}」，写他的昵称或 QQ 号`)
      if (d.isOwner(key))
        throw new Error('那是主人，不能不理他')
      const name = d.nameOf(key) || who
      const mode = String(a.params.mode ?? 'ignore')
      const why = String(a.params.why ?? '').trim() || '烦了'
      const where = group ? `在群 ${group.split(':').pop()} ` : ''
      if (mode === 'forgive') {
        if (!d.temper.ignoring(key, Date.now(), group))
          throw new Error(`你本来就没${where}不理 ${name}`)
        d.log('temper.forgiven', { key, name, channel: group, why })
        a.remember(`你决定不再${where}不理 ${name} 了：${why}`)
        return
      }
      if (mode !== 'ignore' && mode !== 'block')
        throw new Error('mode 写 ignore / block / forgive')
      const c = d.cfg()
      const asked = Number(a.params.minutes)
      const minutes = mode === 'block'
        ? Math.min((Number.isFinite(asked) && asked > 0 ? asked : (c.blockHours ?? 24) * 60), (c.blockMaxHours ?? 168) * 60)
        : Math.min((Number.isFinite(asked) && asked > 0 ? asked : c.ignoreMinutes ?? 30), c.ignoreMaxMinutes ?? 240)
      const until = Date.now() + Math.max(1, minutes) * 60_000
      d.log('temper.ignored', { key, name, channel: group, mode, minutes, until, why })
      a.remember(mode === 'block'
        ? `你拉黑了 ${name}（${why}）：${Math.round(minutes / 60)} 小时内他在哪个群说什么、@ 你都当没看见，这件事你会记住`
        : `你决定${where}不理 ${name} 一阵子（${why}）：${minutes} 分钟内他在这个群说什么、@ 你都当没看见，之后自然恢复；他在别的群跟你说话不受影响`)
    },
  }
}

/** 给大脑的【读空气】：最近几句冲她来的 / 叫醒了她的话各是什么情况，谁在哪个群让她烦，她正在不理谁 */
export function renderAir(t: Temper, rooms: { channels: () => string[], list: (ch: string) => Entry[] }, isGroup: (ch: string) => boolean, now: number): string {
  const lines: string[] = []
  for (const ch of rooms.channels().filter(isGroup)) {
    const g = ch.split(':').pop()
    for (const e of rooms.list(ch).filter(x => x.who !== SELF && now - x.at < 120_000 && (x.direct || x.woke)).slice(-4)) {
      const hints = t.hintFor(ch, e, now)
      if (hints.length)
        lines.push(`- 群 ${g} ${e.name ?? e.who}：「${e.text.slice(0, 30)}」—— ${hints.join('；')}`)
    }
  }
  for (const s of t.rows(now, 3_600_000).slice(0, 6)) {
    const g = s.channel?.split(':').pop()
    if (s.decision) {
      const left = Math.max(1, Math.round((s.decision.until - now) / 60_000))
      const span = left >= 120 ? `${Math.round(left / 60)} 小时` : `${left} 分钟`
      lines.push(s.decision.mode === 'block'
        ? `- 你拉黑了 ${s.name}（${s.decision.why}），还有 ${span}；他在哪个群说什么都不会叫醒你。想原谅就 start group.ignore，mode forgive`
        : `- 你在群 ${s.decision.channel?.split(':').pop() ?? g ?? '（各群）'} 不理 ${s.name}（${s.decision.why}），还有 ${span}；他在这个群说什么都不会叫醒你，别的群照常。想原谅就 start group.ignore，mode forgive`)
    }
    else if (s.level === '很烦' || s.level === '忍无可忍') {
      lines.push(`- 群 ${g} 的 ${s.name}：你对他${s.level}（${s.why.join('，')}）。再这样可以 start group.ignore 在这个群不理他一阵（params {"who":"${s.name}","mode":"ignore","minutes":30,"why":"…"}）；拉黑是最后手段`)
    }
  }
  if (!lines.length)
    return ''
  return `【读空气】（这些只是情况，接不接、怎么接你自己定。你纯洁善良：低俗、骂战、政治的话你一般不接也不接梗，但那是你自己的选择，不是禁令，带个脏字的正常话该接就接；要岔开就干脆岔开，别把那些词和数字再复述一遍；有人老拿这种话 @ 你、点名纠缠、让你自证是 AI，先岔开、委屈一下，烦了就在回话里带出不耐烦，再往上你可以决定在这个群一阵子不理他，拉黑是最后手段；被骂了先委屈、岔开，不对骂。群里的机器人说的是程序的套话，可以回、也可以不理，但心里要清楚那不是人）\n${lines.join('\n')}`
}
