/**
 * 给导演的 QQ 动作：发东西（qq.send）与群管 / 账号（qq.manage）。查询与兜底调用在 queries.ts。
 *
 * 立场：
 * - 说话仍然走 reply（流式、可打断、计送达）；这里是「说话以外」的事，原子的、一次做完。
 * - 导演写人话：对象写名字或 QQ 号（who），频道用意图自带的；本插件负责把名字换成 QQ 号、
 *   把「她最近一条」「某人最近一条」换成 message_id。
 * - 做完用 a.remember 记一句进工作记忆（导演下一拍知道做成了），失败就抛错——动作出错会作为感知回报导演。
 * - 能不能做由 NapCat 和她在群里的权限决定，这里不预判；NapCat 报错原样带回。
 */
import type { ActionRun, ActionType } from '../../../src/index.ts'
import type { TtsService } from '../tts/index.ts'
import type { Memory } from './cache.ts'
import type { Pending } from './notices.ts'
import type { Segment } from './segments.ts'
import { seg } from './segments.ts'

export interface ActionDeps {
  call: <T = unknown>(action: string, params?: Record<string, unknown>) => Promise<T>
  selfId: () => string | undefined
  memory: Memory
  pending: Pending
  tts: () => TtsService | undefined
  /** 往频道发一条（自动记下她自己的消息 id） */
  send: (channel: string, message: Segment[]) => Promise<void>
  /** 名字 → QQ 号；群里先查记性，查不到拉一次成员列表 */
  resolve: (group: string | undefined, who: string) => Promise<string | undefined>
}

export interface Target {
  type: 'private' | 'group'
  id: string
}

export function parseChannel(channel: string | undefined): Target | undefined {
  const [p, type, id] = (channel ?? '').split(':')
  if (p !== 'qq' || (type !== 'private' && type !== 'group') || !id)
    return undefined
  return { type, id }
}

