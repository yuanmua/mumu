/**
 * 网页（docs/web-protocol.md §7）与 /stickers 命令：
 * - 面板「表情包库」：每张一张卡（缩略图、画面、标签、来源、审核结论、状态、用过几次），
 *   行按钮 禁用 / 恢复 / 重新审核 / 删除；顶部「按描述联网找并入库」（带输入框）与「全部按新规则重审」。
 * - 缩略图：GET /api/stickers/img/<文件名>，经 web/route 回图片字节（只认库里登记过的文件名，不是读任意文件的口子）。
 * - 状态卡「表情包」：库里几张、今天发了几张、联网找了几次（入库 / 拦下）。
 */
import type { Ctx } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { Sticker, StickerBook } from './book.ts'
import { canSend, mimeOf } from './book.ts'
import { REVIEW_VERSION } from './review.ts'
import type { Hunter } from './search.ts'

export interface WebDeps {
  book: StickerBook
  hunter: Hunter
  recheck: (file: string) => void
  teach: () => void
  queue: () => number
}

const BASE = '/api/stickers'

export function sourceText(s: Sticker): string {
  const src = s.source
  if (src?.kind === 'web')
    return `网上 · ${src.provider ?? '?'}（按「${src.query ?? ''}」找的）${src.url ? ` ${src.url}` : ''}`
  if (src?.kind === 'group')
    return `群里收的 · ${src.channel ?? ''}`
  return src?.kind === 'manual' ? '主人放的' : '群里收的'
}

export function reviewText(s: Sticker): string {
  if (s.ok === undefined)
    return '还没审'
  const v = s.review?.version ?? 1
  const rule = v < REVIEW_VERSION ? ` · 规则 v${v}（旧，排队重审）` : ` · 规则 v${v}`
  return s.ok ? `通过${rule}` : `没过：${s.reason ?? '不合适'}${rule}`
}

/** 今天的数：从日志倒着数到零点 */
export function todayStats(events: readonly { type: string, at: number, data?: Record<string, unknown> }[]): { sent: number, searches: number, added: number, rejected: number } {
  const today = new Date().setHours(0, 0, 0, 0)
  const n = { sent: 0, searches: 0, added: 0, rejected: 0 }
  for (let i = events.length - 1, k = 0; i >= 0 && k < 50_000; i--, k++) {
    const e = events[i]
    if (e.at < today)
      break
    if (e.type === 'sticker.sent')
      n.sent++
    else if (e.type === 'sticker.search')
      n.searches++
    else if (e.type === 'sticker.added')
      n.added++
    else if (e.type === 'sticker.rejected')
      n.rejected++
  }
  return n
}

