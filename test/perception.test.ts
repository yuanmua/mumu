import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WakeInput } from '../src/kernel/index.ts'
import { Bus, IO, SessionLog } from '../src/kernel/index.ts'

function harness() {
  const log = new SessionLog()
  const wakes: WakeInput[] = []
  const io = new IO({ bus: new Bus(), log, wake: w => wakes.push(w) })
  return { io, log, wakes }
}

/** 起一条发声流，模拟某个动作正在说话 */
function speak(io: IO, channel?: string) {
  const controller = new AbortController()
  return io.utter({ actionId: 'reply#1', signal: controller.signal, channel })
}

test('流式感知：update 是修订不是追加，end 才进历史', async () => {
  const { io, log } = harness()
  const p = io.perceive({ kind: 'message', sender: { id: 'u1', name: '小明' } })
  await p.update('今')
  await p.update('今天天')
  await p.update('今天天气怎么样')
  assert.equal(p.text, '今天天气怎么样')
  assert.deepEqual(log.history(), []) // 没定稿前不进历史

  await p.end()
  assert.deepEqual(log.history().map(t => [t.role, t.text]), [['other', '今天天气怎么样']])
  assert.equal(io.incoming().length, 0)
})

test('流式感知：在途内容对主大脑可见（角色据此决定插不插话）', async () => {
  const { io } = harness()
  const p = io.perceive({ kind: 'message', channel: 'live', sender: { id: 'u1', name: '小明' } })
  await p.update('我想说的是')

  const [view] = io.incoming()
  assert.equal(view.text, '我想说的是')
  assert.equal(view.channel, 'live')
  assert.equal(view.sender?.name, '小明')
  assert.ok(view.elapsedMs >= 0)
})

test('流式感知：cancel 不进历史（说一半不说了不算说过）', async () => {
  const { io, log, wakes } = harness()
  const p = io.perceive({ kind: 'message', sender: { id: 'u1' } })
  await p.update('算了')
  await p.cancel({ reason: 'vad-false-positive' })

  assert.deepEqual(log.history(), [])
  assert.equal(io.incoming().length, 0)
  assert.equal(wakes.length, 0) // 默认不唤醒，避免误触发的噪音
  const settled = log.events.find(e => e.type === 'perception.settled')!
  assert.equal(settled.data.cancelled, true)
})

test('流式感知：唤醒按需——partial 只在 wake 时唤醒，且带 partial 结构位', async () => {
  const { io, wakes } = harness()
  const p = io.perceive({ kind: 'message', sender: { id: 'u1' } })
  await p.update('一')
  await p.update('一二') // 默认不唤醒，避免每个字一拍
  assert.equal(wakes.length, 0)

  await p.update('一二三', { wake: true })
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].partial, true)
  assert.equal(wakes[0].text, '一二三')

  await p.end()
  assert.equal(wakes.length, 2)
  assert.equal(wakes[1].partial, undefined) // 定稿不是半句话
})

test('流式感知：一开口就能打断角色（barge-in），只切本频道', async () => {
  const { io } = harness()
  io.connect({ name: 'x', capabilities: {}, onExpression: () => {} })
  const here = speak(io, 'main')
  const elsewhere = speak(io, 'live')
  await here.write('明天天气是晴')
  await elsewhere.write('另一个频道的话')

  io.perceive({ kind: 'message', channel: 'main', sender: { id: 'u1' }, urgent: true })
  await new Promise(r => setTimeout(r, 0)) // 起始打断不阻塞句柄返回

  assert.equal(here.signal.aborted, true)
  assert.equal(elsewhere.signal.aborted, false) // 别的频道不受影响
  const r = await here.settled
  assert.equal(r.truncated, false) // 无回执端按全量记账
  assert.equal(r.cause, 'user-interrupt')
})

test('流式感知：说到一半也能打断（VAD 晚一点才确认）', async () => {
  const { io } = harness()
  io.connect({ name: 'x', capabilities: {}, onExpression: () => {} })
  const utt = speak(io)
  await utt.write('我正在说话')

  const p = io.perceive({ kind: 'message', sender: { id: 'u1' } }) // 起始不打断
  assert.equal(utt.signal.aborted, false)
  await p.update('等等', { urgent: true }) // 确认是真的在说话了，这才打断
  assert.equal(utt.signal.aborted, true)
})

test('流式感知：settled 后再操作是安全的空操作', async () => {
  const { io, log } = harness()
  const p = io.perceive({ kind: 'message', sender: { id: 'u1' } })
  await p.end({ text: '说完了' })
  await p.update('还想说')
  await p.cancel()
  assert.equal(log.events.filter(e => e.type === 'perception.settled').length, 1)
  assert.deepEqual(log.history().map(t => t.text), ['说完了'])
})

test('I1：在途内容对模型可见，所以三段都落日志', async () => {
  const { io, log } = harness()
  const p = io.perceive({ kind: 'message', sender: { id: 'u1' } })
  await p.update('半')
  await p.end({ text: '半句话' })
  assert.deepEqual(
    log.events.map(e => e.type),
    ['log.opened', 'perception.started', 'perception.part', 'perception.settled'],
  )
})
