/**
 * 通用设置与状态的接口：/api/plugins*、/api/secrets、/api/status。契约见 docs/web-protocol.md §3「设置与状态」。
 *
 * 立场：
 * - 一次做完、所有插件自动有：表单的数据来自清单 defaults + 配置库补丁，插件不用为配置写任何网页代码。
 * - 合并 / 求差只用装配层导出的 mergePatch / diffPatch：网页看到的就是插件实际拿到的，
 *   改回出厂值的项自动从库里消失。
 * - 写整棵 plugins.<id>（这条路径装配层不触发重载），再由本文件显式 reload 一次：
 *   一次提交改了多个字段也只重载一次，且能把重载失败的原因带回给页面。
 * - 重载 surface-web 自己会断开所有连接（包括这次请求），所以先回响应再重载。
 * - 整块在本文件内处理完，index.ts 只挂一个分支，少动 index.ts。
 */
import type { ConfigService, Ctx, PluginLoader, PluginManifest } from '../../../src/index.ts'
import { diffPatch, mergePatch, scanPlugins } from '../../../src/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import type { StatusCard } from './extend.ts'
import { isObject, mask, readUiManifest, unmask, withoutEnabled } from './settings.ts'

export interface AdminResult {
  status: number
  body?: unknown
  after?: () => void // 响应发出后再做的事（重载自己）
}

interface Deps {
  self: string // 本插件 id：重载自己要延后、不许在网页上停用自己
  clients: () => number
}

const PLUGIN_PATH = /^\/api\/plugins\/([^/]+)\/(config|enabled)$/

function optional<T>(ctx: Ctx, key: string): T | undefined {
  try {
    return ctx.use<T>(key)
  }
  catch {
    return undefined // 服务不存在是正常情况：对应功能降级
  }
}

const message = (e: unknown): string => e instanceof Error ? e.message : String(e)

