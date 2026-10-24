/**
 * 插件装配器：扫描插件目录、自动装配、热重载与启停。
 * 装载内容与顺序由清单和配置库决定，入口不写死。
 *
 * 启动分两段：引导段（order < 0）只拿清单 defaults 当配置；
 * 常规段在配置库就绪后读启用覆盖、下发插件配置。
 * 热重载 = 带序号的动态 import 绕过 ESM 缓存（序号经 resolve 钩子传到插件目录内的子模块，见 fresh.ts）
 * + 容器卸载重装。卸掉一个服务提供者时，注入了它的服务的插件一并卸下、再挂回等待队列：服务回来即自动装上，
 * 期间 list() 看得见它们在等什么（否则它们手里是旧服务，如关掉的 db 句柄）。
 * 重载、启停、重扫串行执行：第二个进来时第一个还卡在 apply 里，会报「已加载」的假失败。
 *
 * 失败隔离：单个插件加载失败只跳过它、大声报错并记下原因（list() 的 error），不拖垮启动；
 * 它的目录照样被监视，改好文件即重试。scan() 在运行中重扫目录，新出现的插件不重启就能装上。
 * 插件「有毛病」只有一个口径（problem()）：加载 / 重载失败的原因，或装上了但 inject 的服务还没有；
 * list()、scan()、抛给调用方的错都是这一句。没有悄悄退化：重扫清单失败就报错，不沿用旧清单。
 */
import type { FSWatcher } from 'node:fs'
import { watch } from 'node:fs'
import type { Disposer, LogEvent, Mumu, Plugin } from '../kernel/index.ts'
import { installFreshHooks, versionedEntry } from './fresh.ts'
import type { PluginManifest } from './manifest.ts'
import { scanPlugins } from './manifest.ts'
import { mergePatch } from './merge.ts'
import { DirFingerprint } from './watch.ts'

/** scan() 的结果：新发现的、这次装上的、装不上的（带原因） */
export interface ScanResult {
  added: string[]
  loaded: string[]
  failed: { id: string, error: string }[]
}

/** 配置库契约，由存储插件 provide 为 'config' 服务 */
export interface ConfigService {
  get: <T = unknown>(path: string, def?: T) => T | undefined
  set: (path: string, value: unknown) => void
  /** 变更通知；回调收到被写入的完整点路径，如 plugins.persona.prompt */
  onChange: (fn: (path: string) => void) => Disposer
}

interface LoadedPlugin {
  manifest: PluginManifest
  plugin: Plugin
}

export class PluginLoader {
  private manifests = new Map<string, PluginManifest>()
  private loaded = new Map<string, LoadedPlugin>()
  private watchers = new Map<string, FSWatcher>()
  private configWatch?: Disposer
  private watchedConfig?: ConfigService // 订阅挂在哪个配置服务实例上；存储插件重载后会换实例
  private importSeq = 0
  private failures = new Map<string, string>() // 加载失败的插件 → 原因
  private failWatch?: Disposer
  private ops = Promise.resolve() // 重载 / 启停 / 重扫的串行队列

