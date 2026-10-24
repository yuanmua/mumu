/**
 * 插件容器：服务注册表 + 依赖解析 + 可撤销副作用。
 * 服务占 ctx.<key>，插件按 key 查找；inject 依赖全部就绪才 apply；
 * 注册一律返回 disposer，卸载时逆序回滚。
 */
import type { ActionRegistry } from '../actions/registry.ts'
import type { IO } from '../io/port.ts'
import type { ModelGateway } from '../llm/gateway.ts'
import type { Mind } from '../mind/scheduler.ts'
import type { PromptAssembly } from '../prompt/assembly.ts'
import type { SessionLog } from '../session/log.ts'
import type { Bus } from './bus.ts'

export type Disposer = () => void

// C 缺省 any：现有插件按自己的形状直接读 config；插件重做时改成 unknown 收紧（handbook §9.3）
export interface Plugin<C = any> {
  name: string
  inject?: string[] // 依赖的服务 key，全部就绪后才 apply
  apply: (ctx: Ctx, config: C) => void | Promise<void>
}

interface Loaded {
  plugin: Plugin
  config: unknown
  disposers: Disposer[]
}

export class Container {
  private services = new Map<string, unknown>()
  private loaded = new Map<string, Loaded>()
  private pending: { plugin: Plugin, config: unknown }[] = []

  constructor(private deps: {
    onFailed?: (name: string, error: unknown) => void // 任一插件 apply 抛错都报，含被别的 load 顺手激活的等待者
  } = {}) {}

  registerService(key: string, service: unknown): Disposer {
    if (this.services.has(key))
      throw new Error(`service already registered: ${key}`)
    this.services.set(key, service)
    return () => { this.services.delete(key) }
  }

  get<T>(key: string): T {
    const s = this.services.get(key)
    if (s === undefined)
      throw new Error(`service not found: ${key}`)
    return s as T
  }

  has(key: string): boolean {
    return this.services.has(key)
  }

  async load(plugin: Plugin, config?: unknown): Promise<void> {
    if (this.loaded.has(plugin.name) || this.pending.some(p => p.plugin.name === plugin.name))
      throw new Error(`plugin already registered: ${plugin.name}`)
    this.pending.push({ plugin, config })
    // 只为自己的失败抛错：顺手激活的等待者出错归它自己（onFailed），不能记在触发 flush 的这个头上
    const own = (await this.flush()).find(f => f.name === plugin.name)
    if (own)
      throw own.error
  }

  /** 反复激活依赖已就绪的插件，直到没有进展；provide 新服务会解锁等待者。返回这一轮里 apply 抛错的 */
  private async flush(): Promise<{ name: string, error: unknown }[]> {
    const failed: { name: string, error: unknown }[] = []
    let progressed = true
    while (progressed) {
      progressed = false
      for (const p of [...this.pending]) {
        // 并发的 load 各跑一个 flush：快照里的 p 可能已被另一个 flush 取走（或已被卸载）。
        // 不查就 splice(-1, 1) 会删掉队尾别的插件，还把 p 装两次
        const at = this.pending.indexOf(p)
        if (at < 0)
          continue
        const missing = (p.plugin.inject ?? []).filter(k => !this.services.has(k))
        if (missing.length)
          continue
        this.pending.splice(at, 1)
        const rec: Loaded = { plugin: p.plugin, config: p.config, disposers: [] }
        this.loaded.set(p.plugin.name, rec)
        try {
          await p.plugin.apply(new Ctx(this, rec), p.config)
        }
        catch (e) {
          await this.unload(p.plugin.name) // 失败的插件不留半成品；别的等待者照常激活
          failed.push({ name: p.plugin.name, error: e })
          this.deps.onFailed?.(p.plugin.name, e)
          continue
        }
        progressed = true
      }
    }
    return failed
  }

  /** 依赖未满足的插件；装配完成后应为空 */
  unresolved(): { name: string, missing: string[] }[] {
    return this.pending.map(p => ({
      name: p.plugin.name,
      missing: (p.plugin.inject ?? []).filter(k => !this.services.has(k)),
    }))
  }

  async unload(name: string): Promise<void> {
    // 还在等依赖的也算「装了」：卸载要把它从等待队列里撤掉，否则依赖一到它又自己装上
    this.pending = this.pending.filter(p => p.plugin.name !== name)
    const rec = this.loaded.get(name)
    if (!rec)
      return
    this.loaded.delete(name)
    for (const d of rec.disposers.reverse()) {
      try {
        d()
      }
      catch (e) {
        console.error(`[container] disposer failed: ${name}:`, e)
      }
    }
  }

  async dispose(): Promise<void> {
    for (const name of [...this.loaded.keys()].reverse())
      await this.unload(name)
  }
}

/** 插件 apply 收到的上下文：服务查找 + 可撤销注册 */
export class Ctx {
  constructor(
    private container: Container,
    private rec: { plugin: Plugin, disposers: Disposer[] },
  ) {}

  get name(): string {
    return this.rec.plugin.name
  }

  use<T>(key: string): T {
    return this.container.get<T>(key)
  }

  /** 注册副作用；disposer 在插件卸载时逆序执行 */
  effect(register: () => Disposer): void {
    this.rec.disposers.push(register())
  }

  provide(key: string, service: unknown): void {
    this.effect(() => this.container.registerService(key, service))
  }

  // 内核机制的快捷访问，等价 use('<key>')；插件服务用 use
  get bus(): Bus { return this.use('bus') }
  get log(): SessionLog { return this.use('log') }
  get model(): ModelGateway { return this.use('model') }
  get mind(): Mind { return this.use('mind') }
  get actions(): ActionRegistry { return this.use('actions') }
  get prompt(): PromptAssembly { return this.use('prompt') }
  get io(): IO { return this.use('io') }

  on<T = unknown>(event: string, fn: (payload: T) => void): void {
    this.effect(() => this.bus.on(event, fn))
  }

  intercept<T, R = T>(name: string, mw: (payload: T, next: () => Promise<R>) => Promise<R>): void {
    this.effect(() => this.bus.intercept(name, mw))
  }
}
