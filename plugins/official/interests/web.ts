/**
 * 兴趣在网页上的样子（docs/web-protocol.md §7）：
 * - 面板「兴趣」（`near: 'persona'`：也挂在人格抽屉底下）：兴趣、分、最近触发、来源（行里还带也认的词、为什么变，可搜）；
 *   顶部「加一条」（输入名字，可带「=分」）「调分」（「名字=0.8」）；行按钮「+0.1」「-0.1」「删掉」。
 *   候选（聊过还没够次数）也列出来，分那一列写「候选 n/m」。
 * - 状态卡「兴趣」：表里几条、最高的几条、正在攒的会话。
 * - `GET /api/interests/score?text=…`：同水线 interests/score（验收、调试用）。
 * 改表不改配置，所以按钮不会让插件重载；改完下一次打分就是新值。
 */
import type { Ctx } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { Change } from './learn.ts'
import type { Hit, Interest, InterestStore } from './store.ts'

interface Deps {
  store: InterestStore
  after: () => number // 候选进表要几次
  score: (text: string) => Promise<{ score: number, hits: Hit[] }>
  open: () => { channel: string, turns: number }[]
  set: (name: string, score: number) => Change
  remove: (name: string) => boolean
}

const BASE = '/api/interests'
const SOURCE: Record<string, string> = { persona: '人设', self: '她自己', user: '用户改的' }

/** 「名字」「名字=0.8」「名字 0.8」→ { name, score? }（用户在输入框里写的，不是模型输出） */
export function parseInput(s: string): { name: string, score?: number } | undefined {
  const t = s.trim()
  const cut = Math.max(t.lastIndexOf('='), t.lastIndexOf('＝'), t.lastIndexOf(' '))
  if (cut > 0) {
    const n = Number(t.slice(cut + 1))
    if (t.slice(cut + 1).trim() && Number.isFinite(n))
      return { name: t.slice(0, cut).trim(), score: n > 1 ? n / 100 : n }
  }
  return t ? { name: t } : undefined
}

export function webExtras(ctx: Ctx, d: Deps): void {
  const row = (i: Interest): Record<string, unknown> => ({
    name: i.name,
    score: i.state === 'on' ? i.score.toFixed(2) : `候选 ${i.hits}/${d.after()}`,
    lastAt: i.lastAt || undefined,
    source: SOURCE[i.source] ?? i.source,
    desc: i.desc,
    keywords: i.keywords.join('、'),
    note: i.note,
  })
  const nameOf = (body: unknown): string => String((body as { item?: { name?: unknown } } | undefined)?.item?.name ?? '')
  const inputOf = (body: unknown): string => String((body as { input?: unknown } | undefined)?.input ?? '')
  const nudge = (name: string, delta: number): { status: number, body?: unknown } => {
    const it = d.store.get(name)
    if (!it)
      return { status: 404, body: { error: `没有「${name}」` } }
    const c = d.set(name, (it.state === 'on' ? it.score : 0) + delta)
    return { status: 200, body: { message: `${name} → ${c.to?.toFixed(2)}` } }
  }

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    const { method, path } = r
    if (!path.startsWith(`${BASE}/`))
      return next()
    if (method === 'GET' && path === `${BASE}/items`) {
      r.response = { body: { items: d.store.list().map(row) } }
      return r
    }
    if (method === 'GET' && path === `${BASE}/score`) {
      const s = await d.score(r.query.text ?? '')
      r.response = { body: { text: r.query.text ?? '', ...s } }
      return r
    }
    if (method === 'POST' && (path === `${BASE}/add` || path === `${BASE}/set`)) {
      const p = parseInput(inputOf(r.body))
      if (!p?.name) {
        r.response = { status: 400, body: { error: '写一个兴趣名，可带「=分」，如「摄影=0.6」' } }
        return r
      }
      if (path === `${BASE}/set` && !d.store.get(p.name)) {
        r.response = { status: 404, body: { error: `没有「${p.name}」，要新加用「加一条」` } }
        return r
      }
      const c = d.set(p.name, p.score ?? d.store.get(p.name)?.score ?? 0.5)
      r.response = { body: { message: `${c.name} → ${c.to?.toFixed(2)}` } }
      return r
    }
    if (method === 'POST' && path === `${BASE}/up`) {
      r.response = nudge(nameOf(r.body), 0.1)
      return r
    }
    if (method === 'POST' && path === `${BASE}/down`) {
      r.response = nudge(nameOf(r.body), -0.1)
      return r
    }
    if (method === 'POST' && path === `${BASE}/delete`) {
      const name = nameOf(r.body)
      r.response = d.remove(name) ? { status: 204 } : { status: 404, body: { error: `没有「${name}」` } }
      return r
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'interests',
      title: '兴趣',
      kind: 'table',
      endpoint: `${BASE}/items`,
      near: 'persona',
      columns: [
        { key: 'name', label: '兴趣' },
        { key: 'score', label: '分' },
        { key: 'lastAt', label: '最近聊到', format: 'time' },
        { key: 'source', label: '来源' },
      ], // 描述、也认的词、为什么变：不占列（人格抽屉窄），搜索照样搜得到，/interests 里看得全
      actions: [
        { label: '加一条', endpoint: `${BASE}/add`, input: '名字，可带分：摄影=0.6' },
        { label: '调分', endpoint: `${BASE}/set`, input: '名字=分：猫=0.9' },
      ],
      rowActions: [
        { label: '+0.1', endpoint: `${BASE}/up` },
        { label: '-0.1', endpoint: `${BASE}/down` },
        { label: '删掉', endpoint: `${BASE}/delete`, confirm: '删掉这条兴趣？她以后又聊出来还会再长回来。' },
      ],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const on = d.store.active()
    const cand = d.store.list().filter(i => i.state === 'candidate')
    const open = d.open()
    s.cards.push({
      id: 'interests',
      title: '兴趣',
      level: 'info',
      text: `表里 ${on.length} 条${cand.length ? `，候选 ${cand.length} 条` : ''}`,
      items: [
        on.slice(0, 5).map(i => `${i.name} ${i.score.toFixed(2)}`).join(' · ') || '（空）',
        open.length ? `正在看：${open.map(o => `${o.channel}（她说了 ${o.turns} 次）`).join('、')}` : '',
      ].filter(Boolean),
    })
    return next()
  })
}
