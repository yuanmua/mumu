/**
 * 心跳调度：内核只管节拍，决策由 decider 插件提供。
 * 一拍 = 汇聚材料 → decider 产出意图 → 派发动作；Beat 自身不产生对外输出。
 *
 * 三重防护避免自激振荡：
 * - 合流：冷却窗口内的唤醒并成一拍；
 * - 同源指数退避：内生唤醒逐次放缓，外部唤醒不退避；
 * - 空拍熔断：连续空拍后只接受外部唤醒。
 *
 * 等待不是动作：空意图 + wakeAfterMs 定时器，新事件到来即作废定时器。
 */
import type { CatalogEntry, RunningView } from '../actions/registry.ts'
import type { Disposer } from '../core/container.ts'
import { KernelError } from '../core/error.ts'
import type { IncomingView } from '../io/port.ts'
import type { Note } from '../prompt/assembly.ts'
import type { HistoryTurn, Sender } from '../session/types.ts'

/** 唤醒输入；调用方声明结构位，内核不解析字符串 */
export interface WakeInput {
  source: string // 感知的 kind、'action:<类型>'、'timer' 等
  text: string // 感知来的是它自带的摘要；内核自己发的唤醒只给短代码（如 `reply#12 done`），怎么说成人话归 decider
  data?: Record<string, unknown> // 结构化细节；内核自己发的唤醒必带 code，见 docs/kernel.md
  channel?: string
  sender?: Sender
  external?: boolean // 外部输入：不退避、可解除熔断；内生唤醒为 false
  partial?: boolean // 来自尚未结束的流式感知
}

export interface WakeReason extends WakeInput {
  at: number
  external: boolean
}

export type Intent
  = | { do: 'start', action: string, params?: Record<string, unknown>, channel?: string }
    | { do: 'send', to: string, message: string }
    | { do: 'stop', target: string, reason?: string }

export interface Decision {
  note?: string
  intents: Intent[]
  wakeAfterMs?: number
}

/** 插件贡献的一块材料；text 通用可渲染，data 供认识它的 decider */
export interface MaterialBlock {
  from: string // 贡献者标识
  order: number // 越小越前；同号按 from 排，与段落同一套规则，不看插件加载先后
  text: string
  data?: unknown
}

/** 一拍的材料；本文件声明契约，装配层填充并开放给插件贡献 */
export interface BeatMaterial {
  reasons: WakeReason[]
  catalog: CatalogEntry[]
  running: RunningView[]
  incoming: IncomingView[] // 在途流式感知；据此决定插话还是等对方说完
  history: HistoryTurn[]
  notes: Note[] // 工作记忆，渲染由 decider 决定
  sections: string // 面向 mind 受众的段落组装结果
  blocks: MaterialBlock[] // 插件经 beat/gather 贡献，已按 order 排序
}

export type Decider = (m: BeatMaterial) => Promise<Decision>

export interface MindOptions {
  cooldownMs?: number // 唤醒合流冷却窗口
  backoffBaseMs?: number // 内生唤醒退避基数
  backoffMaxMs?: number // 退避上限
  emptyFuse?: number // 连续空拍多少次后熔断
}

export class Mind {
  private decider?: Decider
  private reasons: WakeReason[] = []
  private beating = false
  private rethink = false
  private timer?: NodeJS.Timeout
  private wakeAfterTimer?: NodeJS.Timeout
  private lastBeatEnd = 0
  private emptyStreak = 0
  private idle = false
  private backoff = new Map<string, { count: number, until: number }>()
  private disposed = false
  private readonly cooldownMs: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly emptyFuse: number

  constructor(private deps: {
    gather: (reasons: WakeReason[]) => Promise<BeatMaterial>
    dispatch: (intent: Intent, note?: string) => Promise<void>
    log: (type: string, data: unknown) => void
    options?: MindOptions
  }) {
    const o = deps.options ?? {}
    this.cooldownMs = o.cooldownMs ?? 300
    this.backoffBaseMs = o.backoffBaseMs ?? 1000
    this.backoffMaxMs = o.backoffMaxMs ?? 30_000
    this.emptyFuse = o.emptyFuse ?? 3
  }

  /** 独占槽位；换 decider 即换决策实现 */
  setDecider(d: Decider): Disposer {
    if (this.decider)
      throw new Error('decider 已被占用（先卸载旧的 mind 插件）')
    this.decider = d
    return () => { this.decider = undefined }
  }

