/**
 * IO 端口：感知进、表现出、发声流与送达回执。
 *
 * 两端信封对称，kind 都是自由字符串，内核不认识任何模态。固定的只有节拍：
 *   进 Perception = 若干 update → end，或中途 cancel
 *   出 Utterance  = 若干 part   → end，或中途 stop
 * 一次性输入用 percept()，不必开流。
 *
 * channel 是并行会话上下文；表现端声明服务的频道，打断只切本频道。
 * I2 的落点在 settle：记录 delivered 而非生成全文。送达账只认 Part.text，
 * 因为文本可线性截断，其余片段是原子的。
 */
import type { Bus } from '../core/bus.ts'
import type { Disposer } from '../core/container.ts'
import { Registry } from '../core/registry.ts'
import type { WakeInput } from '../mind/scheduler.ts'
import type { SessionLog } from '../session/log.ts'
import type { Sender } from '../session/types.ts'
import { MAIN_CHANNEL } from '../session/types.ts'

/**
 * 非文本载荷的结构位：二进制本体放 BlobStore，这里只记 ref 与描述。
 * 只挂在 Part 上——进（Percept.parts、ChatMessage.parts）出（Utterance 的片段）都是 Part[]，一种媒体形状两边共用。
 * 内核不按 mime 分支（不认识模态），只负责让它随片段原样记账、原样传递。
 */
export interface MediaFields {
  mime?: string // 如 image/jpeg、audio/pcm
  ref?: string // BlobStore 里的 id（blobRef 内容哈希）
  bytes?: number // 本体字节数
  durationMs?: number // 音视频时长
}

/** 感知信封；kind 语义由产生它的插件定义，内核只用结构位 */
export interface Percept {
  kind: string
  channel?: string // 缺省 'main'
  sender?: Sender // 与 text 同时存在才进对话历史
  text?: string // 自然语言摘要，用于历史与唤醒原因
  urgent?: boolean // 硬打断本频道正在进行的发声
  parts?: Part[] // 非文本载荷：一条消息的几张图、一帧的几路传感器。与出口同一种片段形状，媒体字段只挂在 Part 上
  data?: Record<string, unknown>
}

/** 输出片段；kind 由插件约定，表现端不认识的直接忽略，此即能力降级 */
export interface Part extends MediaFields {
  kind: string
  text?: string // 唯一计入送达进度与 delivered 的载荷；非文本片段在这里写摘要作兜底
  data?: Record<string, unknown>
}

/** 在途流式感知的快照 */
export interface IncomingView {
  id: string
  kind: string
  channel: string
  sender?: Sender
  text: string // 目前收到的内容，后续 update 整体覆盖
  elapsedMs: number
}

/**
 * 流式感知句柄：若干 update → end，或中途 cancel。
 * update 是修订而非追加，后一次整体覆盖前一次；需要追加语义的表现端自行累积。
 * 音频与视频帧不进内核，表现端完成识别后再流入文本。
 */
export interface Perception {
  id: string
  channel: string
  readonly text: string
  /**
   * 修订内容。
   * @param opts.wake 唤醒 decider，使其有机会插话；默认 false，避免逐字开拍
   * @param opts.urgent 硬打断本频道正在进行的发声
   */
  update: (text: string, opts?: { wake?: boolean, urgent?: boolean }) => Promise<void>
  /** 定稿：落 settled、进对话历史、唤醒 decider */
  end: (opts?: { text?: string }) => Promise<void>
  /** 放弃：落 settled{cancelled}，不进历史，默认不唤醒 */
  cancel: (opts?: { reason?: string, wake?: boolean }) => Promise<void>
}

/** 发声流生命周期；内容开放，节拍固定 */
export type Expression
  = | { type: 'part', uttId: string, channel: string, part: Part }
    | { type: 'end', uttId: string, channel: string }
    | { type: 'stop', uttId: string, channel: string }

/** 表现端能力声明；内核只认 deliveredReport，其余键由插件约定 */
export interface SurfaceCapabilities {
  deliveredReport?: boolean // 缺省时按全部送达记账
  [key: string]: unknown
}

export interface Surface {
  name: string
  channels?: string[] // 缺省服务全部频道
  capabilities?: SurfaceCapabilities
  onExpression: (e: Expression) => void
}

export interface UtteranceResult {
  delivered: string
  generated: string
  truncated: boolean
  cause?: string
}

export interface UtterOptions {
  channel?: string // 缺省用动作自身频道，再缺省 'main'
}

