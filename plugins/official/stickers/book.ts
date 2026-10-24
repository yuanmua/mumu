/**
 * 表情包库：一个目录 + index.json。每张：一句描述、情绪 / 场景标签、什么时候发合适、审核结论、从哪来，
 * 以及群友是在什么话后面发它的（学用法：见过别人怎么用就学会了）。
 *
 * 立场：
 * - 发之前一律审核：能发 = 审核通过（ok:true）且没被主人禁用；没审的只有主人手放进目录的那种可发。
 *   旧版本规则审过的照旧可发，后台按新规则再审一遍（REVIEW_VERSION）。
 * - 选图不调模型：描述与每张的标签、描述、用途、学到的语境比字面重合——发表情包要快，选得差一点也像真人。
 * - 审核没过的网上候选不落盘，只记内容摘要进 rejected.json，下次搜到同一张直接跳过、不再花一次看图。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

export interface StickerContext { text: string, channel: string, at: number }

/** 从哪来：群里收的 / 网上找的 / 主人手放的 */
export interface StickerSource {
  kind: 'group' | 'web' | 'manual'
  channel?: string // group：哪个频道
  provider?: string // web：哪个来源
  url?: string // web：图片地址
  page?: string // web：所在页面
  query?: string // web：按什么描述找到的
}

export interface ReviewNote {
  at: number
  version: number
  emotion?: string
  isSticker?: boolean
  flags?: string[] // 沾上的审核条目（原文）
}

export interface Sticker {
  file: string
  desc: string
  tags: string[] // 情绪 / 语气 / 场景
  usage?: string // 什么时候发合适
  ok?: boolean // 审核结论：true 可发；false 收着但永远不发；undefined 还没审
  reason?: string
  review?: ReviewNote
  disabled?: boolean // 主人禁用（与审核分开：恢复后审核结论还在）
  at: number
  source?: StickerSource
  from?: string // 旧字段：收集来的频道（现在写进 source）
  seen?: number // 群里见过几次
  contexts?: StickerContext[] // 群友发它之前在聊什么
  sent?: number // 她发过几次
  lastSentAt?: number
}

const EXT: Record<string, string> = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/jpeg': '.jpg' }
const IMAGE = new Set(['.png', '.gif', '.webp', '.jpg', '.jpeg'])

/** 只认真正的图片头；不是图片返回 undefined（网上下来的可能是一张「防盗链」网页） */
export function imageType(b: Buffer): string | undefined {
  if (b.length < 12)
    return undefined
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47)
    return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return 'image/gif'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  if (b[0] === 0xFF && b[1] === 0xD8)
    return 'image/jpeg'
  return undefined
}

const MIME: Record<string, string> = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
export const mimeOf = (file: string): string => MIME[extname(file).toLowerCase()] ?? 'image/jpeg'

export const fileOf = (bytes: Buffer, mime: string): string =>
  `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}${EXT[mime] ?? '.jpg'}`

export class StickerBook {
  readonly dir: string
  private list: Sticker[] = []
  private rejected = new Map<string, string>() // 内容摘要（去扩展名）→ 原因
  private lastSent = new Map<string, string>()

  constructor(dir: string, private max: number, private maxContexts: number) {
    this.dir = resolve(dir)
    // 归档（data/backups/**）是存档不是库：指过去就会把测试时收的图当正式表情包发出去（2026-10-22 出过一次）
    if (/[\\/]backups([\\/]|$)/.test(this.dir))
      throw new Error(`表情包目录不能在归档里：${this.dir}`)
    this.load()
  }

  get size(): number {
    return this.usable().length
  }

  all(): Sticker[] {
    return this.list
  }

  usable(): Sticker[] {
    return this.list.filter(canSend)
  }

  has(file: string): Sticker | undefined {
    return this.list.find(s => s.file === file)
  }

