import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipReflex } from '../plugins/official/action-reply/index.ts'

test('反射回复只回一条：句末标点收住（带上它）', () => {
  assert.deepEqual(clipReflex('在，咋了？我刚才在听歌', 0, 8), { text: '在，咋了？', said: 3, done: true })
  assert.deepEqual(clipReflex('嗯？\n怎么啦', 0, 8), { text: '嗯？', said: 1, done: true })
})

test('反射回复：说够三个字后的逗号、空格也收，编的来历出不去', () => {
  assert.deepEqual(clipReflex('在呢在呢 刚被叫去做题了', 0, 8), { text: '在呢在呢', said: 4, done: true })
  assert.deepEqual(clipReflex('来啦来啦，脑子还热着', 0, 8), { text: '来啦来啦', said: 4, done: true })
  assert.deepEqual(clipReflex('在，咋了', 0, 8), { text: '在，咋了', said: 3, done: false }) // 一个字后的逗号不收
})

test('反射回复：跨 chunk 接着数，到上限硬收；开头的标点不算说出字', () => {
  const a = clipReflex('在', 0, 8)
  assert.deepEqual(a, { text: '在', said: 1, done: false })
  assert.deepEqual(clipReflex('。我刚才', a.said, 8), { text: '。', said: 1, done: true })
  assert.deepEqual(clipReflex('一二三四五六七八九十', 0, 8), { text: '一二三四五六七八', said: 8, done: true })
  assert.deepEqual(clipReflex('…在', 0, 8), { text: '…在', said: 1, done: false })
})