export function adminApi(ctx: Ctx, deps: Deps) {
  const config = ctx.use<ConfigService>('config')
  const loader = (): PluginLoader | undefined => optional<PluginLoader>(ctx, 'loader')
  // 装配层扫的是工作目录下的 plugins/，这里用同一个根，清单与它看到的一致
  const manifests = (): Promise<PluginManifest[]> => scanPlugins('plugins')
  const manifest = async (id: string): Promise<PluginManifest | undefined> => (await manifests()).find(m => m.id === id)
  const listItem = (id: string) => loader()?.list().find(p => p.id === id)

  async function plugins(): Promise<AdminResult> {
    const byId = new Map((await manifests()).map(m => [m.id, m]))
    const list = loader()?.list() ?? []
    const out = await Promise.all(list.map(async (p) => {
      const m = byId.get(p.id)
      const { title } = m ? await readUiManifest(m.dir) : { title: undefined }
      return { ...p, title: title ?? p.id, hasConfig: isObject(m?.defaults) && Object.keys(m.defaults).length > 0 }
    }))
    return { status: 200, body: { plugins: out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)) } }
  }

  async function view(m: PluginManifest, masked = true) {
    const { ui } = await readUiManifest(m.dir)
    const defaults = m.defaults ?? {}
    const override = withoutEnabled(config.get(`plugins.${m.id}`))
    const merged = mergePatch(defaults, override)
    const show = (v: unknown): unknown => masked ? mask(v, ui) : v
    return { id: m.id, defaults: show(defaults), override: show(override), merged: show(merged), ui, real: merged }
  }

  async function readConfig(id: string): Promise<AdminResult> {
    const m = await manifest(id)
    if (!m)
      return { status: 404, body: { error: `没有插件 ${id}` } }
    const { real: _real, ...v } = await view(m)
    return { status: 200, body: v }
  }

  async function writeConfig(id: string, body: Record<string, unknown>): Promise<AdminResult> {
    const m = await manifest(id)
    if (!m)
      return { status: 404, body: { error: `没有插件 ${id}` } }
    if (!isObject(body.config))
      return { status: 400, body: { error: 'config 必须是对象（想要的完整配置）' } }
    const { real } = await view(m, false)
    const want = withoutEnabled(unmask(body.config, real))
    const patch = (diffPatch(m.defaults ?? {}, want) ?? {}) as Record<string, unknown>
    const enabled = (config.get<Record<string, unknown>>(`plugins.${id}`) ?? {}).enabled
    config.set(`plugins.${id}`, enabled === undefined ? patch : { ...patch, enabled })

    const reload = (): Promise<void> => loader()?.reload(id) ?? Promise.resolve()
    const { real: _r, ...v } = await view(m)
    if (id === deps.self)
      return { status: 200, body: v, after: () => setTimeout(() => void reload().catch(() => {}), 200) } // 失败原因进 list().error，下次刷新看得到
    let error: string | undefined
    if (listItem(id)?.loaded) {
      try {
        await reload()
      }
      catch (e) {
        error = message(e)
      }
    }
    return { status: 200, body: { ...v, error: error ?? listItem(id)?.error } }
  }

  async function setEnabled(id: string, body: Record<string, unknown>): Promise<AdminResult> {
    const l = loader()
    if (!l || !listItem(id))
      return { status: 404, body: { error: `没有插件 ${id}` } }
    if (typeof body.enabled !== 'boolean')
      return { status: 400, body: { error: 'enabled 必须是 true / false' } }
    if (id === deps.self && !body.enabled)
      return { status: 400, body: { error: '停掉 surface-web 网页就没了；要停请在终端 /plugin disable surface-web' } }
    try {
      await l.setEnabled(id, body.enabled)
    }
    catch (e) {
      return { status: 200, body: { ...listItem(id), error: message(e) } }
    }
    return { status: 200, body: listItem(id) }
  }

  function secrets(method: string, body: Record<string, unknown>): AdminResult {
    const s = optional<SecretsService>(ctx, 'secrets')
    if (!s)
      return { status: 404, body: { error: '没装 secrets 插件' } }
    if (method === 'GET')
      return { status: 200, body: { secrets: s.list() } }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!/^[\w.-]{1,64}$/.test(name))
      return { status: 400, body: { error: '名字只许字母、数字、_ . -，最长 64' } }
    if (typeof body.value !== 'string')
      return { status: 400, body: { error: 'value 必须是字符串（空串 = 删除）' } }
    if (body.value === '')
      s.del(name)
    else s.set(name, body.value)
    return { status: 204 }
  }

  async function status(): Promise<AdminResult> {
    const cards: StatusCard[] = []
    const n = deps.clients()
    cards.push({ id: 'web', title: '网页', level: n ? 'ok' : 'info', text: n ? `${n} 个页面连着` : '没有页面连着' })

    const list = loader()?.list() ?? []
    const failed = list.filter(p => p.error)
    const off = list.filter(p => !p.enabled)
    cards.push({
      id: 'plugins',
      title: '插件',
      level: failed.length ? 'err' : 'ok',
      text: failed.length ? `${failed.length} 个加载失败` : `${list.filter(p => p.loaded).length} 个在跑${off.length ? `，${off.length} 个停用` : ''}`,
      items: failed.map(p => `${p.id}：${p.error}`),
    })

    const running = ctx.actions.snapshot()
    cards.push({
      id: 'actions',
      title: '动作',
      level: running.length ? 'ok' : 'info',
      text: running.length ? `${running.length} 个在跑` : '空闲',
      items: running.map(r => `${r.id}${r.note ? ` · ${r.note}` : ''}${r.channel ? ` · ${r.channel}` : ''} · ${Math.round(r.runningMs / 1000)} 秒`),
    })

    // 模型路由不在这里出：provider-openai 自己经 web/status 报（含探活与退路），它最清楚；这里只出与具体插件无关的卡
    const out = await ctx.bus.waterfall<{ cards: StatusCard[] }, { cards: StatusCard[] }>('web/status', { cards }, async s => s)
    return { status: 200, body: out }
  }

  /** 认领就返回结果，不是这里的路径返回 undefined */
  return async (method: string, path: string, readBody: () => Promise<Record<string, unknown>>): Promise<AdminResult | undefined> => {
    if (path === '/api/plugins' && method === 'GET')
      return plugins()
    if (path === '/api/status' && method === 'GET')
      return status()
    if (path === '/api/secrets' && (method === 'GET' || method === 'POST'))
      return secrets(method, method === 'POST' ? await readBody() : {})
    const m = PLUGIN_PATH.exec(path)
    if (!m)
      return undefined
    const id = decodeURIComponent(m[1])
    if (m[2] === 'config' && method === 'GET')
      return readConfig(id)
    if (m[2] === 'config' && method === 'PUT')
      return writeConfig(id, await readBody())
    if (m[2] === 'enabled' && method === 'POST')
      return setEnabled(id, await readBody())
    return { status: 405, body: { error: `${path} 不支持 ${method}` } }
  }
}
