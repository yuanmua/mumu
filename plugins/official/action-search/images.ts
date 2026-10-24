/**
 * 搜图：几家图源并行搜 → 候选并行下载（原图取不到用缩略图）→ 按文件头认格式、存本地（按内容摘要命名）
 * → 看图模型过一眼（look.ts：图里是什么、和要找的对不对得上、能不能发群里）→ 只留能发的、对得上的。
 *
 * 为什么几家一起搜、还顺手查一次网页：模拟器 2026-10-22 搜「可爱大肥鱼」，360 给的是王者荣耀的鲲、福娃抱鱼——
 * 图源不懂这个词（网上多指 DeepSeek 的蓝鲸吉祥物）。人找图找不对会先弄清这个词指什么、换个说法再搜。
 * 所以：图全对不上时不让她硬发，结果里附上网页搜索说的这个词是什么，叫大脑换个更准的词再搜一次；
 * 找到了也附两行词义——看图只按字面判，群里说的是不是这个意思要她看上下文。
 * 看不了图（看图关了 / 模型挂了）就不知道对不对得上，按对得上处理、标「没看过」。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Env, ImageCandidate, WebHit } from './providers.ts'
import { DOWNLOAD_HEADERS, IMAGE_PROVIDERS, WEB_PROVIDERS } from './providers.ts'
import type { ImageHit, Outcome, SearchConfig, SearchDeps } from './search.ts'

export interface ImageRun {
  query: string
  count: number
  cfg: SearchConfig
  deps: SearchDeps
  env: (key?: string) => Env
  why: (e: unknown) => string
  outer?: AbortSignal
}

type Part = Omit<Outcome, 'kind' | 'query' | 'elapsedMs'>

export async function searchImages(r: ImageRun): Promise<Part> {
  const { query, count, cfg, deps } = r
  const ids = cfg.imageProviders?.length ? cfg.imageProviders : ['bing', 'so360']
  const providers = ids.flatMap(id => IMAGE_PROVIDERS[id] ? [IMAGE_PROVIDERS[id]] : [])
  const provider = providers.map(p => p.id).join('+') || ids.join('+')
  const fail = (error: string): Part => ({ ok: false, provider, error, text: `搜图「${query}」没搜成：${error}` })
  if (!providers.length)
    return fail(`不认识的图片来源「${ids.join('、')}」`)
  const title = providers.map(p => p.title).join(' + ')

  // 这个词网上指什么：和搜图同时查，图对不上时给大脑换词用。没密钥就不查
  const web = WEB_PROVIDERS[cfg.provider ?? 'deepseek']
  const key = web?.needsKey ? deps.key(cfg.apiKeyRef ?? 'deepseek') : undefined
  const meaningP: Promise<WebHit[]> = web && (!web.needsKey || key)
    ? web.search(query, 3, 'web', r.env(key)).catch(() => []) // 查不到词义只是少一段参考，不影响搜图
    : Promise.resolve([])

  const settled = await Promise.allSettled(providers.map(p => p.search(query, count, r.env())))
  const lists = settled.flatMap(s => s.status === 'fulfilled' ? [s.value] : [])
  const errors = settled.flatMap((s, i) => s.status === 'rejected' ? [`${providers[i].title}：${r.why(s.reason)}`] : [])
  const list = interleave(lists)
  if (!list.length) {
    if (errors.length === providers.length)
      return fail(errors.join('；'))
    return { ok: true, provider, images: [], text: `搜图「${query}」（${title}）一张都没找到。${meaningText(query, await meaningP)}` }
  }

  // 下载与看图另给时限：搜索接口几百毫秒就回，看图要几秒，共用一个时限会把看图掐掉
  const budget = AbortSignal.timeout(cfg.imageBudgetMs ?? 30_000)
  const signal = r.outer ? AbortSignal.any([r.outer, budget]) : budget
  const got = await fetchImages(query, list.slice(0, count * 4), count, cfg, deps, signal)
  const meaning = await meaningP
  if (!got.images.length) {
    const error = got.dropped ? '找到的图看过都不合适发' : '找到的图都下载不下来'
    return { ok: false, provider, images: [], dropped: got.dropped, error, text: `搜图「${query}」${got.dropped ? `找到的图看过都不合适发（扔了 ${got.dropped} 张）` : '找到了，但图都下载不下来（多半是防盗链）'}。` }
  }
  if (got.unfit)
    return { ok: true, provider, unfit: true, images: got.images, dropped: got.dropped, meaning, text: unfitText(query, title, got.images, meaning) }
  // 找到了也附上词义：看图只按字面判对不对得上（「大肥鱼」→ 胖鱼），群里说的可能是别的意思（DeepSeek 的蓝鲸），由她看上下文定
  const hint = meaning.length ? meaningText(query, meaning.slice(0, 2)) + '\n（对方说的要是这里的意思、上面的图却不是，就换个更准的词再 search 一次。）' : ''
  return { ok: true, provider, images: got.images, dropped: got.dropped, meaning, text: imageText(query, title, got.images, got.dropped, got.mismatched) + hint }
}

/** 几家的结果轮流取，去掉同一个地址：哪家都不独占前排 */
function interleave(lists: ImageCandidate[][]): ImageCandidate[] {
  const out: ImageCandidate[] = []
  const seen = new Set<string>()
  for (let i = 0; lists.some(l => i < l.length); i++) {
    for (const l of lists) {
      const c = l[i]
      if (c && !seen.has(c.url)) {
        seen.add(c.url)
        out.push(c)
      }
    }
  }
  return out
}