export interface Utterance {
  id: string
  channel: string
  write: (text: string) => Promise<void> // 等价 emit({ kind: 'text', text })
  emit: (part: Part) => Promise<void>
  end: () => Promise<UtteranceResult> // 正常收尾，等待送达后结算
  signal: AbortSignal // 动作被停或被插话时触发
  settled: Promise<UtteranceResult>
}

/** marker 词汇；track 是通道名，与会话 channel 无关 */
export interface MarkerDef {
  track: string
  value: string
  hint?: string
}

export interface IOOptions {
  perceptionTimeoutMs?: number // 在途感知兜底时限，超时自动取消，防止 incoming 泄漏；0 为不兜底
  settleTimeoutMs?: number // 有回执端时等待呈现完成的兜底时限
}

interface LiveIn {
  id: string
  kind: string
  channel: string
  sender?: Sender
  text: string
  startedAt: number
  timeout?: NodeJS.Timeout
}

interface Live {
  id: string
  channel: string
  generated: string
  reported: number
  ended: boolean
  controller: AbortController
  resolve: (r: UtteranceResult) => void
  result?: UtteranceResult
  timeout?: NodeJS.Timeout
  detach?: () => void // 摘掉挂在动作信号上的监听
}

export class IO {
  /** 动作定义 marker 机制，插件贡献具体词汇 */
  readonly markers = new Registry<MarkerDef>('marker')
  private surfaces = new Set<Surface>()
  private live = new Map<string, Live>()
  private incoming_ = new Map<string, LiveIn>()
  private settleTimeoutMs: number
  private perceptionTimeoutMs: number

  constructor(private deps: {
    bus: Bus
    log: SessionLog
    wake: (input: WakeInput) => void
    options?: IOOptions
  }) {
    this.settleTimeoutMs = deps.options?.settleTimeoutMs ?? 60_000
    this.perceptionTimeoutMs = deps.options?.perceptionTimeoutMs ?? 300_000
  }

  connect(surface: Surface): Disposer {
    this.surfaces.add(surface)
    return () => { this.surfaces.delete(surface) }
  }

  /** 按 track 分组，供教学段落使用 */
  markerTracks(): Map<string, MarkerDef[]> {
    return Map.groupBy(this.markers.list(), d => d.track)
  }

  /** 一次性感知入口；先落日志，再过 percept/pre-beat 决定打断与唤醒 */
  async percept(p: Percept): Promise<void> {
    const channel = p.channel ?? MAIN_CHANNEL
    this.deps.log.append('percept.received', { ...p, channel })
    await this.route(p, channel, { wake: true })
  }

  /**
   * 流式感知入口，返回 {@link Perception} 句柄。
   * 在途内容进 BeatMaterial.incoming，按 I1 必须落日志：started / part / settled。
   */
  perceive(input: {
    kind: string
    channel?: string
    sender?: Sender
    urgent?: boolean // 开口即打断；不确定时可留到 update 再打断
    data?: Record<string, unknown>
  }): Perception {
    const channel = input.channel ?? MAIN_CHANNEL
    const { data: { id } } = this.deps.log.appendNew('in', 'perception.started', id => (
      { id, kind: input.kind, channel, sender: input.sender }
    ))
    const live: LiveIn = {
      id,
      kind: input.kind,
      channel,
      sender: input.sender,
      text: '',
      startedAt: Date.now(),
    }
    this.incoming_.set(id, live)

    const snapshot = (): IncomingView => ({
      id,
      kind: live.kind,
      channel,
      sender: live.sender,
      text: live.text,
      elapsedMs: Date.now() - live.startedAt,
    })
    const asPercept = (urgent?: boolean): Percept => ({
      kind: live.kind,
      channel,
      sender: live.sender,
      text: live.text,
      urgent,
      data: input.data,
    })

    // 开口打断也走同一条水线以便插件改写，但开口本身不开拍。
    // 句柄需同步返回，故不 await。
    // 有动静就续期：只有真卡死（长时间不 update 也不收尾）才被兜底取消
    const arm = (): void => {
      clearTimeout(live.timeout)
      if (this.perceptionTimeoutMs > 0) {
        live.timeout = setTimeout(() => {
          if (this.settlePerception(id, { cancelled: true, reason: 'perception-timeout' }))
            console.warn(`[io] perception timed out, cancelled: ${id}`)
        }, this.perceptionTimeoutMs).unref()
      }
    }
    arm()

    if (input.urgent)
      void this.route(asPercept(true), channel, { wake: false, incoming: snapshot() })

    return {
      id,
      channel,
      get text() { return live.text },
      update: async (text, o = {}) => {
        if (!this.incoming_.has(id))
          return
        live.text = text
        arm()
        this.deps.log.append('perception.part', { id, text })
        await this.route(asPercept(o.urgent), channel, {
          wake: o.wake ?? false,
          incoming: snapshot(),
          partial: true,
        })
      },
      end: async (o = {}) => {
        if (!this.settlePerception(id, { text: o.text }))
          return
        await this.route(asPercept(), channel, { wake: true })
      },
      cancel: async (o = {}) => {
        if (!this.settlePerception(id, { cancelled: true, reason: o.reason }))
          return
        if (o.wake)
          await this.route(asPercept(), channel, { wake: true })
      },
    }
  }

