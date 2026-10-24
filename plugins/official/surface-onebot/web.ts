/**
 * QQ 在网页上的样子（docs/web-protocol.md §7）：状态页一张「QQ」卡；设置 → 面板里三块：
 * 「QQ 会话」表格、「QQ 发送队列」日志（出口节流的时间线）、「QQ 能力」表（导演能用的动作对应哪些 NapCat 接口）。
 * 全走水线（web/route、web/meta、web/status），surface-web 与前端一行不改；类型只 import type。
 * 终端 / 调试页的 /onebot 命令也在这里：同一份状态，两种看法。
 */
import type { Ctx, LogEvent } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { Memory } from './cache.ts'
import { avatarOf, groupAvatarOf } from './media.ts'
import type { Pending } from './notices.ts'
import type { Gate } from './throttle.ts'

export interface WebDeps {
  state: () => { open: boolean, lastError: string, url: string, selfId?: string, selfNick?: string }
  served: string[]
  memory: Memory
  gate: Gate
  pending: Pending
  call: <T = unknown>(action: string, params?: Record<string, unknown>) => Promise<T>
  commands: CommandService
  tokenInfo: () => string
  actionsOn: boolean
  deny: string[]
  reconnect: () => void
}

const BASE = '/api/surface-onebot'

/** 能力表：动作 · op · NapCat 接口（README 能力表的机器可读版） */
const ABILITIES: [string, string, string][] = [
  ['reply（说话）', '文字、<|quote|> 引用、<|at:名字|> @人', 'send_group_msg / send_private_msg'],
  ['reply（说话）', '<|sticker:词|> 表情包、图片片段', 'send_*_msg（image 段）'],
  ['qq.send', 'image / voice / file', 'send_*_msg · upload_group_file / upload_private_file'],
  ['qq.send', 'poke / react / like', 'send_poke · set_msg_emoji_like · send_like'],
  ['qq.send', 'qzone 发说说', 'send_qzone_msg'],
  ['qq.manage', 'recall / essence', 'delete_msg · set_essence_msg'],
  ['qq.manage', 'ban / unban / mute_all', 'set_group_ban · set_group_whole_ban'],
  ['qq.manage', 'card / title / group_name', 'set_group_card · set_group_special_title · set_group_name'],
  ['qq.manage', 'kick / admin / leave', 'set_group_kick · set_group_admin · set_group_leave'],
  ['qq.manage', 'accept_friend / accept_group', 'set_friend_add_request · set_group_add_request'],
  ['qq.query', 'members / who / groups / friends', 'get_group_member_list · get_stranger_info · get_group_list · get_friend_list'],
  ['qq.query', 'history / forward / ocr / status', 'get_group_msg_history · get_forward_msg · ocr_image · get_status'],
  ['qq.call', '任意接口（她自己写的 NapCat 插件接口也在这）', '除 denyCall 外全部'],
]

