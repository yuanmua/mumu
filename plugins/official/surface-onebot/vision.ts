/**
 * 看图：把 QQ 里的图片 / 表情包交给 vision.read 角色，换成一句发言者接得上的话。
 *
 * 立场：
 * - 模型角色归 provider 绑定（vision.read 指哪个模型不归这里管），这里只按 OpenAI 的多模态格式组消息。
 *   内核的 ChatMessage.content 声明是 string；provider-openai 把 messages 原样转发，所以运行时传 content 数组能通。
 *   这是唯一一处类型断言，换了不转发数组的 provider，看图就失败——失败写成「[图片：没看清]」，不影响聊天。
 * - 先缩图（shrink.ts，动图抽几帧拼一张）：网关会把请求整条落日志，原图塞进去日志撑大、本地模型也慢。
 * - 一张图只看一次：按内容摘要记结果（内存 + cacheFile，重启也认得）；表情包交给 stickers 插件——
 *   库里有就用库里的描述，新的那张一次调用同时出描述和审核结论、顺手收进库（原来是看一遍描述、入库再看一遍审核）。
 * - 看图有上限：每个会话每分钟最多 perMinute 次真去问模型；在队里等了超过 staleSec 的图不看了（对话早过去了），
 *   写成「[图片：没顾上看]」。命中缓存的不算次数。
 * - 描述要能让发言者接得上：普通图先分清是照片 / 截图 / 带字图 / 表情包，再说画面主体、图上的字、梗或情绪。
 *   输出 JSON，用 JSON.parse 读，不用正则抠。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ChatMessage, ModelRequest } from '../../../src/index.ts'
import type { ImageRef } from './inbound.ts'
import type { Img, View } from './shrink.ts'
import { shrink } from './shrink.ts'

export interface VisionConfig {
  enabled?: boolean
  role?: string
  shrinkTo?: number // 长边像素
  maxBytes?: number // 送模型的图片上限（缩过之后）
  timeoutMs?: number
  cache?: number // 记住几张图的结果
  cacheFile?: string // 结果落盘的地方（相对后端工作目录）；空串 = 只记内存
  perMinute?: number // 每个会话每分钟最多真看几张
  staleSec?: number // 排队超过这么久的图不看了
  gifFrames?: number // 动图抽几帧拼起来
  photoPrompt?: string
  stickerPrompt?: string
}

export interface Seen {
  desc: string
  tags: string[]
  what?: string // 感知里写成「[what：desc]」：图片 / 截图 / 表情包
  failed?: boolean // 没看成（desc 是「没看清」「没顾上看」）
}

/** 表情包交给 stickers 插件看：库里有就不调模型；新的一次调用出描述 + 审核，顺手收进库。budget() 返回拒绝原因或扣一次额度 */
export type StickerSee = (a: { raw: Img, view: () => Promise<View | undefined>, channel: string, budget: () => string | undefined, sim?: boolean })
  => Promise<{ desc: string, tags: string[], emotion?: string } | { refused: string } | undefined>

/** 普通图的描述提示词：画面描述，加上分类、图上的字、梗 / 情绪 */
const PHOTO = `看这张聊天里收到的图，只输出一个 JSON 对象，不要解释：
{"kind":"照片","desc":"…","text":"…","vibe":"…"}
- kind：照片 / 截图 / 带字图 / 表情包 / 其他，选一个。
- desc：一句话说画面主体是什么、在干什么（不超过 30 字）；截图写是什么软件或网页、在说什么事。
- text：图上的字，摘最要紧的一两句原文（不超过 30 字）；没有字就空着。
- vibe：梗图、表情包或带情绪的图，一句话说它在表达什么、好笑在哪（不超过 15 字）；普通照片空着。
看不清或拿不准就照实写「看不清」，别编。`
/** 表情包的描述提示词：情绪 / 场景标签，多要一句画面描述（没装 stickers 插件时用） */
const STICKER = '这是一个表情包。用一句话（不超过 25 字）说出画面和上面的字，再提取它表达的情绪、语气或常见使用场景标签，最多 5 个，每个 2～4 字。只输出 JSON：{"desc":"…","tags":["…"]}'
const FRAMES = '（这是动图：按时间顺序抽了几帧，从左到右拼在一起。）\n'

export class Vision {
  private cache = new Map<string, Seen>()
  private recent = new Map<string, number[]>() // 会话 → 最近一分钟真看图的时间
  private file?: string
  private saving?: NodeJS.Timeout

