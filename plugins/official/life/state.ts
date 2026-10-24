/**
 * 「此刻在干嘛」从日志投影（日志是唯一真源，重启 / 重载不丢）。
 * 只认两种事件：`life.changed`（换了一件事）与 `life.cleared`（用户清掉，作息马上重抽）。
 */
import type { LogEvent } from '../../../src/index.ts'

export type By = 'rhythm' | 'self' | 'user'

export interface LifeState {
  activity: string
  detail: string
  from: number
  until: number
  by: By // rhythm = 到点换的（how 说是她自己选的还是抽签）；self = 她在聊天里改的；user = 网页 / 命令设的
  seed?: number
  how?: 'chose' | 'drew'
  thought?: string // 她自己选时心里那句
  slot?: string // 当时的时段
  cause?: string // 为什么换：expired / slot / reroll / clear / start …
}

export class LifeLog {
  current?: LifeState
  recent: LifeState[] = []
  /** 每个活动上一次做完的时刻：衔接规则（gapMin）用 */
  private ended: Record<string, number> = {}
  /** 每来一条 life.* 加一：在途的抽签据此知道「问模型这会儿别人已经改过了」 */
  version = 0

  constructor(private keep = 30) {}

  observe(e: LogEvent): void {
    if (e.type === 'life.changed') {
      const s = e.data as LifeState
      if (this.current)
        this.ended[this.current.activity] = Math.min(this.current.until, s.from)
      this.current = s
      this.recent.push(s)
      if (this.recent.length > this.keep)
        this.recent.splice(0, this.recent.length - this.keep)
      this.version++
    }
    else if (e.type === 'life.cleared') {
      if (this.current)
        this.ended[this.current.activity] = Math.min(this.current.until, e.at)
      this.current = undefined
      this.version++
    }
  }

  /** 手上这件还在做（没到 until） */
  active(now: number): LifeState | undefined {
    return this.current && this.current.until > now ? this.current : undefined
  }

  /** 各活动上一次做完的时刻，手上这件按「到 now 为止」算 */
  lastEnd(now: number): Record<string, number> {
    const out = { ...this.ended }
    if (this.current)
      out[this.current.activity] = Math.min(this.current.until, now)
    return out
  }
}
