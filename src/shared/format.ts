/**
 * 插件可选用的渲染助手，内核不使用。
 * 内核只出结构化数据，呈现方式由消费方决定。
 */
import type { Note } from '../kernel/index.ts'

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60)
    return `${s}秒`
  if (s < 3600)
    return `${Math.floor(s / 60)}分${s % 60}秒`
  return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`
}

/** 工作记忆的常规呈现：带来源与相对时间 */
export function renderNotes(notes: Note[]): string[] {
  return notes.map(n => `[${n.source} · 距今 ${formatElapsed(n.elapsedMs)}] ${n.text}`)
}
