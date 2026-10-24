/**
 * 群聊策略在网页上的样子（docs/web-protocol.md §7）：
 * - 面板「群聊意愿」：每个活跃群此刻的意愿，分列 基础 × 话多话少 × 群倍率 × 好感 × 心情 × 时段，好感为什么；
 *   每行「少说点 / 多说点 / 只回@ / 恢复」按钮改这个群的倍率（写配置 rates）。
 * - 面板「接话判断」：最近的判断滚动日志——她为什么没答 / 答了。
 * - 面板「脾气（按人）」：谁让她烦、烦到什么程度、她决定不理 / 拉黑了谁到几点（temper.ts）；「原谅」按钮写日志 temper.forgiven。
 * - 状态卡「群聊」：几个群在聊、现在的时段系数、有没有在排队。
 * 只读，数据全从 index.ts 里现成的投影取，不另存。
 */
import type { Ctx } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { ChatState, PolicyConfig } from './judge.ts'
import { timeFactor } from './judge.ts'
import type { Willing } from './rates.ts'
import { parseRate } from './rates.ts'
import type { BotDeps } from './bot-actions.ts'
import { unlock, writeMarks } from './bot-actions.ts'
import type { Entry, Rooms } from './rooms.ts'
import { SELF } from './rooms.ts'
import type { Temper } from './temper.ts'

export interface Decision { at: number, channel: string, who: string, p: number, why: string[], wake: boolean, topic?: string, attraction?: number, state?: ChatState }

interface Deps {
  cfg: PolicyConfig
  rooms: Rooms
  recent: Decision[]
  isGroup: (ch: string) => boolean
  hide: (ch: string, e: Entry) => boolean // 机器人的话不算群里的人在说
  bots: BotDeps
  temper: Temper // 按人的脾气：面板「脾气（按人）」
  log: (type: string, data: Record<string, unknown>) => void
  willing: (ch: string, now: number) => Willing
  setRate: (ch: string, rate: number) => void
  rateOf: (ch: string) => number
}

const ROOMS = '/api/group-policy/rooms'
const LOG = '/api/group-policy/decisions'
const RATE = '/api/group-policy/rate/' // + less | more | quiet | normal
const BOTS = '/api/group-policy/bots'
const BOT = '/api/group-policy/bot/' // + bot | human | reset | chat
const TEMPER = '/api/group-policy/temper'
const FORGIVE = '/api/group-policy/temper/forgive'