  constructor(
    private mumu: Mumu,
    private opts: { dir?: string, watch?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    this.mumu.container.registerService('loader', this)
    // 等依赖的插件被别的 load 顺手激活时 apply 抛错，错归它自己：按日志里的 plugin.failed 把它标成失败
    this.failWatch = this.mumu.bus.on<LogEvent>('log.appended', (e) => {
      if (e.type === 'plugin.failed')
        this.onPluginFailed(e.data.name, e.data.error)
    })
    for (const m of await scanPlugins(this.opts.dir ?? 'plugins'))
      this.manifests.set(m.id, m)

    // 引导段：配置库尚不存在，插件只拿自己的清单 defaults
    for (const m of this.manifests.values()) {
      if (m.order < 0 && m.enabled)
        await this.tryLoad(m.id)
    }

    // 常规段：启用状态与插件配置均来自配置库
    this.watchConfig()
    for (const m of this.manifests.values()) {
      if (m.order >= 0 && this.effectiveEnabled(m))
        await this.tryLoad(m.id)
    }

    if (this.opts.watch !== false)
      this.watchAll()
  }

  /**
   * 运行中重扫插件目录：新出现的插件按 order 装上，之前装失败的（清单可能已修好）再试一次。
   * 已登记的插件不动；目录被删的插件不自动卸载（要卸用 setEnabled）。id 冲突照旧大声失败、一个都不装。
   */
  scan(): Promise<ScanResult> {
    return this.serial(() => this.scanNow())
  }

  private async scanNow(): Promise<ScanResult> {
    const found = await scanPlugins(this.opts.dir ?? 'plugins')
    const added: string[] = []
    for (const m of found) {
      if (!this.manifests.has(m.id))
        added.push(m.id)
      if (!this.manifests.has(m.id) || this.failures.has(m.id))
        this.manifests.set(m.id, m)
    }
    const result: ScanResult = { added, loaded: [], failed: [] }
    for (const m of found) {
      const retry = added.includes(m.id) || this.failures.has(m.id)
      if (!retry || this.loaded.has(m.id) || !this.effectiveEnabled(m))
        continue
      const error = await this.tryLoad(m.id)
      if (error)
        result.failed.push({ id: m.id, error })
      else
        result.loaded.push(m.id)
    }
    return result
  }

  /** 加载并隔离失败：返回毛病（成功为 undefined）。失败的也监视目录，改好即重试 */
  private async tryLoad(id: string): Promise<string | undefined> {
    try {
      await this.load(id)
      return this.problem(id)
    }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[loader] load failed, skipped: ${id}:`, error)
      return error
    }
  }

  /**
   * 这个插件现在的毛病：加载 / 重载失败的原因，或装上了但 inject 的服务还没有。
   * list() 与 scan() 都从这一处取，两边说的是同一句。
   */
  private problem(id: string): string | undefined {
    const failed = this.failures.get(id)
    if (failed)
      return failed
    const rec = this.loaded.get(id)
    const waiting = rec && this.mumu.container.unresolved().find(u => u.name === rec.plugin.name)
    return waiting ? `waiting for services: ${waiting.missing.join(', ')}` : undefined
  }

  private onPluginFailed(name: string, error: string): void {
    const rec = [...this.loaded.values()].find(r => r.plugin.name === name)
    if (!rec)
      return // 自己 load() 的那个由 load 的 catch 处理
    this.loaded.delete(rec.manifest.id)
    this.failures.set(rec.manifest.id, error) // 目录仍在监视，改好即重试
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops.then(fn, fn)
    this.ops = run.then(() => {}, () => {})
    return run
  }

  private config(): ConfigService | undefined {
    return this.mumu.container.has('config')
      ? this.mumu.container.get<ConfigService>('config')
      : undefined
  }

  /** 配置库覆盖优先于清单声明 */
  private effectiveEnabled(m: PluginManifest): boolean {
    return this.config()?.get<boolean>(`plugins.${m.id}.enabled`) ?? m.enabled
  }

  /** 配置库 plugins.<id> 作为 merge patch 打在清单 defaults 上（规则见 merge.ts） */
  private pluginConfig(m: PluginManifest): Record<string, unknown> {
    const fromDb = this.config()?.get<Record<string, unknown>>(`plugins.${m.id}`) ?? {}
    return mergePatch(m.defaults ?? {}, fromDb) as Record<string, unknown>
  }

  /**
   * 配置库变更后重载受影响的插件，使 /config set 立即生效。
   * 对所有插件一视同仁，不为个别插件开特例。
   * 跳过 .enabled，该路径由 setEnabled 处理，重复处理会冲突。
   */
  private watchConfig(): void {
    this.configWatch?.()
    const config = this.config()
    this.watchedConfig = config
    this.configWatch = config?.onChange((path) => {
      // plugins.<id>.<键>：改了一个键；plugins.<id>：整份覆盖（还原配置时常这么写），一样要重载
      const m = /^plugins\.([^.]+)(?:\.(.+))?$/.exec(path)
      if (!m || m[2] === 'enabled' || !this.loaded.has(m[1]))
        return
      this.reload(m[1]).then(
        () => console.log(`[loader] reloaded after config change: ${m[1]}`),
        e => console.error(`[loader] reload failed: ${m[1]}:`, e instanceof Error ? e.message : e),
      )
    })
  }

  private async importPlugin(m: PluginManifest): Promise<Plugin> {
    // 序号查询串绕过 ESM 缓存；钩子把它传给插件目录内的子模块，改深层文件也能重载
    installFreshHooks()
    const mod = await import(versionedEntry(m.entry, ++this.importSeq))
    const plugin = mod.default as Plugin | undefined
    if (!plugin || typeof plugin.apply !== 'function' || !plugin.name)
      throw new Error(`entry does not default-export a Plugin: ${m.entry}`)
    return plugin
  }

  async load(id: string): Promise<void> {
    const m = this.manifests.get(id)
    if (!m)
      throw new Error(`unknown plugin: ${id}`)
    if (this.loaded.has(id))
      return
    let plugin: Plugin
    try {
      plugin = await this.importPlugin(m)
      await this.mumu.container.load(plugin, this.pluginConfig(m))
    }
    catch (e) {
      // 记下原因再抛：热重载 / scan 失败时 list() 与调用方都看得到为什么；
      // 照样监视目录——改到一半的文件存盘失败了，改完那一下要能自动重试
      this.failures.set(id, e instanceof Error ? e.message : String(e))
      if (this.opts.watch !== false)
        this.watchOne(m)
      throw e
    }
    this.loaded.set(id, { manifest: m, plugin })
    this.failures.delete(id)
    if (this.opts.watch !== false)
      this.watchOne(m)
    // 存储插件被重载后配置服务换了新实例：订阅要跟过去，否则之后的 /config set 都不再触发重载（实测踩过）。
    // 配置服务缺席期间装过插件、它再回来，也一样要跟上
    if (this.config() !== this.watchedConfig)
      this.watchConfig()
  }

  /** 卸载；它提供的服务随之消失，inject 了这些服务的插件一并卸下再挂回等待队列，服务回来即自动装上 */
  async unload(id: string): Promise<void> {
    const rec = this.loaded.get(id)
    if (!rec)
      return
    this.loaded.delete(id)
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    await this.mumu.container.unload(rec.plugin.name)
    const orphans = this.orphans()
    for (const d of orphans)
      await this.unload(d)
    for (const d of orphans)
      await this.tryLoad(d)
  }

  /** 重新 import 并按当前配置库重新解析配置；依赖它的插件随 unload 挂回等待队列、随它装好自动装回 */
  reload(id: string): Promise<void> {
    return this.serial(() => this.reloadNow(id))
  }

  private async reloadNow(id: string): Promise<void> {
    if (!this.manifests.has(id))
      throw new Error(`unknown plugin: ${id}`)
    // 清单也重读：改了 package.json 的 defaults / main 不必重启。
    // 重扫失败（id 冲突、清单坏了、目录没了）不悄悄沿用旧清单：记下原因、这次不重载，
    // 插件照旧跑旧代码，list() 看得见为什么；目录还在监视，改好那一下再试
    let fresh: PluginManifest | undefined
    try {
      fresh = (await scanPlugins(this.opts.dir ?? 'plugins')).find(m => m.id === id)
    }
    catch (e) {
      throw this.fail(id, `rescan failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!fresh)
      throw this.fail(id, `plugin not found on rescan: ${id}`)
    this.manifests.set(id, fresh)
    const wasLoaded = this.loaded.has(id)
    await this.unload(id)
    if (wasLoaded || this.effectiveEnabled(fresh))
      await this.load(id)
  }

