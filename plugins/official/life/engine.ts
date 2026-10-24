/**
 * 换状态的三条路，都只经日志写（`life.changed` / `life.cleared`），状态由 LifeLog 投影：
 * - 作息到点（rhythm）：抽签定种子 → 候选不止一个就让她自己选（choose.ts）→ 失败退回抽签结果；
 * - 她在聊天里改（self，大脑的 life.set 动作）；
 * - 用户在网页 / 命令里设（user）：持续到下一个时段或指定分钟数，期间作息和她自己都不改它。
 */
import type { Ctx } from '../../../src/index.ts'
import type { EmotionService } from '../emotion/index.ts'
import type { InterestScore } from '../interests/index.ts'
import type { Choice, Option } from './choose.ts'
import { buildPrompt, choose } from './choose.ts'
import type { Activity, Clock, Slot } from './rhythm.ts'
import { candidates, clockAt, draw, matchActivity, minutesOf, newSeed, rng, slotAt, weightsOf } from './rhythm.ts'
import type { By, LifeLog, LifeState } from './state.ts'

export interface LifeConfig {
  timeZone?: string
  weekendDays?: number[]
  role?: string
  choose?: boolean
  chooseTimeoutSec?: number
  tickSec?: number
  quietSec?: number
  activities?: Activity[]
  rhythm?: Slot[]
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export class Life {
  private rolling?: Promise<LifeState | undefined>

  /** alive：插件已卸载（改设置会重载）时，在途的抽签不再落日志，新实例自己会抽 */
  constructor(private ctx: Ctx, private cfg: LifeConfig, readonly log: LifeLog, private alive: () => boolean = () => true) {}

  get acts(): Activity[] {
    return this.cfg.activities ?? []
  }

  activity(name: string): Activity | undefined {
    return this.acts.find(a => a.name === name)
  }

  clock(ms = Date.now()): Clock {
    return clockAt(ms, this.cfg.timeZone ?? 'Asia/Shanghai', this.cfg.weekendDays ?? [0, 6])
  }

  slot(c: Clock = this.clock()): ReturnType<typeof slotAt> {
    return slotAt(this.cfg.rhythm ?? [], c.minute)
  }

  hm(ms: number): string {
    return this.clock(ms).hm
  }

  /** 「今天 12:05」「昨天 18:02」：按配置时区的日历日算 */
  when(ms: number, now = Date.now()): string {
    const day = (t: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timeZone ?? 'Asia/Shanghai' }).format(new Date(t))
    const d = Math.round((Date.parse(day(now)) - Date.parse(day(ms))) / 86_400_000)
    return `${d === 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`} ${this.hm(ms)}`
  }

  line(s: LifeState): string {
    return s.detail && s.detail !== s.activity ? `${s.activity}：${s.detail}` : s.activity
  }

  /** 该不该换了：返回原因，不该换返回 undefined */
  due(now = Date.now()): string | undefined {
    const s = this.log.current
    if (!s)
      return 'start'
    if (s.until <= now)
      return 'expired'
    if (s.by === 'user')
      return undefined
    const c = this.clock(now)
    const a = this.slot(c)
    const b = this.slot(this.clock(s.from))
    if (a && b && a.index !== b.index && !((weightsOf(a.slot, c.weekend)[s.activity] ?? 0) > 0))
      return 'slot' // 进了新时段，手上这件不在新时段里：到点了
    return undefined
  }

  /** 下一个时段开始的时刻；不到 15 分钟就算再下一个（11:28 设的不该只管两分钟） */
  nextBoundary(now = Date.now()): number {
    const c = this.clock(now)
    const s = this.slot(c)
    if (!s)
      return now + 3_600_000
    let left = s.left
    if (left < 15)
      left += this.slot({ ...c, minute: (c.minute + left) % 1440 })?.left ?? 60
    return now - (now % 60_000) + left * 60_000
  }

  private write(s: LifeState): LifeState {
    this.log.observe(this.ctx.log.append('life.changed', s))
    return s
  }

  /** 用户设（网页 / 命令）：文字认得出是哪个活动就归到它，认不出就是一件新事 */
  setByUser(text: string, minutes?: number, now = Date.now()): LifeState {
    const t = text.trim()
    const a = matchActivity(this.acts, t)
    const activity = a?.name ?? t.replace(/^在/, '')
    const detail = a && t !== a.name && t !== `在${a.name}` ? t : ''
    const until = minutes ? now + minutes * 60_000 : this.nextBoundary(now)
    return this.write({ activity, detail, from: now, until, by: 'user', slot: this.slot()?.slot.label, cause: 'user' })
  }

  /** 她自己在聊天里改（life.set）；用户设的还在管着就不改，返回 undefined */
  setBySelf(activity: string, detail: string, minutes?: number, now = Date.now()): LifeState | undefined {
    if (this.log.active(now)?.by === 'user')
      return undefined
    const a = this.activity(activity) ?? matchActivity(this.acts, `${activity}${detail}`)
    const m = minutes && minutes > 0 ? minutes : minutesOf(a, Math.random)
    return this.write({ activity: a?.name ?? activity, detail, from: now, until: now + m * 60_000, by: 'self', slot: this.slot()?.slot.label, cause: 'self' })
  }

  clear(): void {
    this.log.observe(this.ctx.log.append('life.cleared', { by: 'user' }))
  }

  /** 同一时刻只抽一次：正在问模型时再调拿到的是同一个 Promise */
  roll(o: { cause: string, at?: Clock, exclude?: string }): Promise<LifeState | undefined> {
    return this.rolling ??= this.doRoll(o).finally(() => { this.rolling = undefined })
  }

  private async doRoll(o: { cause: string, at?: Clock, exclude?: string }): Promise<LifeState | undefined> {
    const now = Date.now()
    const c = o.at ?? this.clock(now)
    const where = this.slot(c)
    if (!where)
      return undefined
    const cur = this.log.current
    const current = o.exclude ?? cur?.activity
    let cands = candidates(this.acts, where.slot, c.weekend, current, this.log.lastEnd(now), now)
    if (o.exclude && cands.length > 1)
      cands = cands.filter(x => x.name !== o.exclude)
    const seed = newSeed()
    const drawn = draw(seed, cands, this.acts)
    if (!drawn)
      return undefined
    const version = this.log.version
    let picked: Choice | undefined
    if (this.cfg.choose !== false && cands.length > 1) {
      try {
        picked = await this.ask(c, where.slot, cands, seed, !!o.at)
      }
      catch (e) {
        this.ctx.log.append('life.failed', { error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (this.log.version !== version || !this.alive())
      return undefined // 问模型这会儿，用户或她自己已经改过了：以那个为准
    const a = this.activity(picked?.activity ?? drawn.activity)
    const r = rng(seed ^ 0x5bd1e995)
    const minutes = picked?.minutes && a?.minutes
      ? Math.min(Math.max(picked.minutes, a.minutes[0]), a.minutes[1])
      : picked ? minutesOf(a, r) : drawn.minutes
    return this.write({
      activity: picked?.activity ?? drawn.activity,
      detail: picked ? (picked.detail || (picked.activity === drawn.activity ? drawn.detail : '')) : drawn.detail,
      from: now,
      until: now + minutes * 60_000,
      by: 'rhythm',
      seed,
      how: picked ? 'chose' : 'drew',
      thought: picked?.thought || undefined,
      slot: where.slot.label,
      cause: o.at ? `${o.cause}@${c.hm}` : o.cause,
    })
  }

  private async ask(c: Clock, slot: Slot, cands: { name: string, weight: number }[], seed: number, pretend: boolean): Promise<Choice | undefined> {
    const r = rng(seed ^ 0x9e3779b9)
    const top = [...cands].sort((a, b) => b.weight - a.weight).slice(0, 5)
    const options: Option[] = []
    for (const x of top) {
      const details = [...(this.activity(x.name)?.details ?? [])].sort(() => r() - 0.5).slice(0, 4)
      const liked: string[] = []
      for (const d of details) {
        const s = await this.ctx.bus.waterfall<InterestScore, InterestScore>('interests/score', { text: d, score: 0, hits: [] }, async p => p).catch(() => undefined)
        if ((s?.score ?? 0) >= 0.3)
          liked.push(d)
      }
      options.push({ name: x.name, details, liked })
    }
    const now = Date.now()
    const cur = this.log.current
    const weekday = WEEK[c.day]
    const recent = this.log.recent.filter(s => s !== cur).slice(-6).map(s => `${this.when(s.from, now)} ${this.line(s)}`)
    const chat = this.ctx.log.history({ limit: 6 }).map(t => `${t.role === 'self' ? '你' : (t.sender?.name ?? '对方')}：${[...t.text].slice(0, 40).join('')}`)
    let mood: string | undefined
    try {
      mood = this.ctx.use<EmotionService>('emotion').state().label
    }
    catch {
      // 没装 emotion：不写心情
    }
    const persona = await this.ctx.prompt.assemble('life.choose')
    const messages = buildPrompt(persona, {
      when: `${pretend ? '（这次按这个时间算，别管上面写的现在几点）' : ''}${weekday} ${c.hm}，${slot.label}（${c.weekend ? '周末' : '工作日'}）`,
      now: cur ? `${this.line(cur)}，${this.when(cur.from, now)} 起` : undefined,
      mood,
      recent,
      chat,
      options,
    })
    const signal = AbortSignal.timeout((this.cfg.chooseTimeoutSec ?? 30) * 1000)
    const got = await choose(req => this.ctx.model.complete(req), { role: this.cfg.role ?? 'mind.decide', signal }, messages, options.map(o => o.name))
    if (!got)
      this.ctx.log.append('life.failed', { error: '输出不是合法 JSON，或选的不在候选里' })
    return got
  }
}

export function byLabel(s: LifeState): string {
  const m: Record<By, string> = { rhythm: s.how === 'chose' ? '到点·她选的' : '到点·抽签', self: '她自己改的', user: '用户设的' }
  return m[s.by] ?? s.by
}
