/**
 * 记忆在网页上的样子（docs/web-protocol.md §7）：
 * - 面板「记忆 · 人」：打过交道的人，公开印象 / 私下印象 / 记得的事；行按钮「清掉印象」「彻底忘掉」。
 * - 面板「记忆 · 群」：群印象；行按钮「删掉」。
 * - 面板「记忆 · 中期摘要」：最近的摘要与想起它的线索；行按钮「删掉」；顶部「现在就整理」（把攒着的压掉）。
 * - 状态卡「记忆」：各层条数、攒着没压的。
 * 面板协议没有输入框，所以「编辑」做成清掉 / 删掉——想改内容用 /memory 命令或让她重新聊出来。
 */
import type { Ctx } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { MemoryStore } from './store.ts'

interface Deps {
  store: MemoryStore
  label: (channel: string) => string
  pending: () => { channel: string, turns: number }[]
  flushAll: () => Promise<string[]>
}

const PEOPLE = '/api/memory/people'
const GROUPS = '/api/memory/groups'
const EPISODES = '/api/memory/episodes'

export function webExtras(ctx: Ctx, d: Deps): void {
  const item = (body: unknown): Record<string, unknown> => ((body as { item?: Record<string, unknown> } | undefined)?.item ?? {})
  const done = (ok: boolean, what: string): { status: number, body?: unknown } => ok ? { status: 204 } : { status: 404, body: { error: `没有${what}` } }

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    const { method, path } = r
    if (method === 'GET' && path === PEOPLE) {
      r.response = {
        body: {
          items: d.store.listPeople(300).map(p => ({
            id: p.id,
            name: p.names.length > 1 ? `${p.name}（也叫 ${p.names.filter(n => n !== p.name).join('、')}）` : p.name,
            impression: p.impression,
            privateImpression: p.privateImpression,
            facts: p.facts.map(f => `${f.text}（${d.label(f.channel)}）`).join('；'),
            lastAt: p.lastAt,
          })),
        },
      }
      return r
    }
    if (method === 'GET' && path === GROUPS) {
      r.response = { body: { items: d.store.listGroups().map(g => ({ channel: g.channel, group: d.label(g.channel), impression: g.impression, updatedAt: g.updatedAt })) } }
      return r
    }
    if (method === 'GET' && path === EPISODES) {
      r.response = {
        body: {
          items: d.store.listEpisodes(200).map(e => ({
            id: e.id,
            where: d.label(e.channel),
            toAt: e.toAt,
            summary: e.summary,
            cues: e.cues.join('；'),
            people: e.people.join('、'),
          })),
        },
      }
      return r
    }
    if (method === 'POST' && path === `${PEOPLE}/wipe`) {
      r.response = done(d.store.wipe(String(item(r.body).id)), '这个人')
      return r
    }
    if (method === 'POST' && path === `${PEOPLE}/forget`) {
      r.response = done(d.store.forget(String(item(r.body).id)), '这个人')
      return r
    }
    if (method === 'POST' && path === `${GROUPS}/delete`) {
      r.response = done(d.store.deleteGroup(String(item(r.body).channel)), '这个群印象')
      return r
    }
    if (method === 'POST' && path === `${EPISODES}/delete`) {
      r.response = done(d.store.deleteEpisode(Number(item(r.body).id)), '这段摘要')
      return r
    }
    if (method === 'POST' && path === `${EPISODES}/flush`) {
      r.response = { body: { lines: await d.flushAll() } }
      return r
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'memory-people',
      title: '记忆 · 人',
      kind: 'table',
      endpoint: PEOPLE,
      columns: [
        { key: 'name', label: '谁' },
        { key: 'impression', label: '印象（哪儿都能想起）' },
        { key: 'privateImpression', label: '私下印象（只在单聊时想起）' },
        { key: 'facts', label: '记得的事（来源）' },
        { key: 'lastAt', label: '最近见到', format: 'time' },
        { key: 'id', label: 'id' },
      ],
      rowActions: [
        { label: '清掉印象', endpoint: `${PEOPLE}/wipe`, confirm: '清掉这个人的印象和记得的事（还认得名字）？' },
        { label: '彻底忘掉', endpoint: `${PEOPLE}/forget`, confirm: '彻底忘掉这个人？' },
      ],
    }, {
      id: 'memory-groups',
      title: '记忆 · 群',
      kind: 'table',
      endpoint: GROUPS,
      columns: [{ key: 'group', label: '群' }, { key: 'impression', label: '这个群' }, { key: 'updatedAt', label: '更新', format: 'time' }],
      rowActions: [{ label: '删掉', endpoint: `${GROUPS}/delete`, confirm: '删掉这个群的印象？' }],
    }, {
      id: 'memory-episodes',
      title: '记忆 · 中期摘要',
      kind: 'table',
      endpoint: EPISODES,
      columns: [
        { key: 'where', label: '在哪' },
        { key: 'toAt', label: '到', format: 'time' },
        { key: 'summary', label: '摘要' },
        { key: 'cues', label: '什么时候会想起' },
        { key: 'people', label: '有谁' },
      ],
      actions: [{ label: '现在就整理', endpoint: `${EPISODES}/flush`, confirm: '把所有攒着的对话现在压成摘要？每个会话一次模型调用。' }],
      rowActions: [{ label: '删掉', endpoint: `${EPISODES}/delete`, confirm: '删掉这段摘要？' }],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const st = d.store.stats()
    const pend = d.pending()
    s.cards.push({
      id: 'memory',
      title: '记忆',
      level: 'info',
      text: `认得 ${st.interacted} 人 · 中期摘要 ${st.episodes} 段 · 群印象 ${st.groups} 个 · 约 ${Math.round(st.bytes / 1024)} KB`,
      items: [`攒着还没整理：${pend.length} 个会话共 ${pend.reduce((n, x) => n + x.turns, 0)} 条`],
    })
    return next()
  })
}
