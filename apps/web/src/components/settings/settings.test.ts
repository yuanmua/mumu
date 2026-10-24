import { describe, expect, it } from 'vitest'
import type { WebPanel } from '../../protocol/admin.ts'
import { blankItem, countChanged, getAt, hintFor, kindOf, labelOf, MASK, optionsOf, parseJson, setAt, uiKey } from './configForm.ts'
import { actionBody, cellText, columnsOf, imageSrc, linesOf, page, PAGE_SIZE, refreshMs, rowsOf, search } from './panelData.ts'

describe('configForm', () => {
  it('按类型推控件', () => {
    expect(kindOf(true, undefined, undefined, 'on')).toBe('boolean')
    expect(kindOf(3, undefined, undefined, 'n')).toBe('number')
    expect(kindOf('短', undefined, undefined, 's')).toBe('string')
    expect(kindOf('a\nb', undefined, undefined, 's')).toBe('text')
    expect(kindOf('x'.repeat(61), undefined, undefined, 's')).toBe('text')
    expect(kindOf(['a', 'b'], undefined, undefined, 'l')).toBe('list')
    expect(kindOf([1, 2], undefined, undefined, 'l')).toBe('list')
    expect(kindOf([], undefined, undefined, 'l')).toBe('list')
    expect(kindOf([{ a: 1 }], undefined, undefined, 'l')).toBe('json')
    expect(kindOf(['a', 1], undefined, undefined, 'l')).toBe('json')
    expect(kindOf({ a: 1 }, undefined, undefined, 'o')).toBe('object')
    expect(kindOf(null, undefined, undefined, 'x')).toBe('json')
  })

  it('没值看出厂值；提示优先；敏感字段', () => {
    expect(kindOf(undefined, false, undefined, 'on')).toBe('boolean')
    expect(kindOf(0.3, 0.3, { widget: 'slider' }, 'rate')).toBe('slider')
    expect(kindOf('a', 'a', { widget: 'select' }, 'mode')).toBe('select')
    expect(kindOf('a', 'a', { widget: 'textarea' }, 'p')).toBe('text')
    expect(kindOf('sk-1', '', undefined, 'apiKey')).toBe('secret')
    expect(kindOf(MASK, '', undefined, 'whatever')).toBe('secret')
    expect(kindOf('x', '', { secret: true }, 'x')).toBe('secret')
    expect(kindOf('deepseek', '', undefined, 'apiKeyRef')).toBe('string')
  })

  it('按键名数组读写，不改原对象；undefined = 删键', () => {
    const base = { a: { b: 1, c: 2 }, d: 3 }
    const next = setAt(base, ['a', 'b'], 9)
    expect(next).toEqual({ a: { b: 9, c: 2 }, d: 3 })
    expect(base.a.b).toBe(1)
    expect(getAt(next, ['a', 'b'])).toBe(9)
    expect(setAt(base, ['a', 'c'], undefined)).toEqual({ a: { b: 1 }, d: 3 })
    expect(setAt({}, ['x', 'y'], 1)).toEqual({ x: { y: 1 } })
  })

  it('带点的键名是一个键，不拆成两层（roles 下的 mind.decide）', () => {
    const cfg = { roles: { 'default': { model: 'a' }, 'mind.decide': { model: 'b' } } }
    expect(getAt(cfg, ['roles', 'mind.decide', 'model'])).toBe('b')
    expect(setAt(cfg, ['roles', 'mind.decide', 'model'], 'c')).toEqual({ roles: { 'default': { model: 'a' }, 'mind.decide': { model: 'c' } } })
    expect(labelOf(['roles', 'mind.decide'], undefined)).toBe('mind.decide')
    expect(uiKey(['roles', 'mind.decide'])).toBe('roles.mind\\.decide')
    // ui 提示：转义写法优先，没转义的整串也认
    expect(hintFor({ 'roles.mind\\.decide': { label: '导演' } }, ['roles', 'mind.decide'])?.label).toBe('导演')
    expect(hintFor({ 'roles.mind.decide': { label: '旧写法' } }, ['roles', 'mind.decide'])?.label).toBe('旧写法')
    expect(hintFor({ roles: { hidden: true } }, ['roles'])?.hidden).toBe(true)
  })

  it('选项、JSON、列表初值、改动计数', () => {
    expect(optionsOf({ options: ['a', { value: 'b', label: '乙' }] })).toEqual([{ value: 'a', label: 'a' }, { value: 'b', label: '乙' }])
    expect(parseJson('{"a":1}')).toEqual({ value: { a: 1 } })
    expect('error' in parseJson('{a')).toBe(true)
    expect(blankItem([], [1])).toBe(0)
    expect(blankItem(['x'], undefined)).toBe('')
    expect(countChanged({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 })).toBe(2)
  })
})

describe('panelData', () => {
  const panel: WebPanel = { id: 'p', title: 'P', kind: 'table', endpoint: '/x' }

  it('认数组与 { items } / { lines }，给错了是空', () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }])
    expect(rowsOf({ items: [{ a: 1 }, 'x'] })).toEqual([{ a: 1 }, { value: 'x' }])
    expect(rowsOf('坏')).toEqual([])
    expect(linesOf({ lines: ['a', { b: 1 }] })).toEqual(['a', '{"b":1}'])
  })

  it('列：给了用给的，没给取出现过的键', () => {
    expect(columnsOf(panel, [{ a: 1 }, { b: 2 }])).toEqual([{ key: 'a' }, { key: 'b' }])
    expect(columnsOf({ ...panel, columns: [{ key: 'z' }] }, [{ a: 1 }])).toEqual([{ key: 'z' }])
  })

  it('单元格、搜索、分页、刷新间隔', () => {
    expect(cellText(undefined)).toBe('')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText(0, 'time')).not.toBe('0')
    expect(search([{ t: 'Hello' }, { t: 'x' }], 'hel')).toEqual([{ t: 'Hello' }])
    const many = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => i)
    expect(page(many, 1)).toEqual({ items: [PAGE_SIZE, PAGE_SIZE + 1, PAGE_SIZE + 2], pages: 2, page: 1 })
    expect(page(many, 9).page).toBe(1)
    expect(refreshMs({ ...panel, kind: 'log' })).toBe(3000)
    expect(refreshMs(panel)).toBe(0)
  })

  it('image 列只认站内或 http(s) 地址；带输入框的按钮空着不发', () => {
    expect(imageSrc('/api/stickers/img/a.gif')).toBe('/api/stickers/img/a.gif')
    expect(imageSrc('https://x.test/a.png')).toBe('https://x.test/a.png')
    expect(imageSrc('javascript:alert(1)')).toBeUndefined()
    expect(imageSrc(3)).toBeUndefined()
    expect(actionBody(undefined, '', { file: 'a' })).toEqual({ item: { file: 'a' } })
    expect(actionBody(undefined, '')).toEqual({})
    expect(actionBody('描述', '  ')).toBeUndefined()
    expect(actionBody('描述', ' 无语 ')).toEqual({ input: '无语' })
  })
})