export function webParts(ctx: Ctx, d: WebDeps): void {
  const fileIn = (body: unknown): string => String((body as { item?: { file?: unknown } } | undefined)?.item?.file ?? '')
  const find = async (q: string): Promise<{ status: number, body: unknown }> => {
    const r = await d.hunter.find(q, '主人在网页上补库')
    if (r.sticker) {
      d.teach()
      const skipped = r.rejected.length ? `；路上拦下 ${r.rejected.length} 张（${r.rejected.map(x => x.reason).join(' / ')}）` : ''
      return { status: 200, body: { ok: true, file: r.sticker.file, desc: r.sticker.desc, provider: r.provider, rejected: r.rejected, message: `入库：${r.sticker.desc}（来自 ${r.provider}）${skipped}` } }
    }
    const why = r.error ?? '没找到'
    return { status: 422, body: { error: `没找到合适的（${why}${r.rejected.length ? `；拦下 ${r.rejected.length} 张：${r.rejected.map(x => x.reason).join(' / ')}` : ''}）` } }
  }

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (!r.path.startsWith(`${BASE}/`))
      return next()
    if (r.method === 'GET' && r.path === `${BASE}/items`) {
      r.response = {
        body: {
          items: d.book.all().map(s => ({
            img: `${BASE}/img/${encodeURIComponent(s.file)}`,
            file: s.file,
            desc: s.desc,
            tags: s.tags.join('、'),
            usage: s.usage ?? '',
            source: sourceText(s),
            review: reviewText(s),
            state: s.disabled ? '主人禁用' : canSend(s) ? '可发' : '不能发',
            sent: s.sent ?? 0,
            seen: s.seen ?? 0,
            learned: (s.contexts ?? []).map(c => c.text).join(' | '),
          })).reverse(), // 新收的在前
        },
      }
      return r
    }
    if (r.method === 'GET' && r.path.startsWith(`${BASE}/img/`)) {
      const s = d.book.has(decodeURIComponent(r.path.slice(`${BASE}/img/`.length)))
      r.response = s ? { body: d.book.read(s), contentType: mimeOf(s.file), cache: true } : { status: 404, body: { error: '没有这张' } }
      return r
    }
    if (r.method !== 'POST')
      return next()
    const file = fileIn(r.body)
    const done = (ok: boolean): WebRoute => {
      if (ok)
        d.teach()
      r.response = ok ? { status: 204 } : { status: 404, body: { error: `没有这张：${file}` } }
      return r
    }
    switch (r.path) {
      case `${BASE}/items/disable`: return done(d.book.setDisabled(file, true))
      case `${BASE}/items/enable`: return done(d.book.setDisabled(file, false))
      case `${BASE}/items/delete`: return done(d.book.remove(file))
      case `${BASE}/items/recheck`: {
        const ok = Boolean(d.book.has(file))
        if (ok)
          d.recheck(file)
        return done(ok)
      }
      case `${BASE}/recheck-all`:
        for (const s of d.book.all()) d.recheck(s.file)
        r.response = { status: 204 }
        return r
      case `${BASE}/find`: {
        const q = String((r.body as { input?: unknown } | undefined)?.input ?? '').trim()
        r.response = q ? await find(q) : { status: 400, body: { error: '写一个描述，如「无语」「抱抱」' } }
        return r
      }
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'stickers',
      title: '表情包库',
      kind: 'cards',
      endpoint: `${BASE}/items`,
      columns: [
        { key: 'img', label: '图', format: 'image' },
        { key: 'desc', label: '画面' },
        { key: 'tags', label: '情绪 / 场景' },
        { key: 'usage', label: '什么时候发' },
        { key: 'source', label: '来源' },
        { key: 'review', label: '审核' },
        { key: 'state', label: '状态' },
        { key: 'sent', label: '她发过' },
        { key: 'seen', label: '群里见过' },
        { key: 'learned', label: '群友在这些话后面发它' },
      ],
      actions: [
        { label: '按描述联网找并入库', endpoint: `${BASE}/find`, input: '描述，如「无语」「抱抱」' },
        { label: '全部按新规则重审', endpoint: `${BASE}/recheck-all`, confirm: '整库按现在的审核规则再看一遍？（后台一张张来）' },
      ],
      rowActions: [
        { label: '禁用', endpoint: `${BASE}/items/disable` },
        { label: '恢复', endpoint: `${BASE}/items/enable` },
        { label: '重新审核', endpoint: `${BASE}/items/recheck` },
        { label: '删除', endpoint: `${BASE}/items/delete`, confirm: '删掉这张？以后再见到也不收' },
      ],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const t = todayStats(ctx.log.events)
    const all = d.book.all()
    s.cards.push({
      id: 'stickers',
      title: '表情包',
      level: d.book.size ? 'ok' : 'info',
      text: `库里 ${all.length} 张（能发 ${d.book.size}），今天发了 ${t.sent} 张，联网找了 ${t.searches} 次`,
      items: [
        `联网找图今天入库 ${t.added} 张、拦下 ${t.rejected} 张；这一小时还能找 ${d.hunter.left()} 次`,
        `审核没过 ${all.filter(x => x.ok === false).length} 张，主人禁用 ${all.filter(x => x.disabled).length} 张，排队审核 ${d.queue()} 张`,
      ],
    })
    return next()
  })

  const commands = ((): CommandService | undefined => {
    try {
      return ctx.use<CommandService>('commands')
    }
    catch {
      return undefined // 没装 commands：只是少一个命令
    }
  })()
  if (!commands)
    return
  ctx.effect(() => commands.register({
    name: 'stickers',
    usage: 'stickers [find <描述> | recheck]',
    description: '表情包库：多少张、审核没过的、最常见的标签、她发过哪些；find 联网找一张入库，recheck 整库重审',
    async run(args, io) {
      if (args[0] === 'find') {
        const q = args.slice(1).join(' ')
        const r = await find(q)
        io.print(r.status === 200 ? `  入库：${(r.body as { desc: string }).desc}` : `  ${(r.body as { error: string }).error}`)
        return
      }
      if (args[0] === 'recheck') {
        for (const s of d.book.all()) d.recheck(s.file)
        io.print(`  已排队重审 ${d.book.all().length} 张`)
        return
      }
      const all = d.book.all()
      const t = todayStats(ctx.log.events)
      io.print(`  共 ${all.length} 张（能发 ${d.book.size}，没过 ${all.filter(s => s.ok === false).length}，没审 ${all.filter(s => s.ok === undefined).length}）· 今天发了 ${t.sent}、联网找了 ${t.searches} 次（入库 ${t.added}、拦下 ${t.rejected}）`)
      io.print(`  常见标签：${d.book.topTags(12).join('、') || '无'}`)
      for (const s of all.filter(x => x.sent).sort((a, b) => (b.sent ?? 0) - (a.sent ?? 0)).slice(0, 6))
        io.print(`  发过 ${s.sent} 次：${s.desc}（${s.tags.join('、')}）`)
      for (const s of all.filter(x => x.ok === false).slice(-4))
        io.print(`  ✗ ${s.desc}：${s.reason ?? '审核没过'}`)
    },
  }))
}