  /** 出现最多的标签：进 marker 词汇，教模型用哪些词 */
  topTags(n: number): string[] {
    const count = new Map<string, number>()
    for (const s of this.usable()) {
      for (const t of s.tags) count.set(t, (count.get(t) ?? 0) + 1)
    }
    return [...count].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t)
  }

  /**
   * 按描述挑一张：取分数接近最高分的几张随机一张，同一频道上一张不重复。
   * minScore：多像才算「有合适的」；对方明说要、网上也没找到时调用方会放宽到 0（有就发一张）。
   */
  pick(query: string, channel: string, minScore = 1): Sticker | undefined {
    const q = query.trim()
    const pool = this.usable()
    if (!pool.length)
      return undefined
    const scored = pool.map(s => ({ s, score: q ? score(q, s) : 0 })).filter(x => x.score >= minScore)
    if (!scored.length)
      return undefined
    scored.sort((a, b) => b.score - a.score)
    const top = scored.filter(x => x.score >= scored[0].score * 0.8).map(x => x.s)
    const choices = top.length > 1 ? top.filter(s => s.file !== this.lastSent.get(channel)) : top
    return choices[Math.floor(Math.random() * choices.length)]
  }

  read(s: Sticker): Buffer {
    return readFileSync(join(this.dir, s.file))
  }

  /** 网上那张审核没过：只记摘要，图不落盘 */
  isRejected(file: string): string | undefined {
    return this.rejected.get(file.replace(/\.\w+$/, ''))
  }

  reject(file: string, reason: string): void {
    this.rejected.set(file.replace(/\.\w+$/, ''), reason)
    if (this.rejected.size > 2000)
      this.rejected.delete(this.rejected.keys().next().value!)
    this.saveRejected()
  }

  /** 收一张新的；满了不收。返回收下的条目（已有就返回旧的） */
  add(bytes: Buffer, mime: string, meta: Pick<Sticker, 'desc' | 'tags'> & Partial<Sticker>): Sticker | undefined {
    const file = fileOf(bytes, mime)
    const old = this.has(file)
    if (old)
      return old
    if (this.list.length >= this.max)
      return undefined
    writeFileSync(join(this.dir, file), bytes)
    const s: Sticker = { seen: 0, ...meta, file, at: Date.now() }
    this.list.push(s)
    this.save()
    return s
  }

  /** 审核与打标的结果补进来 */
  reviewed(file: string, r: { desc?: string, tags?: string[], usage?: string, ok: boolean, reason?: string, review: ReviewNote }): void {
    const s = this.has(file)
    if (!s)
      return
    if (r.desc)
      s.desc = r.desc
    if (r.tags?.length)
      s.tags = [...new Set([...r.tags, ...s.tags])].slice(0, 8)
    s.usage = r.usage ?? s.usage
    s.ok = r.ok
    s.reason = r.ok ? undefined : r.reason
    s.review = r.review
    this.save()
  }

  setDisabled(file: string, disabled: boolean): boolean {
    const s = this.has(file)
    if (!s)
      return false
    s.disabled = disabled || undefined
    this.save()
    return true
  }

  /** 删掉这张（文件一起删）；以后再见到同一张也不收 */
  remove(file: string, why = '主人删除'): boolean {
    const s = this.has(file)
    if (!s)
      return false
    this.list = this.list.filter(x => x !== s)
    rmSync(join(this.dir, s.file), { force: true })
    this.reject(s.file, why)
    this.save()
    return true
  }

  /** 真的发出去了才记（QQ 发送成功 / 网页挂上图） */
  markSent(file: string, channel: string): void {
    const s = this.has(file)
    if (!s)
      return
    this.lastSent.set(channel, s.file)
    s.sent = (s.sent ?? 0) + 1
    s.lastSentAt = Date.now()
    this.save()
  }

  /** 群友又发了一次：记下是在什么话后面发的（学用法） */
  learn(file: string, ctx: StickerContext | undefined): void {
    const s = this.has(file)
    if (!s)
      return
    s.seen = (s.seen ?? 0) + 1
    if (ctx?.text && !(s.contexts ?? []).some(c => c.text === ctx.text))
      s.contexts = [...(s.contexts ?? []), ctx].slice(-this.maxContexts)
    this.save()
  }

  private load(): void {
    mkdirSync(this.dir, { recursive: true })
    const index = join(this.dir, 'index.json')
    if (existsSync(index)) {
      try {
        const arr = JSON.parse(readFileSync(index, 'utf8')) as Sticker[]
        this.list = arr.filter(s => s && typeof s.file === 'string' && existsSync(join(this.dir, s.file)))
        // 旧数据：from → source；旧版网页「禁用」写在审核结论里，挪到 disabled
        for (const s of this.list) {
          if (!s.source && s.from)
            s.source = { kind: 'group', channel: s.from }
          if (s.ok === false && s.reason === '主人在网页上禁用') {
            s.disabled = true
            s.ok = true
            s.reason = undefined
          }
        }
      }
      catch (e) {
        console.error('[stickers] index.json 读不了，按空库处理（文件没动）:', e)
      }
    }
    const rej = join(this.dir, 'rejected.json')
    if (existsSync(rej)) {
      try {
        this.rejected = new Map(Object.entries(JSON.parse(readFileSync(rej, 'utf8')) as Record<string, string>))
      }
      catch {
        // 拒绝名单坏了只是会重新审一次，不影响收发
      }
    }
    // 手放进目录、还没登记的图：文件名即描述，算主人放的
    const known = new Set(this.list.map(s => s.file))
    for (const f of readdirSync(this.dir)) {
      const ext = extname(f).toLowerCase()
      if (!IMAGE.has(ext) || known.has(f))
        continue
      const desc = f.slice(0, -ext.length)
      this.list.push({ file: f, desc, tags: desc.split(/[-_，,、\s]+/).filter(Boolean), at: Date.now(), source: { kind: 'manual' } })
    }
  }

  private save(): void {
    writeFileSync(join(this.dir, 'index.json'), `${JSON.stringify(this.list, null, 1)}\n`)
  }

  private saveRejected(): void {
    writeFileSync(join(this.dir, 'rejected.json'), `${JSON.stringify(Object.fromEntries(this.rejected), null, 1)}\n`)
  }
}

/** 能不能发：审核过、没被禁用；没审的只有主人手放的可发 */
export function canSend(s: Sticker): boolean {
  return !s.disabled && (s.ok === true || (s.ok === undefined && s.source?.kind === 'manual'))
}

/**
 * 字面打分：标签完全相同最重，互相包含次之；描述里出现；用途与学到的语境按双字词重合加分；单字重合垫底。
 * 学到的语境权重低（别人在那句话后面发它，不代表她这句也合适），但能把「同一个情绪的几张」排出先后。
 */
export function score(q: string, s: Sticker): number {
  let n = 0
  for (const t of s.tags) {
    if (t === q)
      n += 10
    else if (t.includes(q) || q.includes(t))
      n += 5
  }
  if (s.desc.includes(q))
    n += 4
  n += grams(q, s.usage ?? '') * 1.5
  n += grams(q, (s.contexts ?? []).map(c => c.text).join(' ')) * 0.5
  const chars = new Set([...q])
  for (const c of new Set([...s.desc, ...s.tags.join('')])) {
    if (chars.has(c))
      n += 0.5
  }
  return n
}

function grams(a: string, b: string): number {
  const g = (s: string): Set<string> => {
    const t = s.replace(/[^\p{L}\p{N}]/gu, '')
    const out = new Set<string>()
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const x = g(a)
  let n = 0
  for (const k of g(b)) {
    if (x.has(k))
      n++
  }
  return n
}
