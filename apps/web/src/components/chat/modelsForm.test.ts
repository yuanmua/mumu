import { describe, expect, it } from 'vitest'
import type { Models } from '../../protocol/types.ts'
import { applyPreset, applyToAll, followDefault, isChanged, toForms, toRoles, validate } from './modelsForm.ts'

const deepseek = { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyRef: 'deepseek' }
const local = { name: '本地 4090', baseURL: 'http://127.0.0.1:8091/v1', model: 'qwen3.8-27b', apiKeyRef: 'local', fallback: 'default' }
const m: Models = {
  roles: { 'zzz.custom': { model: 'x' }, 'performer': { temperature: 0.9, maxTokens: 600 }, 'default': { ...deepseek, provider: 'openai' } },
  defaults: { default: deepseek, performer: { temperature: 0.9, maxTokens: 600 } },
  keys: ['deepseek', 'local'],
  presets: [local],
}

describe('modelsForm', () => {
  it('按说明表排序，不认识的角色排后面', () => {
    expect(toForms(m).map(f => f.role)).toEqual(['default', 'performer', 'zzz.custom'])
  })

  it('表单原样转回：空项不写，数字转回数字，不编辑的字段原样带回', () => {
    expect(toRoles(toForms(m))).toEqual(m.roles)
  })

  it('套本地预设只改端点四项；default 不会 fallback 到自己', () => {
    const [d, p] = toForms(m)
    const lp = applyPreset(p, local)
    expect(toRoles([lp]).performer).toEqual({ temperature: 0.9, maxTokens: 600, baseURL: local.baseURL, model: local.model, apiKeyRef: 'local', fallback: 'default' })
    expect(applyPreset(d, local).fallback).toBe('')
    expect(toRoles([followDefault(lp)]).performer).toEqual({ temperature: 0.9, maxTokens: 600 })
  })

  it('全走本地：default 不动；只把开着 JSON 模式的角色换成预设声明的 text', () => {
    const withMind: Models = { ...m, roles: { ...m.roles, 'mind.decide': { temperature: 0.3, responseFormat: 'json' } } }
    const all = toRoles(applyToAll(toForms(withMind), { ...local, responseFormat: 'text' }))
    expect(all.default).toEqual(withMind.roles.default)
    expect(all['mind.decide']).toMatchObject({ baseURL: local.baseURL, fallback: 'default', responseFormat: 'text' })
    expect(all.performer.responseFormat).toBeUndefined()
  })

  it('改过标记对照出厂值', () => {
    const [, p] = toForms(m)
    expect(isChanged(p, m.defaults)).toBe(false)
    expect(isChanged({ ...p, temperature: '0.5' }, m.defaults)).toBe(true)
  })

  it('校验：数字写错、default 缺地址都拦下', () => {
    const forms = toForms(m)
    expect(validate(forms)).toBeUndefined()
    expect(validate([{ ...forms[0], baseURL: '' }])).toMatch(/default/)
    expect(validate([forms[0], { ...forms[1], maxTokens: '六百' }])).toMatch(/maxTokens/)
  })
})
