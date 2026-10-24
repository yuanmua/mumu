/**
 * 网页要看得见 QQ 里的图：收到的图片 / 表情包、她发出的表情包，都存进媒体目录（默认 data/media），
 * 网页用 surface-web 现成的 GET /api/media/<名字> 显示（docs/web-protocol.md §3）。
 *
 * 文件名 = 内容 sha1 前 16 位 + 扩展名，与 action-image 同一约定：同一张图只存一份。
 * 头像用 QQ 公开的头像地址，不下载。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ImageRef } from './inbound.ts'
import { imageLabel } from './inbound.ts'
import type { Seen } from './vision.ts'
import { download, sniff } from './vision.ts'

const EXT: Record<string, string> = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/jpeg': '.jpg' }

export interface MediaRef {
  kind: 'image' | 'sticker'
  media: string // 媒体目录里的文件名
  url: string // 网页显示用
  mime: string
  alt?: string // 一句描述；网页加载不了图时显示它
  what?: string // 图片 / 截图 / 表情包…：原图进上下文时占位写成「[what]」
  shown?: string // 感知文字里这张图的原文（「[图片：…]」），原图进上下文时换掉它（inline.ts）
  inline?: { media: string, bytes: number } // 给模型看的副本（长边 maxSide 的 JPEG）；没有 = 这张不带原图
}

export class MediaStore {
  readonly dir: string

  constructor(dir: string, private maxBytes: number) {
    this.dir = resolve(dir)
  }

  /** 存一张，返回文件名；太大或写不进去返回 undefined（只是网页看不到图，不影响聊天） */
  save(bytes: Buffer, mime: string): string | undefined {
    if (!bytes.length || bytes.length > this.maxBytes)
      return undefined
    const name = `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}${EXT[mime] ?? '.jpg'}`
    try {
      mkdirSync(this.dir, { recursive: true })
      const path = join(this.dir, name)
      if (!existsSync(path))
        writeFileSync(path, bytes)
      return name
    }
    catch (e) {
      console.warn('[surface-onebot] 存图失败:', e instanceof Error ? e.message : e)
      return undefined
    }
  }

  ref(kind: MediaRef['kind'], name: string, mime: string, alt?: string): MediaRef {
    return { kind, media: name, url: `/api/media/${encodeURIComponent(name)}`, mime, ...(alt ? { alt } : {}) }
  }
}

export const avatarOf = (qq: string): string => `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`
export const groupAvatarOf = (group: string): string => `https://p.qlogo.cn/gh/${group}/${group}/100`

/** OneBot 段里的 base64://… → 字节；不是 base64 返回 undefined */
export function fromBase64Ref(file: unknown): Buffer | undefined {
  const s = typeof file === 'string' ? file : ''
  return s.startsWith('base64://') ? Buffer.from(s.slice('base64://'.length), 'base64') : undefined
}

/** 网页显示 QQ 会话要的「来源」：群还是私聊、叫什么、谁说的、头像 */
export interface QqSource {
  platform: 'qq'
  kind: 'group' | 'private'
  chatId: string
  chatTitle: string
  chatAvatar: string
  senderId?: string
  senderName?: string
  senderAvatar?: string
}

export interface MediaKitDeps {
  store: MediaStore
  saveMedia: boolean
  timeoutMs: number
  see: (img: ImageRef, raw: { bytes: Buffer, mime: string } | undefined, at: { channel: string, sentAt?: number }) => Promise<Seen | undefined>
  /** 另存一份给模型看的副本（inline.ts）；不做返回 undefined */
  inline: (raw: { bytes: Buffer, mime: string }, sticker: boolean) => Promise<MediaRef['inline']>
  append:(type: string, data: Record<string, unknown>) => void
  groupName: (group: string) => string | undefined
  privateName: (user: string) => string | undefined
}

