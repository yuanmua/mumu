import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALL_AUDIENCES, PromptAssembly } from '../src/kernel/index.ts'
import { renderNotes } from '../src/shared/format.ts'

test('工作记忆：轮数耗尽且过了最小时长才过期', () => {
  const p = new PromptAssembly()
  p.addNote('轮数已尽但时间未到', { source: 'a', beats: 1, minMs: 60_000 })
  p.addNote('轮数时间都尽', { source: 'b', beats: 1, minMs: 0 })

  assert.equal(p.notes(true).length, 2)

  // b 轮数用尽且 minMs=0 → 消失；a 靠 minMs 活着（双重衰减）
  const second = p.notes(true)
  assert.equal(second.length, 1)
  assert.equal(second[0].text, '轮数已尽但时间未到')
})

test('工作记忆：consume=false 只看不消耗', () => {
  const p = new PromptAssembly()
  p.addNote('x', { source: 's', beats: 1, minMs: 0 })
  assert.equal(p.notes(false).length, 1)
  assert.equal(p.notes(false).length, 1) // 没被消耗
  assert.equal(p.notes(true).length, 1) // 这次消耗
  assert.equal(p.notes(true).length, 0)
})

test('工作记忆：内核只出结构化数据，渲染归插件', () => {
  const p = new PromptAssembly()
  p.addNote('已回复', { source: 'reply#1' })
  const [n] = p.notes(false)
  assert.equal(n.source, 'reply#1')
  assert.equal(n.text, '已回复')
  assert.ok(typeof n.elapsedMs === 'number')
  // 渲染是插件侧的可选助手，不在内核里
  assert.match(renderNotes([n])[0], /^\[reply#1 · 距今 \d+秒\] 已回复$/)
})

test('段落：受众是自由字符串，与模型角色对齐', async () => {
  const p = new PromptAssembly()
  p.section({ id: 'a', audience: 'mind', order: 10, render: () => '给主脑' })
  p.section({ id: 'b', audience: 'memory.summarize', order: 10, render: () => '给摘要器' })
  p.section({ id: 'c', audience: ALL_AUDIENCES, order: 20, render: () => '给所有人' })

  assert.equal(await p.assemble('mind'), '给主脑\n\n给所有人')
  assert.equal(await p.assemble('memory.summarize'), '给摘要器\n\n给所有人')
  assert.equal(await p.assemble('从未注册过的角色'), '给所有人')
})

test('段落：按 order 排序组装，单段出错只缺那一段', async () => {
  const p = new PromptAssembly()
  p.section({ id: 'b', audience: 'mind', order: 20, render: () => '第二' })
  p.section({ id: 'a', audience: 'mind', order: 10, render: () => '第一' })
  p.section({ id: 'boom', audience: 'mind', order: 15, render: () => {
    throw new Error('坏段落')
  } })
  assert.equal(await p.assemble('mind'), '第一\n\n第二')
})

test('段落：一次性附加段落与注册段落同一套 order 排序，且不留下', async () => {
  const p = new PromptAssembly()
  p.section({ id: 'first', audience: 'performer', order: 0, render: () => '人设' })
  p.section({ id: 'last', audience: 'performer', order: 100, render: () => '底线' })
  const extras = [{ id: 'guidance', audience: 'performer', order: 50, render: () => '引导' }]
  assert.equal(await p.assemble('performer', extras), '人设\n\n引导\n\n底线')
  assert.equal(await p.assemble('performer'), '人设\n\n底线')
})

test('段落：同 id 注册冲突大声失败，disposer 撤销后可重注册', () => {
  const p = new PromptAssembly()
  const dispose = p.section({ id: 'x', audience: ALL_AUDIENCES, order: 1, render: () => '1' })
  assert.throws(() => p.section({ id: 'x', audience: ALL_AUDIENCES, order: 1, render: () => '2' }))
  dispose()
  p.section({ id: 'x', audience: ALL_AUDIENCES, order: 1, render: () => '3' })
})
