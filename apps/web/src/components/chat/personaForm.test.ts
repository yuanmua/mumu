import { describe, expect, it } from 'vitest'
import type { Persona } from '../../protocol/types.ts'
import { parseAliases, splitWords, toForm, toPatch, validate } from './personaForm.ts'

const base: Persona = {
  name: '沐沐',
  prompt: '数字生命',
  style: '平淡简短',
  rules: null,
  markers: { emo: ['脸红', '嘟嘴'], tool: ['search'] },
  aliases: { qq: '沐沐小号' },
}

describe('personaForm', () => {
  it('网名：一行一个「平台：网名」，中英文冒号都认，往返不变；坏行挡下', () => {
    const f = toForm(base)
    expect(f.aliases).toBe('qq：沐沐小号')
    expect(toPatch({ ...f, aliases: 'qq: 沐沐小号\n\nWeChat：沐沐酱' }).aliases).toEqual({ qq: '沐沐小号', wechat: '沐沐酱' })
    expect(toPatch({ ...f, aliases: '' }).aliases).toEqual({})
    expect(parseAliases('只有网名没平台')).toHaveProperty('error')
    expect(validate({ ...f, aliases: 'qq：' })).toMatch('网名')
    expect(toForm({ ...base, aliases: undefined }).aliases).toBe('') // 旧后端没有这个字段
  })

  it('中英文逗号、顿号都能分，去空去重', () => {
    expect(splitWords('脸红, 嘟嘴，脸红、 ，歪头')).toEqual(['脸红', '嘟嘴', '歪头'])
    expect(splitWords('  ')).toEqual([])
  })

  it('rules 三态对上：null=内置，空串=不要，其余=自定义', () => {
    expect(toForm(base).rulesMode).toBe('default')
    expect(toForm({ ...base, rules: '' }).rulesMode).toBe('none')
    const custom = toForm({ ...base, rules: '短点' })
    expect(custom.rulesMode).toBe('custom')
    expect(custom.rules).toBe('短点')
    expect(toPatch({ ...custom, rulesMode: 'default' }).rules).toBeNull()
    expect(toPatch({ ...custom, rulesMode: 'none' }).rules).toBe('')
    expect(toPatch(custom).rules).toBe('短点')
  })

  it('往返：没编辑的通道原样带回，emo / act 按逗号拆', () => {
    const f = toForm(base)
    expect(f.emo).toBe('脸红，嘟嘴')
    expect(f.act).toBe('')
    const p = toPatch({ ...f, act: '翻书, 歪头' })
    expect(p.markers).toEqual({ tool: ['search'], emo: ['脸红', '嘟嘴'], act: ['翻书', '歪头'] })
  })

  it('名字、人设必填；自定义要求不能是空的', () => {
    const f = toForm(base)
    expect(validate(f)).toBeUndefined()
    expect(validate({ ...f, name: ' ' })).toMatch('名字')
    expect(validate({ ...f, prompt: '' })).toMatch('人设')
    expect(validate({ ...f, rulesMode: 'custom', rules: '' })).toMatch('要求')
  })
})
