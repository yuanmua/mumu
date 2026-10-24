/**
 * 消息上的图片附件 → OpenAI 多模态 content（文字段 + image_url 段）。
 *
 * 立场：
 * - 内核的 ChatMessage.content 是字符串（冻结契约 ProviderAdapter 用它），不为图片改内核：要带原图的调用方
 *   在消息对象上挂插件层字段 `images`（媒体目录里的文件名 + 字节数），网关原样转发、原样落日志，到这里发请求时才读文件转 base64。
 *   日志里只有文件名和字节数：同一张图每拍都带，base64 落进 model.request，热闹的群一天就是几百 MB；
 *   媒体目录按内容摘要命名、不覆盖，凭文件名就还原得出模型看到的那张（I1）。
 * - 文件读不到（被清理了）退回文字「[图片：alt]」：一张图不该把整次发言弄挂。
 * - label：一条消息里有好几张、要分清哪张是哪张时（大脑的【最近对话】是一整段文字），在那张图前面插一段文字。
 * - 换了不认 `images` 的 provider：附件被忽略，正文里只剩「[图片]」，她只是看不到图，不会出错。
 */
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ChatMessage } from '../../../src/index.ts'

export interface ImageAttachment {
  media: string // 媒体目录里的文件名
  bytes: number // 文件大小：model.request 日志里看得出这次带了几张、多少字节
  mime?: string
  alt?: string // 一句描述：文件读不到时退回成文字
  label?: string // 图前面插的一段文字，如「[图片1]」
}

/** 可以带原图的消息：其余字段与内核的 ChatMessage 一样 */
export type ImageMessage = ChatMessage & { images?: ImageAttachment[] }

type Part = { type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }
export interface WireMessage { role: ChatMessage['role'], content: string | Part[] }

const MIME: Record<string, string> = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }

const asText = (a: ImageAttachment): string => `${a.label ?? ''}[图片${a.alt ? `：${a.alt}` : ''}]`

export const hasImages = (messages: ImageMessage[]): boolean => messages.some(m => m.images?.length)

/**
 * 模型拒收图（4xx：绑了不认图的模型、某张图它不吃）时退回纯文字：附件换回描述。
 * 不退的话，那张图还在「最近几张」里的十几分钟，她每次开口都失败
 */
export function withoutImages(messages: ImageMessage[]): ImageMessage[] {
  return messages.map(({ images, ...m }) => images?.length ? { ...m, content: [m.content, ...images.map(asText)].join(' ') } : m)
}

/** read 可换（单测）；读不到抛错即可 */
export function toWire(messages: ImageMessage[], dir: string, read: (path: string) => Buffer = readFileSync): WireMessage[] {
  return messages.map((m) => {
    if (!m.images?.length)
      return { role: m.role, content: m.content }
    const parts: Part[] = m.content ? [{ type: 'text', text: m.content }] : []
    for (const a of m.images) {
      let bytes: Buffer
      try {
        bytes = read(join(dir, a.media))
      }
      catch (e) {
        console.warn(`[provider-openai] 附件图片 ${a.media} 读不到，改用文字描述:`, e instanceof Error ? e.message : e)
        parts.push({ type: 'text', text: asText(a) })
        continue
      }
      if (a.label)
        parts.push({ type: 'text', text: a.label })
      const mime = a.mime ?? MIME[extname(a.media).toLowerCase()] ?? 'image/jpeg'
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } })
    }
    return { role: m.role, content: parts }
  })
}
