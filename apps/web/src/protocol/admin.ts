/**
 * 设置 / 状态 / 面板的协议形状与网络调用。契约见 docs/web-protocol.md §3「设置与状态」与 §7。
 * 与 client.ts 分开放：这块是一整套新接口，分文件放，两边的改动互不干扰。
 * 失败不抛：返回 { error } 让界面原样显示原因。
 */

export interface PluginInfo {
  id: string
  title: string
  group: string
  description?: string
  enabled: boolean
  loaded: boolean
  order: number
  error?: string
  hasConfig: boolean
}

/** 清单 mumu.ui 的一项（键是点路径；数组元素沿用数组的路径） */
export interface UiHint {
  label?: string
  hint?: string
  widget?: 'slider' | 'select' | 'textarea' | 'password' | 'json'
  min?: number
  max?: number
  step?: number
  options?: (string | number | { value: string | number, label?: string })[]
  secret?: boolean
  hidden?: boolean
}

export interface PluginConfig {
  id: string
  defaults: Record<string, unknown>
  override: Record<string, unknown>
  merged: Record<string, unknown>
  ui: Record<string, UiHint>
  error?: string
}

export interface StatusCard {
  id: string
  title: string
  level: 'ok' | 'warn' | 'err' | 'info'
  text: string
  items?: string[]
}

export interface PanelAction {
  label: string
  endpoint: string
  method?: string
  confirm?: string
  input?: string // 有就在按钮旁放一个输入框（值是占位提示），请求体带 input
}

export interface WebPanel {
  id: string
  title: string
  kind: 'table' | 'cards' | 'json' | 'log'
  endpoint: string
  columns?: { key: string, label?: string, format?: 'time' | 'image' }[]
  actions?: PanelAction[]
  rowActions?: PanelAction[]
  refreshSec?: number
  near?: string // 也挂在哪个专用面板底下：'persona' = 人格抽屉
}

export interface Failed { error: string }
export const failed = (v: unknown): v is Failed => typeof v === 'object' && v !== null && typeof (v as Failed).error === 'string'

/** 一次请求：成功给解析后的 JSON（204 为 null），失败给 { error } */
export async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T | Failed> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 204)
      return null as T
    const data = await res.json().catch(() => undefined)
    if (!res.ok)
      return { error: (data as Failed | undefined)?.error ?? `HTTP ${res.status}` }
    return data as T
  }
  catch {
    return { error: '后端不可达' }
  }
}

const id = (s: string): string => encodeURIComponent(s)

export const fetchPlugins = async (): Promise<PluginInfo[] | Failed> => {
  const r = await call<{ plugins: PluginInfo[] }>('/api/plugins')
  return failed(r) ? r : r.plugins
}
export const fetchPluginConfig = (pluginId: string) => call<PluginConfig>(`/api/plugins/${id(pluginId)}/config`)
export const savePluginConfig = (pluginId: string, config: Record<string, unknown>) => call<PluginConfig>(`/api/plugins/${id(pluginId)}/config`, 'PUT', { config })
export const setPluginEnabled = (pluginId: string, enabled: boolean) => call<PluginInfo & { error?: string }>(`/api/plugins/${id(pluginId)}/enabled`, 'POST', { enabled })

export const fetchSecrets = async (): Promise<{ name: string, updatedAt: number }[] | Failed> => {
  const r = await call<{ secrets: { name: string, updatedAt: number }[] }>('/api/secrets')
  return failed(r) ? r : r.secrets
}
export const saveSecret = (name: string, value: string) => call<null>('/api/secrets', 'POST', { name, value })

export const fetchStatus = async (): Promise<StatusCard[] | Failed> => {
  const r = await call<{ cards: StatusCard[] }>('/api/status')
  return failed(r) ? r : r.cards
}
