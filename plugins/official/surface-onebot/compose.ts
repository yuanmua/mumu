/**
 * 发言 → QQ 消息段。
 *
 * 发言里的两个 marker 不单独成条，而是并进下一条消息（outbox 负责「下一条」）：
 * - <|quote|>       引用对方最近一条；<|quote:名字|> 引用那个人最近一条
 * - <|at:名字或QQ号|> @ 那个人；认不出是谁就写成「@名字」文字，好过丢掉
 * 另外，别的动作发出的图片片段 Part{kind:'image', data:{media}}（如 action-image 的截图 / 找到的图）
 * 单独成条发出：文件在 mediaDir/<media>，NapCat 与沐沐同机，给本机路径即可。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Memory } from './cache.ts'
import { parseChannel } from './actions.ts'
import type { OutItem } from './outbox.ts'
import type { Segment } from './segments.ts'
import { fileRef, seg } from './segments.ts'

export function inlineSegment(memory: Memory, selfId: string | undefined, channel: string, part: { kind: string, data?: Record<string, unknown> }): Segment | undefined {
  const track = part.kind === 'marker' ? String(part.data?.track ?? '') : ''
  const value = String(part.data?.value ?? '').trim()
  if (track === 'quote') {
    const m = memory.lastFrom(channel, selfId, value || undefined)
    return m ? seg.reply(m.messageId) : undefined
  }
  if (track === 'at' && value) {
    const t = parseChannel(channel)
    const id = memory.resolve(t?.type === 'group' ? t.id : undefined, value)
    return id ? seg.at(id) : seg.text(`@${value} `)
  }
  return undefined
}

/** 图片片段 → 一条图片消息；media 只认纯文件名（不许带路径），文件不在就不发 */
export function mediaItem(dir: string, part: { kind: string, data?: Record<string, unknown> }): OutItem | undefined {
  if (part.kind !== 'image')
    return undefined
  const media = String(part.data?.media ?? '')
  if (!/^[\w-][\w.-]*$/.test(media))
    return undefined
  const path = resolve(dir, media)
  if (!existsSync(path)) {
    console.warn(`[surface-onebot] 图片 ${media} 不在 ${dir}，没发`)
    return undefined
  }
  const alt = typeof part.data?.alt === 'string' ? part.data.alt : undefined
  return { kind: 'extra', part: { kind: 'image', data: { file: fileRef(path), ...(alt ? { summary: `[${alt.slice(0, 20)}]` } : {}) } }, raw: 0 }
}

export function toMessage(item: OutItem): Segment[] {
  if (item.kind === 'extra')
    return [{ type: item.part.kind, data: item.part.data ?? {} }]
  return item.msg ?? (item.text ? [seg.text(item.text)] : [])
}
