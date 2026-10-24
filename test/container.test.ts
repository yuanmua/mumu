import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bus, Container } from '../src/kernel/index.ts'

test('inject 依赖：服务就绪前挂起，就绪后自动激活', async () => {
  const c = new Container()
  const order: string[] = []

  await c.load({
    name: 'consumer',
    inject: ['thing'],
    apply: (ctx) => {
      order.push(`consumer 拿到 ${ctx.use<string>('thing')}`)
    },
  })
  assert.deepEqual(c.unresolved(), [{ name: 'consumer', missing: ['thing'] }])

  await c.load({
    name: 'provider',
    apply: (ctx) => {
      order.push('provider')
      ctx.provide('thing', '货')
    },
  })
  assert.deepEqual(order, ['provider', 'consumer 拿到 货'])
  assert.equal(c.unresolved().length, 0)
})

test('卸载：disposer 逆序执行，服务撤销', async () => {
  const c = new Container()
  const order: string[] = []
  await c.load({
    name: 'p',
    apply: (ctx) => {
      ctx.provide('svc', 1)
      ctx.effect(() => () => order.push('a'))
      ctx.effect(() => () => order.push('b'))
    },
  })
  assert.equal(c.has('svc'), true)
  await c.unload('p')
  assert.deepEqual(order, ['b', 'a'])
  assert.equal(c.has('svc'), false)
})

test('apply 抛错：不留半成品', async () => {
  const c = new Container()
  let cleaned = false
  await assert.rejects(c.load({
    name: 'bad',
    apply: (ctx) => {
      ctx.provide('half', 1)
      ctx.effect(() => () => { cleaned = true })
      throw new Error('boom')
    },
  }))
  assert.equal(cleaned, true)
  assert.equal(c.has('half'), false)
})

test('waterfall：拦截器可短路 terminal', async () => {
  const bus = new Bus()
  let terminalRan = false
  bus.intercept('x', async (p: any) => {
    p.blocked = true
    return p // 不调 next → 短路
  })
  const out = await bus.waterfall('x', { blocked: false }, async (p) => {
    terminalRan = true
    return p
  })
  assert.equal(out.blocked, true)
  assert.equal(terminalRan, false)
})

test('waterfall：next 重复调用抛错', async () => {
  const bus = new Bus()
  bus.intercept('y', async (_p, next) => {
    await next()
    return next() // 第二次必须炸
  })
  await assert.rejects(bus.waterfall('y', {}, async p => p), /重复调用/)
})

test('emit：单个坏监听器不影响其他监听器', () => {
  const bus = new Bus()
  let heard = 0
  bus.on('e', () => { throw new Error('bad listener') })
  bus.on('e', () => { heard++ })
  bus.emit('e', {})
  assert.equal(heard, 1)
})