/**
 * 收图 / 发图 / 来源三件事的接线：
 * - describe：下载一次原图 → 存进媒体目录（网页看）→ 交给看图（导演看；表情包由看图交给 stickers 插件，顺手收进库），
 *   同时另存给模型看的副本（原图进上下文用，inline.ts）；
 * - sent：她真正发出一张表情包 / 图片（base64 的）后记一条 surface.media，网页按 uttId 挂到那条发言上
 *   （发言片段在到达表现端前就进了日志，表现端没法回头给它补 url）；
 * - source：拼来源字段。
 */
export function mediaKit(d: MediaKitDeps) {
  return {
    /** 返回感知里写成「[what：desc]」的那两样；看不成也有一句（「没看清」），只有本来就没地址的才返回 undefined */
    async describe(img: ImageRef, channel: string, refs: MediaRef[], sentAt?: number): Promise<{ what?: string, desc: string } | undefined> {
      const raw = img.url ? await download(img.url, AbortSignal.timeout(d.timeoutMs)) : undefined
      const name = raw && d.saveMedia ? d.store.save(raw.bytes, raw.mime) : undefined
      // 缩副本和看图同时做：看图要等模型，缩图只是几十毫秒的本机活，不多占感知进来前的等待
      const [seen, inline] = await Promise.all([
        d.see(img, raw, { channel, sentAt }),
        name && raw ? d.inline(raw, img.sticker).catch(() => undefined) : undefined,
      ])
      const said = seen && { what: seen.what, desc: seen.desc }
      if (name && raw) {
        const ref = d.store.ref(img.sticker ? 'sticker' : 'image', name, raw.mime, seen && !seen.failed ? seen.desc : img.summary)
        refs.push({ ...ref, what: seen?.what ?? (img.sticker ? '表情包' : '图片'), shown: imageLabel(img, said), ...(inline ? { inline } : {}) })
      }
      return said
    },
    sent(channel: string, uttId: string | undefined, data: Record<string, unknown> | undefined, alt?: string): void {
      const bytes = fromBase64Ref(data?.file)
      if (!bytes || !d.saveMedia)
        return
      const mime = sniff(bytes)
      const name = d.store.save(bytes, mime)
      if (!name)
        return
      const ref = d.store.ref(String(data?.sub_type) === '1' ? 'sticker' : 'image', name, mime, alt)
      // utt / url 与 docs/web-protocol.md 里 sticker.sent 的同名字段对齐，网页按 utt 挂到那条发言上
      d.append('surface.media', { uttId, utt: uttId, channel, platform: 'qq', ...ref })
    },
    /** docs/web-protocol.md §5 约定的平铺字段：chat / groupName（只在拿到真群名时给）/ avatar / images */
    webFields(channel: string, sender?: { id: string }, media: MediaRef[] = []): Record<string, unknown> {
      const [, kind, id] = channel.split(':')
      const name = kind === 'group' ? d.groupName(id) : undefined
      return {
        chat: kind === 'group' ? 'group' : 'private',
        ...(name ? { groupName: name } : {}),
        ...(sender ? { avatar: avatarOf(sender.id) } : {}),
        ...(media.length ? { images: media.map(m => ({ url: m.url, ...(m.alt ? { alt: m.alt } : {}), ...(m.kind === 'sticker' ? { sticker: true } : {}) })) } : {}),
      }
    },
    source(channel: string, sender?: { id: string, name?: string }): QqSource | undefined {
      const [p, kind, id] = channel.split(':')
      if (p !== 'qq' || (kind !== 'group' && kind !== 'private') || !id)
        return undefined
      const title = kind === 'group' ? d.groupName(id) ?? `群 ${id}` : d.privateName(id) ?? sender?.name ?? id
      return {
        platform: 'qq',
        kind,
        chatId: id,
        chatTitle: title,
        chatAvatar: kind === 'group' ? groupAvatarOf(id) : avatarOf(id),
        ...(sender ? { senderId: sender.id, senderName: sender.name ?? sender.id, senderAvatar: avatarOf(sender.id) } : {}),
      }
    },
  }
}