export function webExtras(ctx: Ctx, d: WebDeps): { refreshGroups: () => Promise<void>, groupName: (id: string) => string | undefined } {
  // 所在的群（状态卡、会话表里的群名用）：连上时取一次，之后定时刷新
  const groups = new Map<string, { name: string, members?: number }>()
  const refreshGroups = async (): Promise<void> => {
    const list = (await d.call<{ group_id: number, group_name: string, member_count?: number }[] | null>('get_group_list').catch(() => null)) ?? []
    if (!list.length)
      return
    groups.clear()
    for (const g of list) groups.set(String(g.group_id), { name: g.group_name, members: g.member_count })
  }
  const timer = setInterval(() => { if (d.state().open) void refreshGroups() }, 10 * 60_000)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer))
  const todayStart = (): number => new Date(new Date().toDateString()).getTime()

  const sessions = () => {
    const since = todayStart()
    const spoke = new Map<string, number>()
    for (const e of ctx.log.events as LogEvent[]) {
      if (e.type === 'utterance.settled' && e.at >= since && e.data?.delivered && String(e.data.channel ?? '').startsWith('qq:'))
        spoke.set(e.data.channel, (spoke.get(e.data.channel) ?? 0) + 1)
    }
    return d.served.map((channel) => {
      const [, type, id] = channel.split(':')
      const last = d.memory.recent(channel, 1)[0]
      const name = type === 'group'
        ? groups.get(id)?.name ?? `群 ${id}`
        : d.memory.recent(channel, 20).find(m => m.userId === id)?.name ?? id
      return {
        type: type === 'group' ? '群' : '私聊',
        id,
        name,
        last: last ? `${last.name}：${last.text.slice(0, 40)}` : '',
        lastAt: last?.at,
        today: spoke.get(channel) ?? 0,
      }
    }).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
  }

  const queue = () => {
    const lines = d.gate.timeline.map(t =>
      `${new Date(t.at).toLocaleTimeString('zh-CN')}  ${t.action.padEnd(18)} ${(t.channel ?? '').padEnd(20)} 排队 ${t.waitedMs}ms${t.typingMs ? `（打字 ${t.typingMs}ms）` : ''}`)
    lines.push(`—— 现在排着 ${d.gate.pending} 件`)
    return lines
  }

  /** 会话目录：网页据此把 qq:* 频道显示成「群名 / 对方昵称」并分群聊、私聊 */
  const chats = () => d.served.map((channel) => {
    const [, kind, id] = channel.split(':')
    const g = kind === 'group' ? groups.get(id) : undefined
    const title = kind === 'group'
      ? g?.name ?? `群 ${id}`
      : d.memory.recent(channel, 30).find(m => m.userId === id)?.name ?? id
    return {
      channel,
      platform: 'qq',
      kind: kind === 'group' ? 'group' : 'private',
      title,
      ...(g?.members ? { memberCount: g.members } : {}),
      avatar: kind === 'group' ? groupAvatarOf(id) : avatarOf(id),
    }
  })

  const abilities = () => {
    const open = d.state().open
    return ABILITIES.map(([action, ops, api]) => ({
      action,
      ops,
      api: action === 'qq.call' ? `${api}（禁：${d.deny.join('、') || '无'}）` : api,
      ok: !open ? '✗ 没连上' : action.startsWith('qq.') && !d.actionsOn ? '✗ 动作已关' : '✓',
    }))
  }

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (!r.path.startsWith(`${BASE}/`))
      return next()
    const sub = r.path.slice(BASE.length + 1)
    if (r.method === 'GET' && sub === 'sessions')
      r.response = { body: { items: sessions() } }
    else if (r.method === 'GET' && sub === 'queue')
      r.response = { body: { lines: queue() } }
    else if (r.method === 'GET' && sub === 'chats')
      r.response = { body: { items: chats() } }
    else if (r.method === 'GET' && sub === 'abilities')
      r.response = { body: { items: abilities() } }
    else if (r.method === 'POST' && sub === 'reconnect') {
      d.reconnect()
      r.response = { status: 204 }
    }
    else return next()
    return r
  })

  ctx.intercept<{ panels?: WebPanel[], chats?: unknown[] }>('web/meta', async (meta, next) => {
    meta.chats = [...(meta.chats ?? []), ...chats()]
    meta.panels = [...(meta.panels ?? []), {
      id: 'qq-sessions',
      title: 'QQ 会话',
      kind: 'table',
      endpoint: `${BASE}/sessions`,
      columns: [{ key: 'type', label: '类型' }, { key: 'name', label: '名字' }, { key: 'id', label: '号' }, { key: 'last', label: '最近一条' }, { key: 'lastAt', label: '时间', format: 'time' }, { key: 'today', label: '今天她说话（次）' }],
      actions: [{ label: '重连 NapCat', endpoint: `${BASE}/reconnect`, confirm: '断开并重连 NapCat？正在发的话会被打断。' }],
      refreshSec: 10,
    }, {
      id: 'qq-queue',
      title: 'QQ 发送队列',
      kind: 'log',
      endpoint: `${BASE}/queue`,
    }, {
      id: 'qq-abilities',
      title: 'QQ 能力',
      kind: 'table',
      endpoint: `${BASE}/abilities`,
      columns: [{ key: 'ok', label: '可用' }, { key: 'action', label: '动作' }, { key: 'ops', label: '能做' }, { key: 'api', label: 'NapCat 接口' }],
    }]
    return next()
  })

  ctx.effect(() => d.commands.register({
    name: 'onebot',
    usage: 'onebot',
    description: 'QQ（NapCat）连接状态',
    run(_args, io) {
      const st = d.state()
      io.print(`  地址 ${st.url} · ${st.open ? `已连接 · QQ ${st.selfId ?? '?'} ${st.selfNick ?? ''} · ${groups.size} 个群` : `未连接${st.lastError ? `（${st.lastError}）` : ''}`}`)
      io.print(`  token：${d.tokenInfo()}`)
      io.print(`  服务频道 ${d.served.length} 个${d.served.length ? `：${d.served.slice(-8).join('、')}` : ''}`)
      io.print(`  出口队列 ${d.gate.pending} 件；最近：${d.gate.timeline.slice(-5).map(t => `${new Date(t.at).toLocaleTimeString('zh-CN')} ${t.action}(等 ${t.waitedMs}ms)`).join('，') || '无'}`)
      io.print(`  待处理：好友申请 ${d.pending.friends.size} 个，进群邀请 ${d.pending.groups.size} 个`)
    },
  }))

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const st = d.state()
    s.cards.push({
      id: 'qq',
      title: 'QQ',
      level: st.open ? 'ok' : 'err',
      text: st.open ? '已连上 NapCat' : `未连接${st.lastError ? `（${st.lastError}）` : ''}`,
      items: [
        ...(st.open ? [`账号 ${st.selfNick ?? '?'}（${st.selfId ?? '?'}）`, `在 ${groups.size} 个群里`] : []),
        `出口队列 ${d.gate.pending} 件`,
        `地址 ${st.url}`,
      ],
    })
    return next()
  })

  return { refreshGroups, groupName: id => groups.get(id)?.name }
}
