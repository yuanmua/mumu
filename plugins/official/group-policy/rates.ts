/**
 * 每个群的接话意愿：拆成看得懂的几个因子，并且能调。
 *
 *   此刻意愿 = base × talkValue × 群倍率（手动）× 好感（自动）× 心情 × 时段
 *
 * - 群倍率 rates：人在设置页 / 面板按钮 / `/freq set` 改，她自己用动作 group.rate 改（觉得烦就调低，0 = 只在被 @ 时答）。
 *   写进配置 plugins.group-policy.rates，配置一改插件重载，judge 读到新值。
 * - 好感、心情见 affinity.ts。
 * 面板「群聊意愿」、/freq、大脑材料「群的感觉」用的都是这里的同一份计算。
 */
import type { ActionType, ConfigService } from '../../../src/index.ts'
import type { Command } from '../commands/index.ts'
import type { Affinity } from './affinity.ts'
import type { PolicyConfig } from './judge.ts'
import { forChannel, timeFactor } from './judge.ts'
import type { Rooms } from './rooms.ts'
import { SELF } from './rooms.ts'

export interface Willing {
  channel: string
  base: number
  talkValue: number
  rate: number
  affinity: number
  affinityWhy: string
  mood: number
  time: number
  willing: number
}

export interface RateDeps {
  cfg: PolicyConfig
  config: ConfigService
  rooms: Rooms
  affinity: Affinity
  mood: () => number
  isGroup: (ch: string) => boolean
}

const RATE_MAX = 3

export function rateOf(cfg: PolicyConfig, ch: string): number {
  const r = cfg.rates?.[ch]
  return typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.min(RATE_MAX, r)) : 1
}

export function willingness(d: RateDeps, ch: string, now: number): Willing {
  const c = forChannel(d.cfg, ch)
  const a = d.affinity.get(ch, now)
  const w = {
    channel: ch,
    base: c.base ?? 0.25,
    talkValue: c.talkValue ?? 1,
    rate: rateOf(d.cfg, ch),
    affinity: a.value,
    affinityWhy: a.why,
    mood: d.mood(),
    time: timeFactor(c.timeRules ?? [], c.timeZone ?? 'Asia/Shanghai', new Date(now)),
  }
  return { ...w, willing: Math.round(Math.min(1, w.base * w.talkValue * w.rate * w.affinity * w.mood * w.time) * 1000) / 1000 }
}

/** 「少说点 / 多说点 / 只回 @ / 恢复 / 一个数」→ 新倍率 */
export function parseRate(input: string, current: number): number | undefined {
  const s = input.trim()
  if (['quiet', 'mute', '只回@', '只回@她', '0', '闭嘴'].includes(s))
    return 0
  if (['less', 'down', '少说', '少说点', '调低'].includes(s))
    return Math.round(current * 0.5 * 100) / 100
  if (['more', 'up', '多说', '多说点', '调高'].includes(s))
    return Math.min(RATE_MAX, Math.round((current || 0.5) * 1.5 * 100) / 100)
  if (['normal', 'reset', '恢复', '正常'].includes(s))
    return 1
  const n = Number(s)
  return Number.isFinite(n) ? Math.max(0, Math.min(RATE_MAX, n)) : undefined
}

/** 写倍率；1 就删掉这个键（回到默认）。配置一写插件就重载 */
export function setRate(d: Pick<RateDeps, 'cfg' | 'config'>, ch: string, rate: number): void {
  const rates = { ...(d.cfg.rates ?? {}) }
  if (rate === 1)
    delete rates[ch]
  else rates[ch] = rate
  d.config.set('plugins.group-policy.rates', rates)
}

const label = (rate: number): string => rate === 0 ? '只在被 @ 时说话' : rate < 1 ? '少说点' : rate > 1 ? '多说点' : '正常'

/** 给大脑的动作：她自己决定在某个群话多话少 */
export function rateAction(d: RateDeps): ActionType {
  return {
    name: 'group.rate',
    description: '调你在某个群里的话多话少：觉得这个群烦、不想聊就调低（quiet = 只在被 @ 时说话），喜欢这个群就调高。看「群的感觉」里的好感再决定。',
    paramsHint: '{"rate":"quiet|less|more|normal 或 0～3 的数","channel":"群频道（省略 = 意图所在的群）","why":"一句话说为什么"}',
    run: async (a) => {
      const ch = typeof a.params.channel === 'string' ? a.params.channel : a.channel ?? ''
      if (!d.isGroup(ch))
        throw new Error(`不是群频道（${ch || '没给'}），channel 写 qq:group:群号`)
      const now = rateOf(d.cfg, ch)
      const next = parseRate(String(a.params.rate ?? ''), now)
      if (next === undefined)
        throw new Error('rate 写 quiet / less / more / normal 或 0～3 的数')
      // 先记，再写配置：写配置会让本插件重载
      a.remember(`你把在 ${ch} 的话多话少从 ${now} 调成了 ${next}（${label(next)}）${a.params.why ? `：${String(a.params.why)}` : ''}`)
      setRate(d, ch, next)
    },
  }
}

