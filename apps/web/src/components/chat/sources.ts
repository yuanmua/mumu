/**
 * 对话来源的纯函数：图标 + 标签、按来源筛选、未读数。vitest 测。
 * 不认识具体平台：图标按 kind（网页 / 群 / 私聊）给，标签前面加平台名；新平台不用改这里。
 */
import type { Conversation, Source } from '../../protocol/types.ts'

export type SourceFilter = 'all' | 'web' | 'group' | 'private'

const WEB: Source = { platform: 'web', kind: 'web' }
const PLATFORM_NAMES: Record<string, string> = { qq: 'QQ', telegram: 'Telegram', wechat: '微信' }

export const sourceOf = (c: Pick<Conversation, 'source'> | undefined): Source => c?.source ?? WEB

/** 网页之外的会话：别人在左、她在右，发言人带名字和头像 */
export const isPlatform = (s: Source): boolean => s.kind !== 'web'

export function badge(s: Source): { icon: string, label: string } {
  if (!isPlatform(s))
    return { icon: '🌐', label: '网页' }
  const p = PLATFORM_NAMES[s.platform] ?? s.platform
  if (s.kind === 'group')
    return { icon: '👥', label: `${p} 群` }
  if (s.kind === 'private')
    return { icon: '💬', label: `${p} 私聊` }
  return { icon: '💬', label: `${p} ${s.kind}` }
}

export function matches(c: Conversation, f: SourceFilter): boolean {
  if (f === 'all')
    return true
  const k = sourceOf(c).kind
  return f === 'web' ? k === 'web' : k === f
}

/** 未读 = 现在的句数 − 看过时的句数；正在看的这个不算未读 */
export function unread(c: Conversation, seen: Record<string, number>, current: string): number {
  if (c.channel === current)
    return 0
  return Math.max(0, c.count - (seen[c.channel] ?? 0))
}

/**
 * 首字占位头像的底色：同一个人每次同色。QQ 号常是连号（20004、20005），
 * 直接取模会几乎同色，所以按黄金角（≈137.5°）散开：哈希差 1，色相差一大截。
 */
export function hue(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return Math.round((h * 137.508) % 360)
}
