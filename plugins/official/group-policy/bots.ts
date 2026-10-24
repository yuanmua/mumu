/**
 * 群里的其他机器人：认出来、标上，就不陪它演。
 *
 * 真群里另一个机器人（DeepSeek酱）一分钟几条、@ 她、引用她，她回一句它秒回一句，两个全自动的嘴斗个没完——
 * 又刷屏、又像在跟机器人对聊，群友还拿「俩全自动烧 token 机」起哄。真人群友对群里的机器人顶多看一眼，不会天天跟它斗嘴。
 *
 * 认法（谁是机器人）：
 * - 名单 `bots.list`（人工：设置页、/bot mark、主人在群里说「那个是机器人」时大脑用 group.bot 记）；
 * - 自动打分（`bots.auto`）：从真源投影（log.appended → Rooms → 这里），每个人攒几项特征，加权超过 `threshold`
 *   且说过至少 `minMessages` 句就记进 `bots.learned`（写配置，网页看得到、能取消）；
 * - `bots.notBots`：误判取消，自动打分再高也不算。主人（guard 的 owners）永远不算。
 * 特征（权重 `bots.weights.*`）：QQ 号段（官方机器人 3889…、老 Q 群管家 2854196…）· NapCat 的 role 是 bot 一类 ·
 * 机器人才有的文字（官方 markdown 的 `[](%7B%22version`、mqqapi://、qqbot 图床、「LLM 响应错误」）· markdown 排版 ·
 * 昵称带 bot / 机器人 / 助手 / AI（强）或「酱」（弱）· 被人点名后几秒内就回 · 总是 [回复] 引用 · 有人发 /指令 它就应 ·
 * 别人叫它机器人 / 人机 / token 机 · 一口气连发几句短的（大模型把一段回复拆开发的样子）。
 *
 * 标上之后（index.ts 的闸，2026-10-22 起不再一律不理：可以回，但要完全明白那是机器人的无用废话）：
 * 它的普通话吸引力乘 `attraction`（默认 0.15，不归零），它 @ 她按冷 @ 叫醒大脑（概率 `atWake`、脊椎不替她应、surface-onebot 不按 urgent 打断），
 * 材料里标着「机器人的套话」，回不回由大脑定；不加好感；是否进话题线 / 阅读窗口由 index.ts 定。
 * 主人说「跟它聊两句」→ 大脑用 group.bot 解锁（日志 bot.unlocked），那几句当群友的话算，放进来它的 `unlockTurns` 句话或过了 `unlockSec` 就恢复。
 * 解锁与放行都写日志、从日志投影，重启 / 重载不丢。
 */
import { hasMarkdown, hasWord, isCommand } from './bot-text.ts'
import type { Entry } from './rooms.ts'
import { SELF } from './rooms.ts'

export interface BotsConfig {
  enabled?: boolean
  list?: string[] // 名单：「qq:号」或直接写号
  notBots?: string[] // 不是机器人（误判取消）
  learned?: Record<string, Learned> // 自动认出来的（键「qq:号」）
  auto?: boolean
  threshold?: number
  softCap?: number // 行为类特征（秒回、被叫机器人、引用、连发、长段、昵称带「酱」）合计最多算几分
  minMessages?: number
  attraction?: number // 机器人说的话吸引力乘它（不归零；它说什么大脑看到了也知道是程序的套话）
  atWake?: number // 机器人 @ 她时叫醒大脑的概率（冷 @：脊椎不替她应，大脑自己定回不回）
  unlockTurns?: number // 主人让她跟它聊：她在那个群说几次后恢复按机器人算
  unlockSec?: number
  uinPrefixes?: string[]
  roles?: string[]
  nameWords?: string[]
  nameWeakWords?: string[]
  botWords?: string[] // 别人这么叫它 = 在说它是机器人
  botTexts?: string[] // 只有机器人发得出来的文字
  fastReplySec?: number
  commandReplySec?: number
  weights?: Partial<Record<Feature, number>>
}

export interface Learned { name?: string, score?: number, why?: string, at?: number }

type Feature = 'uin' | 'role' | 'sig' | 'markdown' | 'markdownMore' | 'name' | 'nameWeak' | 'fast' | 'quote' | 'long' | 'command' | 'called' | 'calledMore' | 'burst'

const W: Record<Feature, number> = {
  uin: 0.4, role: 0.6, sig: 0.7, markdown: 0.4, markdownMore: 0.6, name: 0.35, nameWeak: 0.15,
  fast: 0.25, quote: 0.1, long: 0.2, command: 0.4, called: 0.3, calledMore: 0.45, burst: 0.1,
}