export interface FreqDeps extends RateDeps {
  recent: { at: number, channel: string, who: string, p: number, why: string[], wake: boolean }[]
  busy: () => string[]
}

export function freqCommand(d: FreqDeps): Command {
  return {
    name: 'freq',
    usage: 'freq [群号] | freq set <群号> <倍率|quiet|less|more|normal>',
    description: '群聊接话意愿：各群此刻的意愿（基础 × 话多话少 × 群倍率 × 好感 × 心情 × 时段）与最近的判断；set 调某个群的倍率',
    run(args, io) {
      const now = Date.now()
      const find = (want: string): string | undefined => d.rooms.channels().find(ch => d.isGroup(ch) && (ch === want || ch.endsWith(`:${want}`)))
        ?? (d.isGroup(want) ? want : /^\d+$/.test(want) ? `qq:group:${want}` : undefined)
      if (args[0] === 'set') {
        const ch = args[1] ? find(args[1]) : undefined
        const next = ch ? parseRate(args[2] ?? '', rateOf(d.cfg, ch)) : undefined
        if (!ch || next === undefined) {
          io.print('  用法：/freq set <群号> <倍率 0～3 | quiet | less | more | normal>')
          return
        }
        setRate(d, ch, next)
        io.print(`  ✓ ${ch} 倍率 → ${next}（${label(next)}）`)
        return
      }
      const want = args[0]
      // 不指定时只列半小时内有动静的群；几万个群挂着也不刷屏
      const active = (ch: string): boolean => now - (d.rooms.list(ch).at(-1)?.at ?? 0) < 1_800_000
      const groups = d.rooms.channels().filter(ch => d.isGroup(ch) && (want ? ch === want || ch.endsWith(`:${want}`) : active(ch)))
      if (!groups.length)
        io.print(want ? `  没有 ${want} 的消息` : '  半小时内没有群消息（/freq <群号> 看指定的群）')
      for (const ch of groups) {
        const w = willingness(d, ch, now)
        const perMin = d.rooms.list(ch).filter(e => e.who !== SELF && now - e.at < 60_000).length
        io.print(`  ${ch}：此刻意愿 ${w.willing}（基础 ${w.base} × 话多话少 ${w.talkValue} × 群倍率 ${w.rate} × 好感 ${w.affinity} × 心情 ${w.mood} × 时段 ${w.time}）`
          + ` · 好感因为：${w.affinityWhy} · 群里 ${perMin} 句/分钟`)
        for (const r of d.recent.filter(x => x.channel === ch).slice(-5))
          io.print(`    ${new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false })} ${r.who} p=${r.p} ${r.wake ? '唤醒' : '没唤醒'}（${r.why.join('、')}）`)
      }
      const busy = d.busy()
      if (busy.length)
        io.print(`  正在忙：${busy.join('、')}（群里只回必答）`)
    },
  }
}

/** 此刻想不想聊这个群，以及为什么——给大脑、给发言者、给面板，同一份说法 */
export function feelOf(w: Willing, c: { coldBelow?: number, warmAbove?: number }): { level: '想聊' | '一般' | '懒得理', reasons: string[] } {
  const reasons: string[] = []
  if (w.mood >= 1.1)
    reasons.push('心情不错')
  else if (w.mood <= 0.85)
    reasons.push('心情不太好')
  if (w.affinity >= 1.15)
    reasons.push(`喜欢这个群（${w.affinityWhy}）`)
  else if (w.affinity <= 0.8)
    reasons.push(`对这个群没什么好感（${w.affinityWhy}）`)
  if (w.rate !== 1)
    reasons.push(w.rate === 0 ? '设了只在被 @ 时说话' : `话多话少倍率 ${w.rate}`)
  if (w.time <= 0.5)
    reasons.push('这个点有点困')
  const level = w.willing >= (c.warmAbove ?? 0.4) ? '想聊' : w.willing < (c.coldBelow ?? 0.12) ? '懒得理' : '一般'
  return { level, reasons }
}

/** 大脑材料「群的感觉」：最近有动静的群，此刻想不想聊、为什么；告诉她不想理就不理，嫌烦可以自己调 */
export function renderFeel(d: RateDeps, now: number): string {
  const active = d.rooms.channels().filter(ch => d.isGroup(ch) && now - (d.rooms.list(ch).at(-1)?.at ?? 0) < 600_000)
  if (!active.length)
    return ''
  const lines = active.slice(0, 6).map((ch) => {
    const w = willingness(d, ch, now)
    const f = feelOf(w, d.cfg.feel ?? {})
    return `- 群 ${ch.split(':').pop()}：此刻${f.level}${f.reasons.length ? `（${f.reasons.join('，')}）` : ''} · 好感 ${w.affinity} · 倍率 ${w.rate}（${label(w.rate)}）`
  })
  return `【群的感觉】（想聊就聊，不想理就不理：懒得理的群有人 @ 你也可以敷衍一句或干脆不回；觉得哪个群一直烦可以用 group.rate 调低，喜欢就调高）\n${lines.join('\n')}`
}
