/**
 * 插件上网页的扩展点：web/route（自带接口）、meta.panels（通用面板）、web/status（状态卡片）。
 * 契约与写法见 docs/web-protocol.md §7；类型随本插件 index.ts 导出，别的插件只许 import type。
 *
 * 立场：插件不改 surface-web、不改前端就能上网页。一律走水线而不是服务——
 * surface-web 换皮肤等会重载，服务一消失注入它的插件都要连带重载；水线挂在各插件自己身上，互不牵连。
 */
import type { Ctx } from '../../../src/index.ts'

/** web/route 的载荷：插件认领就填 response 并不再 next() */
export interface WebRoute {
  method: string
  path: string
  query: Record<string, string>
  body: unknown // 已按 JSON 解析；GET / HEAD 为 undefined
  /**
   * body 是 Buffer 时原样回字节（如缩略图），content-type 取 contentType（缺省 application/octet-stream），
   * cache 为真时带长缓存（名字即内容摘要的那种）；否则按 JSON 回
   */
  response?: { status?: number, body?: unknown, contentType?: string, cache?: boolean }
}

export interface PanelAction {
  label: string
  endpoint: string
  method?: string // 缺省 POST
  confirm?: string // 有就先弹确认
  input?: string // 有就在按钮旁放一个输入框（值是占位提示），请求体多一个 input: 输入的文字；空着不发
}

export interface WebPanel {
  id: string
  title: string
  kind: 'table' | 'cards' | 'json' | 'log'
  endpoint: string
  columns?: { key: string, label?: string, format?: 'time' | 'image' }[] // image：值是图片地址，画成缩略图
  actions?: PanelAction[] // 面板顶部，请求体 {}
  rowActions?: PanelAction[] // 每一行，请求体 { item }
  refreshSec?: number
  near?: string // 也挂在哪个专用面板底下（目前认 'persona'：人格抽屉）；「设置 → 面板」里照常有
}

export interface StatusCard {
  id: string
  title: string
  level: 'ok' | 'warn' | 'err' | 'info'
  text: string
  items?: string[]
}

/** 把一个 surface-web 不认识的 /api/* 请求交给插件；没人认领返回 undefined */
export async function routeToPlugins(ctx: Ctx, route: Omit<WebRoute, 'response'>): Promise<WebRoute['response']> {
  const out = await ctx.bus.waterfall<WebRoute, WebRoute>('web/route', { ...route }, async r => r)
  return out.response
}
