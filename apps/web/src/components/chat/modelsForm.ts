/**
 * 模型面板的表单 ↔ 协议形状（/api/models）。纯函数，vitest 测。
 *
 * 表单里每个输入都是字符串，空 = 这个角色不写这一项（由后端从 default 继承）。
 * POST 的 roles 是整表替换，表单不编辑的字段（如 provider）放 extra 原样带回，丢了就是删了。
 */
import type { ModelBinding, Models } from '../../protocol/types.ts'

export interface RoleForm {
  role: string
  baseURL: string
  model: string
  apiKeyRef: string
  fallback: string
  temperature: string
  maxTokens: string
  timeoutMs: string
  responseFormat: '' | 'json' | 'text'
  extra: ModelBinding
}

type Preset = Models['presets'][number]

/** 角色的人话说明；面板按这个顺序排，不认识的角色排在后面 */
export const ROLE_LABELS: Record<string, string> = {
  'default': '基底：别的角色没写的项都从这里继承',
  'performer.reflex': '快回：大脑放行或脊椎兜底的一句短回复',
  'mind.decide': '大脑：每条消息先到这里，判断回不回、怎么回、做什么',
  'performer': '大脑带想法的回复：回话、补充、主动找话',
  'performer.deep': '认真答：大脑判断要认真回答时',
  'vision.read': '看图',
  'task.agent': '电脑任务',
}

const ENDPOINT = ['baseURL', 'model', 'apiKeyRef', 'fallback'] as const
const NUMBERS = ['temperature', 'maxTokens', 'timeoutMs'] as const

export function toRoleForm(role: string, b: ModelBinding = {}): RoleForm {
  const { baseURL, model, apiKeyRef, fallback, temperature, maxTokens, timeoutMs, responseFormat, ...extra } = b
  return {
    role,
    baseURL: baseURL ?? '',
    model: model ?? '',
    apiKeyRef: apiKeyRef ?? '',
    fallback: fallback ?? '',
    temperature: temperature === undefined ? '' : String(temperature),
    maxTokens: maxTokens === undefined ? '' : String(maxTokens),
    timeoutMs: timeoutMs === undefined ? '' : String(timeoutMs),
    responseFormat: responseFormat ?? '',
    extra,
  }
}

export function toForms(m: Models): RoleForm[] {
  const known = Object.keys(ROLE_LABELS)
  const order = (r: string): number => known.includes(r) ? known.indexOf(r) : known.length
  return Object.keys(m.roles)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map(r => toRoleForm(r, m.roles[r]))
}

export function toBinding(f: RoleForm): ModelBinding {
  const b: ModelBinding = { ...f.extra }
  for (const k of ENDPOINT) {
    if (f[k].trim())
      b[k] = f[k].trim()
  }
  for (const k of NUMBERS) {
    if (f[k].trim())
      b[k] = Number(f[k])
  }
  if (f.responseFormat)
    b.responseFormat = f.responseFormat
  return b
}

export function toRoles(forms: RoleForm[]): Models['roles'] {
  return Object.fromEntries(forms.map(f => [f.role, toBinding(f)]))
}

/** 表单能不能存；不能就返回给人看的原因。细的类型校验后端还会再做一遍 */
export function validate(forms: RoleForm[]): string | undefined {
  for (const f of forms) {
    for (const k of NUMBERS) {
      if (f[k].trim() && !Number.isFinite(Number(f[k])))
        return `${f.role} 的 ${k} 不是数字`
    }
  }
  const d = forms.find(f => f.role === 'default')
  if (!d?.baseURL.trim() || !d.model.trim())
    return 'default 的地址和模型不能空：别的角色没写的都从它继承'
  return undefined
}

/**
 * 一键填充端点：只动地址、模型、密钥名、失败改用，温度长度不变。
 * 预设若声明 responseFormat（如本地引擎不支持 JSON 模式就写 text），只替换原本开着 JSON 模式的角色：
 * 否则导演一切到本地就收 400，而 4xx 不触发 fallback。
 */
export function applyPreset(f: RoleForm, p: Preset): RoleForm {
  return {
    ...f,
    baseURL: p.baseURL ?? '',
    model: p.model ?? '',
    apiKeyRef: p.apiKeyRef ?? '',
    fallback: f.role === 'default' ? '' : p.fallback ?? '',
    responseFormat: f.responseFormat === 'json' && p.responseFormat ? p.responseFormat : f.responseFormat,
  }
}

/** 一档切换：除 default 外全部套这个预设；default 不动，它是各角色的继承基底和失败后的退路 */
export function applyToAll(forms: RoleForm[], p: Preset): RoleForm[] {
  return forms.map(f => f.role === 'default' ? f : applyPreset(f, p))
}

/** 跟随 default：清掉端点四项，由后端继承 */
export function followDefault(f: RoleForm): RoleForm {
  return { ...f, baseURL: '', model: '', apiKeyRef: '', fallback: '' }
}

export function isChanged(f: RoleForm, defaults: Models['defaults']): boolean {
  return JSON.stringify(sorted(toBinding(f))) !== JSON.stringify(sorted(defaults[f.role] ?? {}))
}

function sorted(b: ModelBinding): [string, unknown][] {
  return Object.entries(b).sort(([a], [c]) => a.localeCompare(c))
}
