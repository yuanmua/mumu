/**
 * 「电脑任务」的投影：从日志真源（action.started / computer.step / computer.result / action.ended）算出每次任务做了什么，
 * 再排成网页 log 面板的行。纯函数，不持状态——UI 是日志的纯投影（web-protocol §0）。
 */
import type { LogEvent } from '../../../src/index.ts'
import { formatElapsed } from '../../../src/index.ts'
import { shotId, shotUrl } from './shots.ts'

export interface StepView {
  step: number
  at: number
  say: string
  tool: string
  observation: string
  shot?: string // 媒体文件名
}

export interface TaskView {
  id: string
  kind: string // 动作类型：computer / dsh
  task: string
  channel?: string
  startedAt: number
  endedAt?: number
  outcome?: string // action.ended 的 outcome：done / stopped / error / interrupted
  error?: string
  ok?: boolean
  result?: string
  finalShot?: string
  steps: StepView[]
}

export interface ShotView {
  id: string
  media: string
  url: string
  at: number
  actionId: string
  step: number
  say: string
}

/**
 * 最近 limit 次任务，旧的在前（log 面板最新在下）。
 * kinds 缺省只看 computer；「手头的活」段落连 dsh 一起看（它的 dsh.step / dsh.result 形状相近：say|text|summary、tool|kind、observation|output）
 */
export function tasksOf(events: readonly LogEvent[], limit: number, kinds: readonly string[] = ['computer']): TaskView[] {
  const map = new Map<string, TaskView>()
  const stepTypes = new Set(kinds.map(k => `${k}.step`))
  const resultKinds = new Set(kinds.map(k => `${k}.result`))
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'action.started' && kinds.includes(String(d.type))) {
      map.set(String(d.id), { id: String(d.id), kind: String(d.type), task: String(d.params?.task ?? ''), channel: d.channel, startedAt: e.at, steps: [] })
      continue
    }
    if (stepTypes.has(e.type)) {
      const t = map.get(String(d.actionId))
      if (!t)
        continue
      if (d.done) {
        t.ok = d.ok !== false
        t.result = String(d.result ?? '')
        if (typeof d.shot === 'string')
          t.finalShot = d.shot
      }
      else {
        t.steps.push({
          step: Number(d.step) || t.steps.length + 1,
          at: e.at,
          say: String(d.say ?? d.text ?? d.summary ?? ''),
          tool: String(d.tool ?? d.kind ?? ''),
          observation: String(d.observation ?? d.output ?? ''),
          shot: typeof d.shot === 'string' ? d.shot : undefined,
        })
      }
      continue
    }
    if (e.type === 'percept.received' && resultKinds.has(String(d.kind))) {
      const t = map.get(String(d.data?.actionId))
      if (t) {
        t.ok = d.data?.ok === true
        t.result = String(d.data?.result ?? t.result ?? '')
      }
      continue
    }
    if (e.type === 'action.ended') {
      const t = map.get(String(d.id))
      if (t) {
        t.endedAt = e.at
        t.outcome = String(d.outcome ?? '')
        if (d.error)
          t.error = String(d.error)
      }
    }
  }
  return [...map.values()].slice(-limit)
}

export interface RunningLike {
  id: string
  note: string
  runningMs: number
  channel?: string
}

/**
 * 给发言者的「手头的活」：四种状态一眼看清——进行中 / 刚做完 / 没做成 / 对方说了但还没开始。
 * 反射爱抢着说「看完了 / 写好了」（实测带偏导演），所以状态要写死在材料里，再附一条底线。
 * 什么都没有（没在做、最近没做完、对方最近没说话）就返回空串，段落不出现。
 */
export function handsOn(events: readonly LogEvent[], running: readonly RunningLike[], now = Date.now()): string {
  const tasks = tasksOf(events, 100, ['computer', 'dsh'])
  const byId = new Map(tasks.map(t => [t.id, t]))
  const lines: string[] = []
  const who = (k: string): string => k === 'dsh' ? '写代码的助手在帮你做' : '你正在做'
  for (const r of running) {
    const t = byId.get(r.id)
    if (!t)
      continue
    lines.push(`- 进行中：${who(t.kind)} ${runningBrief(t, r.note, r.runningMs)}`)
  }
  const liveIds = new Set(running.map(r => r.id))
  const done = tasks.filter(t => t.endedAt && !liveIds.has(t.id) && now - t.endedAt < 5 * 60_000)
  for (const t of done.slice(-2)) {
    const how = t.outcome === 'stopped' ? '被叫停了' : t.outcome === 'error' ? `出错了（${oneLine(t.error ?? '', 60)}）` : t.ok === false ? '没做成' : t.ok ? '做成了' : '结束了'
    lines.push(`- ${t.ok ? '刚做完' : '刚失败'}（${formatElapsed(now - t.endedAt!)}前，对话 ${t.channel ?? 'main'}）：「${oneLine(t.task, 50)}」${how}${t.result ? `：${oneLine(t.result, 100)}` : ''}`)
  }
  // 对方最新一句之后那个对话里没起过活：如果那句是让她做事，就是还没开始
  const said = [...events].reverse().find(e => e.type === 'percept.received' && e.data?.sender && e.data?.text && now - e.at < 3 * 60_000)
  if (said) {
    const ch = String(said.data.channel ?? 'main')
    const startedAfter = events.some(e => e.at >= said.at && e.type === 'action.started' && (e.data.type === 'computer' || e.data.type === 'dsh') && (e.data.channel === undefined || e.data.channel === ch))
    const runningHere = running.some(r => (r.channel ?? 'main') === ch)
    if (!startedAfter && !runningHere)
      lines.push(`- 还没开始：对方 ${formatElapsed(now - said.at)}前在对话 ${ch} 说「${oneLine(String(said.data.text), 60)}」，之后没起过电脑上的活。那句要是让你做事，你就是还没动手——只能说「这就去 / 在弄」，不能说做好了`)
  }
  if (!lines.length)
    return ''
  return `【手头的活】\n${lines.join('\n')}\n规矩：活没做完绝不说「做完了 / 看完了 / 写好了」；不知道进度就说「还在弄」；只有上面写着「刚做完」才能说做好了。被问「怎么样了」就照上面说具体的。`
}

