/**
 * 动作结束那次唤醒去重（纯函数，单测直接测）。
 *
 * 带结果感知的动作（computer / dsh / search……，感知 data.actionId 指回动作）先发结果感知唤醒一拍，再结算；
 * 结算时内核固定再唤醒一次「动作 x#n 完成」（ActionRegistry.settle，冻结契约，不改）。
 * 结果那拍已经看过结果、起了后续动作，结束那拍再想一遍就会把后续动作再做一次——
 * 模拟器 2026-10-22：search 结果那拍起了 image，search 结束那拍又起一个 image，群里发了两张图。
 *
 * 所以：动作结束的原因，若它的结果感知已经在之前某拍处理过（不在本拍原因里），就从本拍原因里拿掉；
 * 结果感知还在本拍原因里（比如结果那拍被作废、原因带到了这拍）就留着。没有结果感知的动作（reply、image）不受影响。
 */
import type { LogEvent, WakeReason } from '../../../src/index.ts'

const ACTION = 'action:'

export function dropReported(reasons: WakeReason[], events: readonly LogEvent[]): WakeReason[] {
  if (!reasons.some(r => r.source.startsWith(ACTION)))
    return reasons
  return reasons.filter((r) => {
    if (!r.source.startsWith(ACTION))
      return true
    const id = endedId(events, r.source.slice(ACTION.length), r.at)
    const result = id ? resultOf(events, id) : undefined
    if (!result)
      return true
    const inThisBeat = reasons.some(x => x.source === result.data.kind && x.text === (result.data.text ?? result.data.kind))
    return inThisBeat
  })
}

/** 这条「动作完成」原因对应哪个实例：结算先记 action.ended 再唤醒，取原因时刻之前最近一条同类型的 */
function endedId(events: readonly LogEvent[], type: string, at: number): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.at > at)
      continue
    if (at - e.at > 60_000)
      return undefined
    if (e.type === 'action.ended' && String(e.data?.id).startsWith(`${type}#`))
      return String(e.data.id)
  }
  return undefined
}

/** 这个实例的结果感知（往回最多看到它的 action.started 为止） */
function resultOf(events: readonly LogEvent[], id: string): LogEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'percept.received' && e.data?.data?.actionId === id)
      return e
    if (e.type === 'action.started' && e.data?.id === id)
      return undefined
  }
  return undefined
}