/** 动作所在频道必须是 QQ 的；导演可在 params.channel 里另指 */
export function targetOf(a: ActionRun): { channel: string, t: Target } {
  const channel = typeof a.params.channel === 'string' ? a.params.channel : a.channel ?? ''
  const t = parseChannel(channel)
  if (!t)
    throw new Error(`不在 QQ 频道里（channel=${channel || '无'}），意图里写上 channel，如 qq:group:123`)
  return { channel, t }
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim()

export function sendAction(d: ActionDeps): ActionType {
  return {
    name: 'qq.send',
    description: '发图片以外的东西：文件（mp3 / zip / pdf / txt…）、语音、戳一戳、给某条消息点表情回应、给人点赞、发 QQ 空间说说。说话本身用 reply，发图用 image。',
    paramsHint: '{"op":"file|voice|poke|react|like|qzone|image","path":"file：她电脑上的完整路径，如 C:\\\\Users\\\\me\\\\Music\\\\a.mp3，群和私聊都行；voice：音频文件路径（不写就用 text 合成）","name":"file 可选：对方看到的文件名","text":"voice：要说的话（自动转语音）；qzone：说说正文","who":"poke/like/react 的对象：名字或QQ号（react 省略=对方最近一条）","emoji":"react 的 QQ 表情 id（默认 76 赞）"}',
    reloadPolicy: 'abort',
    run: async (a) => {
      const op = str(a.params.op)
      const path = str(a.params.path)
      const who = str(a.params.who)
      if (op === 'qzone') {
        const content = str(a.params.text)
        if (!content)
          throw new Error('qzone 要写 text（说说正文）')
        const r = await d.call<{ tid?: string }>('send_qzone_msg', { content, ...(path ? { images: [path] } : {}) })
        a.remember(`你发了一条 QQ 空间说说：「${content.slice(0, 60)}」${r?.tid ? `（tid ${r.tid}）` : ''}`)
        return
      }
      const { channel, t } = targetOf(a)
      const group = t.type === 'group' ? t.id : undefined
      const need = async (): Promise<string> => {
        const id = who ? await d.resolve(group, who) : t.type === 'private' ? t.id : undefined
        if (!id)
          throw new Error(`找不到「${who || '对象'}」是谁，写名字（群名片）或 QQ 号`)
        return id
      }
      switch (op) {
        case 'image':
          if (!path)
            throw new Error('image 要写 path')
          await d.send(channel, [seg.image(path)])
          a.remember(`你在 ${channel} 发了一张图片（${path}）`)
          return
        case 'voice': {
          if (path) {
            await d.send(channel, [seg.record(path)])
          }
          else {
            const text = str(a.params.text)
            const tts = d.tts()
            if (!text || !tts?.ready())
              throw new Error(text ? '语音合成没就绪（tts 插件没装或没设密钥），给 path 发现成的语音文件' : 'voice 要写 text 或 path')
            const audio = await tts.synthesize(text, { signal: a.signal })
            await d.send(channel, [seg.record(`base64://${Buffer.from(audio.bytes).toString('base64')}`)])
          }
          a.remember(`你在 ${channel} 发了一条语音${a.params.text ? `：「${str(a.params.text).slice(0, 40)}」` : ''}`)
          return
        }
        case 'file': {
          if (!path)
            throw new Error('file 要写 path（她电脑上的文件路径）')
          const name = str(a.params.name) || path.split(/[\\/]/).pop() || 'file'
          await (t.type === 'group'
            ? d.call('upload_group_file', { group_id: t.id, file: path, name })
            : d.call('upload_private_file', { user_id: t.id, file: path, name }))
          a.remember(`你在 ${channel} 发了文件 ${name}`)
          return
        }
        case 'poke': {
          const id = await need()
          await d.call('send_poke', { user_id: id, ...(group ? { group_id: group } : {}) })
          a.remember(`你戳了戳 ${who || id}`)
          return
        }
        case 'like': {
          const id = await need()
          await d.call('send_like', { user_id: id, times: Number(a.params.times ?? 10) })
          a.remember(`你给 ${who || id} 点了赞`)
          return
        }
        case 'react': {
          const m = d.memory.lastFrom(channel, d.selfId(), who || undefined)
          if (!m)
            throw new Error('找不到要回应的那条消息')
          await d.call('set_msg_emoji_like', { message_id: m.messageId, emoji_id: str(a.params.emoji) || '76' })
          a.remember(`你给 ${m.name} 的「${m.text.slice(0, 30)}」点了表情回应`)
          return
        }
        default:
          throw new Error(`qq.send 不认识 op「${op}」`)
      }
    },
  }
}

export function manageAction(d: ActionDeps): ActionType {
  return {
    name: 'qq.manage',
    description: 'QQ 群管与账号：撤回消息、禁言 / 解禁、改群名片、踢人、设 / 撤管理、发头衔、改群名、全员禁言、设精华、同意加好友 / 进群邀请、退群。要她在群里有对应权限。',
    paramsHint: '{"op":"recall|ban|unban|card|kick|admin|unadmin|title|group_name|mute_all|unmute_all|essence|accept_friend|accept_group|leave","who":"对象名字或QQ号（card 省略=改她自己的）","minutes":10,"text":"新名片 / 头衔 / 群名","target":"recall/essence：mine=她自己最近一条（默认），或某人名字","group":"accept_group 的群号"}',
    reloadPolicy: 'abort',
    run: async (a) => {
      const op = str(a.params.op)
      const who = str(a.params.who)
      if (op === 'accept_friend') {
        const id = /^\d+$/.test(who) ? who : [...d.pending.friends.keys()].pop()
        const req = id ? d.pending.friends.get(id) : undefined
        if (!id || !req)
          throw new Error('没有待处理的好友申请')
        await d.call('set_friend_add_request', { flag: req.flag, approve: true })
        d.pending.friends.delete(id)
        a.remember(`你同意了 QQ ${id} 的好友申请`)
        return
      }
      if (op === 'accept_group') {
        const gid = str(a.params.group) || [...d.pending.groups.keys()].pop()
        const inv = gid ? d.pending.groups.get(gid) : undefined
        if (!gid || !inv)
          throw new Error('没有待处理的进群邀请')
        await d.call('set_group_add_request', { flag: inv.flag, sub_type: 'invite', approve: true })
        d.pending.groups.delete(gid)
        a.remember(`你接受了进群 ${gid} 的邀请`)
        return
      }
      const { channel, t } = targetOf(a)
      const group = t.id
      const user = async (): Promise<string> => {
        const id = who ? await d.resolve(t.type === 'group' ? group : undefined, who) : undefined
        if (!id)
          throw new Error(`找不到「${who || '对象'}」是谁`)
        return id
      }
      const msgOf = (): string => {
        const target = str(a.params.target) || 'mine'
        const m = target === 'mine' ? d.memory.lastFrom(channel, undefined, d.selfId()) : d.memory.lastFrom(channel, d.selfId(), target)
        if (!m)
          throw new Error('找不到那条消息（只记得最近的）')
        return m.messageId
      }
      const groupOnly = (): void => {
        if (t.type !== 'group')
          throw new Error(`${op} 只能在群里用`)
      }
      const done = (s: string): void => a.remember(`你在 ${channel} ${s}`)
      switch (op) {
        case 'recall':
          await d.call('delete_msg', { message_id: msgOf() })
          return done('撤回了一条消息')
        case 'essence':
          groupOnly()
          await d.call('set_essence_msg', { message_id: msgOf() })
          return done('设了一条精华')
        case 'ban':
        case 'unban': {
          groupOnly()
          const id = await user()
          const minutes = op === 'ban' ? Math.max(1, Number(a.params.minutes ?? 10)) : 0
          await d.call('set_group_ban', { group_id: group, user_id: id, duration: minutes * 60 })
          return done(op === 'ban' ? `把 ${who} 禁言了 ${minutes} 分钟` : `解除了 ${who} 的禁言`)
        }
        case 'card': {
          groupOnly()
          const id = who ? await user() : d.selfId()
          await d.call('set_group_card', { group_id: group, user_id: id, card: str(a.params.text) })
          return done(`把 ${who || '自己'} 的群名片改成「${str(a.params.text)}」`)
        }
        case 'title':
          groupOnly()
          await d.call('set_group_special_title', { group_id: group, user_id: await user(), special_title: str(a.params.text) })
          return done(`给 ${who} 发了头衔「${str(a.params.text)}」`)
        case 'kick':
          groupOnly()
          await d.call('set_group_kick', { group_id: group, user_id: await user(), reject_add_request: false })
          return done(`把 ${who} 踢出了群`)
        case 'admin':
        case 'unadmin':
          groupOnly()
          await d.call('set_group_admin', { group_id: group, user_id: await user(), enable: op === 'admin' })
          return done(op === 'admin' ? `把 ${who} 设成了管理员` : `撤了 ${who} 的管理员`)
        case 'group_name':
          groupOnly()
          await d.call('set_group_name', { group_id: group, group_name: str(a.params.text) })
          return done(`把群名改成「${str(a.params.text)}」`)
        case 'mute_all':
        case 'unmute_all':
          groupOnly()
          await d.call('set_group_whole_ban', { group_id: group, enable: op === 'mute_all' })
          return done(op === 'mute_all' ? '开了全员禁言' : '关了全员禁言')
        case 'leave':
          groupOnly()
          await d.call('set_group_leave', { group_id: group })
          return done('退出了这个群')
        default:
          throw new Error(`qq.manage 不认识 op「${op}」`)
      }
    },
  }
}
