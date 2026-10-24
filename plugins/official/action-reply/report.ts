/**
 * 汇报动作结果（纯函数，单测直接测）。
 *
 * 真群 2026-10-22：DSH 跑完水杯题，大脑两拍的 guidance 都写着「n=8 k=3 最坏要问 5 次」，
 * 发言者却两次去接群里最后那条挑衅的话，结果一个字没提。提示词里【此刻你心里想的】夹在中间，
 * 后面【要求】叫它「把握当前的话题」，历史最后一条又是别人的闲话——它就跟着闲话走了。
 * 所以：本对话里有还没汇报的动作结果时，给这次发言加一段排在【要求】前面的「这次开口是汇报」，带结果原文摘录。
 */
import type { LogEvent } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'

export interface ResultConfig {
  kinds: string[] // 算「动作结果」的感知 kind
  windowMs: number // 这么久以前的结果不再提
  maxChars: number // 结果原文摘录多少字
}

const chanOf = (e: LogEvent): string => e.data?.channel ?? MAIN_CHANNEL

/**
 * 本对话最近一条动作结果，它之后还没有带想法的 reply 开过口 → 返回它。
 * 快回（reflex）不算汇报：结果回来时对方恰好「在吗」，那句「在」不能把结果吞了。
 */
export function pendingResult(events: readonly LogEvent[], channel: string, selfId: string, now: number, cfg: ResultConfig): LogEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (now - e.at > cfg.windowMs)
      return undefined
    if (e.type === 'action.started' && String(e.data?.id).startsWith('reply#') && e.data.id !== selfId && chanOf(e) === channel && !e.data.params?.reflex)
      return undefined
    if (e.type === 'percept.received' && cfg.kinds.includes(e.data?.kind) && chanOf(e) === channel)
      return e
  }
  return undefined
}

/** 压成一行再截断：结果多是带代码块的 markdown，发言者只要挑要紧的说 */
const oneLine = (s: unknown, max: number): string => String(s ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, max)

export function renderReport(e: LogEvent, maxChars: number): string {
  const d = e.data?.data ?? {}
  const task = oneLine(d.task, 40)
  const body = oneLine(d.result ?? e.data?.text, maxChars)
  return `【这次开口是汇报】你刚${d.ok === false ? '没做成' : '做完'}一件事${task ? `（「${task}…」）` : ''}，这次就围绕它说：`
    + '做成了什么、关键的数字或结论；没做成就说卡在哪。【此刻你心里想的】里的要点照着说。'
    + '别去接群里最新的闲话、别回刚才谁说了什么，那些这次先不管；下面【要求】里的「当前的话题」这次就是这件事。'
    + (body ? `\n结果原文摘录（挑要紧的说，别念代码和路径）：${body}` : '')
}
