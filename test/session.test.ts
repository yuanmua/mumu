import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEvent } from '../src/kernel/index.ts'
import { SessionLog } from '../src/kernel/index.ts'

test('历史投影：text+sender 才进 other 侧；kind 不参与判断（通用结构）', () => {
  const log = new SessionLog()
  log.append('percept.received', { kind: 'message', channel: 'main', sender: { id: 'u1' }, text: '你好' })
  log.append('percept.received', { kind: 'danmaku', channel: 'live', sender: { id: 'u2', name: '观众A' }, text: '666' })
  log.append('percept.received', { kind: 'performer.tool', text: '想用工具' }) // 无 sender → 不进历史
  log.append('percept.received', { kind: 'vision.frame', channel: 'main', data: { ref: 'x' } }) // 无 text → 不进历史
  log.append('utterance.settled', { id: 'utt#1', channel: 'live', delivered: '谢谢大家', truncated: false })

  const all = log.history()
  assert.deepEqual(all.map(t => [t.role, t.kind, t.text]), [
    ['other', 'message', '你好'],
    ['other', 'danmaku', '666'],
    ['self', 'utterance', '谢谢大家'],
  ])

  // 按频道过滤
  const live = log.history({ channel: 'live' })
  assert.deepEqual(live.map(t => t.text), ['666', '谢谢大家'])
  assert.equal(live[0].sender?.name, '观众A')
})

test('历史投影：I2 —— 只取 delivered，空 delivered 不进历史', () => {
  const log = new SessionLog()
  log.append('utterance.settled', { id: 'a', channel: 'main', delivered: '说了一半', truncated: true })
  log.append('utterance.settled', { id: 'b', channel: 'main', delivered: '', truncated: true })
  assert.deepEqual(log.history().map(t => t.text), ['说了一半'])
})

function memoryStore(initial: LogEvent[] = []): { events: LogEvent[], loadAll: () => LogEvent[], append: (e: LogEvent) => void } {
  const events = [...initial]
  return { events, loadAll: () => [...events], append: e => events.push(e) }
}

test('持久化：冷启动重放 + I3 孤儿恢复回报', () => {
  const orphans: string[][] = []
  const log = new SessionLog({ onOrphans: ids => orphans.push(ids) })
  const store = memoryStore([
    { seq: 1, at: 1, type: 'action.started', data: { id: 'reply#1', type: 'reply' } },
    { seq: 2, at: 2, type: 'action.started', data: { id: 'search#1', type: 'search' } },
    { seq: 3, at: 3, type: 'action.ended', data: { id: 'reply#1', outcome: 'done' } },
  ])
  log.attachPersistence(store)

  assert.deepEqual(orphans, [['search#1']])
  // 这一段的段首落在存量之后、孤儿恢复之前
  assert.deepEqual(store.events.slice(3).map(e => [e.seq, e.type]), [[4, 'log.opened'], [5, 'action.ended']])
  assert.equal(store.events[3].data.cause, 'boot')
  const last = store.events[store.events.length - 1]
  assert.equal(last.data.id, 'search#1')
  assert.equal(last.data.outcome, 'interrupted')
  // 新事件续写，序号接着走
  const e = log.append('percept.received', { kind: 'message' })
  assert.equal(e.seq, 6)
  assert.equal(store.events.length, 6)
})

test('持久化：热重载续写增量（内存包含存量前缀）', () => {
  const log = new SessionLog()
  const store1 = memoryStore()
  const detach1 = log.attachPersistence(store1)
  log.append('a', {})
  log.append('b', {})
  detach1()
  log.append('c', {}) // 存储缺席期间的事件

  const store2 = memoryStore(store1.events) // 同一个库再挂上
  log.attachPersistence(store2)
  assert.deepEqual(store2.events.map(e => e.type), ['log.opened', 'a', 'b', 'c'])
})

test('持久化：平行历史（存储晚挂载）重编序号接续存量', () => {
  const log = new SessionLog()
  log.append('boot', {}) // 存储挂载前就有事件，seq 从 1 起
  const store = memoryStore([
    { seq: 1, at: 1, type: 'old-a', data: {} },
    { seq: 2, at: 2, type: 'old-b', data: {} },
  ])
  log.attachPersistence(store)

  assert.deepEqual(log.events.map(e => [e.seq, e.type]), [[1, 'old-a'], [2, 'old-b'], [3, 'log.opened'], [4, 'boot']])
  assert.deepEqual(store.events.map(e => e.type), ['old-a', 'old-b', 'log.opened', 'boot'])
  assert.equal(log.append('next', {}).seq, 5)
})

test('持久化：reset 后再挂存储，序号不倒回（还在跑的动作 id 不会被撞上）', () => {
  const log = new SessionLog()
  log.append('x', {})
  const before = log.append('x', {}).seq
  log.reset()
  log.attachPersistence({ loadAll: () => [], append: () => {} })
  assert.ok(log.append('y', {}).seq > before)
})
