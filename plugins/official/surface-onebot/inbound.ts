/**
 * 收到的 OneBot 消息段 → 一句给模型看的文字，顺带判断「是不是在叫她」。
 *
 * 渲染是本插件的私事（内核只认 Percept.text）：@ 写成「@名字」、表情写成「[表情]」。
 * 需要再问一次 NapCat 才知道的东西（图片内容、引用的原文、转发里的聊天、语音里的话）走可选钩子；
 * 钩子没给或失败，就退回占位写法（「[图片]」「[回复]」…），不影响这条消息进感知。
 */
import type { Segment } from './segments.ts'

export interface ImageRef {
  url?: string
  file?: string
  sticker: boolean // QQ 的「动画表情 / 收藏的表情包」，sub_type 1 或商城表情
  summary?: string
  sim?: boolean // 模拟器（fake-onebot / replay）生成的图：照常描述，不收进表情包库
}

export interface RenderOptions {
  selfId?: string
  selfName: string
  names: string[] // 叫到这些名字之一 = 在叫她
  ownMessages: Set<string> // 她自己发出的消息 id：回复它们 = 在跟她说话
  messageId?: string // 这条消息自己的 id（语音转文字要用）
  describe?: (img: ImageRef) => Promise<{ what?: string, desc: string } | undefined> // what：图片 / 截图 / 表情包，缺省按段类型
  /** 引用的那条：谁说的、说了什么 */
  quoted?: (messageId: string) => Promise<{ name: string, text: string } | undefined>
  /** @ 的那个人在群里叫什么 */
  nameOf?: (qq: string) => string | undefined
  /** 合并转发 → 几行「名字：内容」 */
  forward?: (data: Record<string, unknown>) => Promise<string | undefined>
  /** 语音 → 文字 */
  voice?: (messageId: string) => Promise<string | undefined>
}

export interface Rendered {
  text: string
  mentioned: boolean // @ 了她、叫了她名字、或回复了她的消息
  images: ImageRef[]
  replyTo?: string // 引用的消息 id
}

const QUOTE_CHARS = 30

export async function render(segments: Segment[], o: RenderOptions): Promise<Rendered> {
  const parts: string[] = []
  const images: ImageRef[] = []
  let mentioned = false
  let replyTo: string | undefined
  for (const s of segments) {
    const d = s.data ?? {}
    switch (s.type) {
      case 'text':
        parts.push(str(d.text))
        break
      case 'at': {
        const qq = str(d.qq)
        if (o.selfId && qq === o.selfId) {
          mentioned = true
          parts.push(`@${o.selfName} `)
        }
        else {
          parts.push(qq === 'all' ? '@全体成员 ' : `@${str(d.name) || o.nameOf?.(qq) || qq} `)
        }
        break
      }
      case 'reply': {
        replyTo = str(d.id)
        const mine = o.ownMessages.has(replyTo)
        if (mine)
          mentioned = true
        const q = await o.quoted?.(replyTo).catch(() => undefined)
        const gist = q ? `${q.text.slice(0, QUOTE_CHARS)}${q.text.length > QUOTE_CHARS ? '…' : ''}` : ''
        if (mine)
          parts.push(gist ? `[回复你「${gist}」] ` : '[回复你] ')
        else parts.push(q ? `[回复 ${q.name}「${gist}」] ` : '[回复] ')
        break
      }
      case 'face':
        parts.push('[表情]')
        break
      case 'image':
      case 'mface': {
        const img: ImageRef = {
          url: str(d.url) || undefined,
          file: str(d.file) || undefined,
          sticker: s.type === 'mface' || String(d.sub_type) === '1',
          summary: str(d.summary).replace(/^\[|\]$/g, '') || undefined,
          ...(d.sim === true ? { sim: true } : {}),
        }
        images.push(img)
        parts.push(imageLabel(img, await o.describe?.(img).catch(() => undefined)))
        break
      }
      case 'record': {
        const said = o.messageId ? await o.voice?.(o.messageId).catch(() => undefined) : undefined
        parts.push(said ? `[语音：${said}]` : '[语音]')
        break
      }
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push(`[文件${d.name ? `：${str(d.name)}` : ''}]`)
        break
      case 'forward': {
        const lines = await o.forward?.(d).catch(() => undefined)
        parts.push(lines ? `[聊天记录：${lines}]` : '[聊天记录]')
        break
      }
      case 'json':
      case 'xml':
        parts.push(cardTitle(d))
        break
      case 'poke':
        parts.push('[戳一戳]')
        break
      case 'dice':
        parts.push(`[骰子${d.result ? `：${str(d.result)}` : ''}]`)
        break
      case 'rps':
        parts.push('[猜拳]')
        break
      case 'markdown':
        parts.push(str(d.content).slice(0, 200))
        break
      default:
        parts.push(`[${s.type}]`)
    }
  }
  const text = parts.join('').replace(/\s+/g, ' ').trim()
  if (!mentioned)
    mentioned = o.names.some(n => n && text.includes(n))
  return { text, mentioned, images, replyTo }
}

/**
 * 一张图在感知文字里写成什么：「[图片：描述]」，没描述退回商城表情的 summary、再退回「[图片]」。
 * 收图时（media.ts）用同一个函数记下这段原文：原图进了发言者上下文时，要把这段换成简短的「[图片]」（inline.ts）。
 * 空白按 render 收尾的规则压成一个空格，记下的才对得上感知里的原文。
 */
export function imageLabel(img: ImageRef, seen?: { what?: string, desc: string }): string {
  const what = seen?.what ?? (img.sticker ? '表情包' : '图片')
  const label = seen?.desc ? `[${what}：${seen.desc}]` : img.sticker && img.summary && img.summary !== '动画表情' ? `[${what}：${img.summary}]` : `[${what}]`
  return label.replace(/\s+/g, ' ')
}

/** 兼容 message 是 CQ 码字符串的上报格式：只取纯文本，其余当一段未知 */
export function toSegments(message: Segment[] | string | undefined, raw?: string): Segment[] {
  if (Array.isArray(message))
    return message
  const s = typeof message === 'string' ? message : raw ?? ''
  return [{ type: 'text', data: { text: s.replace(/\[CQ:[^\]]*\]/g, '') } }]
}

/** 小程序 / 分享卡片：取 prompt 或标题，取不到就是「[卡片消息]」 */
function cardTitle(d: Record<string, unknown>): string {
  try {
    const obj = JSON.parse(str(d.data)) as { prompt?: unknown, meta?: Record<string, { title?: unknown, desc?: unknown }> }
    const meta = obj.meta ? Object.values(obj.meta)[0] : undefined
    const title = str(obj.prompt) || str(meta?.title) || str(meta?.desc)
    return title ? `[卡片：${title.slice(0, 40)}]` : '[卡片消息]'
  }
  catch {
    return '[卡片消息]' // 不是 JSON（xml 卡片）：只说是张卡片
  }
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}
