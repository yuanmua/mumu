import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { DsmlFilter } from '../plugins/official/provider-openai/dsml.ts'
import provider from '../plugins/official/provider-openai/index.ts'

function run(chunks: string[]): { out: string, dropped?: { chars: number, sample: string } } {
  const f = new DsmlFilter()
  let out = ''
  for (const c of chunks) out += f.push(c)
  out += f.end()
  return { out, dropped: f.report }
}

/** 把一段话按每 n 个字切开，模拟流式 chunk 落在任意位置 */
function chop(s: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

const BLOCK = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="look">\n<｜｜DSML｜｜ parameter name="args" string="false">{"question": "蛇在哪"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'

test('整段 DSML 调用块被吞掉，前后的话保留', () => {
  const r = run([`算了去网上搜一张${BLOCK}搜到啦`])
  assert.equal(r.out, '算了去网上搜一张搜到啦')
  assert.equal(r.dropped?.chars, BLOCK.length)
  assert.ok(r.dropped?.sample.startsWith('<｜｜DSML｜｜ calls>'))
})

test('跨 chunk：任意切法结果都一样', () => {
  const text = `前面${BLOCK}后面`
  for (const n of [1, 2, 3, 5, 7, 13, 64])
    assert.equal(run(chop(text, n)).out, '前面后面', `每 ${n} 字一块`)
})

test('孤立的结束标记（截图里那种）只吞标记本身', () => {
  const leak = '算了去网上搜一张</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  assert.equal(run(chop(leak, 4)).out, '算了去网上搜一张\n\n')
})

test('半角竖线、单竖线也认；流结束时没闭合的块吞到底', () => {
  assert.equal(run(['好<|DSML| calls><|DSML| invoke name="x">参数']).out, '好')
  assert.equal(run(['好<||DSML|| invoke name="x"/>的']).out, '好的', '自闭合不加深度')
})

test('别的尖括号与内核 marker 原样放行，被切开也不丢', () => {
  assert.equal(run(['<|emo:开心|>嗯', '<|br|>好']).out, '<|emo:开心|>嗯<|br|>好')
  assert.equal(run(['1 <', ' 2，<b>粗</b>']).out, '1 < 2，<b>粗</b>')
  assert.equal(run(['结尾留着半个<｜｜DS']).out, '结尾留着半个<｜｜DS', '凑不成标记的尾巴按文本吐出')
  assert.equal(run(['没有标记']).dropped, undefined)
})

test('provider 端到端：DSML 拆在多个 SSE 帧里也吞掉，并记一条 provider.dsml-dropped', async () => {
  const frames = chop(`桌面也只有张截图${BLOCK}搜到啦`, 6)
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const f of frames) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: f } }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  try {
    const events: { type: string, data: any }[] = []
    const bindings = new Map<string, Record<string, unknown>>()
    let adapter: any
    const ctx: any = {
      use: () => ({ get: () => 'k' }),
      effect: (f: () => unknown) => f(),
      intercept: () => {},
      log: { append: (type: string, data: unknown) => events.push({ type, data }) },
      model: {
        registerProvider: (p: unknown) => { adapter = p },
        bind: (r: string, b: Record<string, unknown>) => { bindings.set(r, b) },
        resolve: (r: string) => ({ ...bindings.get('default'), ...bindings.get(r) }),
      },
    }
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`
    provider.apply(ctx, { roles: { 'default': { baseURL: base, model: 'm', apiKeyRef: 'x' }, 'performer.reflex': {} } })
    let text = ''
    for await (const c of adapter.stream({ binding: ctx.model.resolve('performer.reflex'), messages: [] })) {
      if (c.type === 'text')
        text += c.text
    }
    assert.equal(text, '桌面也只有张截图搜到啦')
    assert.deepEqual(events.map(e => e.type), ['provider.dsml-dropped'])
    assert.equal(events[0].data.role, 'performer.reflex')
    assert.equal(events[0].data.chars, BLOCK.length)
  }
  finally {
    srv.close()
  }
})
