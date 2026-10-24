/**
 * 给导演的 QQ 查询（qq.query）与兜底调用（qq.call）。
 *
 * 查到的东西写成几行人话记进工作记忆（a.remember），导演下一拍就看得到；太长截断（resultChars）。
 * qq.call 直接调 NapCat / OneBot 的任意接口：上面几个动作没包的能力（NapCat 有一百多个接口，
 * 以及将来她自己写的 NapCat 插件新增的接口）都从这里用。denyCall 里的接口不让调——
 * 默认是会让她自己掉线的几个（退出、重启）。
 */
import type { ActionType } from '../../../src/index.ts'
import type { ActionDeps } from './actions.ts'
import { targetOf } from './actions.ts'
import type { Segment } from './segments.ts'
import { plainText } from './segments.ts'

export interface QueryConfig {
  resultChars?: number
  denyCall?: string[]
}

interface MemberInfo { user_id: number, nickname?: string, card?: string, role?: string, title?: string, last_sent_time?: number }
interface HistoryMsg { message_id?: number, sender?: { nickname?: string, card?: string }, message?: Segment[] | string, raw_message?: string }

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim()

export function queryAction(d: ActionDeps, cfg: QueryConfig): ActionType {
  const limit = cfg.resultChars ?? 1200
  return {
    name: 'qq.query',
    description: '查 QQ 的信息，结果记进你的工作记忆：群成员、某人资料、群列表、好友列表、最近聊天记录、读合并转发、图片识字、账号状态。',
    paramsHint: '{"op":"members|who|groups|friends|history|forward|ocr|status","who":"名字或QQ号（who）","count":20,"path":"ocr 的图片路径或链接"}',
    reloadPolicy: 'abort',
    run: async (a) => {
      const op = str(a.params.op)
      const count = Math.min(100, Math.max(1, Number(a.params.count ?? 20)))
      const put = (title: string, lines: string[]): void => {
        let text = `${title}\n${lines.join('\n')}`
        if (text.length > limit)
          text = `${text.slice(0, limit)}…（截断）`
        a.remember(text, { beats: 3 })
      }
      if (op === 'groups') {
        const list = (await d.call<{ group_id: number, group_name: string, member_count?: number }[] | null>('get_group_list')) ?? []
        return put(`【你在的群】${list.length} 个`, list.map(g => `- ${g.group_name}（${g.group_id}，${g.member_count ?? '?'} 人）`))
      }
      if (op === 'friends') {
        const list = (await d.call<{ user_id: number, nickname: string, remark?: string }[] | null>('get_friend_list')) ?? []
        return put(`【好友】${list.length} 个`, list.map(f => `- ${f.remark || f.nickname}（${f.user_id}）`))
      }
      if (op === 'status') {
        const [info, st] = await Promise.all([d.call<{ user_id: number, nickname: string }>('get_login_info'), d.call<{ online?: boolean, good?: boolean }>('get_status')])
        return put('【QQ 账号状态】', [`- ${info.nickname}（${info.user_id}）在线 ${st?.online ?? '?'}，正常 ${st?.good ?? '?'}`])
      }
      if (op === 'ocr') {
        const path = str(a.params.path)
        if (!path)
          throw new Error('ocr 要写 path')
        const r = await d.call<{ texts?: { text: string }[] } | { text: string }[]>('ocr_image', { image: path })
        const texts = Array.isArray(r) ? r : r?.texts ?? []
        return put('【图片里的字】', texts.map(x => `- ${x.text}`))
      }
      const { channel, t } = targetOf(a)
      const group = t.type === 'group' ? t.id : undefined
      if (op === 'members') {
        if (!group)
          throw new Error('members 只能在群里查')
        const list = (await d.call<MemberInfo[] | null>('get_group_member_list', { group_id: group })) ?? []
        for (const m of list) d.memory.meet(group, { userId: String(m.user_id), card: m.card, nickname: m.nickname, role: m.role })
        const role = (r?: string): string => r === 'owner' ? '群主' : r === 'admin' ? '管理' : ''
        const sorted = [...list].sort((x, y) => (y.last_sent_time ?? 0) - (x.last_sent_time ?? 0))
        return put(`【群 ${group} 成员】${list.length} 人（按最近发言排，最多 ${count} 个）`, sorted.slice(0, count).map(m => `- ${m.card || m.nickname}（${m.user_id}）${role(m.role)}${m.title ? ` 头衔「${m.title}」` : ''}`))
      }
      if (op === 'who') {
        const who = str(a.params.who)
        const id = who ? await d.resolve(group, who) : t.type === 'private' ? t.id : undefined
        if (!id)
          throw new Error(`找不到「${who}」是谁`)
        const [stranger, member] = await Promise.all([
          d.call<{ nickname?: string, sex?: string, age?: number, sign?: string, long_nick?: string, qqLevel?: number }>('get_stranger_info', { user_id: id }).catch(() => undefined),
          group ? d.call<MemberInfo & { join_time?: number, level?: string }>('get_group_member_info', { group_id: group, user_id: id }).catch(() => undefined) : undefined,
        ])
        const lines = [`- QQ ${id}，昵称 ${stranger?.nickname ?? '?'}${stranger?.sex && stranger.sex !== 'unknown' ? `，${stranger.sex === 'male' ? '男' : '女'}` : ''}${stranger?.age ? `，${stranger.age} 岁` : ''}`]
        if (stranger?.sign || stranger?.long_nick)
          lines.push(`- 签名：${stranger.sign || stranger.long_nick}`)
        if (member)
          lines.push(`- 群名片 ${member.card || '（无）'}，${member.role ?? 'member'}${member.title ? `，头衔「${member.title}」` : ''}${member.join_time ? `，${new Date(member.join_time * 1000).toLocaleDateString('zh-CN')} 进群` : ''}`)
        return put(`【${who || id} 的资料】`, lines)
      }
      if (op === 'history') {
        const r = await (group
          ? d.call<{ messages: HistoryMsg[] }>('get_group_msg_history', { group_id: group, count })
          : d.call<{ messages: HistoryMsg[] }>('get_friend_msg_history', { user_id: t.id, count }))
        return put(`【${channel} 最近 ${r.messages?.length ?? 0} 条】`, (r.messages ?? []).map(m => `- ${m.sender?.card || m.sender?.nickname || '?'}：${historyText(m)}`))
      }
      if (op === 'forward') {
        const m = [...d.memory.recent(channel, 50)].reverse().find(x => x.text.includes('[聊天记录'))
        if (!m)
          throw new Error('最近没有合并转发消息')
        const lines = await readForward(d, { id: m.messageId }, count)
        return put(`【${m.name} 转发的聊天记录】`, lines)
      }
      throw new Error(`qq.query 不认识 op「${op}」`)
    },
  }
}

