/**
 * 给人看的：网页状态卡「权限」、面板「权限 · 拦下的请求」（docs/web-protocol.md §7）、命令 /guard。
 * 只读 index.ts 交过来的现状，不改任何东西。
 */
import type { Ctx } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { StatusCard, WebPanel, WebRoute } from '../surface-web/index.ts'
import type { Confirms } from './confirm.ts'

export interface Blocked { at: number, action: string, who: string, why: string }

export interface PanelDeps {
  owners: Set<string>
  webIsOwner: boolean
  needOwner: () => string[] // 要主人的动作
  confirm: string[]
  askOwner: string[]
  blocks: Blocked[]
  confirms: Confirms
}

export function registerPanels(ctx: Ctx, d: PanelDeps): void {
  const fmt = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  ctx.intercept<WebRoute>('web/route', async (r, next) => {
    if (r.method === 'GET' && r.path === '/api/guard/blocks') {
      r.response = { body: { lines: d.blocks.map(b => `${fmt(b.at)} 拦下 ${b.action}（${b.who}：${b.why}）`) } }
      return r
    }
    return next()
  })
  ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
    meta.panels = [...(meta.panels ?? []), { id: 'guard-blocks', title: '权限 · 拦下的请求', kind: 'log', endpoint: '/api/guard/blocks', refreshSec: 10 }]
    return next()
  })
  ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
    s.cards.push({
      id: 'guard',
      title: '权限',
      level: d.owners.size ? 'ok' : 'warn',
      text: d.owners.size ? `主人已设：${[...d.owners].join('、')}` : '主人未设：QQ 上谁让她动电脑都会被拒（设置 → 权限 → 主人）',
      items: [
        d.webIsOwner ? '网页对话视为主人' : '网页对话不视为主人',
        `要主人的动作：${d.needOwner().join('、')}`,
        d.blocks.length ? `最近拦下：${d.blocks.slice(-3).map(b => `${b.action}（${b.who}）`).join('、')}` : '还没拦过',
      ],
    })
    return next()
  })

  const commands = ctx.use<CommandService>('commands')
  ctx.effect(() => commands.register({
    name: 'guard',
    usage: 'guard',
    description: '权限：主人是谁、哪些动作要主人、最近拦下了什么、在等主人点头的',
    run(_args, io) {
      io.print(`  主人：${d.owners.size ? [...d.owners].join('、') : '（没设：/config set plugins.guard.owners ["qq:你的QQ号"]）'}${d.webIsOwner ? ' + 网页对话' : ''}`)
      io.print(`  要主人的动作：${d.needOwner().join('、')}；主人在群里要确认的：${d.confirm.join('、')}；主人要就直接做、别人要先问主人的：${d.askOwner.join('、')}`)
      for (const w of d.confirms.list(Date.now()))
        io.print(`  等主人点头：[${w.room}] ${w.who} 要 ${w.label}`)
      for (const b of d.blocks.slice(-8))
        io.print(`  ${new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false })} 拦下 ${b.action}（${b.who}，${b.why}）`)
    },
  }))
}
