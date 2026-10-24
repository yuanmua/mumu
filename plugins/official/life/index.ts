/**
 * 生活状态（设计见 README）：她「此刻在干嘛」——吃饭、犯困、刷视频、打游戏、睡觉……
 *
 * 写：作息到点换（rhythm.ts 抽签 + choose.ts 她自己选）、大脑 life.set 动作（她在聊天里改）、网页面板 / `/life`（用户设）。
 *     全部只落日志 `life.changed` / `life.cleared`，状态从日志投影（state.ts），重启不丢。
 * 读：发言者段落「你此刻在干嘛」（和心情同槽，id 排在心情后）；beat/gather「你在干嘛」；
 *     水线 `life/now`（给 group-policy 之类查「忙不忙」系数，没装本插件时调用方拿回初值 busy 1）。
 * 睡着时：她自己起的 reply（timer 到了想找话）在 `intent/pre-dispatch` 拦下；那个会话最近有人找她（@、私聊）照常回，像手机响了。
 * 附加小系统：不改内核与别的插件，崩了只缺这一块（总线隔离）。
 */
import type { Intent, LogEvent, MaterialBlock, Plugin } from '../../../src/index.ts'
import { MAIN_CHANNEL, PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { LifeConfig } from './engine.ts'
import { byLabel, Life } from './engine.ts'
import { parseHM, parseSetInput } from './rhythm.ts'
import { LifeLog } from './state.ts'
import { webExtras } from './web.ts'

/** 水线 life/now 的载荷：调用方传 { busy: 1, asleep: false }，没人认领就原样回来 */
export interface LifeNow {
  activity?: string
  detail?: string
  until?: number
  busy: number // 乘到接话意愿上：吃饭 / 打游戏 / 睡觉 < 1，刷视频 = 1
  asleep: boolean
}

const plugin: Plugin<LifeConfig> = {
  name: 'life',
  inject: ['commands'],
  apply(ctx, cfg = {}) {
    const log = new LifeLog()
    for (const e of ctx.log.events) {
      if (e.type.startsWith('life.'))
        log.observe(e)
    }
    let disposed = false
    ctx.effect(() => () => { disposed = true })
    const life = new Life(ctx, cfg, log, () => !disposed)
    const asleep = (now = Date.now()): boolean => {
      const s = log.active(now)
      return !!(s && life.activity(s.activity)?.asleep)
    }

    // ── 到点换 ──
    const tick = (): void => {
      const why = life.due()
      if (why && !disposed)
        life.roll({ cause: why }).catch(e => console.error('[life] 换状态失败:', e))
    }
    ctx.effect(() => {
      const first = setTimeout(tick, 0)
      const t = setInterval(tick, (cfg.tickSec ?? 30) * 1000)
      t.unref()
      return () => {
        clearTimeout(first)
        clearInterval(t)
      }
    })

    // ── 读：发言者 ──
    ctx.effect(() => ctx.prompt.section({
      id: 'life-now', // 和 emotion-now 同槽，按 id 排在它后面
      audience: 'performer',
      order: PROMPT_ORDER.state,
      render: () => {
        const s = log.active(Date.now())
        if (!s)
          return ''
        if (asleep())
          return `【你此刻在干嘛】本来在睡觉${s.detail ? `（${s.detail}）` : ''}，手机响了迷迷糊糊拿起来看：回得短、带点困，别主动开新话题。`
        return `【你此刻在干嘛】${life.line(s)}（${life.hm(s.from)} 起）。这是你真在做的事：被问在干嘛就照这个说，一句就够；没人问别主动提，也别另编。`
      },
    }))

    // ── 读：大脑 ──
    ctx.intercept<{ blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      const s = log.active(Date.now())
      if (s) {
        const lines = [
          `【你在干嘛】${life.line(s)}（${life.hm(s.from)} 起，大概到 ${life.hm(s.until)}）。这是你此刻真在做的事，不算编来历：被问「在干嘛」就照这个答（guidance 里写上）；没人问别硬塞。`,
          asleep()
            ? '你在睡觉：没人找你就别主动开口（timer 到了也不找话）；被 @、私聊找你就像被手机吵醒，回得短、迷糊。'
            : '这一拍让她答应 / 说要去做另一件事（「行吧上号」「我去吃饭了」「那我睡了」），就在同一拍顺手 start life.set 记一下，不然过会儿被问在干嘛就对不上。',
        ]
        m.blocks.push({ from: 'life', order: 21, text: lines.join('\n'), data: { ...s } })
      }
      return next()
    })

    // ── 给别的插件查「忙不忙」 ──
    ctx.intercept<LifeNow>('life/now', async (p, next) => {
      const s = log.active(Date.now())
      if (s) {
        const a = life.activity(s.activity)
        p.activity = s.activity
        p.detail = s.detail
        p.until = s.until
        p.busy *= a?.busy ?? 1
        p.asleep ||= !!a?.asleep
      }
      return next()
    })

    // ── 睡着时不主动找话：她要开口的那个会话，最近 quietSec 内没人叫醒她就拦下（awakeIn） ──
    ctx.intercept<{ intent: Intent, allow: boolean }>('intent/pre-dispatch', async (p, next) => {
      const it = p.intent
      const quiet = (cfg.quietSec ?? 600) * 1000
      if (p.allow && quiet > 0 && it.do === 'start' && it.action === 'reply' && asleep()) {
        const channel = it.channel ?? MAIN_CHANNEL
        if (!awakeIn(ctx.log.events, channel, Date.now() - quiet)) {
          p.allow = false
          ctx.log.append('life.quiet', { channel, activity: log.active(Date.now())?.activity })
        }
      }
      return next()
    })

    // ── 大脑动作：她在聊天里改 ──
    ctx.effect(() => ctx.actions.register({
      name: 'life.set',
      description: '改你此刻在干嘛（【你在干嘛】那个状态）：你在 reply 里答应 / 说要去做另一件事了（「行吧上号」「我去吃饭了」「那我去睡了」），和那条 reply 同一拍起它记一下。不说话，只改状态。',
      paramsHint: '{"activity":"打游戏","detail":"具体在干嘛，如 在打第三关","minutes":40}',
      run: async (a) => {
        const activity = typeof a.params.activity === 'string' ? a.params.activity.trim() : ''
        if (!activity)
          throw new Error('activity 写在干嘛，如 打游戏')
        const detail = typeof a.params.detail === 'string' ? a.params.detail.trim() : ''
        const minutes = typeof a.params.minutes === 'number' ? a.params.minutes : undefined
        const s = life.setBySelf(activity, detail, minutes)
        if (!s) {
          const cur = log.active(Date.now())!
          a.remember(`在干嘛这会儿是定好的「${life.line(cur)}」，到 ${life.hm(cur.until)} 前不改`)
          return
        }
        a.remember(`你把在干嘛改成了「${life.line(s)}」，到 ${life.hm(s.until)} 左右`)
      },
    }))

    webExtras(ctx, life)

    // ── 命令 ──
    const commands = ctx.use<CommandService>('commands')
    ctx.effect(() => commands.register({
      name: 'life',
      usage: 'life [set <在做什么> [分钟] | next [HH:MM] [周末|平时] | clear]',
      description: '她此刻在干嘛：看现在的、用户设一个、按作息换一个（可假装是某个时间）、清掉重抽',
      async run(args, io) {
        const [op, ...rest] = args
        const show = (): void => {
          const now = Date.now()
          const s = log.active(now)
          const where = life.slot()
          io.print(s ? `  现在：${life.line(s)}  ${life.hm(s.from)}–${life.hm(s.until)}  ${byLabel(s)}${s.thought ? `  「${s.thought}」` : ''}` : '  现在：（还没定）')
          if (where)
            io.print(`  时段：${where.slot.label}，还有 ${where.left} 分钟进下一个`)
          for (const x of log.recent.filter(x => x !== s).slice(-5).reverse())
            io.print(`  ${life.when(x.from, now)}  ${life.line(x)}  ${byLabel(x)}`)
        }
        if (!op) {
          show()
          return
        }
        if (op === 'set') {
          const p = parseSetInput(rest.join(' '))
          if (!p.text)
            throw new Error('用法: /life set <在做什么> [分钟]')
          life.setByUser(p.text, p.minutes)
          show()
          return
        }
        if (op === 'next') {
          const hm = rest.find(x => parseHM(x) !== undefined && /[:：]/.test(x))
          const real = life.clock()
          const minute = hm ? parseHM(hm)! : undefined
          const weekend = rest.includes('周末') ? true : rest.includes('平时') ? false : real.weekend
          const at = minute === undefined ? undefined : { ...real, minute, hm: hm!.replace('：', ':'), weekend }
          await life.roll({ cause: 'reroll', at, exclude: log.active(Date.now())?.activity })
          show()
          return
        }
        if (op === 'clear') {
          life.clear()
          await life.roll({ cause: 'clear' })
          show()
          return
        }
        throw new Error('用法: /life [set <在做什么> [分钟] | next [HH:MM] [周末|平时] | clear]')
      },
    }))
  },
}

export default plugin

/**
 * 睡着时这个会话算不算「把她叫醒了」：since 之后有人冲她说过话（私聊、网页、群里 @ 她 / 叫她名字），
 * 或者她已经在这里开过口（被叫醒后接着聊的那几句别掐断）。
 * 群里没 @ 她的闲聊（surface-onebot 记成 kind `group.message`）不算——那是她睡着时没看见的。
 */
export function awakeIn(events: readonly LogEvent[], channel: string, since: number): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.at < since)
      return false
    if ((e.data?.channel ?? MAIN_CHANNEL) !== channel)
      continue
    if (e.type === 'utterance.started')
      return true
    if (e.type === 'percept.received' && e.data?.text && e.data?.sender && e.data.kind !== 'group.message')
      return true
  }
  return false
}
