/**
 * 会话日志：append-only 事件序列，唯一真源。模型历史、UI、回放全部从此投影。
 *
 * 三条不变量：
 * - I1 模型可见 ⟺ 已记录，进模型请求的内容必须能从日志重建。
 * - I2 说出去的 ⟺ 记录实际送达部分，打断时记 delivered 前缀而非生成全文。
 * - I3 action.started 必有 action.ended，孤儿恢复为 interrupted。
 *
 * 每段日志以 log.opened 开头（启动一次、清空一次各算一段），记启动标识与版本号；
 * 第一条别的事件写入、或冷启动挂上存储时补写，所以它总落在这一段的最前面、存量之后。
 *
 * 动作 / 发声 / 感知 / 模型请求的 id 取「它的起始事件的序号」（appendNew），
 * 序号随存量续写、清空也不归零，于是 id 在同一份日志里永不重复。
 *
 * 落盘由存储插件经 attachPersistence 接入，内核只持内存镜像。
 */
import { randomUUID } from 'node:crypto'
import type { Disposer } from '../core/container.ts'
import { KERNEL_VERSION, LOG_SCHEMA } from '../version.ts'
import type { HistoryTurn, LogEvent } from './types.ts'
import { MAIN_CHANNEL } from './types.ts'

/** 每段日志的开头事件 */
export const LOG_OPENED = 'log.opened'

/** 持久化后端契约；append 需快速同步返回，异步后端自行缓冲 */
export interface LogStore {
  loadAll: () => LogEvent[]
  append: (e: LogEvent) => void
  clear?: () => void // 不实现则 reset 只清内存
}

export class SessionLog {
  private events_: LogEvent[] = []
  private store?: LogStore
  private seq = 0
  private readonly boot = randomUUID() // 本进程这次启动；多份日志合并时据此分段
  private opened?: 'boot' | 'reset' = 'boot' // 待补写的段首；写过即清

  constructor(private deps: {
    onOrphans?: (ids: string[]) => void // I3 恢复回调，供上层告知角色
    onAppend?: (e: LogEvent) => void // 每次 append 的观察钩子；重放不触发
    onReset?: () => void // reset 后的连带清理；调用方只需调 log.reset() 一处
  } = {}) {}

  /**
   * 挂载持久化后端。三种情形：
   * - 冷启动（内存为空）：整段重放存量，随后做 I3 孤儿恢复；
   * - 热重载（内存包含存量前缀）：只补写存量之后的新事件；
   * - 平行历史（存储晚挂载，内存已自起序号）：重编内存段接续存量并告警。
   */
  attachPersistence(store: LogStore): Disposer {
    const stored = store.loadAll()
    const maxStored = stored.length ? stored[stored.length - 1].seq : 0

    if (this.events_.length === 0) {
      this.events_ = stored
      this.seq = maxStored
      this.store = store
      this.writeOpened() // 段首落在存量之后、孤儿恢复之前
      this.recoverOrphans()
    }
    else if (!stored.length || this.containsStored(stored)) {
      for (const e of this.events_) {
        if (e.seq > maxStored)
          store.append(e)
      }
      this.store = store
    }
    else {
      console.warn('[log] 检测到平行历史，重编内存事件接续存量')
      let next = maxStored
      for (const e of this.events_) {
        e.seq = ++next
        store.append(e)
      }
      this.events_ = [...stored, ...this.events_]
      this.seq = next
      this.store = store
    }

    return () => {
      if (this.store === store)
        this.store = undefined
    }
  }

  /**
   * 内存是否以存量为前缀（热重载：同一进程里存储插件卸了又装）。
   * 只比序号不够：存储晚挂载时内存自起的序号可能恰好和存量一样长，要连时间与类型一起对上。
   */
  private containsStored(stored: LogEvent[]): boolean {
    const last = stored[stored.length - 1]
    const mine = this.events_[stored.length - 1]
    return !!mine && mine.seq === last.seq && mine.at === last.at && mine.type === last.type
  }

