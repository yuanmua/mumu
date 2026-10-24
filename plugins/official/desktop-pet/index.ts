/**
 * 桌宠开关：她电脑桌面上的 Live2D 桌宠（apps/desktop）显示与否、置顶、大小、贴哪个角，状态放在配置库里。
 *
 * 立场：
 * - 开关有三处（网页角色栏按钮、桌宠托盘菜单、/pet 命令），设置只能有一份：配置库 `plugins.desktop-pet.*`，
 *   重启、换设备都还是上次的选择；默认关。「设置」里的表单由清单 `mumu.ui` 自动生成。
 * - 本插件不认识桌宠进程：桌宠每 3 秒 GET /api/desktop-pet/state 取设置，顺带报自己此刻的样子（from=pet）——
 *   这就是心跳。状态页据此显示「显示/隐藏、桌宠程序在不在」。心跳只记在本插件的闭包里：重载后几秒内就会补上。
 * - 网页按钮也轮询同一个接口（不带 from=pet，不算心跳），托盘一改网页自己跟上，不用刷新。
 * 协议见 docs/web-protocol.md `meta.pet` 与 §7。
 */
import type { ConfigService, Plugin } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { StatusCard, WebRoute } from '../surface-web/index.ts'

type Corner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

interface PetConfig {
  visible?: boolean
  alwaysOnTop?: boolean
  width?: number
  height?: number
  corner?: Corner
}

const STATE = '/api/desktop-pet/state'
const ALIVE_MS = 10_000 // 桌宠 3 秒一次心跳；10 秒没来就当它不在
const CORNER_TEXT: Record<Corner, string> = { 'bottom-right': '右下角', 'bottom-left': '左下角', 'top-right': '右上角', 'top-left': '左上角' }

const plugin: Plugin<PetConfig> = {
  name: 'desktop-pet',
  inject: ['config', 'commands'],
  apply(ctx, cfg = {}) {
    const config = ctx.use<ConfigService>('config')
    const commands = ctx.use<CommandService>('commands')
    // 配置一改装配层就重载本插件，所以这里读到的总是最新值
    const settings = {
      visible: cfg.visible === true,
      alwaysOnTop: cfg.alwaysOnTop !== false,
      width: clamp(cfg.width, 200, 1600, 420),
      height: clamp(cfg.height, 200, 1600, 720),
      corner: (cfg.corner && cfg.corner in CORNER_TEXT ? cfg.corner : 'bottom-right') as Corner,
    }
    const loadedAt = Date.now()
    let beat: { at: number, shown: boolean } | undefined // 桌宠最近一次心跳

    ctx.intercept<WebRoute>('web/route', async (r, next) => {
      if (r.method !== 'GET' || r.path !== STATE)
        return next()
      if (r.query.from === 'pet')
        beat = { at: Date.now(), shown: r.query.shown === '1' }
      r.response = { body: { ...settings, alive: alive(), shown: beat?.shown } }
      return r
    })

    ctx.intercept<{ pet?: { visible: boolean } }>('web/meta', async (meta, next) => {
      meta.pet = { visible: settings.visible }
      return next()
    })

    ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
      const wanted = settings.visible ? '显示' : '隐藏'
      let level: StatusCard['level'] = 'ok'
      let text: string
      if (alive()) {
        const shown = beat!.shown ? '显示着' : '隐藏着'
        text = `${shown}（开关：${wanted}）`
        if (beat!.shown !== settings.visible)
          level = 'warn' // 开关刚改、桌宠还没跟上；超过几秒还这样才是问题
      }
      else if (!beat && Date.now() - loadedAt < ALIVE_MS) {
        level = 'info'
        text = `开关：${wanted}；刚重载，等桌宠程序报到…`
      }
      else {
        level = 'warn'
        text = `开关：${wanted}；桌宠程序没在跑（她没登录桌面，或任务计划 mumu-desktop 没起来）`
      }
      s.cards.push({
        id: 'desktop-pet',
        title: '桌宠',
        level,
        text,
        items: [
          beat ? `最后心跳 ${Math.round((Date.now() - beat.at) / 1000)} 秒前` : '还没收到心跳',
          `${settings.width}×${settings.height} · ${CORNER_TEXT[settings.corner]} · ${settings.alwaysOnTop ? '置顶' : '不置顶'}`,
        ],
      })
      return next()
    })

    ctx.effect(() => commands.register({
      name: 'pet',
      usage: 'pet [on|off]',
      description: '她电脑桌面上的桌宠：on 显示 / off 隐藏（默认关，状态记在配置库）；不带参数看当前状态',
      run(args, io) {
        const want = args[0]
        if (want !== 'on' && want !== 'off') {
          const proc = alive() ? '桌宠程序在跑' : '桌宠程序没在跑'
          io.print(`桌宠开关：${settings.visible ? '显示' : '隐藏'}；${proc}。用法：/pet on | /pet off`)
          return
        }
        config.set('plugins.desktop-pet.visible', want === 'on')
        io.print(want === 'on' ? '桌宠：显示（几秒内出现在她桌面上）' : '桌宠：隐藏')
      },
    }))

    function alive(): boolean {
      return !!beat && Date.now() - beat.at < ALIVE_MS
    }
  },
}

export default plugin

function clamp(v: unknown, min: number, max: number, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def
}