  constructor(
    private complete: (req: ModelRequest) => Promise<string>,
    private cfg: VisionConfig,
    private stickerSee: () => StickerSee | undefined = () => undefined,
  ) {
    this.file = cfg.cacheFile === '' ? undefined : resolve(cfg.cacheFile ?? 'data/vision-cache.json')
    if (this.file && existsSync(this.file)) {
      try {
        this.cache = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Seen>))
      }
      catch {
        // 缓存坏了只是重新看一遍，不影响收图
      }
    }
  }

  /** raw：已经下载好的原图（存媒体目录也用它，同一张图不下两次）；sentAt：消息的时间（秒），排队太久就不看 */
  async see(img: ImageRef, raw: Img | undefined, at: { channel: string, sentAt?: number }): Promise<Seen | undefined> {
    if (this.cfg.enabled === false)
      return undefined
    if (!raw)
      return img.url ? fail('没看清') : undefined // 下载失败；本来就没有地址的（商城表情）交给调用方用 summary
    const budget = (): string | undefined => this.budget(at.channel, at.sentAt)
    const view = async (): Promise<View | undefined> => {
      const v = await shrink(raw, this.cfg.shrinkTo ?? 512, this.cfg.gifFrames ?? 4)
      return v.bytes.length <= (this.cfg.maxBytes ?? 400_000) ? v : undefined
    }

    const sticker = img.sticker ? this.stickerSee() : undefined
    if (sticker) {
      const r = await sticker({ raw, view, channel: at.channel, budget, sim: img.sim }).catch(() => undefined)
      if (!r)
        return fail('没看清')
      if ('refused' in r)
        return fail(r.refused)
      const mood = r.emotion && !r.desc.includes(r.emotion) ? `（${r.emotion}）` : ''
      return { what: '表情包', desc: `${r.desc}${mood}`, tags: r.tags }
    }

    const key = createHash('sha1').update(raw.bytes).digest('hex').slice(0, 20)
    const hit = this.cache.get(key)
    if (hit)
      return { ...hit }
    const refused = budget()
    if (refused)
      return fail(refused)
    const v = await view()
    if (!v)
      return fail('没看清')
    const prompt = (v.frames > 1 ? FRAMES : '') + (img.sticker ? this.cfg.stickerPrompt ?? STICKER : this.cfg.photoPrompt ?? PHOTO)
    const text = await this.look(v, prompt)
    const seen = text ? img.sticker ? parseSticker(text) : parsePhoto(text) : undefined
    if (!seen)
      return fail('没看清')
    this.remember(key, seen)
    return { ...seen }
  }

  /** 扣一次看图额度；不行返回原因 */
  private budget(channel: string, sentAt?: number): string | undefined {
    if (sentAt && Date.now() / 1000 - sentAt > (this.cfg.staleSec ?? 45))
      return '没顾上看'
    const now = Date.now()
    const list = (this.recent.get(channel) ?? []).filter(t => now - t < 60_000)
    if (list.length >= (this.cfg.perMinute ?? 10)) {
      this.recent.set(channel, list)
      return '没顾上看'
    }
    list.push(now)
    this.recent.set(channel, list)
    return undefined
  }

  private remember(key: string, seen: Seen): void {
    this.cache.set(key, seen)
    while (this.cache.size > (this.cfg.cache ?? 2000))
      this.cache.delete(this.cache.keys().next().value!)
    if (!this.file || this.saving)
      return
    this.saving = setTimeout(() => {
      this.saving = undefined
      try {
        mkdirSync(dirname(this.file!), { recursive: true })
        writeFileSync(this.file!, JSON.stringify(Object.fromEntries(this.cache)))
      }
      catch (e) {
        console.warn('[surface-onebot] 看图缓存写不进去（下次重启会重看）:', e instanceof Error ? e.message : e)
      }
    }, 5000)
    this.saving.unref()
  }

  private async look(img: Img, prompt: string): Promise<string | undefined> {
    const content = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.bytes.toString('base64')}` } },
    ]
    // 见文件头：内核类型只声明了 string，多模态数组靠 provider 原样转发
    const messages = [{ role: 'user', content }] as unknown as ChatMessage[]
    try {
      return (await this.complete({ role: this.cfg.role ?? 'vision.read', messages, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000) })).trim()
    }
    catch (e) {
      console.warn('[surface-onebot] 看图失败:', e instanceof Error ? e.message : e)
      return undefined
    }
  }
}

const fail = (desc: string): Seen => ({ desc, tags: [], failed: true })

export async function download(url: string, signal: AbortSignal): Promise<Img | undefined> {
  try {
    const res = await fetch(url, { signal })
    if (!res.ok)
      return undefined
    const bytes = Buffer.from(await res.arrayBuffer())
    return { bytes, mime: sniff(bytes) }
  }
  catch {
    return undefined // 图片链接过期 / 网络不通：写成「[图片：没看清]」
  }
}

export function sniff(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50)
    return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49)
    return 'image/gif'
  if (b.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  return 'image/jpeg'
}

function json(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  }
  catch {
    return undefined
  }
}

const str = (v: unknown, n: number): string => typeof v === 'string' ? oneLine(v).slice(0, n) : ''

/** 普通图：{kind, desc, text, vibe} → 一句；模型没按 JSON 回但给了一句话，也照用 */
export function parsePhoto(text: string): Seen | undefined {
  const o = json(text)
  if (!o) {
    const line = oneLine(text)
    return line && !line.startsWith('{') ? { what: '图片', desc: line.slice(0, 80), tags: [] } : undefined
  }
  const kind = str(o.kind, 6)
  const desc = str(o.desc, 40).replace(/[。.！!，,；;]+$/, '') // 后面还要接「，上面写着…」
  const words = str(o.text, 40)
  const vibe = str(o.vibe, 20)
  if (!desc && !words)
    return undefined
  const what = kind.includes('截图') ? '截图' : kind.includes('表情') ? '表情包' : '图片'
  const said = words && !desc.includes(words) ? `${desc ? '，' : ''}上面写着「${words}」` : ''
  return { what, desc: `${desc}${said}${vibe ? `（${vibe}）` : ''}`.slice(0, 100), tags: [] }
}

function parseSticker(text: string): Seen | undefined {
  const o = json(text)
  if (!o)
    return undefined
  const desc = str(o.desc, 40)
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean).slice(0, 5) : []
  return desc || tags.length ? { what: '表情包', desc: desc || tags.join('、'), tags } : undefined
}

function oneLine(s: string): string {
  return s.split('\n').map(l => l.trim()).filter(Boolean).join(' ')
}