export function callAction(d: ActionDeps, cfg: QueryConfig): ActionType {
  const deny = new Set(cfg.denyCall ?? ['bot_exit', 'set_restart'])
  const limit = cfg.resultChars ?? 1200
  return {
    name: 'qq.call',
    description: '直接调用 NapCat / OneBot 的任意接口（qq.send / qq.manage / qq.query 没覆盖的才用），结果记进工作记忆。例：get_group_honor_info（群荣誉）、_send_group_notice（发群公告）、get_group_root_files（群文件）、set_qq_profile（改自己资料）、set_self_longnick（改签名）、fetch_custom_face（收藏的表情）、get_group_shut_list（禁言列表），以及她自己写的 NapCat 插件提供的接口。',
    paramsHint: '{"action":"接口名","params":{"group_id":123}}（group_id / user_id 省略时按当前频道补）',
    reloadPolicy: 'abort',
    run: async (a) => {
      const action = str(a.params.action)
      if (!action)
        throw new Error('要写 action（接口名）')
      if (deny.has(action))
        throw new Error(`${action} 不允许直接调用（配置 denyCall）`)
      const params = a.params.params && typeof a.params.params === 'object' ? { ...(a.params.params as Record<string, unknown>) } : {}
      const t = (() => {
        try {
          return targetOf(a).t
        }
        catch {
          return undefined // 不在 QQ 频道也能调（比如查好友列表），只是不自动补 id
        }
      })()
      if (t?.type === 'group' && params.group_id === undefined)
        params.group_id = t.id
      if (t?.type === 'private' && params.user_id === undefined)
        params.user_id = t.id
      const r = await d.call(action, params)
      let text = r === undefined || r === null ? '成功（无返回）' : JSON.stringify(r)
      if (text.length > limit)
        text = `${text.slice(0, limit)}…（截断）`
      a.remember(`【qq.call ${action}】${text}`, { beats: 3 })
    },
  }
}

/** 合并转发 → 「名字：内容」几行；NapCat 认 message_id，标准 OneBot 认 id，两个都给 */
export async function readForward(d: Pick<ActionDeps, 'call'>, data: Record<string, unknown>, max: number): Promise<string[]> {
  const inline = Array.isArray(data.content) ? (data.content as HistoryMsg[]) : undefined
  const id = str(data.id ?? data.message_id)
  const msgs = inline ?? (id ? (await d.call<{ messages?: HistoryMsg[] }>('get_forward_msg', { message_id: id, id }))?.messages ?? [] : [])
  return msgs.slice(0, max).map(m => `${m.sender?.card || m.sender?.nickname || '?'}：${historyText(m).slice(0, 80)}`)
}

function historyText(m: HistoryMsg): string {
  if (Array.isArray(m.message)) {
    const t = m.message.map(s => s.type === 'text' ? String(s.data?.text ?? '') : `[${s.type === 'image' ? '图片' : s.type === 'face' ? '表情' : s.type}]`).join('')
    return t || plainText(m.message)
  }
  return str(m.raw_message ?? m.message)
}