const line = (m: ImageHit, i: number): string =>
  `${i + 1}. ${m.desc ?? m.title ?? '（没说是什么）'}${m.checked ? '' : '（没看过图，只有网页标题）'}${m.site ? `　来自 ${m.site}` : ''}\n   路径：${m.path}`

function imageText(query: string, title: string, images: ImageHit[], dropped: number, mismatched: number): string {
  const extra = [dropped ? `${dropped} 张看过不合适发` : '', mismatched ? `${mismatched} 张跟要找的对不上` : ''].filter(Boolean).join('、')
  return `搜图「${query}」（${title}）找到 ${images.length} 张，已存到本地${extra ? `（另有 ${extra}，没列）` : ''}；`
    + `要发就 start image，params.path 用下面的路径：\n${images.map(line).join('\n')}`
}

function meaningText(query: string, meaning: WebHit[]): string {
  if (!meaning.length)
    return ''
  return `\n网上说的「${query}」：\n${meaning.map(h => `- ${h.title}：${h.snippet.slice(0, 80)}`).join('\n')}`
}

function unfitText(query: string, title: string, images: ImageHit[], meaning: WebHit[]): string {
  return `搜图「${query}」（${title}）找到的图看过都跟「${query}」对不上，先别发：\n${images.map(line).join('\n')}`
    + meaningText(query, meaning)
    + '\n想再找就换个更准的词再 search 一次（kind:image，比如加上它到底是什么）；还是不行就跟对方说没找到合适的。'
}

/** 按文件头认格式；image 动作只认这四种 */
export function imageType(b: Buffer): string | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47)
    return '.png'
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF)
    return '.jpg'
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8')
    return '.gif'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
    return '.webp'
  return undefined
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

interface Fetched { images: ImageHit[], dropped: number, mismatched: number, unfit: boolean }

/**
 * 下载候选、看图挑图。看的比要的多一倍（最多 8 张）：对不上的扔掉还有得挑。
 * 有对得上的就只留对得上的；一张都对不上（unfit）就把看过的都列出来，由大脑决定换词再搜。
 */
async function fetchImages(query: string, list: ImageCandidate[], want: number, cfg: SearchConfig, deps: SearchDeps, signal: AbortSignal): Promise<Fetched> {
  const dir = resolve(cfg.dir ?? 'data/search')
  const maxBytes = (cfg.maxMB ?? 10) * 1024 * 1024
  mkdirSync(dir, { recursive: true })
  const one = async (url: string, page?: string): Promise<Buffer | undefined> => {
    try {
      const res = await deps.fetch(url, { headers: { ...DOWNLOAD_HEADERS, ...(page ? { referer: page } : {}) }, signal })
      if (!res.ok)
        return undefined
      const b = Buffer.from(await res.arrayBuffer())
      return b.length <= maxBytes && imageType(b) ? b : undefined
    }
    catch {
      return undefined // 单张下载失败（防盗链、超时）只是少一张，换备用地址或下一张
    }
  }
  const got = await Promise.all(list.map(async (c) => {
    const bytes = await one(c.url, c.page) ?? (c.fallback ? await one(c.fallback) : undefined)
    return bytes ? { c, bytes } : undefined
  }))
  const looking = cfg.look !== false && !!deps.look
  const take = looking ? Math.min(want * 2, 8) : want
  const seen = new Set<string>()
  const picked: { c: ImageCandidate, bytes: Buffer, path: string }[] = []
  for (const g of got) {
    if (!g || picked.length >= take)
      continue
    const path = join(dir, `${createHash('sha256').update(g.bytes).digest('hex').slice(0, 16)}${imageType(g.bytes)}`)
    if (seen.has(path))
      continue // 同一张图两个来源
    seen.add(path)
    if (!existsSync(path))
      await writeFile(path, g.bytes)
    picked.push({ ...g, path })
  }
  prune(dir, cfg.keep ?? 200)

  const looks = await Promise.all(picked.map(p => looking
    ? deps.look!(p.bytes, MIME[imageType(p.bytes)!], query, signal).catch(() => undefined)
    : undefined))
  let dropped = 0
  const ok: ImageHit[] = []
  picked.forEach((p, i) => {
    const l = looks[i]
    if (l && !l.ok) {
      dropped++
      return
    }
    ok.push({ path: p.path, url: p.c.url, page: p.c.page, site: p.c.site, title: p.c.title, desc: l?.desc, checked: Boolean(l), ...(l?.fit === false ? { fit: false } : {}) })
  })
  const fits = ok.filter(m => m.fit !== false)
  if (fits.length)
    return { images: fits.slice(0, want), dropped, mismatched: ok.length - fits.length, unfit: false }
  return { images: ok.slice(0, want), dropped, mismatched: 0, unfit: ok.length > 0 }
}

/** 下载目录只留最近 keep 张：搜过的图大多不会发，别越攒越多 */
function prune(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir).map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(keep))
      unlinkSync(join(dir, f))
  }
  catch {
    // 清理失败（并发删了同一个文件之类）不影响这次搜索，下次再清
  }
}
