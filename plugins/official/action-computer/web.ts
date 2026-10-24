/**
 * 电脑身体在网页上的样子（docs/web-protocol.md §7）：状态页一张「电脑身体」卡（身体服务在不在、以什么权限跑、正在做什么），
 * 设置 → 面板里一块「电脑任务」滚动日志（每次任务的指令、每一步、截图链接、结果、耗时），
 * 自带接口 /api/action-computer/{tasks,shots,shots/<id>,stop}。
 *
 * 立场：
 * - 全走水线（web/route、web/meta、web/status），surface-web 与前端一行不改；类型只 import type。
 * - 任务记录从日志现算（view.ts），本模块不另存一份；正在做的那一个看运行表（a.note 的「第 n 步」）。
 * - web/route 的响应只能是 JSON（surface-web 统一序列化），所以截图文件本体由 surface-web 现成的
 *   `GET /api/media/<name>` 提供；/shots/<id> 回的是这张图的元数据与那个地址。
 * - 探活用短超时：状态页每 10 秒刷一次，身体掉线时不能让整页卡 8 秒。
 */
import type { Ctx } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { BodyClient } from './body.ts'
import { BodyError, busyText } from './body.ts'
import { shotsOf, taskLines, tasksOf } from './view.ts'

export interface WebDeps {
  client: () => BodyClient
  panelTasks: number // 面板里保留最近几次任务
  shotsOn: boolean
  stopAll: () => string[] // 急停，返回叫停的实例 id
}

const BASE = '/api/action-computer'
const PROBE_MS = 3000

export function webExtras(ctx: Ctx, d: WebDeps): void {
  const tasks = () => tasksOf(ctx.log.events, d.panelTasks)
  // 截图从全部日志里找：面板只显示最近几次任务，但旧任务的图链接可能还被人开着
  const shots = () => shotsOf(tasksOf(ctx.log.events, Number.MAX_SAFE_INTEGER))

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (!r.path.startsWith(`${BASE}/`))
      return next()
    const sub = r.path.slice(BASE.length + 1)
    if (r.method === 'GET' && sub === 'tasks') {
      const lines = tasks().flatMap(t => taskLines(t))
      r.response = { body: { lines: lines.length ? lines : ['还没做过电脑任务'] } }
    }
    else if (r.method === 'GET' && sub === 'shots') {
      r.response = { body: { items: shots() } }
    }
    else if (r.method === 'GET' && sub.startsWith('shots/')) {
      const id = decodeURIComponent(sub.slice('shots/'.length))
      const s = shots().find(x => x.id === id)
      r.response = s ? { body: s } : { status: 404, body: { error: `没有截图 ${id}` } }
    }
    else if (r.method === 'POST' && sub === 'stop') {
      r.response = { body: { stopped: d.stopAll() } }
    }
    else {
      return next()
    }
    return r
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'computer-tasks',
      title: '电脑任务',
      kind: 'log',
      endpoint: `${BASE}/tasks`,
      refreshSec: 5,
      actions: [{ label: '急停全部', endpoint: `${BASE}/stop`, confirm: '叫停所有正在做的电脑任务？' }],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    s.cards.push(await card())
    return next()
  })

  async function card(): Promise<StatusCard> {
    const c = d.client()
    const running = runningLines()
    let h: Record<string, unknown> | undefined
    let why = ''
    try {
      h = await c.health(AbortSignal.timeout(PROBE_MS))
    }
    catch (e) {
      why = e instanceof BodyError ? e.message : e instanceof Error ? e.message : String(e)
    }
    if (!h) {
      return {
        id: 'computer-body',
        title: '电脑身体',
        level: 'err',
        text: `离线：${why}`,
        items: [`地址 ${c.url}`, ...running],
      }
    }
    const interactive = h.interactive !== false
    const admin = h.admin === true ? '管理员权限' : h.admin === false ? '普通权限' : '权限未知（身体服务是旧版本）'
    const session = interactive ? `登录桌面（session ${String(h.sessionId)}）` : 'session 0（没有桌面，界面操作做不了）'
    const screen = h.screen as { width?: number, height?: number } | undefined
    const busy = busyText(h)
    const browser = browserText(h)
    return {
      id: 'computer-body',
      title: '电脑身体',
      level: interactive ? 'ok' : 'warn',
      text: `在线 · 用户 ${String(h.user)} · ${session} · ${admin}`,
      items: [
        `地址 ${c.url} · 版本 ${String(h.version ?? '?')} · 屏幕 ${screen?.width ?? '?'}×${screen?.height ?? '?'} · 每步截图${d.shotsOn ? '开' : '关'}`,
        ...(busy ? [`身体那边正在做：${busy}`] : []),
        ...(browser ? [browser] : []),
        ...running,
      ],
    }
  }

  /** /health 的 browser（0.2.1 起）：Edge 开着没、这次进程里重建过几次、上一次的错；旧版身体服务没有这块就不显示 */
  function browserText(h: Record<string, unknown>): string {
    const b = h.browser as { state?: string, rebuilt?: number, lastRebuild?: string | null, lastError?: string | null, sinceSec?: number } | undefined
    if (!b || typeof b !== 'object')
      return ''
    const state = b.state === 'open' ? `开着（${Math.round((b.sinceSec ?? 0) / 60)} 分钟）` : '没开（用到时再开）'
    const parts = [`浏览器 ${state}`]
    if (b.rebuilt)
      parts.push(`重建过 ${b.rebuilt} 次${b.lastRebuild ? `（上次：${b.lastRebuild.slice(0, 80)}）` : ''}`)
    if (b.lastError)
      parts.push(`上次的错：${b.lastError.slice(0, 80)}`)
    return parts.join(' · ')
  }

  /** 正在做的任务：第几步看运行表的 note（agent 每步都更新），任务内容从日志取 */
  function runningLines(): string[] {
    const live = ctx.actions.snapshot().filter(r => r.id.startsWith('computer#'))
    if (!live.length)
      return ['现在没有在做的电脑任务']
    const byId = new Map(tasks().map(t => [t.id, t]))
    return live.map((r) => {
      const t = byId.get(r.id)
      const task = t?.task ? `「${t.task.length > 60 ? `${t.task.slice(0, 60)}…` : t.task}」` : ''
      return `${r.id} · ${r.note} · ${Math.round(r.runningMs / 1000)} 秒${task ? ` · ${task}` : ''}`
    })
  }
}
