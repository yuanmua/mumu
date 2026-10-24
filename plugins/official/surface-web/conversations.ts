/**
 * /api/conversations：从日志真源投影对话列表，带来源（网页 / QQ 群 / QQ 私聊 / 以后的平台）。契约见 docs/web-protocol.md §3。
 *
 * 立场：
 * - 不认识任何平台：来源全靠两条通用约定推——频道名 `<platform>:<kind>:<id>`，以及平台插件在感知 data 里带的
 *   platform / chat / groupName（§5「平台感知的 data」）。新平台照约定起频道名就自动有来源，本文件不用改。
 * - 纯函数，吃日志事件数组；index.ts 只挂一个分支。
 */
import type { LogEvent } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'

export interface Source {
  platform: string // web | qq | …
  kind: string // web | group | private
  id?: string
  name?: string
}

export interface Conversation {
  channel: string
  title: string
  firstAt: number
  lastAt: number
  count: number // 别人说过几句
  said: number // 她今天在这里说出去几条
  source: Source
}

/** 频道名 → 来源骨架；main 与 c:<id> 是网页对话 */
export function sourceOf(channel: string): Source {
  const parts = channel.split(':')
  if (channel === MAIN_CHANNEL || parts[0] === 'c' || parts.length < 3)
    return { platform: 'web', kind: 'web' }
  return { platform: parts[0], kind: parts[1], id: parts.slice(2).join(':') }
}

const startOfToday = (now: number): number => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 指定对话的重放窗口：本频道自己的事件优先（最近 own 条），无频道的事件（拍子、模型、心情…）只补这段时间里最近 shared 条。
 * 不能「混在一起取最后 N 条」：别的频道一忙，满屏的无频道事件会把这个对话较早的消息挤出窗口，
 * 网页上就看不到对方说了什么、她回了什么（2026-10-21 QQ 私聊打开是空的就是这个）。
 */
export function replayWindow(
  events: readonly LogEvent[],
  channelOf: (e: LogEvent) => string | undefined,
  channel: string,
  own: number,
  shared: number,
): LogEvent[] {
  const mine = events.filter(e => channelOf(e) === channel).slice(-own)
  const since = mine[0]?.seq ?? -Infinity
  const common = events.filter(e => e.seq >= since && channelOf(e) === undefined).slice(-shared)
  return [...mine, ...common].sort((a, b) => a.seq - b.seq)
}

export function listConversations(events: readonly LogEvent[], now = Date.now()): Conversation[] {
  const today = startOfToday(now)
  const map = new Map<string, Conversation>()
  const said = new Map<string, number>()
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'utterance.settled' && d.delivered && e.at >= today) {
      const ch = d.channel ?? MAIN_CHANNEL
      said.set(ch, (said.get(ch) ?? 0) + 1)
      continue
    }
    if (e.type !== 'percept.received' || !d.text || !d.sender)
      continue
    const ch: string = d.channel ?? MAIN_CHANNEL
    const data = (d.data ?? {}) as Record<string, unknown>
    let c = map.get(ch)
    if (!c) {
      c = { channel: ch, title: String(d.text).slice(0, 24), firstAt: e.at, lastAt: e.at, count: 0, said: 0, source: sourceOf(ch) }
      map.set(ch, c)
    }
    c.lastAt = e.at
    c.count++
    // 插件报的比频道名推的准；取最近一条的，群改名后跟着变
    if (typeof data.platform === 'string')
      c.source.platform = data.platform
    if (data.chat === 'group' || data.chat === 'private')
      c.source.kind = data.chat
    const name = c.source.kind === 'group' ? data.groupName : c.source.kind === 'private' ? d.sender.name : undefined
    if (typeof name === 'string' && name)
      c.source.name = name
  }
  if (!map.has(MAIN_CHANNEL))
    map.set(MAIN_CHANNEL, { channel: MAIN_CHANNEL, title: '默认对话', firstAt: 0, lastAt: 0, count: 0, said: 0, source: sourceOf(MAIN_CHANNEL) })
  for (const c of map.values()) {
    c.said = said.get(c.channel) ?? 0
    // 平台会话的标题是「谁」而不是第一句话；群名还没报上来时先用群号
    if (c.source.name)
      c.title = c.source.name
    else if (c.source.kind === 'group' && c.source.id)
      c.title = `群 ${c.source.id}`
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
}
