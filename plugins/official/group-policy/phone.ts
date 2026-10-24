/**
 * 「手机上现在的情况」：给大脑的一块材料，像手机通知栏。
 *
 * 真人同时挂着好几个群和私聊，但一次只在一个会话里打字：先看谁在找自己（私聊、@），再扫一眼群。
 * 大脑是单个的、看所有频道，所以把每个会话压成一行：未读几条、有没有人 @ 她、最后一两句、多久前。
 * 她刚在哪个会话、是不是正忙着用电脑，也写在这里——切会话要不要有由头、先回谁，由大脑自己判断。
 */
import type { RunningView } from '../../../src/index.ts'
import { formatElapsed } from '../../../src/index.ts'
import type { Entry, Rooms } from './rooms.ts'
import { SELF } from './rooms.ts'

export interface PhoneConfig { windowSec?: number, lines?: number, max?: number }

/** hide：群里的机器人说的不算未读、不算有人 @ 她（bots.ts） */
export function renderPhone(rooms: Rooms, cfg: PhoneConfig, isGroup: (ch: string) => boolean, busy: RunningView[], now = Date.now(), hide: (ch: string, e: Entry) => boolean = () => false): string | undefined {
  const windowMs = (cfg.windowSec ?? 1800) * 1000
  const rows: { rank: number, at: number, text: string }[] = []
  for (const ch of rooms.channels()) {
    const list = rooms.list(ch).filter(e => !hide(ch, e))
    const last = list[list.length - 1]
    if (!last || now - last.at > windowMs)
      continue
    const unread = list.slice(list.findLastIndex(e => e.who === SELF) + 1)
    const group = isGroup(ch)
    const calling = unread.some(e => e.direct)
    const others = list.filter(e => e.who !== SELF)
    const label = group
      ? `群 ${ch.split(':').pop()}`
      : ch.startsWith('qq:private:')
        ? `私聊 ${others[others.length - 1]?.name ?? ch.split(':').pop()}`
        : `网页对话${ch === 'main' ? '' : `（${ch}）`}`
    const show = (unread.length ? unread : list).slice(-(cfg.lines ?? 2))
      .map(e => `${group && e.who !== SELF ? (e.name ?? e.who) : e.who === SELF ? '你' : ''}「${clip(e.text)}」`)
      .join(' / ')
    const state = unread.length
      ? `${unread.length} 条未读${calling ? (group ? '，有人 @ 你' : '，在等你回') : ''}`
      : '已回'
    // 排序：在等她回的私聊 > 有人 @ 她的群 > 有未读的 > 其余，同级按新近
    const rank = !group && calling ? 0 : calling ? 1 : unread.length ? 2 : 3
    rows.push({ rank, at: last.at, text: `- ${label} [${ch}]：${state}（${ago(now - last.at)}）${show}` })
  }
  if (!rows.length && !busy.length)
    return undefined
  rows.sort((a, b) => a.rank - b.rank || b.at - a.at)
  const lines = rows.slice(0, cfg.max ?? 8).map(r => r.text)
  const here = rooms.lastSpoken()
  if (here && now - here.at < windowMs)
    lines.unshift(`- 你刚在：${here.channel}（${ago(now - here.at)}开过口）`)
  for (const b of busy)
    lines.push(`- 你正在忙：${b.id}（${b.note || '启动中'}），群里只回 @ 你的`)
  return `【手机上现在的情况】（你一次只在一个会话里；先回找你的，再看群）\n${lines.join('\n')}`
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ')
  return t.length > 30 ? `${t.slice(0, 30)}…` : t
}

function ago(ms: number): string {
  return ms < 10_000 ? '刚刚' : `${formatElapsed(ms)}前`
}
