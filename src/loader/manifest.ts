/**
 * 插件清单：一个插件一个目录，元信息在 package.json 的 mumu 字段。
 * plugins/ 下可任意分层归类，层数不限。
 * 目录只是组织，id 由 package.json 决定且与路径无关，插件移动不影响配置与命令。
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

export interface PluginManifest {
  id: string // mumu.id > 包名去 scope > 目录名；与路径无关
  dir: string
  entry: string
  group: string // 相对 plugins/ 的归类路径，顶层为空串，仅用于展示
  enabled: boolean
  order: number // 越小越早；负数为引导期，在配置库可用前加载
  description?: string
  defaults?: Record<string, unknown> // 配置库 plugins.<id> 覆盖它
}

/** 目录深度上限，兜住软链环 */
const MAX_DEPTH = 8

/**
 * 递归扫描。有 package.json 的目录即插件，且不再往下找。
 * 无效目录跳过并告警。
 */
export async function scanPlugins(pluginsDir: string): Promise<PluginManifest[]> {
  const root = resolve(pluginsDir)
  const found: PluginManifest[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      console.warn(`[loader] 目录过深，停止扫描: ${relative(root, dir)}`)
      return
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === 'node_modules')
        continue
      const sub = join(dir, ent.name)
      const pkgText = await readFile(join(sub, 'package.json'), 'utf8').catch(() => undefined)
      if (pkgText === undefined) {
        await walk(sub, depth + 1) // 归类目录，继续下钻
        continue
      }
      try {
        const pkg = JSON.parse(pkgText)
        const mumu = pkg.mumu ?? {}
        const groupDir = relative(root, dir)
        found.push({
          id: mumu.id ?? (typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : basename(sub)),
          dir: sub,
          entry: join(sub, pkg.main ?? 'index.ts'),
          group: groupDir === '' ? '' : groupDir.split(sep).join('/'),
          enabled: mumu.enabled ?? true,
          order: mumu.order ?? 0,
          description: mumu.description ?? pkg.description,
          defaults: mumu.defaults,
        })
      }
      catch (e) {
        console.warn(`[loader] 跳过无效插件目录 ${relative(root, sub)}:`, e instanceof Error ? e.message : e)
      }
    }
  }

  await walk(root, 0)

  // id 是配置与命令的键，重名必须报错，否则配置会串到另一个插件
  const byId = new Map<string, PluginManifest>()
  for (const m of found) {
    const dup = byId.get(m.id)
    if (dup) {
      throw new Error(
        `插件 id 冲突: "${m.id}" 同时来自 ${relative(root, dup.dir)} 与 ${relative(root, m.dir)}。`
        + `改其中一个的 package.json name 或 mumu.id。`,
      )
    }
    byId.set(m.id, m)
  }

  // 加载次序只看 order，与目录层级无关
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}