/** 行为类（软）特征：真人也会有，合计封顶 softCap */
const SOFT = new Set<Feature>(['nameWeak', 'fast', 'quote', 'long', 'called', 'calledMore', 'burst'])

interface Stat {
  key: string
  name: string
  role?: string
  n: number
  sig: number
  markdown: number
  quote: number
  long: number
  fast: number
  command: number
  called: number
  bursts: number
  lastAt: number
  channels: Set<string>
}

export interface BotStatus {
  key: string
  name: string
  bot: boolean
  source: '名单' | '自动认出' | '不是机器人' | '候选' | '—'
  score: number
  why: string[]
  messages: number
  lastAt: number
  channels: string[]
}

export interface Gate { allow: boolean, via?: 'unlock', why: string, factor: number }

/** 频道 + 发送者 → 「平台:号」，和 guard 的主人写法一致 */
export function botKey(channel: string, id: string): string {
  return `${channel.split(':')[0]}:${id}`
}

/** 名单里写「30001」或「qq:30001」都认 */
function inList(list: string[] | undefined, key: string): boolean {
  const bare = key.slice(key.indexOf(':') + 1)
  return (list ?? []).some(x => String(x) === key || String(x) === bare)
}

export class Bots {
  private stats = new Map<string, Stat>()
  private unlocks = new Map<string, { left: number, until: number, at: number }>() // 「频道|键」

  constructor(private cfg: () => BotsConfig, private isOwner: (key: string) => boolean) {}

  clear(): void {
    this.stats.clear()
    this.unlocks.clear()
  }

