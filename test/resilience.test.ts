import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BeatMaterial, WakeInput } from '../src/kernel/index.ts'
import { Bus, IO, Mind, PromptAssembly, SessionLog } from '../src/kernel/index.ts'

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

test('拦截器抛错不能杀进程，也不能吃掉输入', async () => {
  const bus = new Bus()
  const log = new SessionLog()
  const wakes: WakeInput[] = []
  const io = new IO({ bus, log, wake: w => wakes.push(w) })

  bus.intercept('percept/pre-beat', async () => { throw new Error('坏插件') })
  await io.percept({ kind: 'message', sender: { id: 'u1' }, text: '你好' })

  assert.equal(wakes.length, 1, '出错也要按原意图唤醒，不能吞掉用户输入')
  assert.ok(log.events.some(e => e.type === 'percept.route-error'), '降级必须留痕')
})

test('gather 抛错只作废本拍，不拒绝 beat（fire-and-forget 会杀进程）', async () => {
  const logged: { type: string, data: any }[] = []
  const mind = new Mind({
    gather: async () => { throw new Error('坏的 beat/gather 插件') },
    dispatch: async () => {},
    log: (type, data) => logged.push({ type, data: data as any }),
    options: { cooldownMs: 0 },
  })
  let unhandled: unknown
  const onUnhandled = (e: unknown): void => { unhandled = e }
  process.on('unhandledRejection', onUnhandled)
  try {
    mind.wake({ source: 'user', text: '嗨', external: true })
    await new Promise(r => setTimeout(r, 30))
  }
  finally {
    process.off('unhandledRejection', onUnhandled)
    mind.dispose()
  }
  assert.equal(unhandled, undefined, '不得产生未捕获拒绝')
  assert.ok(logged.some(e => e.type === 'beat.failed'), '失败要可见')
  assert.ok(!logged.some(e => e.type === 'beat.closed'), '作废的拍不该记成正常收拍')
})

test('decider 抛错只作废决策，拍照常收尾', async () => {
  const logged: string[] = []
  const material = {} as BeatMaterial
  const mind = new Mind({
    gather: async () => material,
    dispatch: async () => {},
    log: t => logged.push(t),
    options: { cooldownMs: 0 },
  })
  mind.setDecider(async () => { throw new Error('坏脑子') })
  mind.wake({ source: 'user', text: '嗨', external: true })
  await new Promise(r => setTimeout(r, 30))
  mind.dispose()
  // 降级必须可见：拍照常收尾，但日志里看得出这拍是想失败了，不是决定不动
  assert.deepEqual(logged, ['beat.opened', 'beat.decide-failed', 'beat.closed'])
})

test('清除记忆是一次调用：真源与工作记忆一起归零', () => {
  const prompt = new PromptAssembly()
  const log = new SessionLog({ onReset: () => prompt.clearNotes() })
  log.append('percept.received', { kind: 'message', sender: { id: 'u' }, text: '记住这个' })
  prompt.addNote('别忘了', { source: 'reply#1' })

  log.reset() // 调用方只需这一处

  assert.deepEqual(log.history(), [])
  assert.deepEqual(prompt.notes(false), [])
  // 序号不归零：清空时还在跑的动作 / 发声的 id 取自旧序号，归零会让新 id 撞上它们
  const next = log.append('x', {})
  assert.ok(next.seq > 2, '序号接着走')
  assert.deepEqual(log.events.map(e => [e.type, e.data.cause]), [['log.opened', 'reset'], ['x', undefined]], '新的一段以 log.opened 开头')
})

test('在途感知有兜底：卡死的流被自动取消，不永久占着 incoming', async () => {
  const log = new SessionLog()
  const io = new IO({ bus: new Bus(), log, wake: () => {}, options: { perceptionTimeoutMs: 20 } })
  const p = io.perceive({ kind: 'voice', sender: { id: 'u1' } })
  await p.update('说到一半就卡住了')
  assert.equal(io.incoming().length, 1)

  await new Promise(r => setTimeout(r, 40))
  assert.equal(io.incoming().length, 0, '超时后不该继续挂在在途列表里')
  const settled = log.events.find(e => e.type === 'perception.settled')!
  assert.equal(settled.data.cancelled, true)
  assert.equal(settled.data.reason, 'perception-timeout')
  assert.deepEqual(log.history(), [], '卡死的半句话不算说过')
})

test('在途感知有动静就续期，不会说着说着被兜底掐掉', async () => {
  const io = new IO({ bus: new Bus(), log: new SessionLog(), wake: () => {}, options: { perceptionTimeoutMs: 40 } })
  const p = io.perceive({ kind: 'voice', sender: { id: 'u1' } })
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 25))
    await p.update(`第 ${i} 段`)
  }
  assert.equal(io.incoming().length, 1, '持续有 update 就不该被取消')
  await p.end()
})

test('关机收尾在途感知，日志不留半开的 started', async () => {
  const log = new SessionLog()
  const io = new IO({ bus: new Bus(), log, wake: () => {} })
  io.perceive({ kind: 'voice', sender: { id: 'u1' } })
  io.perceive({ kind: 'message', channel: 'live', sender: { id: 'u2' } })
  await tick()

  io.disposeAll('shutdown')
  assert.equal(io.incoming().length, 0)
  const started = log.events.filter(e => e.type === 'perception.started').length
  const settled = log.events.filter(e => e.type === 'perception.settled')
  assert.equal(settled.length, started, 'started 必有对应的 settled')
  assert.ok(settled.every(e => e.data.cancelled && e.data.reason === 'shutdown'))
})
