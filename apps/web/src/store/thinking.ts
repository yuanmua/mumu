/**
 * 思考时间线：把原始日志整理成人能读的「轮次」。纯函数，调试页的「思考」标签用它。
 *
 * 一轮 = 从一条用户消息（或一次定时醒来）到下一条之间发生的事：
 * 大脑想了什么、回复首字多久、说了什么、被打断在哪、脊椎兜底开没开口、硬闸拦了什么、心情怎么变。
 * 大脑 = mind-default 插件，脊椎 = reflex 插件（旧称导演、反射）；事件名没改。
 * 时间全部相对本轮开始，单位 ms。
 */
import type { LogEvent } from '../protocol/types.ts'

/** 硬闸理由（reflex 插件的 intent.blocked.why）→ 人话 */
const BLOCK_WHY: Record<string, string> = {
  'reply-running': '同频道已有回复在说',
  'merge-pending': '对方还在发',
  'stale-running': '想的时候已有回复在说，说完了就不再说一遍',
  'spine-answered': '脊椎已经先应过一声',
  'busy-elsewhere': '她正在别的会话说话，排队',
}

export type ItemKind = 'user' | 'reflex' | 'reply' | 'decision' | 'blocked' | 'timer' | 'emotion' | 'tool' | 'error' | 'thinking'

export interface ReplyInfo {
  uttId: string
  actionId?: string
  reflex: boolean
  guidance?: string
  append?: boolean
  text: string // 生成的文本（打断时为对方实际听到的）
  generated: string
  markers: { track: string, value: string }[]
  firstTokenMs?: number
  settled?: boolean
  truncated?: boolean
  cause?: string
  durationMs?: number
}

export interface DecisionInfo {
  note?: string
  intents: unknown[]
  wakeAfterSec?: number
  aborted: boolean
  tookMs: number
  reasons: { source: string, text: string }[]
}

export interface TurnItem {
  key: string
  at: number
  offsetMs: number
  kind: ItemKind
  title: string
  detail?: string
  reply?: ReplyInfo
  decision?: DecisionInfo
}

export interface Turn {
  id: string
  startedAt: number
  kind: 'user' | 'timer' | 'boot'
  user?: string
  items: TurnItem[]
}

function describeIntents(intents: unknown[]): string {
  if (!intents.length)
    return '不动'
  return intents.map((raw) => {
    const it = raw as { do?: string, action?: string, params?: { guidance?: string, append?: boolean }, target?: string, to?: string, message?: string, reason?: string }
    if (it.do === 'start')
      return `起 ${it.action}${it.params?.append ? '（补充）' : ''}${it.params?.guidance ? `：${it.params.guidance}` : ''}`
    if (it.do === 'stop')
      return `停 ${it.target}${it.reason ? `（${it.reason}）` : ''}`
    if (it.do === 'send')
      return `给 ${it.to} 捎话：${it.message}`
    return JSON.stringify(it)
  }).join('；')
}

export function buildTurns(events: LogEvent[]): Turn[] {
  const turns: Turn[] = []
  const replies = new Map<string, { item: TurnItem, info: ReplyInfo }>()
  const actionParams = new Map<string, { reflex?: boolean, quick?: boolean, guidance?: string, append?: boolean }>()
  let current: Turn | undefined

  const open = (kind: Turn['kind'], at: number, user?: string): Turn => {
    current = { id: `${kind}-${at}-${turns.length}`, startedAt: at, kind, user, items: [] }
    turns.push(current)
    return current
  }
  const push = (at: number, kind: ItemKind, title: string, extra: Partial<TurnItem> = {}): TurnItem => {
    const t = current ?? open('boot', at)
    const item: TurnItem = { key: `${t.id}-${t.items.length}`, at, offsetMs: at - t.startedAt, kind, title, ...extra }
    t.items.push(item)
    return item
  }

  for (const e of events) {
    const d = e.data ?? {}
    switch (e.type) {
      case 'percept.received':
        if (d.text && d.sender) {
          open('user', e.at, d.text)
          push(e.at, 'user', d.text)
        }
        else if (d.kind === 'performer.tool') {
          push(e.at, 'tool', '说话中想用工具', { detail: d.text })
        }
        break
      case 'beat.opened': {
        const reasons: { source: string, text: string }[] = d.reasons ?? []
        if (reasons.some(r => r.source === 'timer') && !reasons.some(r => r.source === 'message')) {
          open('timer', e.at)
          push(e.at, 'timer', '到了自己定的时间，醒来看看')
        }
        else {
          push(e.at, 'thinking', `开始想（${reasons.map(r => r.source).join('、') || '…'}）`)
        }
        break
      }
      case 'reflex.started':
        push(e.at, 'reflex', `脊椎兜底开口 ${d.actionId}`)
        break
      case 'action.started':
        if (typeof d.id === 'string' && d.id.startsWith('reply#'))
          actionParams.set(d.id, d.params ?? {})
        break
      case 'utterance.started': {
        const params = actionParams.get(d.action) ?? {}
        const info: ReplyInfo = {
          uttId: d.id,
          actionId: d.action,
          reflex: !!params.reflex,
          guidance: params.guidance,
          append: !!params.append,
          text: '',
          generated: '',
          markers: [],
        }
        const item = push(e.at, 'reply', params.reflex ? (params.quick ? '快回（大脑放行）' : '脊椎兜底回复') : params.append ? '大脑补充' : '大脑起的回复', { reply: info })
        replies.set(d.id, { item, info })
        break
      }
      case 'utterance.part': {
        const r = replies.get(d.id)
        if (!r)
          break
        const p = d.part ?? {}
        if (p.kind === 'text' && p.text) {
          if (r.info.firstTokenMs === undefined)
            r.info.firstTokenMs = e.at - r.item.at
          r.info.generated += p.text
          r.info.text = r.info.generated
        }
        else if (p.kind === 'marker' && p.data?.track) {
          r.info.markers.push({ track: p.data.track, value: String(p.data.value ?? '') })
        }
        break
      }
      case 'utterance.settled': {
        const r = replies.get(d.id)
        if (!r)
          break
        r.info.settled = true
        r.info.truncated = !!d.truncated
        r.info.cause = d.cause
        r.info.text = d.delivered ?? r.info.generated
        r.info.durationMs = e.at - r.item.at
        if (!d.delivered && !r.info.generated)
          r.item.title += '（没来得及说）'
        else if (d.truncated)
          r.item.title += '（被打断）'
        break
      }
      case 'mind.decision': {
        const info: DecisionInfo = {
          note: d.note,
          intents: d.intents ?? [],
          wakeAfterSec: d.wakeAfterSec,
          aborted: !!d.aborted,
          tookMs: d.tookMs ?? 0,
          reasons: d.reasons ?? [],
        }
        push(e.at, 'decision', info.aborted ? '想法作废' : describeIntents(info.intents), { decision: info, detail: d.note })
        break
      }
      case 'intent.blocked':
        push(e.at, 'blocked', `硬闸拦下：${describeIntents([d.intent])}`, { detail: BLOCK_WHY[d.why] ?? d.why })
        break
      case 'emotion.changed':
        push(e.at, 'emotion', `心情：${d.label}`, { detail: d.last ? `刚表达过「${d.last}」` : undefined })
        break
      case 'beat.failed':
        push(e.at, 'error', '这一拍失败了', { detail: d.error })
        break
      case 'action.ended':
        if (d.outcome === 'error')
          push(e.at, 'error', `${d.id} 出错`, { detail: d.error })
        break
    }
  }
  return turns
}