  /** 群里有人说了一句：给他攒特征，也给他点名的人攒「被叫机器人」；before 不含这句 */
  observe(ch: string, cur: Entry, before: Entry[]): void {
    if (cur.who === SELF)
      return
    const c = this.cfg()
    const s = this.stat(ch, cur)
    s.n++
    s.lastAt = cur.at
    s.channels.add(ch)
    if (cur.role)
      s.role = cur.role
    const text = cur.text
    if ((c.botTexts ?? []).some(t => t && text.includes(t)))
      s.sig++
    if (hasMarkdown(text))
      s.markdown++
    if (text.replace(/^\[回复[^\]]*\]\s*/, '').length > 60)
      s.long++
    if (text.startsWith('[回复 ') || text.startsWith('[回复你'))
      s.quote++
    const prev = before.findLast(e => e.who !== cur.who)
    if (prev && cur.at - prev.at <= (c.fastReplySec ?? 3) * 1000) {
      // 它回的就是上一句的人（引用 / @ 回去），或者上一句正是在 @ 它
      const answers = prev.who === SELF ? text.startsWith('[回复你') : !!prev.name && (text.includes(`@${prev.name}`) || text.startsWith(`[回复 ${prev.name}`))
      const calledIt = !!s.name && prev.text.includes(`@${s.name}`)
      if (answers || calledIt)
        s.fast++
    }
    if (prev && prev.who !== SELF && cur.at - prev.at <= (c.commandReplySec ?? 6) * 1000 && isCommand(prev.text))
      s.command++
    // 一口气连发：同一人连续第 3 句、都很短、10 秒内（中间没人插话）
    let run = 1
    for (let i = before.length - 1; i >= 0 && before[i].who === cur.who && cur.at - before[i].at < 10_000 && before[i].text.length <= 25; i--)
      run++
    if (run === 3 && text.length <= 25)
      s.bursts++
    // 别人冲着它（@ 它 / 引用它的话）说「机器人」一类的词；只提到名字不算，一句话里点了好几个人也只算被 @ 的那个。
    // 只看说话人自己的话：「[回复 X「群里多少机器人了」] 数不过来」里的「机器人」是 X 说的，不是在说谁是机器人
    const words = c.botWords ?? []
    const own = text.replace(/^\[回复[^\]]*\]\s*/, '')
    if (words.some(w => hasWord(own, w))) {
      for (const o of this.stats.values()) {
        if (o.key === s.key || !o.name || !o.channels.has(ch))
          continue
        if (own.includes(`@${o.name}`) || text.startsWith(`[回复 ${o.name}「`))
          o.called++
      }
    }
  }

  /** 日志里的解锁 / 放行：投影出「还能跟它聊几轮」「上次理它是什么时候」 */
  onLog(type: string, d: Record<string, any>, at: number): void {
    const ch = String(d.channel ?? '')
    // 解锁的轮数按「放进来的它的话」扣：放进 unlockTurns 句就恢复不理。按她开口扣的话，她打字慢、
    // 回第二句之前它的第三句已经到了，会多放进来一句（模拟器 bot-mark 抓到过）
    if (type === 'bot.unlocked')
      this.unlocks.set(`${ch}|${d.key}`, { left: Number(d.turns) || 1, until: Number(d.until) || at + 300_000, at })
    else if (type === 'bot.allowed') {
      const u = this.unlocks.get(`${ch}|${d.key}`)
      if (u && d.via === 'unlock')
        u.left--
    }
  }

  /** 这个人现在算不算机器人 */
  is(key: string): boolean {
    return this.status(key).bot
  }

  /** 主人解锁了、还在期限内：这时它的话照常进话题线、阅读窗口 */
  unlocked(ch: string, key: string, now: number): boolean {
    const u = this.unlocks.get(`${ch}|${key}`)
    return !!u && u.left > 0 && now < u.until
  }

  /** 这个群里最近一次解锁它的时刻（用完、过期了也算）；没解锁过是 undefined */
  unlockedAt(ch: string, key: string): number | undefined {
    return this.unlocks.get(`${ch}|${key}`)?.at
  }

  status(key: string): BotStatus {
    const c = this.cfg()
    const s = this.stats.get(key)
    const { score, why } = this.score(key)
    const base = { key, name: s?.name ?? c.learned?.[key]?.name ?? '', score, why, messages: s?.n ?? 0, lastAt: s?.lastAt ?? 0, channels: [...s?.channels ?? []] }
    if (c.enabled === false || this.isOwner(key))
      return { ...base, bot: false, source: '—' }
    if (inList(c.notBots, key))
      return { ...base, bot: false, source: '不是机器人' }
    if (inList(c.list, key))
      return { ...base, bot: true, source: '名单' }
    if (c.learned?.[key])
      return { ...base, bot: true, source: '自动认出', why: c.learned[key].why ? [c.learned[key].why!] : why }
    const candidate = score > 0 && s !== undefined
    return { ...base, bot: false, source: candidate ? '候选' : '—' }
  }

  score(key: string): { score: number, why: string[] } {
    const s = this.stats.get(key)
    if (!s)
      return { score: 0, why: [] }
    const c = this.cfg()
    const w = { ...W, ...c.weights }
    const why: string[] = []
    let hard = 0
    let soft = 0
    const add = (f: Feature, reason: string): void => {
      if (SOFT.has(f))
        soft += w[f]
      else hard += w[f]
      why.push(reason)
    }
    const bare = key.slice(key.indexOf(':') + 1)
    if (bare.length >= 10 && (c.uinPrefixes ?? []).some(p => p && bare.startsWith(p)))
      add('uin', `号段像机器人（${bare.slice(0, 4)}…）`)
    if (s.role && (c.roles ?? []).includes(s.role))
      add('role', `身份是 ${s.role}`)
    if (s.sig)
      add('sig', '发过只有机器人发得出来的东西（官方 markdown / 报错）')
    if (s.markdown >= 3 && s.markdown / s.n >= 0.6)
      add('markdownMore', `${s.markdown}/${s.n} 句带 markdown 排版`)
    else if (s.markdown >= 2 && s.markdown / s.n >= 0.3)
      add('markdown', `${s.markdown} 句带 markdown 排版`)
    if ((c.nameWords ?? []).some(x => hasWord(s.name, x)))
      add('name', `昵称「${s.name}」`)
    else if ((c.nameWeakWords ?? []).some(x => hasWord(s.name, x)))
      add('nameWeak', `昵称「${s.name}」`)
    if (s.fast >= 2)
      add('fast', `被点名后几秒就回（${s.fast} 次）`)
    if (s.n >= 6 && s.quote / s.n >= 0.6)
      add('quote', `总是引用回复（${s.quote}/${s.n}）`)
    if (s.long >= 3 && s.long / s.n >= 0.4)
      add('long', `老发长段（${s.long}/${s.n}）`)
    if (s.command >= 3 && s.command / s.n >= 0.15)
      add('command', `有人发指令它就应（${s.command} 次）`)
    if (s.called >= 2)
      add('calledMore', `被人叫机器人 ${s.called} 次`)
    else if (s.called === 1)
      add('called', '被人叫过机器人')
    if (s.bursts >= 3)
      add('burst', `老是一口气连发几句（${s.bursts} 次）`)
    // 行为类特征真人也常有（真群里一个群友被 @ 时别人提到「机器人」、又回得快，就被认成了机器人），
    // 加起来最多 softCap：光靠它们过不了线，得有一项硬特征
    const score = hard + Math.min(soft, c.softCap ?? 0.5)
    return { score: Math.round(score * 100) / 100, why }
  }

  /** 该自动记下、还没记的：分数够、话够多、不在任何名单里 */
  toLearn(): { key: string, info: Learned }[] {
    const c = this.cfg()
    if (c.enabled === false || c.auto === false)
      return []
    const out: { key: string, info: Learned }[] = []
    for (const s of this.stats.values()) {
      // 发过只有机器人发得出来的东西（官方 markdown / 报错）是铁证，一句就够；其余的要多看几句
      if ((s.sig ? 1 : c.minMessages ?? 3) > s.n || this.isOwner(s.key) || inList(c.list, s.key) || inList(c.notBots, s.key) || c.learned?.[s.key])
        continue
      const { score, why } = this.score(s.key)
      if (score >= (c.threshold ?? 0.6))
        out.push({ key: s.key, info: { name: s.name, score, why: why.join('、'), at: s.lastAt } })
    }
    return out
  }

  /**
   * 机器人的话怎么算：主人解锁了 → 当群友（allow）；否则 allow=false 只表示「按机器人算」——
   * 它的普通话吸引力乘 `attraction`（不归零），它 @ 她按冷 @ 叫醒大脑（概率 `atWake`），材料里标着「机器人的套话」，
   * 回不回由大脑定（可以回，但要完全明白那是机器人的无用废话）。原来是 wake=false、p=0 一律不理。
   */
  gate(ch: string, key: string, now: number): Gate {
    const c = this.cfg()
    const st = this.status(key)
    const name = st.name || key
    const u = this.unlocks.get(`${ch}|${key}`)
    if (u && u.left > 0 && now < u.until)
      return { allow: true, via: 'unlock', why: `主人让你跟 ${name} 聊两句（还剩 ${u.left} 轮）`, factor: 1 }
    const factor = Math.max(0.01, Math.min(1, c.attraction ?? 0.15))
    return { allow: false, why: `${name} 是机器人（${st.source}），程序的套话：吸引力 × ${factor}，回不回她自己定`, factor }
  }

  /** 名字或号 → 键：号直接拼；名字在这些频道里最近说过话的人里找（全等优先，再找包含） */
  resolve(who: string, channels: string[], platform = 'qq'): string | undefined {
    const w = who.trim().replace(/^@/, '')
    if (/^\d{5,}$/.test(w))
      return `${platform}:${w}`
    if (/^[a-z]+:\d{5,}$/.test(w))
      return w
    const pool = [...this.stats.values()].filter(s => !channels.length || channels.some(ch => s.channels.has(ch))).sort((a, b) => b.lastAt - a.lastAt)
    return (pool.find(s => s.name === w) ?? pool.find(s => s.name.length >= 2 && w.length >= 2 && (s.name.includes(w) || w.includes(s.name))))?.key
  }

  /** 这个群里说过话的人（主人提到谁时对名字用） */
  people(ch: string): { key: string, name: string }[] {
    return [...this.stats.values()].filter(s => s.channels.has(ch) && s.name).map(s => ({ key: s.key, name: s.name }))
  }

  /** 网页 / 命令用：名单里的、自动认出的、候选的、取消过的 */
  rows(): BotStatus[] {
    const c = this.cfg()
    const keys = new Set([...this.stats.keys(), ...Object.keys(c.learned ?? {}), ...(c.list ?? []).map(k => String(k).includes(':') ? String(k) : `qq:${k}`), ...(c.notBots ?? []).map(k => String(k).includes(':') ? String(k) : `qq:${k}`)])
    return [...keys].map(k => this.status(k))
      .filter(r => r.source !== '—')
      .sort((a, b) => Number(b.bot) - Number(a.bot) || b.score - a.score || b.lastAt - a.lastAt)
  }

  private stat(ch: string, e: Entry): Stat {
    const key = botKey(ch, e.who)
    let s = this.stats.get(key)
    if (!s) {
      s = { key, name: e.name ?? e.who, n: 0, sig: 0, markdown: 0, quote: 0, long: 0, fast: 0, command: 0, called: 0, bursts: 0, lastAt: e.at, channels: new Set() }
      this.stats.set(key, s)
    }
    if (e.name)
      s.name = e.name
    return s
  }
}
