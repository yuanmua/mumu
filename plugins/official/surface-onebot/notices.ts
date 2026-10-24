/**
 * 通知 / 请求事件 → 感知。
 *
 * 立场：
 * - 只把「她会在意」的事变成感知：有人戳她、有人撤回、有人进出群、她被禁言 / 踢出、有人加她好友 / 拉她进群。
 *   别人之间戳来戳去、改群名片之类不进来。每类可在配置 notices 里关。
 * - 戳她带 sender（进对话历史，像对方说了一句「[戳了戳你]」）；其余是旁观到的事，不带 sender，
 *   只当一次唤醒原因给导演看，不混进「谁说了什么」。
 * - kind 一律 qq.* 前缀，反射不认，要不要回应由导演定。
 * - 加好友 / 进群邀请的 flag 记在 pending 里，导演用 qq.manage 的 accept_friend / accept_group 只需说是谁。
 */
import type { Percept } from '../../../src/index.ts'
import type { Memory } from './cache.ts'
import type { OneBotEvent } from './segments.ts'

export interface NoticeConfig {
  poke?: boolean
  recall?: boolean
  join?: boolean // 有人进群 / 退群
  ban?: boolean // 她自己被禁言 / 解禁 / 踢出
  request?: boolean // 加好友、拉她进群
}

export interface Pending {
  friends: Map<string, { flag: string, comment: string }> // QQ 号 → 请求
  groups: Map<string, { flag: string, from: string }> // 群号 → 邀请
}

export interface NoticeDeps {
  cfg: NoticeConfig
  selfId: () => string | undefined
  memory: Memory
  pending: Pending
  /** 群里某人叫什么（先查记性，再问 NapCat） */
  nameOf: (group: string | undefined, user: string) => Promise<string>
}

export async function noticeToPercept(e: OneBotEvent, d: NoticeDeps): Promise<Percept | undefined> {
  const self = d.selfId()
  const user = String(e.user_id ?? '')
  const group = e.group_id !== undefined ? String(e.group_id) : undefined
  const channel = group ? `qq:group:${group}` : `qq:private:${user}`
  const base = { channel, data: { platform: 'qq', event: e.notice_type ?? e.request_type, groupId: e.group_id, userId: e.user_id } }

  if (e.post_type === 'notice' && e.notice_type === 'notify' && e.sub_type === 'poke') {
    if (d.cfg.poke === false || String(e.target_id) !== self || user === self)
      return undefined
    return { ...base, kind: 'qq.poke', sender: { id: user, name: await d.nameOf(group, user) }, text: '[戳了戳你]' }
  }

  if (e.notice_type === 'group_recall' || e.notice_type === 'friend_recall') {
    if (d.cfg.recall === false)
      return undefined
    const old = d.memory.find(String(e.message_id))
    const operator = String(e.operator_id ?? user)
    const what = old?.text ? `：「${old.text.slice(0, 60)}」` : ''
    if (user === self)
      return { ...base, kind: 'qq.recall', text: operator === self ? `你撤回了自己的消息${what}` : `${await d.nameOf(group, operator)} 撤回了你的消息${what}` }
    const who = await d.nameOf(group, user)
    const by = operator !== user ? `${await d.nameOf(group, operator)} 撤回了 ${who} 的消息` : `${who} 撤回了一条消息`
    return { ...base, kind: 'qq.recall', text: `${by}${what}` }
  }

  if (e.notice_type === 'group_increase' || e.notice_type === 'group_decrease') {
    const me = user === self
    if (me && e.notice_type === 'group_decrease')
      return d.cfg.ban === false ? undefined : { ...base, kind: 'qq.notice', text: e.sub_type === 'kick_me' ? `你被踢出了群 ${group}` : `你退出了群 ${group}` }
    if (d.cfg.join === false && !me)
      return undefined
    if (me)
      return { ...base, kind: 'qq.notice', text: `你进了一个新群（${group}）` }
    const who = await d.nameOf(group, user)
    const how = e.notice_type === 'group_increase' ? '进群了' : e.sub_type === 'kick' ? '被踢出了群' : '退群了'
    return { ...base, kind: 'qq.notice', text: `${who} ${how}` }
  }

  if (e.notice_type === 'group_ban' && user === self) {
    if (d.cfg.ban === false)
      return undefined
    const min = Math.ceil(Number(e.duration ?? 0) / 60)
    return { ...base, kind: 'qq.notice', text: e.sub_type === 'lift_ban' ? '你在这个群的禁言被解除了' : `你在这个群被禁言了 ${min} 分钟（这段时间发不出消息）` }
  }

  if (e.post_type === 'request' && d.cfg.request !== false) {
    if (e.request_type === 'friend') {
      d.pending.friends.set(user, { flag: String(e.flag ?? ''), comment: String(e.comment ?? '') })
      return { ...base, channel: `qq:private:${user}`, kind: 'qq.request', text: `QQ ${user} 想加你好友${e.comment ? `，附言「${e.comment}」` : ''}（同意用 qq.manage accept_friend）` }
    }
    if (e.request_type === 'group' && e.sub_type === 'invite' && group) {
      d.pending.groups.set(group, { flag: String(e.flag ?? ''), from: user })
      return { ...base, kind: 'qq.request', text: `${await d.nameOf(undefined, user)} 邀请你进群 ${group}（同意用 qq.manage accept_group）` }
    }
  }
  return undefined
}
