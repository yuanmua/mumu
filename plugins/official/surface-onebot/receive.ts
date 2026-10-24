/**
 * 进来的方向：OneBot 消息 / 通知事件 → 内核感知。
 *
 * 消息：渲染成一句文字（inbound.ts）、记进记性（cache.ts）、带上来源与图片（media.ts，网页用），
 * 再按私聊 / 群聊 / 是否在叫她定 kind 与 urgent（见 index.ts 文件头的映射表）。
 * 通知：noticeToPercept（notices.ts）给出感知，这里补上来源。
 */
import type { Percept } from '../../../src/index.ts'
import type { Memory } from './cache.ts'
import type { ImageRef } from './inbound.ts'
import { render, toSegments } from './inbound.ts'
import type { MediaRef, mediaKit } from './media.ts'
import type { NoticeConfig, Pending } from './notices.ts'
import { noticeToPercept } from './notices.ts'
import { readForward } from './queries.ts'
import type { OneBotEvent, Segment } from './segments.ts'
import { plainText } from './segments.ts'

export interface ReceiveDeps {
  percept: (p: Percept) => Promise<void>
  call: <T = unknown>(action: string, params?: Record<string, unknown>) => Promise<T>
  selfId: () => string | undefined
  selfName: () => string
  /** 叫到这些名字之一 = 在叫她：真名 + QQ 网名（persona/names 水线现取）+ 配置补充 + 登录昵称；第一个是真名 */
  names: () => Promise<string[]>
  ownSet: Set<string>
  memory: Memory
  pending: Pending
  nameOf: (group: string | undefined, user: string) => Promise<string>
  kit: ReturnType<typeof mediaKit>
  serve: (channel: string) => void
  notices: NoticeConfig
  voiceToText: boolean
  privateUrgent: boolean
  /** 群里的机器人：它 @ 她不算急事，不打断她正说的话 */
  isBot: (userId: string) => boolean
  isIgnored: (userId: string) => boolean // 她（大脑）决定不理 / 拉黑了这个人（group-policy 的 temper）
}

export function receiver(d: ReceiveDeps) {
  const notice = async (e: OneBotEvent): Promise<void> => {
    const p = await noticeToPercept(e, { cfg: d.notices, selfId: d.selfId, memory: d.memory, pending: d.pending, nameOf: d.nameOf })
    if (!p)
      return
    d.serve(p.channel!)
    p.data = { ...p.data, ...d.kit.webFields(p.channel!, p.sender), source: d.kit.source(p.channel!, p.sender) }
    await d.percept(p)
  }

  const perceive = async (e: OneBotEvent, channel: string, uid: string): Promise<void> => {
    const group = e.message_type === 'group' ? String(e.group_id) : undefined
    const name = (group ? e.sender?.card || e.sender?.nickname : e.sender?.nickname) || uid
    if (group)
      d.memory.meet(group, { userId: uid, card: e.sender?.card, nickname: e.sender?.nickname, role: e.sender?.role })
    const names = await d.names()
    const media: MediaRef[] = []
    const r = await render(toSegments(e.message, e.raw_message), {
      selfId: d.selfId(),
      selfName: names[0] ?? d.selfName(),
      names,
      ownMessages: d.ownSet,
      messageId: e.message_id !== undefined ? String(e.message_id) : undefined,
      describe: (img: ImageRef) => d.kit.describe(img, channel, media, e.time), // 带上消息时间：排队太久的图不看了
      quoted: async (id) => {
        const m = d.memory.find(id)
        if (m)
          return { name: m.userId === d.selfId() ? '你' : m.name, text: m.text }
        const got = await d.call<{ sender?: { nickname?: string, card?: string }, message?: Segment[] }>('get_msg', { message_id: id })
        return got ? { name: got.sender?.card || got.sender?.nickname || '?', text: plainText(got.message ?? []) } : undefined
      },
      nameOf: qq => group ? d.memory.memberName(group, qq) : undefined,
      forward: async fw => (await readForward({ call: d.call }, fw, 5)).join('；') || undefined,
      voice: async id => d.voiceToText ? (await d.call<{ text?: string }>('fetch_ptt_text', { message_id: id }))?.text || undefined : undefined,
    })
    if (!r.text)
      return
    if (e.message_id !== undefined)
      d.memory.remember(channel, { messageId: String(e.message_id), userId: uid, name, text: r.text, at: Date.now() })
    d.serve(channel)
    const bot = !!group && d.isBot(uid)
    await d.percept({
      kind: group && !r.mentioned ? 'group.message' : 'message',
      channel,
      sender: { id: uid, name },
      text: r.text,
      // 机器人 @ 她、她决定不理的人 @ 她：都不打断她正说的话
      urgent: group ? r.mentioned && !bot && !d.isIgnored(uid) : d.privateUrgent,
      data: {
        platform: 'qq',
        messageId: e.message_id,
        groupId: e.group_id,
        role: e.sender?.role,
        ...(bot ? { bot: true } : {}),
        mentioned: r.mentioned,
        replyTo: r.replyTo,
        ...d.kit.webFields(channel, { id: uid }, media),
        source: d.kit.source(channel, { id: uid, name }),
        ...(media.length ? { media } : {}),
      },
    })
  }


  return { perceive, notice }
}
