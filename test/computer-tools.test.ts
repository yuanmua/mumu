import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { ActionRun, ChatMessage, Ctx, LogEvent } from '../src/index.ts'
import { AsyncQueue } from '../src/index.ts'
import { runTask } from '../plugins/official/action-computer/agent.ts'
import { BodyClient } from '../plugins/official/action-computer/body.ts'
import { errorKey, ToolHealth } from '../plugins/official/action-computer/broken.ts'

const CLOSED = '{"error":"TargetClosedError: BrowserContext.new_page: Target page, context or browser has been closed"}'

test('ToolHealth：同一工具连着两次同一个错误才标坏，中间夹别的工具不算断，成功一次就清零', () => {
  const h = new ToolHealth()
  assert.equal(h.record('browser', CLOSED), false)
  assert.equal(h.record('exec', '{"exitCode":0,"stdout":"ok"}'), false) // 别的工具插在中间
  assert.equal(h.record('browser', CLOSED), true) // 第二次同一个错误：这一刻标坏
  assert.equal(h.isBroken('browser'), true)
  assert.equal(h.record('browser', CLOSED), false) // 已经标过，不再重复提醒
  assert.match(h.notice('browser'), /浏览器工具.*别再调它.*换路线/)
  assert.match(h.refusal('browser'), /^出错：browser.*这一步没有执行/)
  assert.match(h.summary(), /浏览器工具（browser）坏了.*不是找不到或点不开/)
  assert.deepEqual(h.tools, ['browser'])

  // 错误文字不一样（换个控件又没找到）不算坏：那是「这条路不通」，不是工具坏了
  const g = new ToolHealth()
  assert.equal(g.record('ui_click', '{"error":"找不到控件 #3"}'), false)
  assert.equal(g.record('ui_click', '{"error":"找不到控件 #4"}'), false)
  assert.equal(g.isBroken('ui_click'), false)
  // 中间成功一次就从头数：#4 错一次、成功、#4 再错一次，不算连着两次
  assert.equal(g.record('ui_click', '{"ok":true}'), false)
  assert.equal(g.record('ui_click', '{"error":"找不到控件 #4"}'), false)
  assert.equal(g.isBroken('ui_click'), false)
  assert.equal(g.record('ui_click', '{"error":"找不到控件 #4"}'), true) // 这回才是连着两次
  assert.equal(g.isBroken('ui_click'), true)
  assert.match(g.summary(), /点控件（ui_click）坏了/)
})

test('errorKey：JSON 的 error 字段、「出错：」全文；不是错误回空', () => {
  assert.equal(errorKey(CLOSED), 'TargetClosedError: BrowserContext.new_page: Target page, context or browser has been closed')
  assert.equal(errorKey('出错：看图失败（x）'), '出错：看图失败（x）')
  assert.equal(errorKey('{"ok":true}'), '')
  assert.equal(errorKey('窗口 记事本\n#1 Button 保存'), '')
})

/** 假身体服务 + 假模型跑一遍真实的工具循环：browser 两次同错 → 提示换路线 → 第三次不再去身体服务 → 结果写明浏览器工具坏了 */
test('工具循环：browser 连着两次同一个错误标为暂不可用，之后不再调身体服务，结果里说清工具坏了', async () => {
  const hits: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push(url.pathname)
    const send = (status: number, obj: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))
    if (url.pathname === '/health')
      return send(200, { ok: true, user: 'me', interactive: true, screen: { width: 1, height: 1 } })
    if (url.pathname === '/browser')
      return send(500, { error: 'TargetClosedError: BrowserContext.new_page: Target page, context or browser has been closed' })
    if (url.pathname === '/exec')
      return send(200, { exitCode: 0, stdout: '' })
    send(404, { error: 'no' })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo

  // 模型的剧本：两次 browser → 看到【工具暂不可用】后还不死心再叫一次 → exec 查目录 → done
  const script = [
    '{"say":"打开搜索","tool":"browser","args":{"op":"open","url":"https://www.bing.com/images/search?q=x"}}',
    '{"say":"读页面","tool":"browser","args":{"op":"read"}}',
    '{"say":"再试一次","tool":"browser","args":{"op":"open","url":"https://x"}}',
    '{"say":"看看目录","tool":"exec","args":{"command":"dir"}}',
    '{"done":true,"ok":false,"result":"没存下图"}',
  ]
  const prompts: ChatMessage[][] = []
  const logged: Array<Record<string, unknown>> = []
  const ctx = {
    model: { complete: async (req: { messages: ChatMessage[] }) => {
      prompts.push(req.messages.map(m => ({ ...m })))
      return script.shift() ?? '{"done":true,"ok":false,"result":"剧本完了"}'
    } },
    log: { append: (type: string, data: Record<string, unknown>) => { logged.push({ type, ...data }) }, history: () => [] },
    bus: { on: (_e: string, _fn: (e: LogEvent) => void) => () => {} },
  } as unknown as Ctx
  const a = {
    id: 'computer#1',
    params: {},
    channel: 'c:test',
    signal: new AbortController().signal,
    inbox: new AsyncQueue<string>(),
    note: () => {},
    utter: () => { throw new Error('不该说话') },
    remember: () => {},
  } as unknown as ActionRun
  try {
    const body = new BodyClient({ url: `http://127.0.0.1:${port}`, requestTimeoutSec: 5, pollMs: 20 })
    const r = await runTask(ctx, a, body, '找一张图存到 Pictures', { maxSteps: 10, observationChars: 3000 })
    assert.equal(r.ok, false)
    assert.deepEqual(r.broken, ['browser'])
    assert.match(r.result, /没存下图。这次浏览器工具（browser）坏了：每次都报「TargetClosedError/)
    assert.equal(hits.filter(p => p === '/browser').length, 2) // 第三次没去身体服务
    // 第二次同错之后给模型的观察带了换路线的提示；第三次叫它时直接被拒
    const obs = (i: number) => prompts[i].at(-1)!.content
    assert.doesNotMatch(obs(1), /工具暂不可用/)
    assert.match(obs(2), /【工具暂不可用】browser（浏览器工具）连着 2 次报同一个错误/)
    assert.match(obs(3), /已标为暂不可用.*这一步没有执行/)
    const done = logged.find(e => e.type === 'computer.step' && e.done)
    assert.deepEqual(done?.broken, ['browser'])
  }
  finally {
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
  }
})
