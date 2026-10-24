/**
 * 联网找表情包：按描述从公开来源搜候选 → 下载 → 审核（review.ts）→ 通过的入库，不过的只记原因、图不落盘。
 *
 * 来源（providers 按顺序试，一个失败 / 没结果 / 全被拦就换下一个）：
 * - so360：360 图片搜索的 JSON 接口（image.so.com/j），关键词后面补「表情包」。原图常有防盗链，取不到就用它的缩略图（qhimgs1 CDN）。
 * - fabiaoqing：「发表情」fabiaoqing.com 的搜索页（表情包专站），图片要带 Referer。页面是 HTML，按属性名找图，不靠模型输出。
 * 两个都不需要密钥；别的 bot 常用的斗图啦 / 逗比表情包接口实测已不通（2026-10-22），没收。
 *
 * 限流与降级：每次最多看 perSearch 张、每小时最多 perHour 次、单个请求 timeoutMs、整次 budgetMs；
 * 任何一步失败都只是「这次没找到」，不抛给聊天。同一个描述同时只找一次（后来的等同一个结果）。
 */
import type { ReviewNote, StickerBook, Sticker } from './book.ts'
import { fileOf, imageType } from './book.ts'
import type { Review } from './review.ts'
import { REVIEW_VERSION } from './review.ts'

export interface SearchConfig {
  enabled?: boolean
  providers?: string[]
  perSearch?: number // 每次最多下载审核几张
  perHour?: number
  timeoutMs?: number
  budgetMs?: number
  maxBytes?: number
  suffix?: string // 补在关键词后面（so360 用）
}

export interface Candidate {
  provider: string
  url: string
  fallback?: string // 原图取不到时用的（缩略图）
  alt?: string
  page?: string
  headers?: Record<string, string>
}

type Fetch = (url: string, init: { headers: Record<string, string>, signal: AbortSignal }) => Promise<Response>

export interface Provider {
  id: string
  title: string
  search: (query: string, n: number, signal: AbortSignal) => Promise<Candidate[]>
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

export function builtinProviders(fetchFn: Fetch, cfg: SearchConfig): Record<string, Provider> {
  const get = async (url: string, signal: AbortSignal, headers: Record<string, string> = {}): Promise<string> => {
    const res = await fetchFn(url, { headers: { 'user-agent': UA, ...headers }, signal })
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`)
    return res.text()
  }
  return {
    so360: {
      id: 'so360',
      title: '360 图片搜索',
      async search(query, n, signal) {
        const q = encodeURIComponent(`${query} ${cfg.suffix ?? '表情包'}`)
        const body = JSON.parse(await get(`https://image.so.com/j?q=${q}&sn=0&pn=${Math.max(n * 3, 10)}`, signal)) as { list?: Record<string, unknown>[] }
        return (body.list ?? []).flatMap((x) => {
          const img = typeof x.img === 'string' ? x.img : ''
          const thumb = typeof x.thumb_bak === 'string' ? x.thumb_bak : typeof x.thumb === 'string' ? x.thumb : ''
          if (!img && !thumb)
            return []
          return [{ provider: 'so360', url: img || thumb, fallback: img && thumb ? thumb : undefined, alt: typeof x.title === 'string' ? x.title : undefined, page: typeof x.link === 'string' ? x.link : undefined }]
        })
      },
    },
    fabiaoqing: {
      id: 'fabiaoqing',
      title: '发表情 fabiaoqing.com',
      async search(query, _n, signal) {
        const page = `https://fabiaoqing.com/search/bqb/keyword/${encodeURIComponent(query)}/type/bq/page/1.html`
        const html = await get(page, signal)
        return imgTags(html).flatMap((attrs) => {
          const url = attrs['data-original']
          return url?.startsWith('http') ? [{ provider: 'fabiaoqing', url, alt: attrs.title ?? attrs.alt, page, headers: { referer: 'https://fabiaoqing.com/' } }] : []
        })
      },
    },
  }
}

/** HTML 里每个 <img …> 的属性（只认双引号属性，够用；认不出的跳过） */
export function imgTags(html: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  let i = 0
  for (;;) {
    const start = html.indexOf('<img', i)
    if (start < 0)
      return out
    const end = html.indexOf('>', start)
    if (end < 0)
      return out
    const tag = html.slice(start + 4, end)
    const attrs: Record<string, string> = {}
    let j = 0
    for (;;) {
      const eq = tag.indexOf('="', j)
      if (eq < 0)
        break
      const close = tag.indexOf('"', eq + 2)
      if (close < 0)
        break
      const name = tag.slice(tag.lastIndexOf(' ', eq) + 1, eq).trim()
      if (name)
        attrs[name] = tag.slice(eq + 2, close)
      j = close + 1
    }
    out.push(attrs)
    i = end + 1
  }
}

export interface HuntResult {
  sticker?: Sticker
  provider?: string
  tried: number // 看了几张
  rejected: { url: string, reason: string }[]
  error?: string // 一张都没看成的原因（限流、禁词、网络）
}

export interface HunterDeps {
  book: StickerBook
  cfg: SearchConfig
  blockWords: string[]
  fetch?: Fetch
  providers?: Record<string, Provider> // 测试注入
  review: (bytes: Buffer, mime: string, signal: AbortSignal) => Promise<Review | undefined>
  log: (type: string, data: Record<string, unknown>) => void
  alive?: () => boolean // 插件卸载后看完的那张不再写库（新实例已接手 index.json）
}

