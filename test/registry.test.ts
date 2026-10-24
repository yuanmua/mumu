import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Registry } from '../src/kernel/index.ts'

test('有键集合：唯一，冲突大声失败，撤销后可重注册', () => {
  const r = new Registry<{ name: string }>('动作', x => x.name)
  const off = r.add({ name: 'reply' })
  assert.equal(r.has('reply'), true)
  assert.equal(r.get('reply')?.name, 'reply')
  assert.throws(() => r.add({ name: 'reply' }), /动作 reply 已存在/)
  off()
  assert.equal(r.has('reply'), false)
  r.add({ name: 'reply' }) // 撤销后可重注册（热重载靠这条）
  assert.equal(r.size, 1)
})

test('无键集合：允许重复，各自独立撤销', () => {
  const r = new Registry<{ track: string, value: string }>('marker')
  const off1 = r.add({ track: 'emo', value: '开心' })
  r.add({ track: 'emo', value: '开心' }) // 不同插件贡献同名词汇是常态
  r.add({ track: 'act', value: '点头' })
  assert.equal(r.size, 3)

  off1()
  assert.equal(r.size, 2)
  assert.deepEqual(
    [...Map.groupBy(r.list(), d => d.track).keys()].sort(),
    ['act', 'emo'],
  )
})
