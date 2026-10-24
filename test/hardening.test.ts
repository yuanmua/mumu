/**
 * 开源前修掉的内核坑：每条一个测试，守着不回退。
 */
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import type { BeatMaterial, Ctx, MaterialBlock, Percept, WakeInput } from '../src/kernel/index.ts'
import { Bus, Container, IO, Mumu, SessionLog } from '../src/kernel/index.ts'

const wait = (ms = 20): Promise<void> => new Promise(r => setTimeout(r, ms))

test('percept/pre-beat：插件改写的感知、频道、唤醒都生效', async () => {
  const bus = new Bus()
  const wakes: WakeInput[] = []
  const io = new IO({ bus, log: new SessionLog(), wake: w => wakes.push(w) })
  bus.intercept<{ percept: Percept, channel: string, wake: boolean }>('percept/pre-beat', async (p, next) => {
    if (p.percept.kind === 'message') {
      p.percept = { ...p.percept, kind: 'message.queued', text: '排队中' }
      p.channel = 'queue'
    }
    if (p.percept.kind === 'noise')
      p.wake = false
    return next()
  })
  await io.percept({ kind: 'message', channel: 'g1', sender: { id: 'u' }, text: '在吗' })
  await io.percept({ kind: 'noise', text: '沙沙' })
  assert.deepEqual(wakes.map(w => [w.source, w.text, w.channel]), [['message.queued', '排队中', 'queue']])
})

test('percept/pre-beat：插件把感知改成 urgent，按改写后的频道打断', async () => {
  const bus = new Bus()
  const io = new IO({ bus, log: new SessionLog(), wake: () => {} })
  bus.intercept<{ percept: Percept, channel: string }>('percept/pre-beat', async (p, next) => {
    p.percept = { ...p.percept, urgent: true }
    p.channel = 'stage'
    return next()
  })
  const u = io.utter({ actionId: 'reply#1', signal: new AbortController().signal, channel: 'stage' })
  await u.write('正在说')
  await io.percept({ kind: 'message', channel: 'elsewhere', text: '停一下' })
  assert.equal(u.signal.aborted, true)
  assert.equal((await u.settled).cause, 'user-interrupt')
})

test('清空日志一处调用，工作记忆跟着清（Mumu 装配里接好了 onReset）', () => {
  const mumu = Mumu.create()
  mumu.prompt.addNote('刚才的事', { source: 'reply#1' })
  mumu.log.reset()
  assert.deepEqual(mumu.prompt.notes(false), [])
})

test('派发失败可见：未知动作、send / stop 找不到目标都记 intent.dispatch-failed 并带原因码', async () => {
  const mumu = Mumu.create({ cooldownMs: 0 })
  mumu.mind.setDecider(async m => m.reasons.some(r => r.source === 'go')
    ? { intents: [
        { do: 'start', action: 'nope' },
        { do: 'send', to: 'ghost#1', message: '在吗' },
        { do: 'stop', target: 'ghost' },
      ] }
    : { intents: [] })
  mumu.mind.wake({ source: 'go', text: 'go', external: true })
  await wait()
  const failed = mumu.log.events.filter(e => e.type === 'intent.dispatch-failed')
  assert.deepEqual(failed.map(e => [e.data.intent.do, e.data.code]), [
    ['start', 'unknown-action'],
    ['send', 'no-target'],
    ['stop', 'no-target'],
  ])
  await mumu.dispose()
})

test('动作 run 同步抛错：实例照常结算为 error，不永远挂在「正在运行」', async () => {
  const mumu = Mumu.create()
  mumu.actions.types.add({ name: 'broken', description: '', run: () => { throw new Error('没返回 Promise 就炸了') } })
  const id = mumu.actions.start('broken')
  await wait(5)
  assert.deepEqual(mumu.actions.snapshot(), [])
  const ended = mumu.log.events.find(e => e.type === 'action.ended')!
  assert.deepEqual([ended.data.id, ended.data.outcome, ended.data.error], [id, 'error', '没返回 Promise 就炸了'])
  await mumu.dispose()
})

