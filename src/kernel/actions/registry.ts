/**
 * 动作层：decider 只编排，实际发声与做事都在动作实例里。
 * 类型由插件注册，实例可多开并发；实例带频道，发声默认回该频道。
 * 完成、失败、被停都回灌为唤醒原因，交给 decider 处理。
 */
import type { Disposer } from '../core/container.ts'
import { KernelError } from '../core/error.ts'
import { Registry } from '../core/registry.ts'
import type { UtterOptions, Utterance } from '../io/port.ts'
import { AsyncQueue } from '../llm/stream.ts'
import type { SessionLog } from '../session/log.ts'

/** done 正常结束；stopped 被 decider 或卸载叫停；error 出错；interrupted 进程退出时还没结束（I3 孤儿恢复补记） */
export type Outcome = 'done' | 'stopped' | 'error' | 'interrupted'

export interface CatalogEntry {
  name: string
  description: string
  paramsHint?: string
  running: number
}

export interface RunningView {
  id: string
  note: string
  runningMs: number
  channel?: string
}

export interface ActionRun {
  id: string
  params: Record<string, unknown>
  channel?: string // 触发本实例的意图所在频道，发声默认去向
  signal: AbortSignal // 停止或关闭时触发
  inbox: AsyncQueue<string> // decider send 来的消息
  note: (text: string) => void // 更新给 decider 看的一句话现状
  utter: (opts?: UtterOptions) => Utterance // 开一条发声流，含送达回执
  remember: (text: string, opts?: { beats?: number, minMs?: number, data?: Record<string, unknown> }) => void
}

export interface ActionType {
  name: string
  description: string // 给 decider 看：这个动作是什么、何时用
  paramsHint?: string // 参数说明，自然语言即可
  reloadPolicy?: 'drain' | 'abort' // 卸载时运行中实例的处置，默认 drain
  run: (a: ActionRun) => Promise<void>
}

interface Instance {
  id: string
  type: ActionType
  channel?: string
  note: string
  startedAt: number
  controller: AbortController
  inbox: AsyncQueue<string>
  task: Promise<void>
}

export class ActionRegistry {
  /** 插件贡献的动作类型 */
  readonly types = new Registry<ActionType>('action', t => t.name)
  private running = new Map<string, Instance>()

  constructor(private deps: {
    log: SessionLog
    wake: (source: string, text: string, data: Record<string, unknown>) => void
    utter: (owner: { actionId: string, signal: AbortSignal, channel?: string }, opts?: UtterOptions) => Utterance
    remember: (text: string, opts: { source: string, beats?: number, minMs?: number, data?: Record<string, unknown> }) => void
  }) {}

  register(type: ActionType): Disposer {
    const off = this.types.add(type)
    return () => {
      off()
      // drain 时运行中实例持有自身闭包可跑完；abort 立即停止
      if (type.reloadPolicy === 'abort') {
        for (const ins of [...this.running.values()]) {
          if (ins.type.name === type.name)
            ins.controller.abort('plugin-unload')
        }
      }
    }
  }

  /** 供 decider 选择的动作目录 */
  catalog(): CatalogEntry[] {
    return this.types.list().map(t => ({
      name: t.name,
      description: t.description,
      paramsHint: t.paramsHint,
      running: [...this.running.values()].filter(i => i.type.name === t.name).length,
    }))
  }

  /** 运行中实例快照 */
  snapshot(): RunningView[] {
    return [...this.running.values()].map(i => ({
      id: i.id,
      note: i.note,
      runningMs: Date.now() - i.startedAt,
      channel: i.channel,
    }))
  }

  start(name: string, params: Record<string, unknown> = {}, channel?: string): string {
    const type = this.types.get(name)
    if (!type)
      throw new KernelError('unknown-action', `unknown action: ${name}`)
    const { data: { id } } = this.deps.log.appendNew(name, 'action.started', id => ({ id, type: name, params, channel }))
    const controller = new AbortController()
    const inbox = new AsyncQueue<string>()
    const ins: Instance = {
      id,
      type,
      channel,
      note: '', // 动作自己 note 之前没有现状可说；怎么显示「刚起」归 decider
      startedAt: Date.now(),
      controller,
      inbox,
      task: Promise.resolve(),
    }

    const run: ActionRun = {
      id,
      params,
      channel,
      signal: controller.signal,
      inbox,
      note: (t) => { ins.note = t },
      utter: opts => this.deps.utter({ actionId: id, signal: controller.signal, channel }, opts),
      remember: (text, opts) => this.deps.remember(text, { source: id, ...opts }),
    }
    this.running.set(id, ins)
    // run 同步抛错（还没返回 Promise 就炸了）也要走到结算，否则实例永远挂在「正在运行」里、I3 永不收尾
    let task: Promise<void>
    try {
      task = type.run(run)
    }
    catch (e) {
      task = Promise.reject(e)
    }
    ins.task = task.then(
      () => this.settle(ins, controller.signal.aborted ? 'stopped' : 'done'),
      (e) => {
        if (controller.signal.aborted)
          return this.settle(ins, 'stopped')
        console.error(`[actions] run failed: ${id}:`, e)
        this.settle(ins, 'error', e instanceof Error ? e.message : String(e))
      },
    )
    return id
  }

  private settle(ins: Instance, outcome: Outcome, error?: string): void {
    if (!this.running.delete(ins.id))
      return
    ins.inbox.close()
    this.deps.log.append('action.ended', { id: ins.id, outcome, error })
    this.deps.wake(`action:${ins.type.name}`, `${ins.id} ${outcome}`, {
      code: 'action-ended',
      id: ins.id,
      action: ins.type.name,
      outcome,
      ...(error === undefined ? {} : { error }),
    })
  }

  /** target 为实例 id 或动作名；动作名取最新实例 */
  private resolveId(target: string): string | undefined {
    if (this.running.has(target))
      return target
    const list = [...this.running.values()].filter(i => i.type.name === target)
    return list.sort((a, b) => b.startedAt - a.startedAt)[0]?.id
  }

  send(target: string, message: string): boolean {
    const id = this.resolveId(target)
    if (!id)
      return false
    this.running.get(id)!.inbox.push(message)
    return true
  }

  stop(target: string, reason: string): boolean {
    const id = this.resolveId(target)
    if (!id)
      return false
    this.running.get(id)!.controller.abort(reason)
    return true
  }

  async stopAll(reason: string): Promise<void> {
    const tasks = [...this.running.values()].map(i => i.task)
    for (const ins of [...this.running.values()])
      ins.controller.abort(reason)
    await Promise.allSettled(tasks)
  }

}
