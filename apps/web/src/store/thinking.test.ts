import { describe, expect, it } from 'vitest'
import type { LogEvent } from '../protocol/types.ts'
import { buildTurns } from './thinking.ts'

let seq = 0
const ev = (at: number, type: string, data: unknown): LogEvent => ({ seq: ++seq, at, type, data })

describe('思考时间线', () => {
  it('一轮从用户消息开始，脊椎、回复、大脑决定按偏移排列', () => {
    const turns = buildTurns([
      ev(1000, 'percept.received', { kind: 'message', channel: 'main', sender: { id: 'u' }, text: '你好' }),
      ev(1001, 'beat.opened', { reasons: [{ source: 'message', text: '你好' }] }),
      ev(1350, 'action.started', { id: 'reply#1', type: 'reply', params: { reflex: true } }),
      ev(1350, 'utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }),
      ev(1350, 'reflex.started', { channel: 'main', actionId: 'reply#1' }),
      ev(1360, 'mind.decision', { note: '作废', intents: [], aborted: true, tookMs: 359, reasons: [] }),
      ev(2100, 'utterance.part', { id: 'utt#1', part: { kind: 'marker', data: { track: 'emo', value: '开心' } } }),
      ev(2120, 'utterance.part', { id: 'utt#1', part: { kind: 'text', text: '嗨' } }),
      ev(2500, 'utterance.settled', { id: 'utt#1', channel: 'main', delivered: '嗨', truncated: false }),
      ev(2600, 'mind.decision', { note: '等他', intents: [], wakeAfterSec: 90, aborted: false, tookMs: 700, reasons: [{ source: 'action:reply', text: '完成' }] }),
    ])
    expect(turns).toHaveLength(1)
    const t = turns[0]
    expect(t.kind).toBe('user')
    expect(t.user).toBe('你好')
    expect(t.items.map(i => [i.kind, i.offsetMs])).toEqual([
      ['user', 0],
      ['thinking', 1],
      ['reply', 350],
      ['reflex', 350],
      ['decision', 360],
      ['decision', 1600],
    ])
    const reply = t.items.find(i => i.kind === 'reply')!.reply!
    expect(reply).toMatchObject({ reflex: true, firstTokenMs: 770, text: '嗨', settled: true, truncated: false, durationMs: 1150 })
    expect(reply.markers).toEqual([{ track: 'emo', value: '开心' }])
    const decisions = t.items.filter(i => i.kind === 'decision')
    expect(decisions[0].title).toBe('想法作废')
    expect(decisions[1].title).toBe('不动')
    expect(decisions[1].decision?.wakeAfterSec).toBe(90)
  })

  it('被打断的回复标题带（被打断），文本取 delivered', () => {
    const turns = buildTurns([
      ev(0, 'percept.received', { kind: 'message', channel: 'main', sender: { id: 'u' }, text: 'a' }),
      ev(300, 'action.started', { id: 'reply#1', type: 'reply', params: { reflex: true } }),
      ev(300, 'utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }),
      ev(900, 'utterance.part', { id: 'utt#1', part: { kind: 'text', text: '我想说很多' } }),
      ev(1500, 'percept.received', { kind: 'message', channel: 'main', sender: { id: 'u' }, text: 'b' }),
      ev(1500, 'utterance.settled', { id: 'utt#1', channel: 'main', delivered: '我想', truncated: true, cause: 'user-interrupt' }),
      ev(1510, 'intent.blocked', { intent: { do: 'start', action: 'reply' }, channel: 'main', why: 'merge-pending' }),
    ])
    expect(turns).toHaveLength(2)
    const reply = turns[0].items.find(i => i.kind === 'reply')!
    expect(reply.title).toBe('脊椎兜底回复（被打断）')
    expect(reply.reply?.text).toBe('我想')
    expect(reply.reply?.generated).toBe('我想说很多')
    expect(turns[1].items.map(i => i.kind)).toEqual(['user', 'blocked'])
    expect(turns[1].items[1].detail).toBe('对方还在发')
  })

  it('定时醒来单独成一轮；大脑起的回复标注 guidance', () => {
    const turns = buildTurns([
      ev(0, 'beat.opened', { reasons: [{ source: 'timer', text: '到了自己之前定的时间' }] }),
      ev(800, 'mind.decision', { note: '主动聊', intents: [{ do: 'start', action: 'reply', params: { guidance: '问问他在干嘛' } }], aborted: false, tookMs: 800, reasons: [] }),
      ev(801, 'action.started', { id: 'reply#2', type: 'reply', params: { guidance: '问问他在干嘛' } }),
      ev(801, 'utterance.started', { id: 'utt#2', action: 'reply#2', channel: 'main' }),
    ])
    expect(turns[0].kind).toBe('timer')
    expect(turns[0].items[1].title).toBe('起 reply：问问他在干嘛')
    expect(turns[0].items[2]).toMatchObject({ kind: 'reply', title: '大脑起的回复' })
    expect(turns[0].items[2].reply?.guidance).toBe('问问他在干嘛')
  })

  it('没有任何用户消息时的事件归入 boot 轮', () => {
    const turns = buildTurns([ev(5, 'emotion.changed', { label: '困困的', valence: 0, arousal: 0.1 })])
    expect(turns[0].kind).toBe('boot')
    expect(turns[0].items[0].title).toBe('心情：困困的')
  })
})