  /** 收尾一条在途感知；已收尾则返回 undefined，重复调用为空操作 */
  private settlePerception(
    id: string,
    opts: { text?: string, cancelled?: boolean, reason?: string },
  ): LiveIn | undefined {
    const live = this.incoming_.get(id)
    if (!live)
      return undefined
    this.incoming_.delete(id)
    clearTimeout(live.timeout)
    if (opts.text !== undefined)
      live.text = opts.text
    this.deps.log.append('perception.settled', {
      id,
      kind: live.kind,
      channel: live.channel,
      sender: live.sender,
      text: live.text,
      cancelled: opts.cancelled,
      reason: opts.reason,
    })
    return live
  }

  /** 在途的流式感知 */
  incoming(): IncomingView[] {
    const now = Date.now()
    return [...this.incoming_.values()].map(i => ({
      id: i.id,
      kind: i.kind,
      channel: i.channel,
      sender: i.sender,
      text: i.text,
      elapsedMs: now - i.startedAt,
    }))
  }

  /**
   * 感知的公共去向：过 percept/pre-beat 决定打断与唤醒。
   * terminal 里的默认策略只认结构位 urgent；插件包裹该水线即可改写。
   * 感知一律算外部输入，可解除空拍熔断。
   */
  private async route(
    p: Percept,
    channel: string,
    opts: { wake: boolean, incoming?: IncomingView, partial?: boolean },
  ): Promise<void> {
    // 本方法被 fire-and-forget 调用（起始打断、插件的 void ctx.io.percept），
    // 未捕获拒绝会杀进程，故拦截器出错时降级为默认行为而不是抛出。
    // 打断与唤醒一律按水线最终的 payload 走：插件改写了感知、频道或唤醒与否，就以改写后的为准。
    let decision = { percept: p, channel, wake: opts.wake, incoming: opts.incoming }
    try {
      decision = await this.deps.bus.waterfall(
        'percept/pre-beat',
        decision,
        async (payload) => {
          if (payload.percept.urgent)
            this.interruptChannel(payload.channel, 'user-interrupt')
          return payload
        },
      )
    }
    catch (e) {
      console.error('[io] interceptor failed, using defaults: percept/pre-beat:', e)
      this.deps.log.append('percept.route-error', {
        kind: p.kind,
        channel,
        error: e instanceof Error ? e.message : String(e),
      })
      decision = { percept: p, channel, wake: opts.wake, incoming: opts.incoming }
      if (p.urgent)
        this.interruptChannel(channel, 'user-interrupt') // 打断幂等
    }
    const { percept, channel: to } = decision
    if (decision.wake) {
      this.deps.wake({
        source: percept.kind,
        text: percept.text ?? percept.kind,
        channel: to,
        sender: percept.sender,
        external: true,
        partial: opts.partial,
      })
    }
  }

  /** 硬停某频道全部在进行的发声 */
  private interruptChannel(channel: string, cause: string): void {
    for (const u of [...this.live.values()]) {
      if (u.channel === channel)
        this.abortUtterance(u, cause)
    }
  }

  /** 表现端回报该 utterance 已呈现的累计文本字符数 */
  reportDelivered(uttId: string, chars: number): void {
    const u = this.live.get(uttId)
    if (!u)
      return
    u.reported = Math.max(u.reported, Math.min(chars, u.generated.length))
    this.maybeSettle(u)
  }

