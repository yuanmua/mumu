import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent, WakeReason } from '../src/index.ts'
import { dropReported } from '../plugins/official/mind-default/reported.ts'

let seq = 0
const ev = (at: number, type: string, data: Record<string, unknown>): LogEvent => ({ seq: ++seq, at, type, data })
const reason = (at: number, source: string, text: string, channel?: string): WakeReason => ({ at, source, text, channel, external: !source.startsWith('action:') })

const RESULT_TEXT = '搜图「大肥鱼」找到 2 张'
const events = [
  ev(1000, 'action.started', { id: 'search#2', type: 'search', channel: 'qq:group:1' }),
  ev(1500, 'percept.received', { kind: 'search.result', channel: 'qq:group:1', text: RESULT_TEXT, data: { actionId: 'search#2', ok: true } }),
  ev(1501, 'action.ended', { id: 'search#2', outcome: 'done' }),
  ev(1600, 'action.started', { id: 'image#1', type: 'image', channel: 'qq:group:1' }),
  ev(1700, 'action.ended', { id: 'image#1', outcome: 'done' }),
]

test('结果感知已在上一拍处理过的动作，它结束的唤醒拿掉（搜到图那拍起了 image，search 结束那拍别再起一个）', () => {
  assert.deepEqual(dropReported([reason(1501, 'action:search', '动作 search#2 完成')], events), [])
})

test('结果感知还在本拍原因里（上一拍被作废、原因带过来）→ 留着', () => {
  const rs = [reason(1500, 'search.result', RESULT_TEXT, 'qq:group:1'), reason(1501, 'action:search', '动作 search#2 完成')]
  assert.equal(dropReported(rs, events).length, 2)
})

test('没有结果感知的动作（image、reply）结束照常唤醒；别的原因不动', () => {
  const rs = [reason(1700, 'action:image', '动作 image#1 完成'), reason(1700, 'message', '在吗', 'qq:group:1')]
  assert.deepEqual(dropReported(rs, events), rs)
  const mixed = [reason(1501, 'action:search', '动作 search#2 完成'), reason(1502, 'message', '好看', 'qq:group:1')]
  assert.deepEqual(dropReported(mixed, events).map(r => r.source), ['message'])
})
