/**
 * 训练级轨迹：日志要能直接当训练素材——分段带版本、id 永不重复、模型原始输出在账、内核发的唤醒是结构化的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BeatMaterial, StreamChunk } from '../src/kernel/index.ts'
import { blobRef, KERNEL_VERSION, LOG_SCHEMA, ModelGateway, Mumu, SessionLog } from '../src/kernel/index.ts'

const wait = (ms = 20): Promise<void> => new Promise(r => setTimeout(r, ms))

test('段首：每段日志以 log.opened 开头，记启动标识与版本号', () => {
  const log = new SessionLog()
  log.append('x', {})
  const [head] = log.events
  assert.equal(head.type, 'log.opened')
  assert.equal(head.data.kernel, KERNEL_VERSION)
  assert.equal(head.data.schema, LOG_SCHEMA)
  assert.equal(head.data.cause, 'boot')
  assert.match(head.data.boot, /^[0-9a-f-]{36}$/)

  log.reset()
  log.append('y', {})
  assert.deepEqual(log.events.map(e => [e.type, e.data.cause]), [['log.opened', 'reset'], ['y', undefined]])
  assert.equal(log.events[0].data.boot, head.data.boot, '同一次启动里清空，启动标识不变')
})

test('id：取起始事件的序号，形状仍是「名字#数字」，清空后也不重复', async () => {
  const mumu = Mumu.create()
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  mumu.actions.types.add({ name: 'work', description: '', run: async (a) => {
    const u = a.utter()
    await u.write('嗯')
    await gate
  } })

  const first = mumu.actions.start('work')
  const started = mumu.log.events.find(e => e.type === 'action.started')!
  assert.equal(first, `work#${started.seq}`)
  await wait(5)
  const utt = mumu.log.events.find(e => e.type === 'utterance.started')!
  assert.equal(utt.data.id, `utt#${utt.seq}`)
  assert.equal(utt.data.action, first)

  mumu.log.reset() // 动作还在跑
  const second = mumu.actions.start('work')
  assert.notEqual(second, first, '清空后的新 id 不能撞上还在跑的实例')
  release()
  await mumu.dispose()
})

test('model.request / model.response：采样参数与模型原始输出（文本与 marker 按顺序）都在账，不记密钥', async () => {
  const log = new SessionLog()
  const gw = new ModelGateway(log)
  gw.registerProvider({
    name: 'fake',
    async* stream() {
      const chunks: StreamChunk[] = [
        { type: 'text', text: '你' },
        { type: 'text', text: '好' },
        { type: 'marker', track: 'face', body: 'smile' },
        { type: 'text', text: '呀' },
        { type: 'usage', prompt: 3, completion: 3 },
        { type: 'done' },
      ]
      yield * chunks
    },
  })
  gw.bind('default', { provider: 'fake', model: 'm', temperature: 0.7, maxTokens: 64, apiKey: 'sk-secret' })
  assert.equal(await gw.complete({ role: 'performer', messages: [{ role: 'user', content: '嗨' }] }), '你好呀')

  const req = log.events.find(e => e.type === 'model.request')!
  assert.equal(req.data.reqId, `req#${req.seq}`)
  assert.deepEqual(req.data.params, { temperature: 0.7, maxTokens: 64 })
  assert.ok(!JSON.stringify(log.events).includes('sk-secret'), '密钥不进日志')

  const res = log.events.find(e => e.type === 'model.response')!
  assert.deepEqual(res.data.output, [
    { type: 'text', text: '你好' },
    { type: 'marker', track: 'face', body: 'smile' },
    { type: 'text', text: '呀' },
  ])
  assert.equal(res.data.chars, 3)
  assert.deepEqual(res.data.usage, { prompt: 3, completion: 3 })
  assert.equal(res.data.error, undefined)
})

test('model.response：provider 中途报错也记下（已吐出的部分 + 错误），错误照常抛给调用方', async () => {
  const log = new SessionLog()
  const gw = new ModelGateway(log)
  gw.registerProvider({
    name: 'flaky',
    async* stream() {
      yield { type: 'text', text: '说到一半' } as StreamChunk
      throw new Error('upstream 502')
    },
  })
  gw.bind('default', { provider: 'flaky', model: 'm' })
  await assert.rejects(gw.complete({ role: 'mind', messages: [] }), /upstream 502/)
  const res = log.events.find(e => e.type === 'model.response')!
  assert.deepEqual(res.data.output, [{ type: 'text', text: '说到一半' }])
  assert.equal(res.data.error, 'upstream 502')
})

test('内核发的唤醒与工作记忆是结构化的：text 是短代码，细节在 data（没有中文渲染）', async () => {
  const mumu = Mumu.create({ cooldownMs: 0 })
  const seen: BeatMaterial[] = []
  mumu.mind.setDecider(async (m) => {
    seen.push(m)
    return { intents: [], wakeAfterMs: seen.length === 1 ? 5 : undefined }
  })
  mumu.actions.types.add({ name: 'quick', description: '', run: async () => {} })
  const id = mumu.actions.start('quick')
  await wait(40)

  const ended = seen[0].reasons.find(r => r.source === 'action:quick')!
  assert.equal(ended.text, `${id} done`)
  assert.deepEqual(ended.data, { code: 'action-ended', id, action: 'quick', outcome: 'done' })
  const timer = seen.flatMap(m => m.reasons).find(r => r.source === 'timer')!
  assert.deepEqual(timer.data, { code: 'wake-after', afterMs: 5 })
  const opened = mumu.log.events.find(e => e.type === 'beat.opened')!
  assert.deepEqual(opened.data.reasons[0].data, ended.data, '唤醒原因的 data 也在账（I1）')
  await mumu.dispose()
})

test('孤儿恢复给大脑的工作记忆带结构化 data', () => {
  const mumu = Mumu.create()
  mumu.log.attachPersistence({
    loadAll: () => [{ seq: 1, at: 1, type: 'action.started', data: { id: 'reply#1', type: 'reply' } }],
    append: () => {},
  })
  const [note] = mumu.prompt.notes(false)
  assert.equal(note.source, 'kernel')
  assert.deepEqual(note.data, { code: 'orphans-interrupted', ids: ['reply#1'] })
})

test('blobRef：内容哈希，同样的字节在哪都得到同一个 ref', () => {
  const a = blobRef(new TextEncoder().encode('abc'))
  assert.equal(a, 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(blobRef(Uint8Array.from([97, 98, 99])), a)
})