  utter(owner: { actionId: string, signal: AbortSignal, channel?: string }, opts: UtterOptions = {}): Utterance {
    // 频道解析链：显式 > 动作自身 > 缺省，无全局可变态
    const channel = opts.channel ?? owner.channel ?? MAIN_CHANNEL
    const { data: { id } } = this.deps.log.appendNew('utt', 'utterance.started', id => (
      { id, action: owner.actionId, channel }
    ))
    const controller = new AbortController()
    let resolve!: (r: UtteranceResult) => void
    const settled = new Promise<UtteranceResult>((res) => { resolve = res })
    const u: Live = { id, channel, generated: '', reported: 0, ended: false, controller, resolve }
    this.live.set(id, u)

    // 动作被停则发声同步停止；发声结算时摘掉监听，长命的动作开再多句也不累积
    const onOwnerAbort = (): void => this.abortLive(id, String(owner.signal.reason ?? 'action-stopped'))
    if (owner.signal.aborted) {
      queueMicrotask(onOwnerAbort)
    }
    else {
      owner.signal.addEventListener('abort', onOwnerAbort, { once: true })
      u.detach = () => owner.signal.removeEventListener('abort', onOwnerAbort)
    }

    // 拦截器出错按原样送出：发声必须能走到结算，否则 settled 永远悬着、I2 记不上账
    const send = async (e: Expression): Promise<void> => {
      let out = { expression: e, drop: false }
      try {
        out = await this.deps.bus.waterfall('expression/pre-emit', out, async payload => payload)
      }
      catch (err) {
        console.error('[io] interceptor failed, sending as-is: expression/pre-emit:', err)
        this.deps.log.append('expression.route-error', {
          uttId: id,
          type: e.type,
          error: err instanceof Error ? err.message : String(err),
        })
        out = { expression: e, drop: false }
      }
      if (!out.drop)
        this.deliver(out.expression)
    }

    const emit = async (part: Part): Promise<void> => {
      // end() 之后再 emit 不算数：否则等回执期间还能往 generated 里加字，I2 的账就对不上
      if (u.result || u.ended)
        return
      if (part.text)
        u.generated += part.text
      this.deps.log.append('utterance.part', { id, part })
      await send({ type: 'part', uttId: id, channel, part })
    }

    return {
      id,
      channel,
      signal: controller.signal,
      settled,
      emit,
      write: text => text ? emit({ kind: 'text', text }) : Promise.resolve(),
      end: async () => {
        if (!u.result && !u.ended) {
          u.ended = true
          await send({ type: 'end', uttId: id, channel })
          if (this.hasReporter(channel)) {
            // 有回执端：等呈现完成再结算，打断窗口保持开启
            this.maybeSettle(u)
            // 到点回执还没来：只认已回执的前缀（I2），和打断一个口径；没人看见的不算说过
            if (!u.result)
              u.timeout = setTimeout(() => this.settle(u, u.generated.slice(0, u.reported), 'settle-timeout'), this.settleTimeoutMs).unref()
          }
          else {
            // 无回执端：按全部送达记账，能力声明中已注明
            this.settle(u, u.generated, undefined)
          }
        }
        return settled
      },
    }
  }

  /** 只送给服务该频道的表现端 */
  private deliver(e: Expression): void {
    for (const s of this.surfaces) {
      if (s.channels && !s.channels.includes(e.channel))
        continue
      try {
        s.onExpression(e)
      }
      catch (err) {
        console.error(`[io] surface failed: ${s.name}:`, err)
      }
    }
  }

  private hasReporter(channel: string): boolean {
    return [...this.surfaces].some(s =>
      s.capabilities?.deliveredReport && (!s.channels || s.channels.includes(channel)))
  }

  private maybeSettle(u: Live): void {
    if (u.ended && !u.result && u.reported >= u.generated.length)
      this.settle(u, u.generated, undefined)
  }

  private abortLive(id: string, cause: string): void {
    const u = this.live.get(id)
    if (u)
      this.abortUtterance(u, cause)
  }

  /** 硬打断：停流、通知表现端停止呈现、以回执前缀结算（I2） */
  private abortUtterance(u: Live, cause: string): void {
    if (u.result)
      return
    u.controller.abort(cause)
    this.deliver({ type: 'stop', uttId: u.id, channel: u.channel })
    const delivered = this.hasReporter(u.channel) ? u.generated.slice(0, u.reported) : u.generated
    this.settle(u, delivered, cause)
  }

  private settle(u: Live, delivered: string, cause?: string): void {
    if (u.result)
      return
    clearTimeout(u.timeout)
    u.detach?.()
    u.result = {
      delivered,
      generated: u.generated,
      truncated: delivered.length < u.generated.length,
      cause,
    }
    this.live.delete(u.id)
    this.deps.log.append('utterance.settled', {
      id: u.id,
      channel: u.channel,
      delivered,
      truncated: u.result.truncated,
      cause,
    })
    u.resolve(u.result)
  }

  disposeAll(cause: string): void {
    for (const u of [...this.live.values()])
      this.abortUtterance(u, cause)
    for (const id of [...this.incoming_.keys()])
      this.settlePerception(id, { cancelled: true, reason: cause })
  }
}
