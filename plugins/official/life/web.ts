/**
 * 「此刻在干嘛」在网页上的样子（docs/web-protocol.md §7）：
 * - 面板「在干嘛」（`near: 'persona'`：挂在人格抽屉底下）：第一行是现在这件（到几点、谁定的、她当时心里那句），下面是最近换过的；
 *   顶部「设成」（输入「在吃火锅」「拼乐高 40」——带分钟就管这么久，不带就管到下一个时段）「换一个」「清掉」。
 * - 状态卡「在干嘛」。
 * - `GET /api/life/now`：现在的状态 + 时段（调试、探针用）；`POST /api/life/next` 可带 `{ at: 'HH:MM', weekend? }` 假装是那个时间抽一次。
 */
import type { Ctx } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { Life } from './engine.ts'
import { byLabel } from './engine.ts'
import { parseHM, parseSetInput } from './rhythm.ts'
import type { LifeState } from './state.ts'

const BASE = '/api/life'

export function webExtras(ctx: Ctx, life: Life): void {
  // 人格抽屉窄：起止并成一列只写钟点，细节并进「在干嘛」（和兴趣面板一样少占列）
  const row = (s: LifeState, now: boolean): Record<string, unknown> => ({
    time: `${now ? '现在 ' : ''}${life.hm(s.from)}–${life.hm(s.until)}`,
    activity: life.line(s),
    by: byLabel(s),
    thought: s.thought ?? '',
    from: s.from,
    until: s.until,
  })
  const said = (s: LifeState | undefined): string =>
    s ? `现在：${life.line(s)}（到 ${life.hm(s.until)}，${byLabel(s)}）` : '作息里这会儿没有能做的事'

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    const { method, path } = r
    if (!path.startsWith(`${BASE}/`))
      return next()
    const now = Date.now()
    if (method === 'GET' && path === `${BASE}/items`) {
      const cur = life.log.active(now)
      const past = life.log.recent.filter(s => s !== cur).reverse().slice(0, 12)
      r.response = { body: { items: [...(cur ? [row(cur, true)] : []), ...past.map(s => row(s, false))] } }
      return r
    }
    if (method === 'GET' && path === `${BASE}/now`) {
      const where = life.slot()
      r.response = { body: { state: life.log.active(now) ?? null, slot: where?.slot.label, slotEndsAt: life.nextBoundary(now), due: life.due(now) ?? null } }
      return r
    }
    if (method === 'POST' && path === `${BASE}/set`) {
      const p = parseSetInput(String((r.body as { input?: unknown } | undefined)?.input ?? ''))
      if (!p.text) {
        r.response = { status: 400, body: { error: '写她在做什么，如「在吃火锅」「拼乐高 40」（带分钟就管这么久）' } }
        return r
      }
      r.response = { body: { message: said(life.setByUser(p.text, p.minutes)) } }
      return r
    }
    if (method === 'POST' && path === `${BASE}/next`) {
      const b = (r.body ?? {}) as { at?: unknown, weekend?: unknown }
      const minute = typeof b.at === 'string' ? parseHM(b.at) : undefined
      if (typeof b.at === 'string' && minute === undefined) {
        r.response = { status: 400, body: { error: 'at 写成 HH:MM' } }
        return r
      }
      const real = life.clock(now)
      const at = minute === undefined ? undefined : { ...real, minute, hm: b.at as string, weekend: typeof b.weekend === 'boolean' ? b.weekend : real.weekend }
      const s = await life.roll({ cause: 'reroll', at, exclude: life.log.active(now)?.activity })
      r.response = { body: { message: said(s ?? life.log.active(Date.now())), state: s ?? null } }
      return r
    }
    if (method === 'POST' && path === `${BASE}/clear`) {
      life.clear()
      const s = await life.roll({ cause: 'clear' })
      r.response = { body: { message: `清掉了，${said(s)}` } }
      return r
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'life',
      title: '在干嘛',
      kind: 'table',
      endpoint: `${BASE}/items`,
      near: 'persona',
      refreshSec: 30,
      columns: [
        { key: 'time', label: '时间' },
        { key: 'activity', label: '在干嘛' },
        { key: 'by', label: '谁定的' },
        { key: 'thought', label: '她心里' },
      ],
      actions: [
        { label: '设成', endpoint: `${BASE}/set`, input: '在吃火锅 / 拼乐高 40' },
        { label: '换一个', endpoint: `${BASE}/next` },
        { label: '清掉', endpoint: `${BASE}/clear`, confirm: '清掉现在的状态，按作息重新定一个？' },
      ],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const now = Date.now()
    const cur = life.log.active(now)
    const where = life.slot()
    s.cards.push({
      id: 'life',
      title: '在干嘛',
      level: 'info',
      text: cur ? life.line(cur) : '（还没定）',
      items: [
        cur ? `${life.hm(cur.from)}–${life.hm(cur.until)} · ${byLabel(cur)}` : '',
        where ? `时段：${where.slot.label}，${life.hm(now + where.left * 60_000)} 进下一个时段` : '',
      ].filter(Boolean),
    })
    return next()
  })
}
