/**
 * 她对每个群的好感：喜欢的群多说两句，烦的群少说。
 *
 * 从真源投影（log.appended，启动时回放全部存量），不另存一份：每条事件只做常数级更新，几万条也是瞬间。
 * 分值以 1 为中性，夹在 min～max；没事发生时按 halfLifeDays 半衰期慢慢回到 1（记仇也记好都会淡）。
 *
 * 涨：她在群里说话，replyWindowSec 内有人接着说（被接住了）· 有人 @ 她 / 叫她名字 / 回复她（被惦记）。
 * 跌：她说完 replyWindowSec 没人接（冷场）· 冲她说的话里带 insultWords（被怼）。
 *
 * memory 插件的群印象是一段文字、不出数值，这里不去解析它；大脑那边两样都看得到（印象由 memory 给，分值由这里给）。
 */
import type { LogEvent } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'

export interface AffinityConfig {
  enabled?: boolean
  caught?: number
  mentioned?: number
  ignored?: number
  insulted?: number
  insultWords?: string[]
  replyWindowSec?: number
  halfLifeDays?: number
  min?: number
  max?: number
}

interface Score {
  value: number
  at: number // 上次结算衰减的时刻
  pendingSelfAt?: number // 她最近一次开口、还没判出「接住 / 冷场」的时刻
  counts: { caught: number, mentioned: number, ignored: number, insulted: number }
}

export class Affinity {
  private scores = new Map<string, Score>()

  /** ignore：群里的机器人（bots.ts）——它接她的话、@ 她都不算人情 */
  constructor(private cfg: () => AffinityConfig, private isGroup: (ch: string) => boolean, private ignore: (ch: string, senderId: string) => boolean = () => false) {}

  clear(): void {
    this.scores.clear()
  }

  observe(e: LogEvent): void {
    const c = this.cfg()
    if (c.enabled === false)
      return
    const d = e.data ?? {}
    const ch = String(d.channel ?? MAIN_CHANNEL)
    if (!this.isGroup(ch))
      return
    const s = this.settle(ch, e.at)
    if (e.type === 'utterance.settled' && d.delivered) {
      s.pendingSelfAt = e.at
      return
    }
    if (e.type !== 'percept.received' || !d.sender || !d.text || this.ignore(ch, String(d.sender.id)))
      return
    const win = (c.replyWindowSec ?? 120) * 1000
    if (s.pendingSelfAt !== undefined) {
      if (e.at - s.pendingSelfAt <= win)
        this.bump(s, 'caught', c.caught ?? 0.04)
      else this.bump(s, 'ignored', c.ignored ?? -0.03)
      s.pendingSelfAt = undefined
    }
    if (d.kind !== 'group.message') { // @ / 叫名字 / 回复她：冲她来的
      const text = String(d.text)
      if ((c.insultWords ?? []).some(w => w && text.includes(w)))
        this.bump(s, 'insulted', c.insulted ?? -0.1)
      else this.bump(s, 'mentioned', c.mentioned ?? 0.02)
    }
  }

  /** 此刻的好感（含到 now 为止的衰减与「说完一直没人接」） */
  get(ch: string, now: number): { value: number, why: string } {
    if (this.cfg().enabled === false)
      return { value: 1, why: '好感关闭' }
    const s = this.scores.get(ch)
    if (!s)
      return { value: 1, why: '还不熟' }
    const c = this.cfg()
    if (s.pendingSelfAt !== undefined && now - s.pendingSelfAt > (c.replyWindowSec ?? 120) * 1000) {
      this.settle(ch, now)
      this.bump(s, 'ignored', c.ignored ?? -0.03)
      s.pendingSelfAt = undefined
    }
    this.settle(ch, now)
    const n = s.counts
    const parts = [
      n.caught && `被接住 ${n.caught} 次`,
      n.mentioned && `被 @ ${n.mentioned} 次`,
      n.ignored && `没人接 ${n.ignored} 次`,
      n.insulted && `被怼 ${n.insulted} 次`,
    ].filter(Boolean)
    return { value: Math.round(s.value * 100) / 100, why: parts.length ? parts.join('、') : '没什么来往' }
  }

  private settle(ch: string, now: number): Score {
    let s = this.scores.get(ch)
    if (!s) {
      s = { value: 1, at: now, counts: { caught: 0, mentioned: 0, ignored: 0, insulted: 0 } }
      this.scores.set(ch, s)
      return s
    }
    const half = (this.cfg().halfLifeDays ?? 3) * 86_400_000
    if (now > s.at && half > 0)
      s.value = 1 + (s.value - 1) * 0.5 ** ((now - s.at) / half)
    s.at = Math.max(s.at, now)
    return s
  }

  private bump(s: Score, kind: keyof Score['counts'], delta: number): void {
    const c = this.cfg()
    s.value = Math.min(c.max ?? 1.8, Math.max(c.min ?? 0.3, s.value + delta))
    s.counts[kind]++
  }
}

/** 心情系数：相对 emotion 的基线，愉悦 / 兴奋高一点就多说，低落就少说；夹在 min～max */
export interface MoodConfig {
  enabled?: boolean
  valence?: number
  arousal?: number
  baseValence?: number
  baseArousal?: number
  min?: number
  max?: number
}

export function moodFactor(state: { valence: number, arousal: number } | undefined, c: MoodConfig): number {
  if (!state || c.enabled === false)
    return 1
  const f = 1 + (c.valence ?? 0.6) * (state.valence - (c.baseValence ?? 0.25)) + (c.arousal ?? 0.4) * (state.arousal - (c.baseArousal ?? 0.45))
  return Math.round(Math.min(c.max ?? 1.4, Math.max(c.min ?? 0.6, f)) * 100) / 100
}
