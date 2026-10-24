/**
 * 通用设置表单的服务端小件：读清单里的 title / ui，敏感字段遮罩与还原。纯函数为主，契约见 docs/web-protocol.md §3「设置与状态」。
 *
 * 为什么要遮罩：网页可能经隧道或局域网被别的设备打开；配置里万一写着真 key（provider 的 defaults 就有过），
 * 不该原样发给浏览器。遮罩值原样提交回来 = 不改，所以前端不用知道真值也能保存别的字段。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const MASK = '••••••'

/** 清单 mumu.ui 的一项；只列服务端关心的，前端另有完整形状 */
export interface UiHint {
  secret?: boolean
  widget?: string
  [k: string]: unknown
}
export type UiHints = Record<string, UiHint>

const SECRET_NAME = /(key|token|secret|password)$/i

/**
 * 路径一律是键名数组：配置里有带点的键（provider 的 roles 下 mind.decide、performer.reflex），
 * 拼成点串再拆会把一个键拆成两层。ui 提示的键是点串，键名里的点写成 `\.`（协议 §7）；
 * 没转义的整串也认，兼容已经这么写的清单。
 */
export function uiKey(path: string[]): string {
  return path.map(s => s.replaceAll('.', '\\.')).join('.')
}
export function hintFor(ui: UiHints, path: string[]): UiHint | undefined {
  return ui[uiKey(path)] ?? ui[path.join('.')]
}

export function isSecret(path: string[], ui: UiHints): boolean {
  const hint = hintFor(ui, path)
  if (hint?.secret === true || hint?.widget === 'password')
    return true
  return SECRET_NAME.test(path.at(-1) ?? '')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 敏感的非空字符串换成 MASK；数组元素沿用数组自己的路径（ui 不给元素单独标） */
export function mask(v: unknown, ui: UiHints, path: string[] = []): unknown {
  if (typeof v === 'string')
    return v && path.length && isSecret(path, ui) ? MASK : v
  if (Array.isArray(v))
    return v.map(x => mask(x, ui, path))
  if (isObject(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x, ui, [...path, k])]))
  return v
}

/** 提交回来的值里仍是 MASK 的位置，换回真值（同一路径的旧值）；找不到旧值就当空串，绝不把 MASK 写进库 */
export function unmask(want: unknown, real: unknown): unknown {
  if (want === MASK)
    return typeof real === 'string' ? real : ''
  if (Array.isArray(want))
    return want.map((x, i) => unmask(x, Array.isArray(real) ? real[i] : undefined))
  if (isObject(want))
    return Object.fromEntries(Object.entries(want).map(([k, x]) => [k, unmask(x, isObject(real) ? real[k] : undefined)]))
  return want
}

/** 清单里给网页看的两个可选字段；每次现读，改了 package.json 不用重启 */
export async function readUiManifest(dir: string): Promise<{ title?: string, ui: UiHints }> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const m = pkg?.mumu ?? {}
    return {
      title: typeof m.title === 'string' ? m.title : undefined,
      ui: isObject(m.ui) ? (m.ui as UiHints) : {},
    }
  }
  catch {
    return { ui: {} } // 清单读不了（刚被删、写到一半）：没有提示照样能按类型出表单
  }
}

export function withoutEnabled(v: unknown): Record<string, unknown> {
  if (!isObject(v))
    return {}
  const { enabled: _enabled, ...rest } = v
  return rest
}

export { isObject }
