import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { BodyClient, BodyError, busyText } from '../plugins/official/action-computer/body.ts'

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void

/** 假的身体服务：handler 决定每个请求怎么回 */
async function fakeBody(handler: Handler): Promise<{ url: string, close: () => Promise<void> }> {
  const server = createServer((req, res) => handler(req, res, new URL(req.url ?? '/', 'http://x')))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => r())
    }),
  }
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))
}

const client = (url: string, extra: Partial<ConstructorParameters<typeof BodyClient>[0]> = {}): BodyClient =>
  new BodyClient({ url, requestTimeoutSec: 0.3, stepWaitSec: 2, pollMs: 20, ...extra })

const health = { ok: true, user: 'me', interactive: true }

test('身体服务回 504 running：按 job 号查 /job，做完后拿到真正的结果', async () => {
  let polls = 0
  let jobId = ''
  const body = await fakeBody((req, res, url) => {
    if (url.pathname === '/exec') {
      jobId = String(req.headers['x-body-job'])
      return json(res, 504, { job: jobId, state: 'running', sec: 75, error: '还在执行' })
    }
    if (url.pathname === '/health')
      return json(res, 200, health)
    if (url.pathname === '/job') {
      assert.equal(url.searchParams.get('id'), jobId)
      return json(res, 200, ++polls < 3 ? { job: jobId, state: 'running', sec: 80 } : { job: jobId, state: 'done', status: 200, result: { exitCode: 0, stdout: '装好了' } })
    }
  })
  try {
    const waits: string[] = []
    const r = await client(body.url).call('/exec', { command: 'x', timeoutSec: 1 }, AbortSignal.timeout(5000), t => waits.push(t))
    assert.deepEqual(r, { exitCode: 0, stdout: '装好了' })
    assert.ok(jobId.length > 0)
    assert.equal(waits.length, 1)
    assert.match(waits[0], /还没完.*身体服务还在/)
  }
  finally {
    await body.close()
  }
})

test('请求超时但 /health 秒回：不判连不上，等到上限回「还在执行」当观察', async () => {
  const body = await fakeBody((_req, res, url) => {
    if (url.pathname === '/ui/tree')
      return // 不回：一直挂着
    if (url.pathname === '/health')
      return json(res, 200, health)
    if (url.pathname === '/job')
      return json(res, 200, { state: 'running', sec: 42 })
  })
  try {
    const r = await client(body.url, { stepWaitSec: 0.1 }).call('/ui/tree', {}, AbortSignal.timeout(5000))
    assert.equal(r.running, true)
    assert.match(String(r.error), /已经做了 42 秒还没做完.*先别重复/)
  }
  finally {
    await body.close()
  }
})

test('身体服务没有这一步的记录（旧版 / 请求没送到）：结果不明，交回模型核实', async () => {
  const body = await fakeBody((_req, res, url) => {
    if (url.pathname === '/key')
      return
    if (url.pathname === '/health')
      return json(res, 200, health)
    json(res, 404, { error: '没有这个接口' })
  })
  try {
    const r = await client(body.url).call('/key', { keys: 'enter' }, AbortSignal.timeout(5000))
    assert.match(String(r.error), /没有这一步的记录.*核实/)
  }
  finally {
    await body.close()
  }
})

test('超时后探活几次都不通才抛 BodyError（真的连不上）', async () => {
  let healthCalls = 0
  const body = await fakeBody((req, _res, url) => {
    if (url.pathname === '/health') {
      healthCalls++
      req.socket.destroy() // 探活直接断：身体服务进程没了 / 隧道断了
    }
    // 其余不回
  })
  try {
    await assert.rejects(
      client(body.url).call('/ui/click', { ref: 1 }, AbortSignal.timeout(10_000)),
      (e: unknown) => e instanceof BodyError && /探活 3 次都不通/.test(e.message),
    )
    assert.equal(healthCalls, 3 * 4) // 探活 3 次，每次连接断了再原样重发 3 遍
  }
  finally {
    await body.close()
  }
})

test('连接被重置（AdGuard 随机 RST 本机回环）：带同一个 job 号原样重发，不走探活', async () => {
  const jobs: string[] = []
  let healthCalls = 0
  const body = await fakeBody((req, res, url) => {
    if (url.pathname === '/health')
      healthCalls++
    if (url.pathname !== '/ui/click')
      return
    jobs.push(String(req.headers['x-body-job']))
    if (jobs.length < 3)
      return void req.socket.destroy()
    json(res, 200, { ok: true, via: 'invoke' })
  })
  try {
    const r = await client(body.url).call('/ui/click', { ref: 3 }, AbortSignal.timeout(5000))
    assert.deepEqual(r, { ok: true, via: 'invoke' })
    assert.equal(jobs.length, 3)
    assert.equal(new Set(jobs).size, 1) // 三次是同一个 job 号：身体服务按号去重，送到过的不会重做
    assert.equal(healthCalls, 0)
  }
  finally {
    await body.close()
  }
})

test('exec 的请求超时按它自己的 timeoutSec 放宽：requestTimeoutSec 短也不会提前放弃', async () => {
  const body = await fakeBody((_req, res, url) => {
    if (url.pathname === '/exec')
      return void setTimeout(() => json(res, 200, { exitCode: 0, stdout: 'ok' }), 500)
  })
  try {
    const r = await client(body.url, { requestTimeoutSec: 0.1 }).call('/exec', { command: 'x', timeoutSec: 1 }, AbortSignal.timeout(5000))
    assert.equal(r.stdout, 'ok')
  }
  finally {
    await body.close()
  }
})

test('排队被取消：直接告诉模型这一步没执行；被叫停时不再等', async () => {
  const body = await fakeBody((_req, res, url) => {
    if (url.pathname === '/browser')
      return json(res, 504, { state: 'cancelled', error: '排队没轮到，这一步没有执行' })
    if (url.pathname === '/apps')
      return json(res, 504, { state: 'running', sec: 61 })
    if (url.pathname === '/health')
      return json(res, 200, health)
    if (url.pathname === '/job')
      return json(res, 200, { state: 'running', sec: 70 })
  })
  try {
    const r = await client(body.url).call('/browser', { op: 'read' }, AbortSignal.timeout(5000))
    assert.match(String(r.error), /没有执行/)
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    await assert.rejects(client(body.url, { stepWaitSec: 60 }).call('/apps', { op: 'list' }, stop.signal))
  }
  finally {
    await body.close()
  }
})

test('health 重试：前两次不通、第三次通就算在；busyText 把通道里的活说成人话', async () => {
  let n = 0
  const body = await fakeBody((_req, res) => {
    if (++n < 3)
      return void res.writeHead(503).end()
    json(res, 200, { ...health, busy: [{ path: '/exec', state: 'running', sec: 32.4 }, { path: '/exec', state: 'queued', sec: 3 }] })
  })
  try {
    const h = await client(body.url).health(AbortSignal.timeout(5000), 3)
    assert.equal(busyText(h), '/exec 在做 32 秒、/exec 排队 3 秒')
    assert.equal(busyText(health), '')
  }
  finally {
    await body.close()
  }
})