test('一个长命动作开很多句话：发声结算后摘掉挂在动作信号上的监听，不累积', async () => {
  const io = new IO({ bus: new Bus(), log: new SessionLog(), wake: () => {} })
  const owner = new AbortController()
  for (let i = 0; i < 20; i++) {
    const u = io.utter({ actionId: 'chat#1', signal: owner.signal })
    await u.write('嗯')
    await u.end()
  }
  assert.equal(getEventListeners(owner.signal, 'abort').length, 0)
})

test('expression/pre-emit 拦截器抛错：按原样送出，发声照常结算（settled 不悬挂）', async () => {
  const bus = new Bus()
  const log = new SessionLog()
  const io = new IO({ bus, log, wake: () => {} })
  const got: string[] = []
  io.connect({ name: 's', onExpression: e => got.push(e.type) })
  bus.intercept('expression/pre-emit', async () => { throw new Error('坏拦截器') })
  const u = io.utter({ actionId: 'reply#1', signal: new AbortController().signal })
  await u.write('你好')
  const r = await u.end()
  assert.equal(r.delivered, '你好')
  assert.deepEqual(got, ['part', 'end'])
  assert.equal(log.events.filter(e => e.type === 'expression.route-error').length, 2)
})

test('容器：并发 load 不会把同一个插件装两次，也不会误删等待队列里别的插件', async () => {
  const c = new Container()
  const gate = (): { wait: Promise<void>, open: () => void } => {
    let open!: () => void
    return { wait: new Promise<void>((r) => { open = r }), open }
  }
  const q = gate()
  const r = gate()
  let p1Applied = 0
  const loads: Promise<void>[] = []
  loads.push(c.load({ name: 'Q', apply: async (ctx: Ctx) => { await q.wait; ctx.provide('svc', {}) } }))
  await c.load({ name: 'R', inject: ['svc'], apply: async () => { await r.wait } })
  await c.load({ name: 'P1', inject: ['svc'], apply: () => { p1Applied++ } })
  await c.load({ name: 'Z', inject: ['never'], apply: () => {} })
  q.open() // Q 提供 svc：Q 那一轮 flush 拿起 R，卡在 R 的 apply 里
  await wait(5)
  await c.load({ name: 'W', apply: () => {} }) // 另一轮 flush 趁机装上 P1
  r.open() // Q 那一轮醒来，快照里还有 P1
  await Promise.all(loads)
  assert.equal(p1Applied, 1)
  assert.deepEqual(c.unresolved().map(u => u.name), ['Z'], 'Z 还在等，不能被误删')
})

test('容器：卸载还在等依赖的插件，它就不会在依赖到来时自己装上', async () => {
  const c = new Container()
  let applied = false
  await c.load({ name: 'late', inject: ['svc'], apply: () => { applied = true } })
  await c.unload('late')
  await c.load({ name: 'provider', apply: (ctx: Ctx) => ctx.provide('svc', {}) })
  assert.equal(applied, false)
  assert.deepEqual(c.unresolved(), [])
})

test('材料块：同号按 from 排，不看插件加载先后', async () => {
  const run = async (order: string[]): Promise<string[]> => {
    const mumu = Mumu.create({ cooldownMs: 0 })
    for (const from of order) {
      mumu.bus.intercept<BeatMaterial>('beat/gather', async (m, next) => {
        m.blocks.push({ from, order: 10, text: from } satisfies MaterialBlock)
        return next()
      })
    }
    let froms: string[] = []
    mumu.mind.setDecider(async (m) => { froms = m.blocks.map(b => b.from); return { intents: [] } })
    mumu.mind.wake({ source: 'x', text: 'x', external: true })
    await wait()
    await mumu.dispose()
    return froms
  }
  assert.deepEqual(await run(['b', 'a', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(await run(['c', 'b', 'a']), ['a', 'b', 'c'])
})