  /** I3：扫描无收尾的动作，补 interrupted 并回报 */
  private recoverOrphans(): void {
    const open = new Set<string>()
    for (const e of this.events_) {
      if (e.type === 'action.started')
        open.add(e.data.id)
      if (e.type === 'action.ended')
        open.delete(e.data.id)
    }
    if (!open.size)
      return
    for (const id of open)
      this.append('action.ended', { id, outcome: 'interrupted', cause: 'process-exit' })
    this.deps.onOrphans?.([...open])
  }

  append<T>(type: string, data: T): LogEvent<T> {
    this.writeOpened()
    return this.write(type, data)
  }

  /**
   * 写一条起始事件并给它发 id：`<前缀>#<这条事件的序号>`。
   * 前缀是动作名或 utt / in / req；保留「名字#数字」的形状，按 # 切名字的消费方不受影响。
   */
  appendNew<T>(prefix: string, type: string, make: (id: string) => T): LogEvent<T> {
    this.writeOpened()
    return this.write(type, make(`${prefix}#${this.seq + 1}`))
  }

  private writeOpened(): void {
    const cause = this.opened
    if (!cause)
      return
    this.opened = undefined
    this.write(LOG_OPENED, { boot: this.boot, kernel: KERNEL_VERSION, schema: LOG_SCHEMA, cause })
  }

  private write<T>(type: string, data: T): LogEvent<T> {
    const e: LogEvent<T> = { seq: ++this.seq, at: Date.now(), type, data }
    this.events_.push(e)
    try {
      this.store?.append(e)
    }
    catch (err) {
      // 落盘失败不打断角色，但要看得见
      console.error('[log] 持久化失败:', err)
    }
    try {
      this.deps.onAppend?.(e)
    }
    catch (err) {
      // 观察者出错不能污染真源写入
      console.error('[log] onAppend 观察者出错:', err)
    }
    return e
  }

  get events(): readonly LogEvent[] {
    return this.events_
  }

  /**
   * 真源归零，含持久层。append-only 是会话内纪律，清除属显式生命周期操作。
   * 序号不归零：清空时可能还有动作 / 发声在跑，它们的 id 取自旧序号，归零会让新 id 撞上它们。
   */
  reset(): void {
    this.events_ = []
    this.opened = 'reset'
    try {
      this.store?.clear?.()
    }
    catch (err) {
      console.error('[log] 持久层清空失败:', err)
    }
    try {
      this.deps.onReset?.()
    }
    catch (err) {
      console.error('[log] reset 连带清理出错:', err)
    }
  }

  /**
   * 对话历史投影，只认结构不认 kind 语义：
   * - 感知有 text 且有 sender ⇒ other 侧；percept 与定稿的 perception 同等对待，
   *   被 cancel 的不计入；
   * - utterance.settled 的 delivered ⇒ self 侧（I2 的消费端）。
   * 省略 channel 则返回全部频道。需要更丰富投影的插件自行读 events。
   */
  history(opts: { channel?: string, limit?: number } = {}): HistoryTurn[] {
    const { channel, limit = 20 } = opts
    const turns: HistoryTurn[] = []
    for (const e of this.events_) {
      const settledPerception = e.type === 'perception.settled' && !e.data.cancelled
      if ((e.type === 'percept.received' || settledPerception) && e.data.text && e.data.sender) {
        turns.push({
          role: 'other',
          text: e.data.text,
          at: e.at,
          channel: e.data.channel ?? MAIN_CHANNEL,
          kind: e.data.kind,
          sender: e.data.sender,
        })
      }
      else if (e.type === 'utterance.settled' && e.data.delivered) {
        turns.push({
          role: 'self',
          text: e.data.delivered,
          at: e.at,
          channel: e.data.channel ?? MAIN_CHANNEL,
          kind: 'utterance',
        })
      }
    }
    const filtered = channel ? turns.filter(t => t.channel === channel) : turns
    return filtered.slice(-limit)
  }
}
