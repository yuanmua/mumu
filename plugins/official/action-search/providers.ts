/**
 * 搜索来源：网页 / 新闻一家、图片一家，各自一张表。换一家 = 在表里加一项、配置里改 provider / imageProvider（README「怎么换一家」）。
 *
 * - deepseek：DeepSeek 官方 Search API（POST {endpoint}，Bearer 与对话共用一个 DeepSeek 密钥）。没有新闻分类，
 *   news 用它支持的搜索语法 `after:<日期>` 只要最近几天的，再按发布时间从新到旧排。
 * - so360：DeepSeek 没有图片搜索，图片走 360 图片搜索的 JSON 接口（不要密钥，表情包插件验证过）。
 *   原图常有防盗链，给缩略图（qhimgs1 CDN）当备用。
 *
 * 只认结构化 JSON 字段，不解析网页；字段缺了就跳过那一条。
 */

export type Kind = 'web' | 'image' | 'news'
type Fetch = typeof fetch

export interface WebHit {
  title: string
  url: string
  site?: string
  date?: string // RFC 3339
  snippet: string
}

export interface ImageCandidate {
  url: string
  fallback?: string // 原图取不到时用的（缩略图）
  title?: string
  page?: string
  site?: string
}

export interface Env {
  fetch: Fetch
  endpoint?: string
  key?: string
  signal: AbortSignal
  now: number
  newsDays: number
}

export interface WebProvider {
  id: string
  title: string
  needsKey: boolean
  search: (query: string, count: number, kind: 'web' | 'news', env: Env) => Promise<WebHit[]>
}

export interface ImageProvider {
  id: string
  title: string
  search: (query: string, count: number, env: Env) => Promise<ImageCandidate[]>
}

/** 搜索服务回的错误码 → 她能照实说的原因 */
export class SearchError extends Error {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'

const str = (v: unknown): string => typeof v === 'string' ? v : ''
/** 360 的标题带 <em> 高亮；这是接口数据不是模型输出，去标签即可 */
export const plain = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

function httpError(status: number, body: string): SearchError {
  if (status === 401 || status === 403)
    return new SearchError(`密钥不对或没开通搜索（${status}）`)
  if (status === 402)
    return new SearchError('搜索账户余额不足（402）')
  if (status === 429)
    return new SearchError('搜得太频繁，被限流了（429）')
  return new SearchError(`搜索服务回 ${status}：${body.slice(0, 100)}`)
}

export const WEB_PROVIDERS: Record<string, WebProvider> = {
  deepseek: {
    id: 'deepseek',
    title: 'DeepSeek',
    needsKey: true,
    async search(query, count, kind, env) {
      let q = query
      if (kind === 'news' && !q.includes('after:')) {
        const since = new Date(env.now - env.newsDays * 86400_000).toISOString().slice(0, 10)
        q = `${q} after:${since}`
      }
      const res = await env.fetch(env.endpoint || 'https://api.deepseek.com/v1/tools/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q.slice(0, 128), count }),
        signal: env.signal,
      })
      if (!res.ok)
        throw httpError(res.status, await res.text())
      const body = await res.json() as { results?: Record<string, unknown>[] }
      const hits = (body.results ?? []).flatMap((r): WebHit[] => {
        const url = str(r.url)
        const title = plain(str(r.title))
        if (!url || !title)
          return []
        return [{ title, url, site: str(r.site_name) || undefined, date: str(r.date) || undefined, snippet: plain(str(r.snippet) || str(r.summary)) }]
      })
      if (kind === 'news')
        hits.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
      return hits
    },
  },
}

/** 必应图片的结果页：每张图一个 `m="{json}"` 属性（HTML 转义过的 JSON，murl 原图、turl 缩略图、t 标题、purl 来源页） */
export function bingItems(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let i = 0
  for (;;) {
    const start = html.indexOf(' m="{', i)
    if (start < 0)
      return out
    const end = html.indexOf('"', start + 4)
    if (end < 0)
      return out
    const raw = html.slice(start + 4, end).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    try {
      out.push(JSON.parse(raw) as Record<string, unknown>)
    }
    catch {
      // 这一项转义没认全：跳过它，别的照常
    }
    i = end + 1
  }
}

export const IMAGE_PROVIDERS: Record<string, ImageProvider> = {
  bing: {
    id: 'bing',
    title: '必应图片',
    async search(query, count, env) {
      const url = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=0&count=${Math.max(count * 4, 10)}&mmasync=1`
      const res = await env.fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: env.signal })
      if (!res.ok)
        throw httpError(res.status, await res.text())
      return bingItems(await res.text()).flatMap((x): ImageCandidate[] => {
        const img = str(x.murl)
        const thumb = str(x.turl)
        if (!img && !thumb)
          return []
        const page = str(x.purl) || undefined
        let site: string | undefined
        try {
          site = page ? new URL(page).hostname : undefined
        }
        catch {
          site = undefined // 来源页地址不规范：不显示站点而已
        }
        return [{ url: img || thumb, fallback: img && thumb ? thumb : undefined, title: plain(str(x.t)) || undefined, page, site }]
      })
    },
  },
  so360: {
    id: 'so360',
    title: '360 图片搜索',
    async search(query, count, env) {
      const url = `https://image.so.com/j?q=${encodeURIComponent(query)}&sn=0&pn=${Math.max(count * 4, 10)}`
      const res = await env.fetch(url, { headers: { 'user-agent': UA }, signal: env.signal })
      if (!res.ok)
        throw httpError(res.status, await res.text())
      const body = await res.json() as { list?: Record<string, unknown>[] }
      return (body.list ?? []).flatMap((x): ImageCandidate[] => {
        const img = str(x.img)
        const thumb = str(x.thumb_bak) || str(x.thumb)
        if (!img && !thumb)
          return []
        return [{ url: img || thumb, fallback: img && thumb ? thumb : undefined, title: plain(str(x.title)) || undefined, page: str(x.link) || undefined, site: str(x.site) || undefined }]
      })
    },
  },
}

export const DOWNLOAD_HEADERS = { 'user-agent': UA }
