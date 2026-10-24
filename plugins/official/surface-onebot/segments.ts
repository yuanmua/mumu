/**
 * OneBot v11 消息段与上报事件：类型 + 构造函数。
 *
 * 这是本插件对外的稳定层：
 * - 插件自己发消息用 `seg.*` 组消息段；
 * - 模拟器（scripts/fake-onebot.ts 之类）用 `ev.*` 构造上报事件对着本插件发，字段与 NapCat 实际上报一致，
 *   换成真 NapCat 不用改插件。
 * 只放纯数据，不碰网络、不碰内核；字段名照 OneBot v11 / NapCat 原样（下划线命名）。
 */

/** 消息段：{ type:'text', data:{ text } } 之类 */
export interface Segment {
  type: string
  data: Record<string, unknown>
}

/** 上报事件；只声明用得到的字段，其余原样保留 */
export interface OneBotEvent {
  post_type: string // message | message_sent | notice | request | meta_event
  message_type?: 'private' | 'group'
  notice_type?: string
  request_type?: string
  meta_event_type?: string
  sub_type?: string
  time?: number
  self_id?: number
  user_id?: number
  group_id?: number
  target_id?: number
  operator_id?: number
  message_id?: number
  duration?: number
  comment?: string
  flag?: string
  message?: Segment[] | string
  raw_message?: string
  sender?: { user_id?: number, nickname?: string, card?: string, role?: string }
  [key: string]: unknown
}

/** 发出去的文件 / 图片 / 语音：本机路径、http(s) 链接或 base64 都行，NapCat 自己处理 */
export function fileRef(src: string): string {
  if (/^(?:https?|file|base64):\/\//.test(src))
    return src
  if (/^[a-z]:[\\/]/i.test(src) || src.startsWith('/'))
    return `file:///${src.replace(/\\/g, '/').replace(/^\/+/, '')}`
  return src
}

export const seg = {
  text: (text: string): Segment => ({ type: 'text', data: { text } }),
  at: (qq: string | number): Segment => ({ type: 'at', data: { qq: String(qq) } }),
  atAll: (): Segment => ({ type: 'at', data: { qq: 'all' } }),
  reply: (messageId: string | number): Segment => ({ type: 'reply', data: { id: String(messageId) } }),
  face: (id: string | number): Segment => ({ type: 'face', data: { id: String(id) } }),
  image: (src: string, opts: { sticker?: boolean, summary?: string } = {}): Segment => ({
    type: 'image',
    data: { file: fileRef(src), ...(opts.sticker ? { sub_type: 1 } : {}), ...(opts.summary ? { summary: opts.summary } : {}) },
  }),
  record: (src: string): Segment => ({ type: 'record', data: { file: fileRef(src) } }),
  video: (src: string): Segment => ({ type: 'video', data: { file: fileRef(src) } }),
  file: (src: string, name?: string): Segment => ({ type: 'file', data: { file: fileRef(src), ...(name ? { name } : {}) } }),
  poke: (qq: string | number): Segment => ({ type: 'poke', data: { qq: String(qq) } }),
  dice: (): Segment => ({ type: 'dice', data: {} }),
  rps: (): Segment => ({ type: 'rps', data: {} }),
}

/** 只取文字部分（判断「空消息」、日志摘要用）；不做任何渲染 */
export function plainText(segments: Segment[]): string {
  return segments.filter(s => s.type === 'text').map(s => String(s.data?.text ?? '')).join('')
}

interface Who { user: number, name?: string, card?: string, role?: 'owner' | 'admin' | 'member' }
const now = (): number => Math.floor(Date.now() / 1000)
const senderOf = (w: Who): OneBotEvent['sender'] => ({ user_id: w.user, nickname: w.name ?? String(w.user), card: w.card ?? '', role: w.role ?? 'member' })

/** 上报事件构造（模拟器用）。self = 她的 QQ 号 */
export const ev = {
  privateMessage: (self: number, from: Who, message: Segment[], messageId: number): OneBotEvent => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', time: now(), self_id: self,
    user_id: from.user, message_id: messageId, message, raw_message: plainText(message), sender: senderOf(from),
  }),
  groupMessage: (self: number, group: number, from: Who, message: Segment[], messageId: number): OneBotEvent => ({
    post_type: 'message', message_type: 'group', sub_type: 'normal', time: now(), self_id: self,
    group_id: group, user_id: from.user, message_id: messageId, message, raw_message: plainText(message), sender: senderOf(from),
  }),
  /** 戳一戳：user 戳了 target（target = self 即戳她）；group 省略为私聊 */
  poke: (self: number, user: number, target: number, group?: number): OneBotEvent => ({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke', time: now(), self_id: self, user_id: user, target_id: target, ...(group ? { group_id: group } : {}),
  }),
  groupRecall: (self: number, group: number, user: number, operator: number, messageId: number): OneBotEvent => ({
    post_type: 'notice', notice_type: 'group_recall', time: now(), self_id: self, group_id: group, user_id: user, operator_id: operator, message_id: messageId,
  }),
  friendRecall: (self: number, user: number, messageId: number): OneBotEvent => ({
    post_type: 'notice', notice_type: 'friend_recall', time: now(), self_id: self, user_id: user, message_id: messageId,
  }),
  groupIncrease: (self: number, group: number, user: number, operator = 0): OneBotEvent => ({
    post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve', time: now(), self_id: self, group_id: group, user_id: user, operator_id: operator,
  }),
  groupDecrease: (self: number, group: number, user: number, kicked = false, operator = 0): OneBotEvent => ({
    post_type: 'notice', notice_type: 'group_decrease', sub_type: kicked ? (user === self ? 'kick_me' : 'kick') : 'leave', time: now(), self_id: self, group_id: group, user_id: user, operator_id: operator,
  }),
  groupBan: (self: number, group: number, user: number, duration: number, operator = 0): OneBotEvent => ({
    post_type: 'notice', notice_type: 'group_ban', sub_type: duration > 0 ? 'ban' : 'lift_ban', time: now(), self_id: self, group_id: group, user_id: user, operator_id: operator, duration,
  }),
  friendRequest: (self: number, user: number, comment: string, flag: string): OneBotEvent => ({
    post_type: 'request', request_type: 'friend', time: now(), self_id: self, user_id: user, comment, flag,
  }),
  groupInvite: (self: number, group: number, user: number, comment: string, flag: string): OneBotEvent => ({
    post_type: 'request', request_type: 'group', sub_type: 'invite', time: now(), self_id: self, group_id: group, user_id: user, comment, flag,
  }),
}
