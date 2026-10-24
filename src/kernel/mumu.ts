/**
 * 内核装配。机制之间只经窄接口协作，本文件是唯一知道全貌的地方。
 */
import { ActionRegistry } from './actions/registry.ts'
import { Bus } from './core/bus.ts'
import { Container } from './core/container.ts'
import type { Plugin } from './core/container.ts'
import { KernelError } from './core/error.ts'
import { IO } from './io/port.ts'
import type { IOOptions } from './io/port.ts'
import { ModelGateway } from './llm/gateway.ts'
import { Mind } from './mind/scheduler.ts'
import type { BeatMaterial, Intent, MindOptions, WakeReason } from './mind/scheduler.ts'
import { PromptAssembly } from './prompt/assembly.ts'
import { SessionLog } from './session/log.ts'

export interface KernelOptions extends MindOptions, IOOptions {
  historyLimit?: number // 一拍携带的对话历史条数
}

export class Mumu {
  // 插件 apply 抛错进日志：装配层据此把它标成失败，UI 也看得见
  readonly container = new Container({
    onFailed: (name, error) => {
      this.log.append('plugin.failed', { name, error: error instanceof Error ? error.message : String(error) })
    },
  })

  readonly bus = new Bus()
  readonly log: SessionLog
  readonly model: ModelGateway
  readonly prompt = new PromptAssembly()
  readonly actions: ActionRegistry
  readonly mind: Mind
  readonly io: IO

  private constructor(private options: KernelOptions) {
    this.log = new SessionLog({
      onOrphans: (ids) => {
        this.prompt.addNote(
          `interrupted: ${ids.join(', ')}`,
          { source: 'kernel', beats: 2, data: { code: 'orphans-interrupted', ids } },
        )
      },
      // 真源观察口：UI 与遥测类插件监听 log.appended 做纯投影
      onAppend: e => this.bus.emit('log.appended', e),
      // 清空真源时工作记忆一起清，否则她还「记得」日志里已经没有的事
      onReset: () => this.prompt.clearNotes(),
    })
    // 逐 chunk 观察口：调试与遥测监听 model.stream，不落日志
    this.model = new ModelGateway(this.log, {
      onStream: e => this.bus.emit('model.stream', e),
    })

    this.io = new IO({
      bus: this.bus,
      log: this.log,
      wake: input => this.mind.wake(input),
      options,
    })

    this.actions = new ActionRegistry({
      log: this.log,
      wake: (source, text, data) => this.mind.wake({ source, text, data }),
      utter: (owner, opts) => this.io.utter(owner, opts),
      remember: (text, opts) => this.prompt.addNote(text, opts),
    })

    this.mind = new Mind({
      gather: reasons => this.gather(reasons),
      dispatch: (intent, note) => this.dispatch(intent, note),
      log: (type, data) => { this.log.append(type, data) },
      options,
    })

    const services = {
      bus: this.bus,
      log: this.log,
      model: this.model,
      prompt: this.prompt,
      actions: this.actions,
      mind: this.mind,
      io: this.io,
    }
    for (const [key, svc] of Object.entries(services))
      this.container.registerService(key, svc)
  }

  /** 多实例各自一棵树，彼此隔离 */
  static create(options: KernelOptions = {}): Mumu {
    return new Mumu(options)
  }

  use(plugin: Plugin, config?: unknown): Promise<void> {
    return this.container.load(plugin, config)
  }

  /** 装配完成检查；仍有插件缺依赖则失败 */
  assertReady(): void {
    const un = this.container.unresolved()
    if (un.length) {
      throw new Error(
        `unresolved dependencies: ${un.map(u => `${u.name} needs ${u.missing.join(', ')}`).join('; ')}`,
      )
    }
  }

  /** 汇聚一拍材料；内核只填已知部分，插件经 beat/gather 往 blocks 贡献 */
  private async gather(reasons: WakeReason[]): Promise<BeatMaterial> {
    const base: BeatMaterial = {
      reasons,
      catalog: this.actions.catalog(),
      running: this.actions.snapshot(),
      incoming: this.io.incoming(),
      history: this.log.history({ limit: this.options.historyLimit ?? 48 }),
      notes: this.prompt.notes(true),
      sections: await this.prompt.assemble('mind'),
      blocks: [],
    }
    const out = await this.bus.waterfall('beat/gather', base, async p => p)
    out.blocks.sort((a, b) => a.order - b.order || a.from.localeCompare(b.from))
    return out
  }

  /** 意图经 intent/pre-dispatch 后落到动作层 */
  private async dispatch(intent: Intent, note?: string): Promise<void> {
    await this.bus.waterfall(
      'intent/pre-dispatch',
      { intent, note, allow: true },
      async (p) => {
        if (!p.allow)
          return p
        const it = p.intent
        // send / stop 找不到目标（多半是动作刚结束）抛出，由调度器记 intent.dispatch-failed，不悄悄吞掉
        if (it.do === 'start')
          this.actions.start(it.action, it.params ?? {}, it.channel)
        else if (it.do === 'send' && !this.actions.send(it.to, it.message))
          throw new KernelError('no-target', `no running action: ${it.to}`)
        else if (it.do === 'stop' && !this.actions.stop(it.target, it.reason ?? 'decider-stop'))
          throw new KernelError('no-target', `no running action: ${it.target}`)
        return p
      },
    )
  }

  async dispose(): Promise<void> {
    this.mind.dispose()
    await this.actions.stopAll('shutdown')
    this.io.disposeAll('shutdown')
    await this.container.dispose()
  }
}
