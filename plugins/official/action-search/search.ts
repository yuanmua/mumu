/**
 * 一次搜索：调来源 → 整理成她能读的一段话。不碰 ctx，依赖全从参数进，单测 mock fetch 就能跑。
 *
 * 契约：永不抛错。成功、没结果、没密钥、超时、服务报错都落成一个 Outcome，`text` 是给大脑和发言者读的人话，
 * 失败时写清原因（她会照着跟对方说，所以别带技术栈名词以外的噪音）。
 * 网页 / 新闻在这里；图片（几家并行、下载、看图挑图）在 images.ts。
 */
import { searchImages } from './images.ts'
import type { Env, Kind, WebHit } from './providers.ts'
import { SearchError, WEB_PROVIDERS } from './providers.ts'

export { imageType } from './images.ts'

export interface SearchConfig {
  provider?: string // 网页 / 新闻来源
  endpoint?: string // 网页来源的接口地址；空 = 该家默认
  imageProviders?: string[] // 图片来源，几家并行
  apiKeyRef?: string // secrets 里密钥的名字
  count?: number // 网页 / 新闻默认几条
  imageCount?: number // 图片默认几张
  timeoutMs?: number // 搜索请求的时限
  imageBudgetMs?: number // 图片下载 + 看图一共多久
  newsDays?: number // news 只要最近几天的
  snippetChars?: number // 每条摘要最多几个字
  dir?: string // 图片下载目录
  keep?: number // 下载目录最多留几张
  maxMB?: number // 单张图上限
  look?: boolean // 下载的图交看图模型过一眼
}

export interface Look { desc?: string, ok: boolean, fit?: boolean, why?: string } // fit = 和搜的东西对得上

export interface SearchDeps {
  fetch: typeof fetch
  key: (name: string) => string | undefined
  look?: (bytes: Buffer, mime: string, query: string, signal: AbortSignal) => Promise<Look | undefined>
  now?: () => number
}

export interface ImageHit { path: string, url: string, page?: string, site?: string, title?: string, desc?: string, checked: boolean, fit?: boolean }

export interface Outcome {
  ok: boolean
  kind: Kind
  query: string
  provider: string
  text: string
  error?: string
  hits?: WebHit[]
  images?: ImageHit[]
  dropped?: number // 看图后觉得不能发、扔掉的
  unfit?: boolean // 图看过都跟要找的对不上：别发，换词再搜
  meaning?: WebHit[] // 图对不上时附上的「这个词网上指什么」
  elapsedMs: number
}

const KIND_NAME: Record<Kind, string> = { web: '网页', news: '新闻', image: '图片' }

export function normalize(params: Record<string, unknown>, cfg: SearchConfig): { query: string, kind: Kind, count: number } {
  const query = String(params.query ?? params.q ?? '').trim().slice(0, 128)
  const kind: Kind = params.kind === 'image' || params.kind === 'news' ? params.kind : 'web'
  const fallback = kind === 'image' ? cfg.imageCount ?? 3 : cfg.count ?? 5
  const n = Number(params.count)
  const count = Math.round(Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : fallback, 1), kind === 'image' ? 6 : 10))
  return { query, kind, count }
}

export async function runSearch(params: Record<string, unknown>, cfg: SearchConfig, deps: SearchDeps, outer?: AbortSignal): Promise<Outcome> {
  const now = deps.now ?? Date.now
  const started = now()
  const { query, kind, count } = normalize(params, cfg)
  const providerId = cfg.provider ?? 'deepseek'
  const done = (o: Omit<Outcome, 'kind' | 'query' | 'elapsedMs'>): Outcome =>
    ({ kind, query, elapsedMs: now() - started, ...o })
  const fail = (error: string): Outcome =>
    done({ ok: false, provider: providerId, error, text: `搜「${query || '（没给关键词）'}」没搜成：${error}` })

  if (!query)
    return fail('没给关键词')
  const timeoutMs = cfg.timeoutMs ?? 15_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout
  const env = (key?: string): Env => ({ fetch: deps.fetch, endpoint: cfg.endpoint, key, signal, now: now(), newsDays: cfg.newsDays ?? 7 })
  const why = (e: unknown): string => {
    if (e instanceof SearchError)
      return e.message
    if (timeout.aborted)
      return `搜索超时（${Math.round(timeoutMs / 1000)} 秒没回）`
    if (outer?.aborted)
      return '搜索被叫停了'
    return `连不上搜索服务（${e instanceof Error ? e.message : String(e)}）`
  }

  if (kind === 'image')
    return done(await searchImages({ query, count, cfg, deps, env, why, outer }))

  const p = WEB_PROVIDERS[providerId]
  if (!p)
    return fail(`不认识的搜索来源「${providerId}」`)
  const keyName = cfg.apiKeyRef ?? 'deepseek'
  const key = p.needsKey ? deps.key(keyName) : undefined
  if (p.needsKey && !key)
    return fail(`没有搜索密钥（要主人在网页「密钥」里填「${keyName}」，或 /secret set ${keyName} <key>）`)
  let hits: WebHit[]
  try {
    hits = (await p.search(query, count, kind, env(key))).slice(0, count)
  }
  catch (e) {
    return fail(why(e))
  }
  if (!hits.length)
    return done({ ok: true, provider: providerId, hits, text: `搜「${query}」（${KIND_NAME[kind]}，${p.title}）什么都没搜到。` })
  return done({ ok: true, provider: providerId, hits, text: webText(query, kind, p.title, hits, cfg.snippetChars ?? 160) })
}

function webText(query: string, kind: Kind, title: string, hits: WebHit[], max: number): string {
  const lines = hits.map((h, i) => {
    const meta = [h.site, h.date?.slice(0, 10)].filter(Boolean).join(' · ')
    const snip = h.snippet.length > max ? `${h.snippet.slice(0, max)}…` : h.snippet
    return `${i + 1}. ${h.title}${meta ? `（${meta}）` : ''}\n   ${snip}\n   ${h.url}`
  })
  return `搜「${query}」（${KIND_NAME[kind]}，${title}）找到 ${hits.length} 条：\n${lines.join('\n')}`
}