  /** 一切唤醒入口 */
  wake(input: WakeInput): void {
    if (this.disposed)
      return
    const external = input.external ?? false
    if (this.idle && !external)
      return // 熔断中忽略内生唤醒
    if (external) {
      this.idle = false
      this.emptyStreak = 0
    }
    this.reasons.push({ ...input, at: Date.now(), external })
    clearTimeout(this.wakeAfterTimer) // 新事件到来，主动等待作废

    if (this.beating) {
      this.rethink = true
      return
    }
    const delay = this.delayFor(input.source, external)
    if (delay <= 0)
      void this.beat()
    else this.schedule(delay)
  }

  /** 冷却合流与同源退避共同决定开拍时刻 */
  private delayFor(source: string, external: boolean): number {
    let until = this.lastBeatEnd + this.cooldownMs
    if (!external) {
      const b = this.backoff.get(source)
      if (b && b.until > until)
        until = b.until
    }
    return until - Date.now()
  }

  private schedule(delay: number): void {
    if (this.timer)
      return // 已有待开的拍，新原因会被合流
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.beat()
    }, delay)
  }

  private async beat(): Promise<void> {
    if (this.beating || this.disposed || !this.reasons.length)
      return
    this.beating = true
    try {
      do {
        this.rethink = false
        const reasons = this.reasons.splice(0)
        for (const r of reasons) {
          if (!r.external)
            this.bumpBackoff(r.source)
        }

        // 汇聚要过 beat/gather 水线，插件可能抛错。beat() 是 fire-and-forget
        // 调用的，未捕获拒绝会杀进程，所以这里必须自己兜住。
        let material: BeatMaterial
        try {
          material = await this.deps.gather(reasons)
        }
        catch (e) {
          console.error('[mind] 汇聚材料失败，本拍作废:', e)
          this.deps.log('beat.failed', {
            reasons: reasons.map(r => ({ source: r.source, text: r.text })),
            error: errorText(e),
          })
          break // 不重试：下一次唤醒会带冷却重新开拍，避免连续失败空转
        }
        this.deps.log('beat.opened', {
          reasons, // I1：唤醒原因整条进材料（含 sender、data），就整条记
        })

        let decision: Decision = { intents: [] }
        if (this.decider) {
          try {
            decision = await this.decider(material)
          }
          catch (e) {
            // 降级必须可见：这一拍按空决策走，但日志里要看得出是「想失败了」而不是「决定不动」
            console.error('[mind] 决策失败:', e)
            this.deps.log('beat.decide-failed', { error: errorText(e) })
          }
        }

        for (const intent of decision.intents) {
          try {
            await this.deps.dispatch(intent, decision.note)
          }
          catch (e) {
            console.error('[mind] 派发失败:', e)
            this.deps.log('intent.dispatch-failed', { intent, code: errorCode(e), error: errorText(e) })
          }
        }
        this.deps.log('beat.closed', { note: decision.note, intents: decision.intents.length })

        if (decision.intents.length === 0) {
          if (++this.emptyStreak >= this.emptyFuse && !this.idle) {
            this.idle = true
            this.deps.log('beat.fused', { emptyStreak: this.emptyStreak })
          }
        }
        else {
          this.emptyStreak = 0
        }

        if (decision.wakeAfterMs && !this.rethink) {
          clearTimeout(this.wakeAfterTimer)
          this.wakeAfterTimer = setTimeout(
            () => this.wake({ source: 'timer', text: 'wake-after', data: { code: 'wake-after', afterMs: decision.wakeAfterMs }, external: true }),
            decision.wakeAfterMs,
          )
        }
      } while (this.rethink)
    }
    finally {
      this.beating = false
      this.lastBeatEnd = Date.now()
      if (this.reasons.length)
        this.schedule(this.cooldownMs) // 拍中新到的原因不丢
    }
  }

  /** 同源连续唤醒指数退避，间隔够久自动清零 */
  private bumpBackoff(source: string): void {
    const now = Date.now()
    const b = this.backoff.get(source)
    const count = b && b.until + this.backoffMaxMs > now ? b.count + 1 : 1
    this.backoff.set(source, {
      count,
      until: now + Math.min(this.backoffBaseMs * 2 ** (count - 1), this.backoffMaxMs),
    })
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    clearTimeout(this.wakeAfterTimer)
  }
}

function errorCode(e: unknown): string {
  return e instanceof KernelError ? e.code : 'error'
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
