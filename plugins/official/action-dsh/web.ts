/**
 * action-dsh 上网页（docs/web-protocol.md §7）：状态卡、「DSH 任务」日志面板、急停接口。不改 surface-web、不改前端。
 *
 * 立场：面板内容从日志现算（action.started / dsh.step / dsh.result 感知），运行中的从运行表现算，不在插件里另存一份。
 */
import type { Ctx, LogEvent } from '../../../src/index.ts'
import { formatElapsed } from '../../../src/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { DshConfig, Install } from './index.ts'

const LOG_PATH = '/api/action-dsh/log'
const STOP_PATH = '/api/action-dsh/stop'

export function mountWeb(ctx: Ctx, cfg: DshConfig, locate: () => Install | undefined, hasKey: () => boolean): void {
  const runs = (): ReturnType<Ctx['actions']['snapshot']> => ctx.actions.snapshot().filter(r => r.id.startsWith('dsh#'))

  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (r.method === 'GET' && r.path === LOG_PATH) {
      r.response = { body: { lines: logLines(ctx.log.events, runs()) } }
      return r
    }
    if (r.method === 'POST' && r.path === STOP_PATH) {
      const ids = runs().map(x => x.id)
      for (const id of ids) ctx.actions.stop(id, '网页急停')
      r.response = { body: { stopped: ids } }
      return r
    }
    return next()
  })

  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), {
      id: 'action-dsh',
      title: 'DSH 任务',
      kind: 'log',
      endpoint: LOG_PATH,
      actions: [{ label: '急停', endpoint: STOP_PATH, method: 'POST', confirm: '停掉正在跑的 DSH 任务？' }],
    }]
    return next()
  })

  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    const inst = locate()
    const key = hasKey()
    const now = runs()
    s.cards.push({
      id: 'action-dsh',
      title: 'DSH',
      level: !inst || !key ? 'warn' : now.length ? 'info' : 'ok',
      text: !inst ? '未安装（npm i -g @deepseek-ai/dsh）' : !key ? `已安装 ${inst.version}，但密钥「${cfg.keySecret ?? 'deepseek'}」没设` : now.length ? `已安装 ${inst.version}，正在干活` : `已安装 ${inst.version}，空闲`,
      items: [
        ...(inst ? [`入口：${inst.entry}`] : []),
        ...now.map(r => `${r.id}（${Math.round(r.runningMs / 1000)}s）：${r.note}`),
        `时限 ${cfg.timeoutMin ?? 20} 分钟 · 静默 ${cfg.idleSec ?? 300} 秒 · 同时 ${cfg.concurrency ?? 1} 个`,
      ],
    })
    return next()
  })
}

/** 最近的任务：开始（任务）→ 每步（工具、参数、结果开头）→ 结果（结局、步数、耗时）；正在跑的末尾标「进行中」 */
function logLines(events: readonly LogEvent[], live: { id: string, runningMs: number, note: string }[]): string[] {
  const out: string[] = []
  const time = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'action.started' && d.type === 'dsh')
      out.push(`${time(e.at)} ▶ ${d.id} 任务：${String(d.params?.task ?? '').slice(0, 300)}${d.params?.cwd ? `（在 ${d.params.cwd}）` : ''}`)
    else if (e.type === 'dsh.step')
      out.push(`${time(e.at)}   ${d.actionId} 第 ${d.step} 步 ${d.say || d.tool}${d.status === 'error' ? '（出错）' : ''}　[${d.tool}] ${String(d.input).slice(0, 140)} → ${String(d.result).replace(/\s+/g, ' ').slice(0, 140)}`)
    else if (e.type === 'dsh.blocked')
      out.push(`${time(e.at)} ⛔ ${d.actionId} 第 ${d.step} 步被护栏拦下（${d.why}：${d.hit}）`)
    else if (e.type === 'percept.received' && d.kind === 'dsh.progress')
      out.push(`${time(e.at)} ✦ ${d.data?.actionId} 进度：${String(d.text ?? '').slice(0, 200)}`)
    else if (e.type === 'percept.received' && d.kind === 'dsh.result')
      out.push(`${time(e.at)} ■ ${d.data?.actionId} ${d.data?.ok ? '✓' : '✗'} ${d.data?.outcome}（${d.data?.steps} 步，${formatElapsed(Number(d.data?.elapsedMs ?? 0))}）：${String(d.data?.result ?? '').slice(0, 600)}`)
  }
  for (const r of live)
    out.push(`… ${r.id} 进行中（${Math.round(r.runningMs / 1000)}s）：${r.note}`)
  return out.slice(-300)
}