  /** 记下毛病并造出要抛的错：list() 与抛给调用方的是同一句 */
  private fail(id: string, error: string): Error {
    this.failures.set(id, error)
    return new Error(error)
  }

  /** 已装上、但 inject 的服务现在不在容器里的插件（还在等待队列里的不算，它们本来就在等） */
  private orphans(): string[] {
    const waiting = new Set(this.mumu.container.unresolved().map(u => u.name))
    return [...this.loaded.values()]
      .filter(r => !waiting.has(r.plugin.name) && (r.plugin.inject ?? []).some(k => !this.mumu.container.has(k)))
      .map(r => r.manifest.id)
  }

  /** 启停持久化到配置库并立即生效 */
  setEnabled(id: string, on: boolean): Promise<void> {
    return this.serial(() => this.setEnabledNow(id, on))
  }

  private async setEnabledNow(id: string, on: boolean): Promise<void> {
    const m = this.manifests.get(id)
    if (!m)
      throw new Error(`unknown plugin: ${id}`)
    this.config()?.set(`plugins.${id}.enabled`, on)
    if (on && !this.loaded.has(id))
      await this.load(id)
    else if (!on && this.loaded.has(id))
      await this.unload(id)
  }

  list(): { id: string, group: string, loaded: boolean, enabled: boolean, order: number, description?: string, error?: string }[] {
    return [...this.manifests.values()].map(m => ({
      id: m.id,
      group: m.group,
      loaded: this.loaded.has(m.id),
      enabled: this.effectiveEnabled(m),
      order: m.order,
      description: m.description,
      error: this.problem(m.id),
    }))
  }

  private watchAll(): void {
    for (const { manifest } of this.loaded.values())
      this.watchOne(manifest)
  }

  /** 监视插件目录，文件真的变了（见 watch.ts）才防抖后热重载 */
  private watchOne(m: PluginManifest): void {
    if (this.watchers.has(m.id))
      return
    let timer: NodeJS.Timeout | undefined
    const prints = new DirFingerprint(m.dir)
    try {
      const w = watch(m.dir, { recursive: true }, (_ev, file) => {
        if (!prints.changed(file))
          return
        clearTimeout(timer)
        timer = setTimeout(() => {
          console.log(`[loader] files changed, reloading: ${m.id}`)
          this.reload(m.id).then(
            () => console.log(`[loader] reloaded: ${m.id}`),
            e => console.error(`[loader] reload failed: ${m.id}:`, e instanceof Error ? e.message : e),
          )
        }, 400)
      })
      this.watchers.set(m.id, w)
    }
    catch (e) {
      console.warn(`[loader] watch failed: ${m.id}:`, e instanceof Error ? e.message : e)
    }
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    this.configWatch?.()
    this.configWatch = undefined
    this.failWatch?.()
    this.failWatch = undefined
  }
}
