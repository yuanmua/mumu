/**
 * 通用设置表单的纯函数：值 → 控件类型、按键名数组读写、改过没有。vitest 测。
 *
 * 立场：插件不为网页写代码，表单全按值的类型推；清单 mumu.ui 有提示就听提示（协议 §7）。
 * 推不出来的（混合数组、null、深层怪形状）一律给 JSON 编辑框，宁可朴素也不画错。
 */
import type { UiHint } from '../../protocol/admin.ts'

export type FieldKind = 'boolean' | 'number' | 'slider' | 'string' | 'text' | 'secret' | 'select' | 'list' | 'object' | 'json'

export const MASK = '••••••'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SECRET_NAME = /(key|token|secret|password)$/i

/** 由值（没有就看出厂值）和提示决定用什么控件 */
export function kindOf(value: unknown, def: unknown, hint: UiHint | undefined, key: string): FieldKind {
  const sample = value ?? def
  switch (hint?.widget) {
    case 'json': return 'json'
    case 'select': return 'select'
    case 'textarea': return 'text'
    case 'password': return 'secret'
    case 'slider': return typeof sample === 'number' ? 'slider' : 'json'
  }
  if (typeof sample === 'boolean')
    return 'boolean'
  if (typeof sample === 'number')
    return 'number'
  if (typeof sample === 'string') {
    if (hint?.secret || sample === MASK || SECRET_NAME.test(key))
      return 'secret'
    return sample.length > 60 || sample.includes('\n') ? 'text' : 'string'
  }
  if (Array.isArray(sample)) {
    const types = new Set(sample.map(x => typeof x))
    // 纯字符串或纯数字的数组才画成可增删的列表；空数组按字符串列表（最常见）
    return types.size <= 1 && [...types].every(t => t === 'string' || t === 'number') ? 'list' : 'json'
  }
  if (isObject(sample))
    return 'object'
  return 'json'
}

/**
 * 字段路径 = 键名数组，逐级按对象的实际键走。不拼点串：配置里有带点的键
 * （provider 的 roles 下 mind.decide、performer.reflex），拆点会把一个键当成两层，写回去就把结构写坏。
 * 数组元素不进路径（ui 不给元素单独标）。
 */
export type Path = string[]

/** ui 提示的键是点串，键名里的点写成 `\.`（协议 §7）；没转义的整串也认，兼容已经这么写的清单 */
export const uiKey = (path: Path): string => path.map(s => s.split('.').join('\\.')).join('.')
export function hintFor(ui: Record<string, UiHint>, path: Path): UiHint | undefined {
  return ui[uiKey(path)] ?? ui[path.join('.')]
}

export function getAt(obj: unknown, path: Path): unknown {
  let v: unknown = obj
  for (const k of path) v = isObject(v) ? v[k] : undefined
  return v
}

/** 不可变地写一个路径；value 为 undefined = 删掉这个键（字段不在出厂值里时的「恢复默认」） */
export function setAt(obj: Record<string, unknown>, path: Path, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  const out = { ...obj }
  if (!rest.length) {
    if (value === undefined)
      delete out[head]
    else out[head] = value
    return out
  }
  out[head] = setAt(isObject(obj[head]) ? obj[head] : {}, rest, value)
  return out
}

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function labelOf(path: Path, hint: UiHint | undefined): string {
  return hint?.label ?? path.at(-1) ?? ''
}

export function optionsOf(hint: UiHint | undefined): { value: string | number, label: string }[] {
  return (hint?.options ?? []).map(o => typeof o === 'object' ? { value: o.value, label: o.label ?? String(o.value) } : { value: o, label: String(o) })
}

/** JSON 编辑框的文本 → 值；坏 JSON 给出原因，不改值 */
export function parseJson(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) }
  }
  catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** 列表里新增一项的初值：跟着已有元素（或出厂值）的类型走 */
export function blankItem(list: unknown[], def: unknown): string | number {
  const sample = list[0] ?? (Array.isArray(def) ? def[0] : undefined)
  return typeof sample === 'number' ? 0 : ''
}

/** 改了多少个叶子字段（显示在保存按钮旁） */
export function countChanged(a: unknown, b: unknown): number {
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    let n = 0
    for (const k of keys) n += countChanged(a[k], b[k])
    return n
  }
  return same(a, b) ? 0 : 1
}
