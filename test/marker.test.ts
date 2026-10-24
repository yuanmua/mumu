import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMarkers, type StreamChunk } from '../src/kernel/index.ts'

async function* feed(parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p
}

async function collect(parts: string[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of parseMarkers(feed(parts))) out.push(c)
  return out
}

test('marker 跨块切割也能正确解析', async () => {
  const out = await collect(['你好<', '|emo:开', '心|>呀'])
  assert.deepEqual(out, [
    { type: 'text', text: '你好' },
    { type: 'marker', track: 'emo', body: '开心' },
    { type: 'text', text: '呀' },
  ])
})

test('尾部缓冲：半个开标记不外泄，后续拼回', async () => {
  const out = await collect(['我看看<', '|act:点头|>好'])
  assert.deepEqual(out, [
    { type: 'text', text: '我看看' },
    { type: 'marker', track: 'act', body: '点头' },
    { type: 'text', text: '好' },
  ])
})

test('流结束时未闭合的标记按普通文本吐出，不吞内容', async () => {
  const out = await collect(['早啊<|emo:开'])
  assert.deepEqual(out, [
    { type: 'text', text: '早啊' },
    { type: 'text', text: '<|emo:开' },
  ])
})

test('无 body 的 marker', async () => {
  const out = await collect(['<|nod|>'])
  assert.deepEqual(out, [{ type: 'marker', track: 'nod', body: '' }])
})

test('超长不闭合标记中途按文本吐出（防卡死）', async () => {
  const long = `<|${'x'.repeat(200)}`
  const out = await collect([long, '尾巴'])
  const text = out.filter(c => c.type === 'text').map(c => (c as any).text).join('')
  assert.equal(text, `${long}尾巴`)
})

test('普通文本里的单个 < 不受影响', async () => {
  const out = await collect(['a < b 而且 1<2 对吧'])
  const text = out.map(c => (c as any).text ?? '').join('')
  assert.equal(text, 'a < b 而且 1<2 对吧')
})