export function statusText(t: TaskView): string {
  if (!t.endedAt)
    return `进行中（已做 ${t.steps.length} 步）`
  if (t.outcome === 'stopped')
    return '被叫停'
  if (t.outcome === 'error')
    return `出错：${t.error ?? ''}`
  if (t.outcome === 'interrupted')
    return '中断（后端重启了）'
  if (t.ok === undefined)
    return '结束'
  return t.ok ? '做完了 ✓' : '没做成 ✗'
}

const clock = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
const day = (at: number): string => new Date(at).toLocaleString('zh-CN', { hour12: false })
const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/** 一次任务在 log 面板里的几行 */
export function taskLines(t: TaskView, now = Date.now()): string[] {
  const took = formatElapsed((t.endedAt ?? now) - t.startedAt)
  const lines = [
    `━━ ${t.id} · ${day(t.startedAt)} · ${statusText(t)} · ${t.steps.length} 步 · ${took}${t.channel ? ` · 对话 ${t.channel}` : ''}`,
    `任务：${t.task || '（没写）'}`,
  ]
  for (const s of t.steps) {
    lines.push(`  ${String(s.step).padStart(3)}. ${clock(s.at)} ${s.tool}｜${s.say || '（没说）'} → ${oneLine(s.observation, 120) || '（没有结果）'}`)
    if (s.shot)
      lines.push(`       📷 ${shotUrl(s.shot)}`)
  }
  if (t.result !== undefined)
    lines.push(`结果：${t.ok ? '做成了' : '没做成'}——${oneLine(t.result, 400)}`)
  if (t.finalShot)
    lines.push(`       📷 ${shotUrl(t.finalShot)}`)
  lines.push('')
  return lines
}

/** 观察是不是「这条路不通」：身体服务的 {error}、本地标的「出错」、超时 */
export const isError = (obs: string): boolean => obs.startsWith('出错') || obs.startsWith('{"error"') || obs.includes('没回应（')

/** 尾部连着几步出错（0 = 上一步是顺的） */
export function stuckTail(t: TaskView): number {
  let n = 0
  for (let i = t.steps.length - 1; i >= 0 && isError(t.steps[i].observation); i--) n++
  return n
}

/**
 * 正在做的一件事，给导演 / 发言者看的一句：任务、第几步、刚做了什么、卡在哪、是否在等对方回答。
 * note 是运行表里的现状（agent 每步更新），runningMs 已跑多久。
 */
export function runningBrief(t: TaskView, note: string, runningMs: number, lastSaid?: string): string {
  const last = t.steps.at(-1)
  const parts = [`${t.id}「${oneLine(t.task, 60)}」第 ${t.steps.length} 步（已 ${Math.round(runningMs / 1000)} 秒，眼下：${note}）`]
  if (last?.tool === 'ask') {
    // 导演转问的 reply 常被硬闸拦掉（反射那句「这就去弄」正占着），之后它以为问过了（实测）：把她最后说的那句摆出来对照
    parts.push(`在等对方回答：${last.say.replace(/^问对方：/, '')}（问了 ${Math.round((Date.now() - last.at) / 1000)} 秒）`)
    if (lastSaid !== undefined)
      parts.push(`你在这个对话里最后说的是「${oneLine(lastSaid, 60)}」——那句要是没把问题问出来，现在就 start reply 原样问`)
  }
  else if (last)
    parts.push(`刚做了：${last.say || last.tool} → ${oneLine(last.observation, 80) || '（没有结果）'}`)
  const stuck = stuckTail(t)
  if (stuck >= 2)
    parts.push(`卡住了：连着 ${stuck} 步没走通，在换办法`)
  return parts.join('；')
}

/** 所有截图，新的在前 */
export function shotsOf(tasks: TaskView[]): ShotView[] {
  const out: ShotView[] = []
  for (const t of tasks) {
    for (const s of t.steps) {
      if (s.shot)
        out.push({ id: shotId(s.shot), media: s.shot, url: shotUrl(s.shot), at: s.at, actionId: t.id, step: s.step, say: s.say })
    }
    if (t.finalShot)
      out.push({ id: shotId(t.finalShot), media: t.finalShot, url: shotUrl(t.finalShot), at: t.endedAt ?? t.startedAt, actionId: t.id, step: t.steps.length + 1, say: '做完时的屏幕' })
  }
  return out.reverse()
}
