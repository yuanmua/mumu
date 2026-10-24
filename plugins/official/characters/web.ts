/**
 * 角色包在网页「设置 → 面板」里的样子：一张角色包表格，每行一个「切换」按钮；状态页一张「当前角色」卡。
 * 走 surface-web 的通用扩展点（docs/web-protocol.md §7），也是给别的插件抄的最小样例：
 * web/route 认领自己的接口、web/meta 报面板定义、web/status 报卡片，surface-web 与前端一行不改。
 */
import type { Ctx } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { CharacterPack } from './pack.ts'

interface Deps {
  packs: Map<string, CharacterPack>
  current: () => { id?: string, stage: CharacterPack['stage'] } | undefined
  use: (pack: CharacterPack) => void
}

const LIST = '/api/characters/packs'
const USE = '/api/characters/use'

export function webExtras(ctx: Ctx, deps: Deps): void {
  const rows = () => {
    const cur = deps.current()
    return [...deps.packs.values()].map(p => ({
      id: p.id,
      name: p.name,
      stage: `${p.stage.kind} · ${p.stage.profile}`,
      voice: p.voice?.voice ?? '',
      current: p.id === cur?.id ? '✓' : '',
    }))
  }

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (r.method === 'GET' && r.path === LIST) {
      r.response = { body: { items: rows() } }
      return r
    }
    if (r.method === 'POST' && r.path === USE) {
      const id = (r.body as { item?: { id?: unknown } } | undefined)?.item?.id
      const pack = typeof id === 'string' ? deps.packs.get(id) : undefined
      r.response = pack ? { status: 204 } : { status: 404, body: { error: `没有角色包 ${String(id)}` } }
      if (pack)
        deps.use(pack)
      return r
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'characters',
      title: '角色包',
      kind: 'table',
      endpoint: LIST,
      columns: [{ key: 'current', label: '当前' }, { key: 'name', label: '名字' }, { key: 'id' }, { key: 'stage', label: '舞台' }, { key: 'voice', label: '声音' }],
      rowActions: [{ label: '切换', endpoint: USE, confirm: '切换角色会换人设、舞台和声音，确定？' }],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const cur = deps.current()
    const pack = cur?.id ? deps.packs.get(cur.id) : undefined
    s.cards.push({
      id: 'character',
      title: '角色',
      level: 'info',
      text: pack ? `${pack.name}（${pack.id}）` : '没切过角色包，用 persona 默认',
      items: cur?.stage ? [`舞台 ${cur.stage.kind} · ${cur.stage.profile}`] : [],
    })
    return next()
  })
}
