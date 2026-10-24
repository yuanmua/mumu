/**
 * 进度：把 DSH 的每一步翻成一句人能看懂的话，并从日志现算「手头的活」给导演和发言者。
 *
 * 立场：
 * - 一句话摘要优先用 DSH 自己写的工具说明（preamble 要它用中文写），没有就按工具种类说「写了 snake.py」「跑了个命令」，
 *   绝不把命令原文贴给她——她要的是「在干嘛」，不是 PowerShell。
 * - 进度的真源是日志里的 `dsh.step`（每步一条，带 say），材料和网页都从它现算，插件里不另存一份。
 */
import type { LogEvent } from '../../../src/index.ts'
import { formatElapsed } from '../../../src/index.ts'

/** 一步的一句话：DSH 写的说明 > 按工具种类 */
export function sayOf(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const desc = typeof o.description === 'string' ? o.description.trim() : ''
  if (desc)
    return desc.slice(0, 60)
  const file = typeof o.file_path === 'string' ? o.file_path : typeof o.path === 'string' ? o.path : ''
  const base = file.split(/[\\/]/).pop() ?? ''
  if (/^(write|create)/i.test(tool))
    return base ? `写了 ${base}` : '写文件'
  if (/edit|patch|replace/i.test(tool))
    return base ? `改了 ${base}` : '改文件'
  if (/image/i.test(tool))
    return base ? `看了一眼 ${base}` : '看了张图'
  if (/^(read|view|cat)/i.test(tool))
    return base ? `看了看 ${base}` : '翻文件'
  if (/glob|grep|search|find|ls/i.test(tool))
    return '在找文件'
  if (/web|fetch|http/i.test(tool))
    return '上网查资料'
  if (/todo|plan/i.test(tool))
    return '理了理步骤'
  if (/pwsh|bash|shell|exec/i.test(tool))
    return '跑了个命令'
  return `用了 ${tool}`
}

export interface Work {
  id: string
  task: string
  steps: number
  elapsedMs: number
  recent: string[] // 最近几步的一句话，旧 → 新
  stuck?: string // 最近一步出错了（之后还没成功过）
}

/** 某个运行中的 dsh 实例此刻的「手头的活」，从日志现算 */
export function workOf(events: readonly LogEvent[], id: string, runningMs: number): Work {
  let task = ''
  const says: string[] = []
  let stuck: string | undefined
  let steps = 0
  for (const e of events) {
    if (e.type === 'action.started' && e.data.id === id) {
      task = String(e.data.params?.task ?? '')
      says.length = 0
      stuck = undefined
      steps = 0
    }
    else if (e.type === 'dsh.step' && e.data.actionId === id) {
      steps = Math.max(steps, Number(e.data.step) || 0)
      says.push(String(e.data.say || e.data.tool))
      stuck = e.data.status === 'error'
        ? `「${e.data.say || e.data.tool}」没成功：${String(e.data.result ?? '').replace(/\s+/g, ' ').slice(0, 80)}`
        : undefined
    }
  }
  return { id, task, steps, elapsedMs: runningMs, recent: says.slice(-3), stuck }
}

export function describe(w: Work): string {
  return `「${w.task.slice(0, 80)}」做到第 ${w.steps} 步（${formatElapsed(w.elapsedMs)}）`
    + `${w.recent.length ? `，刚才：${w.recent.join(' → ')}` : '，还在起步'}`
    + `${w.stuck ? `；卡在：${w.stuck}` : ''}`
}