export class Hunter {
  private recent: number[] = [] // 最近一小时每次搜索的时间
  private inflight = new Map<string, Promise<HuntResult>>()
  private providers: Record<string, Provider>
  private fetchFn: Fetch

  constructor(private d: HunterDeps) {
    this.fetchFn = d.fetch ?? ((url, init) => fetch(url, init))
    this.providers = d.providers ?? builtinProviders(this.fetchFn, d.cfg)
  }

  /** 这一小时还能搜几次 */
  left(): number {
    const now = Date.now()
    this.recent = this.recent.filter(t => now - t < 3600_000)
    return Math.max(0, (this.d.cfg.perHour ?? 20) - this.recent.length)
  }

  find(query: string, why: string, signal?: AbortSignal): Promise<HuntResult> {
    const q = query.trim().slice(0, 20)
    const hit = this.inflight.get(q)
    if (hit)
      return hit
    const p = this.run(q, why, signal).finally(() => this.inflight.delete(q))
    this.inflight.set(q, p)
    return p
  }

  private async run(query: string, why: string, outer?: AbortSignal): Promise<HuntResult> {
    const cfg = this.d.cfg
    const out: HuntResult = { tried: 0, rejected: [] }
    const done = (r: HuntResult): HuntResult => {
      this.d.log('sticker.search', { query, why, ok: Boolean(r.sticker), provider: r.provider, file: r.sticker?.file, tried: r.tried, rejected: r.rejected.length, error: r.error })
      return r
    }
    if (cfg.enabled === false)
      return done({ ...out, error: '联网找图关着' })
    if (!query)
      return done({ ...out, error: '没有描述' })
    const bad = this.d.blockWords.filter(w => w && query.includes(w))
    if (bad.length)
      return done({ ...out, error: `描述里有不合适的词：${bad.join('、')}` })
    if (!this.left())
      return done({ ...out, error: `这一小时已经找了 ${cfg.perHour ?? 20} 次` })
    this.recent.push(Date.now())

    const budget = AbortSignal.timeout(cfg.budgetMs ?? 40_000)
    const signal = outer ? AbortSignal.any([outer, budget]) : budget
    let left = cfg.perSearch ?? 3
    const errors: string[] = []
    for (const id of cfg.providers ?? ['so360', 'fabiaoqing']) {
      const p = this.providers[id]
      if (!p || left <= 0 || signal.aborted)
        continue
      let list: Candidate[]
      try {
        list = await p.search(query, left, AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs ?? 10_000)]))
      }
      catch (e) {
        errors.push(`${id}：${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      for (const c of list) {
        if (left <= 0 || signal.aborted)
          break
        // 标题就带禁词的不下（省一次看图）
        if (c.alt && this.d.blockWords.some(w => w && c.alt!.includes(w)))
          continue
        const img = await this.download(c, signal)
        if (!img)
          continue
        const file = fileOf(img.bytes, img.mime)
        const known = this.d.book.has(file)
        if (known) {
          if (known.ok === true && !known.disabled)
            return done({ ...out, sticker: known, provider: id })
          continue
        }
        if (this.d.book.isRejected(file))
          continue
        left--
        out.tried++
        const r = await this.d.review(img.bytes, img.mime, signal)
        if (this.d.alive?.() === false)
          return { ...out, error: '插件已卸载' }
        if (!r) {
          errors.push('看图审核没跑成')
          continue // 看不了就不收：网上的图不审不入库
        }
        if (!r.ok) {
          const reason = r.reason ?? '不合适'
          this.d.book.reject(file, reason)
          out.rejected.push({ url: c.url, reason })
          this.d.log('sticker.rejected', { query, provider: id, url: c.url, page: c.page, desc: r.desc, flags: r.flags, reason })
          continue
        }
        const note: ReviewNote = { at: Date.now(), version: REVIEW_VERSION, emotion: r.emotion, isSticker: r.isSticker, flags: r.flags }
        const s = this.d.book.add(img.bytes, img.mime, {
          desc: r.desc ?? c.alt ?? query,
          tags: [...new Set([query, ...r.tags])].slice(0, 6),
          usage: r.usage,
          ok: true,
          review: note,
          source: { kind: 'web', provider: id, url: c.url, page: c.page, query },
        })
        if (!s)
          return done({ ...out, error: '库满了' })
        this.d.log('sticker.added', { file: s.file, desc: s.desc, tags: s.tags, source: s.source })
        return done({ ...out, sticker: s, provider: id })
      }
    }
    return done({ ...out, error: signal.aborted ? '超时' : errors.join('；') || (out.tried ? '找到的都不合适' : '没搜到') })
  }

  private async download(c: Candidate, signal: AbortSignal): Promise<{ bytes: Buffer, mime: string } | undefined> {
    for (const url of [c.url, c.fallback]) {
      if (!url || signal.aborted)
        continue
      try {
        const res = await this.fetchFn(url, { headers: { 'user-agent': UA, ...c.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(this.d.cfg.timeoutMs ?? 10_000)]) })
        if (!res.ok)
          continue
        const bytes = Buffer.from(await res.arrayBuffer())
        const mime = imageType(bytes)
        if (mime && bytes.length <= (this.d.cfg.maxBytes ?? 2_000_000))
          return { bytes, mime }
      }
      catch {
        // 这个地址不行（超时 / 防盗链 / 断网）：试缩略图或下一张
      }
    }
    return undefined
  }
}
