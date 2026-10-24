/**
 * 通用面板的纯函数：接口返回的形状 → 行 / 日志行，列推断、搜索、分页、单元格文本。vitest 测。
 * 宽容：插件给数组或 { items } / { lines } 都认（协议 §7），给错了显示空而不是报错。
 */
import type { WebPanel } from '../../protocol/admin.ts'

export type Row = Record<string, unknown>

export const PAGE_SIZE = 20

const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)

export function rowsOf(data: unknown): Row[] {
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.items) ? data.items : []
  return list.map(x => isObject(x) ? x : { value: x })
}

export function linesOf(data: unknown): string[] {
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.lines) ? data.lines : []
  return list.map(x => typeof x === 'string' ? x : JSON.stringify(x))
}

/** 没给 columns 就取前几行出现过的键 */
export function columnsOf(panel: WebPanel, rows: Row[]): NonNullable<WebPanel['columns']> {
  if (panel.columns?.length)
    return panel.columns
  const keys = new Set<string>()
  for (const r of rows.slice(0, 20)) Object.keys(r).forEach(k => keys.add(k))
  return [...keys].map(key => ({ key }))
}

/** image 列：值是站内地址（/api/…）或 http(s) 才画成图，别的当文字 */
export function imageSrc(v: unknown): string | undefined {
  return typeof v === 'string' && (v.startsWith('/api/') || /^https?:\/\//.test(v)) ? v : undefined
}

/** 带输入框的按钮：请求体 { item?, input }；输入框空着返回 undefined（不发） */
export function actionBody(input: string | undefined, typed: string, item?: Row): Record<string, unknown> | undefined {
  if (input === undefined)
    return item ? { item } : {}
  const text = typed.trim()
  if (!text)
    return undefined
  return item ? { item, input: text } : { input: text }
}

export function cellText(v: unknown, format?: 'time' | 'image'): string {
  if (v === undefined || v === null)
    return ''
  if (format === 'time' && typeof v === 'number')
    return new Date(v).toLocaleString('zh-CN', { hour12: false })
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** 搜索：整行的 JSON 里包含关键词（不分大小写） */
export function search<T>(items: T[], q: string): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle)
    return items
  return items.filter(x => (typeof x === 'string' ? x : JSON.stringify(x)).toLowerCase().includes(needle))
}

export function page<T>(items: T[], n: number): { items: T[], pages: number, page: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const p = Math.min(Math.max(0, n), pages - 1)
  return { items: items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), pages, page: p }
}

/** 自动刷新间隔（毫秒）；0 = 不刷新。日志默认 3 秒 */
export function refreshMs(panel: WebPanel): number {
  const sec = panel.refreshSec ?? (panel.kind === 'log' ? 3 : 0)
  return sec > 0 ? sec * 1000 : 0
}