export function webExtras(ctx: Ctx, d: Deps): void {
  const active = (now: number): string[] => d.rooms.channels()
    .filter(ch => d.isGroup(ch) && now - (d.rooms.list(ch).at(-1)?.at ?? 0) < 1_800_000)

  const rows = (): Record<string, unknown>[] => {
    const now = Date.now()
    return active(now).map((ch) => {
      const w = d.willing(ch, now)
      const people = d.rooms.list(ch).filter(e => !d.hide(ch, e))
      const perMin = people.filter(e => e.who !== SELF && now - e.at < 60_000).length
      const last = d.recent.filter(r => r.channel === ch).at(-1)
      const bots = d.bots.bots.rows().filter(r => r.bot && r.channels.includes(ch)).map(r => r.name || r.key)
      return {
        channel: ch,
        group: ch.split(':').pop(),
        willing: w.willing,
        base: w.base,
        talkValue: w.talkValue,
        rate: w.rate,
        affinity: w.affinity,
        affinityWhy: w.affinityWhy,
        mood: w.mood,
        timeFactor: w.time,
        spoke: d.rooms.startsWithin(ch, now, 60_000),
        perMinute: perMin,
        flood: perMin > (d.cfg.floodPerMinute ?? 20) ? '刷屏，静默' : '',
        unread: people.length - 1 - people.findLastIndex(e => e.who === SELF),
        bots: bots.join('、'),
        last: last ? `${last.who} p=${last.p} ${last.wake ? '唤醒' : '没唤醒'}（${last.why.join('、')}）` : '',
        topic: last?.topic ?? '',
        lastAt: d.rooms.list(ch).at(-1)?.at,
      }
    })
  }

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (r.method === 'GET' && r.path === ROOMS) {
      r.response = { body: { items: rows() } }
      return r
    }
    if (r.method === 'POST' && r.path.startsWith(RATE)) {
      const ch = String((r.body as { item?: { channel?: unknown } } | undefined)?.item?.channel ?? '')
      const next = d.isGroup(ch) ? parseRate(r.path.slice(RATE.length), d.rateOf(ch)) : undefined
      if (next === undefined) {
        r.response = { status: 400, body: { error: '要选中一个群，操作是 less / more / quiet / normal' } }
        return r
      }
      d.setRate(ch, next)
      r.response = { status: 204 }
      return r
    }
    if (r.method === 'GET' && r.path === BOTS) {
      r.response = { body: { items: d.bots.bots.rows().map(b => ({
        key: b.key,
        name: b.name,
        bot: b.bot ? '是' : '',
        source: b.source,
        score: b.score,
        why: b.why.join('、'),
        messages: b.messages,
        groups: b.channels.map(c => c.split(':').pop()).join('、'),
        lastAt: b.lastAt || undefined,
      })) } }
      return r
    }
    if (r.method === 'POST' && r.path.startsWith(BOT)) {
      const key = String((r.body as { item?: { key?: unknown } } | undefined)?.item?.key ?? '')
      const op = r.path.slice(BOT.length)
      if (!/^[a-z]+:\d+$/.test(key) || !['bot', 'human', 'reset', 'chat'].includes(op)) {
        r.response = { status: 400, body: { error: '要选中一个人，操作是 bot / human / reset / chat' } }
        return r
      }
      if (op === 'chat')
        unlock(d.bots, key)
      else {
        d.bots.log('bot.marked', { key, name: d.bots.bots.status(key).name, mark: op, by: 'web' })
        writeMarks(d.bots, { key, mark: op as 'bot' | 'human' | 'reset' })
      }
      r.response = { status: 204 }
      return r
    }
    if (r.method === 'GET' && r.path === TEMPER) {
      const now = Date.now()
      r.response = { body: { items: d.temper.rows(now).map(s => ({
        key: s.key,
        name: s.name,
        level: s.level,
        value: s.value,
        why: s.why.join('、'),
        decision: s.decision ? `${s.decision.mode === 'block' ? '拉黑' : '不理'}到 ${new Date(s.decision.until).toLocaleTimeString('zh-CN', { hour12: false, timeZone: d.cfg.timeZone ?? 'Asia/Shanghai' })}：${s.decision.why}` : '',
        lastAt: s.lastAt || undefined,
      })) } }
      return r
    }
    if (r.method === 'POST' && r.path === FORGIVE) {
      const key = String((r.body as { item?: { key?: unknown } } | undefined)?.item?.key ?? '')
      if (!/^[a-z]+:\d+$/.test(key) || !d.temper.ignoring(key, Date.now())) {
        r.response = { status: 400, body: { error: '要选中一个她正在不理的人' } }
        return r
      }
      d.log('temper.forgiven', { key, name: d.temper.status(key, Date.now()).name, why: '网页上点了原谅' })
      r.response = { status: 204 }
      return r
    }
    if (r.method === 'GET' && r.path === LOG) {
      const fmt = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: d.cfg.timeZone ?? 'Asia/Shanghai' })
      r.response = { body: { lines: d.recent.map(x => `${fmt(x.at)} [群 ${x.channel.split(':').pop()}] ${x.who}${x.state ? (x.state === 'chatting' ? ' 在聊' : ' 没在聊') : ''}${x.attraction !== undefined ? ` 话题吸引力 ${x.attraction}` : ''} p=${x.p} ${x.wake ? '→ 唤醒大脑' : '→ 不唤醒'}（${x.why.join('、')}）${x.topic ? ` · 话题${x.topic}` : ''}`) } }
      return r
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'group-policy-rooms',
      title: '群聊意愿',
      kind: 'table',
      endpoint: ROOMS,
      refreshSec: 5,
      rowActions: [
        { label: '少说点', endpoint: `${RATE}less` },
        { label: '多说点', endpoint: `${RATE}more` },
        { label: '只回@', endpoint: `${RATE}quiet`, confirm: '这个群只在有人 @ 她 / 叫她名字时才说话？' },
        { label: '恢复', endpoint: `${RATE}normal` },
      ],
      columns: [
        { key: 'group', label: '群' },
        { key: 'willing', label: '此刻意愿' },
        { key: 'base', label: '基础' },
        { key: 'talkValue', label: '× 话多话少' },
        { key: 'rate', label: '× 群倍率' },
        { key: 'affinity', label: '× 好感' },
        { key: 'mood', label: '× 心情' },
        { key: 'timeFactor', label: '× 时段' },
        { key: 'affinityWhy', label: '好感因为' },
        { key: 'spoke', label: '一分钟内开口' },
        { key: 'perMinute', label: '群里句/分钟' },
        { key: 'flood', label: '刷屏' },
        { key: 'unread', label: '未读' },
        { key: 'bots', label: '群里的机器人' },
        { key: 'last', label: '最近一次判断' },
        { key: 'topic', label: '话题' },
        { key: 'lastAt', label: '最后动静', format: 'time' },
      ],
    }, {
      id: 'group-policy-bots',
      title: '群里的机器人',
      kind: 'table',
      endpoint: BOTS,
      refreshSec: 10,
      rowActions: [
        { label: '是机器人', endpoint: `${BOT}bot` },
        { label: '不是机器人', endpoint: `${BOT}human`, confirm: '标成「不是机器人」？自动判断以后也不会再把他当机器人' },
        { label: '重新自动判断', endpoint: `${BOT}reset` },
        { label: '解锁聊两句', endpoint: `${BOT}chat` },
      ],
      columns: [
        { key: 'name', label: '昵称' },
        { key: 'key', label: '号' },
        { key: 'bot', label: '机器人' },
        { key: 'source', label: '来源' },
        { key: 'score', label: '自动打分' },
        { key: 'why', label: '为什么' },
        { key: 'messages', label: '说过几句' },
        { key: 'groups', label: '在哪些群' },
        { key: 'lastAt', label: '最后说话', format: 'time' },
      ],
    }, {
      id: 'group-policy-temper',
      title: '脾气（按人）',
      kind: 'table',
      endpoint: TEMPER,
      refreshSec: 10,
      rowActions: [
        { label: '原谅', endpoint: FORGIVE, confirm: '让她现在就不再不理这个人？' },
      ],
      columns: [
        { key: 'name', label: '谁' },
        { key: 'key', label: '号' },
        { key: 'level', label: '她对他' },
        { key: 'value', label: '骚扰度' },
        { key: 'why', label: '因为' },
        { key: 'decision', label: '她的决定' },
        { key: 'lastAt', label: '最后说话', format: 'time' },
      ],
    }, {
      id: 'group-policy-log',
      title: '接话判断（为什么答 / 没答）',
      kind: 'log',
      endpoint: LOG,
      refreshSec: 3,
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const now = Date.now()
    const list = rows()
    const t = timeFactor(d.cfg.timeRules ?? [], d.cfg.timeZone ?? 'Asia/Shanghai', new Date(now))
    s.cards.push({
      id: 'group-policy',
      title: '群聊',
      level: 'info',
      text: list.length ? `${list.length} 个群半小时内有动静 · 时段系数 ${t}` : `半小时内没有群消息 · 时段系数 ${t}`,
      items: list.slice(0, 6).map(r => `群 ${r.group}：意愿 ${r.willing}（倍率 ${r.rate} · 好感 ${r.affinity} · 心情 ${r.mood}）${r.flood ? '，刷屏静默' : ''}${r.unread ? `，未读 ${r.unread}` : ''}`),
    })
    return next()
  })
}
