/**
 * 时间感插件。
 *
 * 模型没有钟。没有这一段，角色会在下午四点说「这么晚了还没睡」，一句话就穿帮。
 * 段落给所有受众；另给发言者一句「对方多久没说话」，主动找话时才接得自然。
 */
import type { LogEvent, Plugin } from '../../../src/index.ts'
import { ALL_AUDIENCES, PROMPT_ORDER, formatElapsed } from '../../../src/index.ts'

interface ClockConfig {
  locale?: string
  timeZone?: string
}

const plugin: Plugin<ClockConfig> = {
  name: 'clock',
  apply(ctx, cfg = {}) {
    const locale = cfg.locale ?? 'zh-CN'
    const timeZone = cfg.timeZone ?? 'Asia/Shanghai'
    let lastOtherAt: number | undefined

    // 对方最近一次说话的时间，从真源投影
    const seed = [...ctx.log.events].reverse().find(e => e.type === 'percept.received' && e.data?.text && e.data?.sender)
    lastOtherAt = seed?.at
    ctx.on<LogEvent>('log.appended', (e) => {
      if (e.type === 'percept.received' && e.data?.text && e.data?.sender)
        lastOtherAt = e.at
    })

    const now = (): string => new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date())

    const period = (): string => {
      const h = Number(new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric', hour12: false }).format(new Date()))
      if (h < 5)
        return '深夜'
      if (h < 9)
        return '早上'
      if (h < 12)
        return '上午'
      if (h < 14)
        return '中午'
      if (h < 18)
        return '下午'
      if (h < 23)
        return '晚上'
      return '深夜'
    }

    ctx.effect(() => ctx.prompt.section({
      id: 'clock',
      audience: ALL_AUDIENCES,
      order: PROMPT_ORDER.time,
      render: () => {
        const silence = lastOtherAt ? `对方上一句话是 ${formatElapsed(Date.now() - lastOtherAt)}前说的。` : ''
        return `【现在】${now()}，${period()}。${silence}`
      },
    }))
  },
}

export default plugin
