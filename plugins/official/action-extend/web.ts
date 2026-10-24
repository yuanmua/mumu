/**
 * 她给自己加的功能在网页上的样子（docs/web-protocol.md §7）：面板「她加的功能」，每行一个用户插件，
 * 行按钮「停用」「启用」「卸载」。卸载 = 停用 + 把目录挪到 data/extend-trash/（不直接删，挪回来就能恢复）。
 */
import { mkdirSync, renameSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Ctx, PluginLoader } from '../../../src/index.ts'
import type { WebPanel, WebRoute } from '../surface-web/index.ts'

const LIST = '/api/action-extend/plugins'

export function webExtras(ctx: Ctx, loader: PluginLoader, userRoot: string): void {
  const mine = () => loader.list().filter(p => p.group.startsWith('user'))
  const idOf = (body: unknown): string => String((body as { item?: { id?: unknown } } | undefined)?.item?.id ?? '')

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (r.method === 'GET' && r.path === LIST) {
      const last = new Map<string, { at: number, tries: number }>()
      for (const e of ctx.log.events) {
        if (e.type === 'extend.installed')
          last.set(String(e.data.name), { at: e.at, tries: Number(e.data.tries ?? 1) })
      }
      r.response = {
        body: {
          items: mine().map(p => ({
            id: p.id,
            state: p.error ? `✗ ${p.error}` : p.loaded ? '在用' : p.enabled ? '没装上' : '停用',
            description: p.description ?? '',
            installedAt: last.get(p.id)?.at,
            tries: last.get(p.id)?.tries,
          })),
        },
      }
      return r
    }
    const act = r.method === 'POST' && r.path.startsWith(`${LIST}/`) ? r.path.slice(LIST.length + 1) : ''
    if (!act)
      return next()
    const id = idOf(r.body)
    if (!mine().some(p => p.id === id)) {
      r.response = { status: 404, body: { error: `不是她加的功能：${id}` } }
      return r
    }
    try {
      if (act === 'disable' || act === 'remove')
        await loader.setEnabled(id, false)
      else if (act === 'enable')
        await loader.setEnabled(id, true)
      if (act === 'remove') {
        // 挪到回收站，不直接删：她写的东西也是她的，误点了还能挪回来再 /plugin scan
        const dir = resolve(userRoot, id)
        if (!dir.startsWith(resolve(userRoot) + sep))
          throw new Error('路径不对')
        const trash = resolve('data/extend-trash')
        mkdirSync(trash, { recursive: true })
        renameSync(dir, join(trash, `${id}-${Date.now()}`))
      }
      r.response = { status: 204 }
    }
    catch (e) {
      r.response = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
    }
    return r
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'action-extend',
      title: '她给自己加的功能',
      kind: 'table',
      endpoint: LIST,
      columns: [
        { key: 'id', label: '名字' },
        { key: 'state', label: '状态' },
        { key: 'description', label: '做什么' },
        { key: 'installedAt', label: '装上', format: 'time' },
        { key: 'tries', label: '改了几次才过' },
      ],
      rowActions: [
        { label: '停用', endpoint: `${LIST}/disable` },
        { label: '启用', endpoint: `${LIST}/enable` },
        { label: '卸载', endpoint: `${LIST}/remove`, confirm: '卸载这个功能？目录会挪到 data/extend-trash/，挪回来能恢复。' },
      ],
    }]
    return next()
  })
}
