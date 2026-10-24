import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../src/index.ts'
import { renderThread, thread } from '../plugins/official/bench/thread.ts'

let seq = 0
const ev = (at: number, type: string, data: Record<string, unknown>): LogEvent => ({ seq: ++seq, at, type, data: { channel: 'c:t', ...data } })
const said = (at: number, n: number, params: Record<string, unknown>, delivered: string, truncated = false): LogEvent[] => [
  ev(at, 'action.started', { id: `reply#${n}`, params }),
  ev(at + 1, 'utterance.started', { id: `utt#${n}`, action: `reply#${n}` }),
  ev(at + 500, 'utterance.settled', { id: `utt#${n}`, delivered, truncated }),
]

test('bench 对话统计：反射占比、补充紧跟反射、被打断没出字、回应率', () => {
  const events = [
    ev(0, 'percept.received', { sender: { id: 'u' }, text: '好' }),
    ...said(400, 1, { reflex: true }, '嗯嗯'),
    ...said(2000, 2, { append: true, guidance: '再说一遍' }, '嗯嗯好的'), // 反射说了导演又补一遍
    ev(5000, 'percept.received', { sender: { id: 'u' }, text: '你觉得呢？' }),
    ev(5100, 'percept.received', { sender: { id: 'u' }, text: '说说' }),
    ...said(6000, 3, { guidance: '想想' }, '', true), // 一个字没说出去就被打断
    ev(6200, 'percept.received', { sender: { id: 'u' }, text: '[表情包]' }),
    ...said(8000, 4, { guidance: '认真说', tier: 'deep' }, '我觉得可以'),
    ev(9000, 'percept.received', { sender: { id: 'other' }, text: '别的频道', channel: 'c:other' }),
  ]
  const { lines, stats } = thread(events, 'c:t', 0, 99_999)
  assert.deepEqual(stats, {
    received: 4, replies: 4, reflex: 1, mind: 1, deep: 1, append: 1, appendAfterReflex: 1,
    delivered: 3, truncated: 1, silentTruncated: 1, avgChars: 3.7, answeredRatio: 1,
  })
  assert.deepEqual(lines.filter(l => l.who === 'self').map(l => l.via), ['reflex', 'append', 'deep'])
  assert.match(renderThread(lines), /^\[\+0\.0s\] 对方：好\n\[\+0\.9s\] 沐沐：嗯嗯/)
})
