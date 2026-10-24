/**
 * 插件装配器：扫描插件目录、自动装配、热重载与启停。
 * 装载内容与顺序由清单和配置库决定，入口不写死。
 *
 * 启动分两段：引导段（order < 0）只拿清单 defaults 当配置；
 * 常规段在配置库就绪后读启用覆盖、下发插件配置。
 * 热重载 = 带序号的动态 import 绕过 ESM 缓存（序号经 resolve 钩子传到插件目录内的子模块，见 fresh.ts）
 * + 容器卸载重装。重载一个服务提供者时，注入了它的服务的插件一并重载（否则它们手里是旧服务）。
 *
 * 失败隔离：单个插件加载失败只跳过它、大声报错并记下原因（list() 的 error），不拖垮启动；
 * 它的目录照样被监视，改好文件即重试。scan() 在运行中重扫目录，新出现的插件不重启就能装上。
 */
import type { FSWatcher } from 'node:fs'
import { watch } from 'node:fs'
import type { Disposer, Mumu, Plugin } from '../kernel/index.ts'
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

  constructor(
    private mumu: Mumu,
    private opts: { dir?: string, watch?: boolean } = {},
  ) {}

  async start(): Promise<void> {
    this.mumu.container.registerService('loader', this)
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
  async scan(): Promise<ScanResult> {
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

  /** 加载并隔离失败：返回错误原因（成功为 undefined）。失败的也监视目录，改好即重试 */
  private async tryLoad(id: string): Promise<string | undefined> {
    try {
      await this.load(id)
      const m = this.loaded.get(id)
      const waiting = m && this.mumu.container.unresolved().find(u => u.name === m.plugin.name)
      if (waiting)
        return `依赖的服务不存在：${waiting.missing.join('、')}（装上提供它的插件后自动生效）`
      return undefined
    }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`✗ 插件 ${id} 加载失败，已跳过:`, error)
      return error
    }
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
        () => console.log(`✓ ${m[1]} 已按新配置重载`),
        e => console.error(`✗ ${m[1]} 重载失败:`, e instanceof Error ? e.message : e),
      )
    })
  }

  private async importPlugin(m: PluginManifest): Promise<Plugin> {
    // 序号查询串绕过 ESM 缓存；钩子把它传给插件目录内的子模块，改深层文件也能重载
    installFreshHooks()
    const mod = await import(versionedEntry(m.entry, ++this.importSeq))
    const plugin = mod.default as Plugin | undefined
    if (!plugin || typeof plugin.apply !== 'function' || !plugin.name)
      throw new Error(`插件 ${m.id} 的入口必须 default 导出 Plugin 对象`)
    return plugin
  }

  async load(id: string): Promise<void> {
    const m = this.manifests.get(id)
    if (!m)
      throw new Error(`未知插件: ${id}`)
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
    // 存储插件被重载后配置服务换了新实例：订阅要跟过去，否则之后的 /config set 都不再触发重载（实测踩过）
    if (this.watchedConfig && this.config() !== this.watchedConfig)
      this.watchConfig()
  }

  async unload(id: string): Promise<void> {
    const rec = this.loaded.get(id)
    if (!rec)
      return
    this.loaded.delete(id)
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    await this.mumu.container.unload(rec.plugin.name)
  }

  /**
   * 重新 import 并按当前配置库重新解析配置。
   * 它提供的服务随卸载消失：注入了这些服务的插件手里拿的是旧对象（如关掉的 db 句柄），
   * 所以按 inject 图把它们一并卸下，等它装好后再按原次序装回。
   */
  async reload(id: string): Promise<void> {
    const wasLoaded = this.loaded.has(id)
    await this.unload(id)
    // 清单也重读：改了 package.json 的 defaults / main 不必重启（重扫失败就沿用旧清单）
    const fresh = await scanPlugins(this.opts.dir ?? 'plugins').then(all => all.find(m => m.id === id), () => undefined)
    if (fresh)
      this.manifests.set(id, fresh)
    const dependents: string[] = []
    for (let orphans = this.orphans(); orphans.length; orphans = this.orphans()) {
      for (const d of orphans) {
        dependents.push(d)
        await this.unload(d)
      }
    }
    if (wasLoaded || this.effectiveEnabled(this.manifests.get(id)!))
      await this.load(id)
    for (const d of dependents) {
      const error = await this.tryLoad(d)
      if (!error)
        console.log(`  ↻ ${d} 依赖 ${id} 的服务，已随之重载`)
    }
  }

  /** 已加载、但 inject 的服务现在不在容器里的插件 */
  private orphans(): string[] {
    return [...this.loaded.values()]
      .filter(r => (r.plugin.inject ?? []).some(k => !this.mumu.container.has(k)))
      .map(r => r.manifest.id)
  }

  /** 启停持久化到配置库并立即生效 */
  async setEnabled(id: string, on: boolean): Promise<void> {
    const m = this.manifests.get(id)
    if (!m)
      throw new Error(`未知插件: ${id}`)
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
      error: this.failures.get(m.id),
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
          console.log(`↻ 插件 ${m.id} 文件变更，热重载…`)
          this.reload(m.id).then(
            () => console.log(`✓ ${m.id} 已重载`),
            e => console.error(`✗ ${m.id} 重载失败:`, e instanceof Error ? e.message : e),
          )
        }, 400)
      })
      this.watchers.set(m.id, w)
    }
    catch (e) {
      console.warn(`[loader] 无法监视 ${m.id}:`, e instanceof Error ? e.message : e)
    }
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    this.configWatch?.()
    this.configWatch = undefined
  }
}
