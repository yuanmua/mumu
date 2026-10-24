/**
 * 审核 + 打标：一次看图调用，两件事并成一份提示词——
 * 打标（情绪、语气或常见使用场景标签，最多 5 个）+ 过滤（公序良俗、不是截图、字不多），
 * 再加沐沐自己的硬规矩（rules，可配）。输出 JSON，用 JSON.parse 读，不用正则抠。
 *
 * 判定不全信模型的 ok：isSticker 为真、flags 为空、模型说 ok、描述里不含禁词——四样都满足才通过。
 * 看不了（模型挂了、超时、没按 JSON 回）返回 undefined：调用方按「没审」处理，网上找来的就不入库（宁缺毋滥）。
 * 多模态数组的类型断言与 surface-onebot/vision.ts 同理：内核 ChatMessage.content 声明是 string，provider 原样转发。
 */
import type { ChatMessage, ModelRequest } from '../../../src/index.ts'

/** 审核规则改了就加一：库里旧版本审过的会在后台按新规则再审 */
export const REVIEW_VERSION = 2

/** 不合适的标准（写死在默认值里，配置 review.rules 可整份替换） */
export const DEFAULT_RULES = [
  '色情、擦边、裸露或性暗示',
  '暴力、血腥、恐怖、自残、虐待动物',
  '政治人物、国家领导人、政党 / 国旗 / 军队 / 宗教等敏感符号，或时政话题',
  '真人照片（明星、网红、路人、自拍），或可能泄露隐私的内容（证件、聊天记录、手机号、住址、车牌）',
  '广告、二维码、联系方式、网址，或明显的网站水印、商标',
  '辱骂、歧视、低俗、违法违规的文字',
  '任何形式的截图（聊天记录、视频、网页、游戏、电视画面）',
]

export interface ReviewConfig {
  role?: string
  rules?: string[]
  maxChars?: number // 图上的字最多几个（中文表情包常带一句话，放宽）
  blockWords?: string[] // 描述 / 标签里出现就不要（兜底：模型漏报时还有一道）
  timeoutMs?: number
}

export interface Review {
  desc?: string
  emotion?: string
  tags: string[]
  usage?: string
  isSticker: boolean
  flags: string[] // 沾上的规则原文
  ok: boolean
  reason?: string
}

export function reviewPrompt(cfg: ReviewConfig): string {
  const rules = [...(cfg.rules ?? DEFAULT_RULES), `图上的字超过 ${cfg.maxChars ?? 12} 个`]
  return `这张图可能是一个聊天用的表情包。看图后只输出一个 JSON 对象，不要解释：
{"desc":"…","emotion":"…","tags":["…"],"usage":"…","isSticker":true,"flags":[],"ok":true,"reason":""}
- desc：一句话（不超过 20 字）说出画面和上面的字。
- emotion：它主要表达的情绪，一个词。
- tags：它主要表达的情绪、语气或常见使用场景标签，最多 5 个，每个 2～4 字。
- usage：一句话（不超过 20 字）说聊天里什么时候发它合适。
- isSticker：是不是聊天用的表情包（卡通、动漫、动物、手绘、配字小图）。普通照片、海报、商品图、截图都不算。
- flags：下面哪几条它沾上了，就写那几条的编号（数字），一条都没有就是空数组；拿不准就算沾上，宁可多报：
${rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}
- ok：isSticker 为 true 且 flags 为空才是 true。
- reason：ok 为 false 时一句话说原因。`
}

export async function review(
  complete: (req: ModelRequest) => Promise<string>,
  bytes: Buffer,
  mime: string,
  cfg: ReviewConfig,
  signal?: AbortSignal,
  frames = false, // 动图抽了几帧拼成一张（告诉模型怎么看）
): Promise<Review | undefined> {
  const content = [
    { type: 'text', text: (frames ? '（这是动图：按时间顺序抽了几帧，从左到右拼在一起，当成一个表情包看。）\n' : '') + reviewPrompt(cfg) },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
  ]
  const messages = [{ role: 'user', content }] as unknown as ChatMessage[]
  const timeout = AbortSignal.timeout(cfg.timeoutMs ?? 45_000)
  let text: string
  try {
    text = await complete({ role: cfg.role ?? 'vision.read', messages, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  }
  catch (e) {
    console.warn('[stickers] 看图审核失败:', e instanceof Error ? e.message : e)
    return undefined
  }
  return parseReview(text, cfg)
}

/** 模型回的 JSON → 审核结论；不是 JSON 返回 undefined。判定见文件头 */
export function parseReview(text: string, cfg: ReviewConfig = {}): Review | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  }
  catch {
    return undefined
  }
  const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : undefined
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean).slice(0, 5) : []
  const rules = [...(cfg.rules ?? DEFAULT_RULES), `图上的字超过 ${cfg.maxChars ?? 12} 个`]
  const flags = (Array.isArray(o.flags) ? o.flags : [])
    .map(f => typeof f === 'number' ? rules[f - 1] : typeof f === 'string' ? rules[Number(f) - 1] ?? f : undefined)
    .filter((f): f is string => Boolean(f))
  const desc = str(o.desc)
  const isSticker = o.isSticker !== false
  const words = (cfg.blockWords ?? []).filter(w => w && [desc ?? '', ...tags, str(o.emotion) ?? ''].some(t => t.includes(w)))
  const ok = o.ok === true && isSticker && !flags.length && !words.length
  const reason = ok
    ? undefined
    : !isSticker
        ? str(o.reason) ?? '不是表情包'
        : flags.length
          ? `沾上了：${flags.join('；')}`
          : words.length
            ? `描述里有不合适的词：${words.join('、')}`
            : str(o.reason) ?? '模型判定不合适'
  return { desc, emotion: str(o.emotion), tags, usage: str(o.usage), isSticker, flags, ok, reason }
}
