import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Ctx, Plugin } from '../src/index.ts'
import { Mumu } from '../src/index.ts'
import actionImage from '../plugins/official/action-image/index.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16, 7)])

/** 装上 action-image，起一个 image 动作，等它结算；返回结算事件与这段时间发出的图 */
async function run(params: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<{ ended: { outcome: string, error?: string }, images: unknown[] }> {
  const mumu = Mumu.create({ cooldownMs: 0 })
  const realFetch = globalThis.fetch
  if (fetchImpl)
    globalThis.fetch = fetchImpl
  try {
    let ctx!: Ctx
    const fake: Plugin = {
      name: 'fake',
      apply(c) {
        ctx = c
        c.provide('secrets', { get: () => undefined, set: () => {}, del: () => false, list: () => [] })
      },
    }
    await mumu.use(fake)
    await mumu.use(actionImage, { dir: mkdtempSync(join(tmpdir(), 'mumu-media-')) })
    const id = ctx.actions.start('image', params, 'qq:group:1')
    const ended = (): { outcome: string, error?: string } | undefined =>
      ctx.log.events.find(e => e.type === 'action.ended' && e.data.id === id)?.data
    for (let i = 0; i < 100 && !ended(); i++)
      await sleep(10)
    const images = ctx.log.events.filter(e => e.type === 'utterance.part' && e.data.part?.kind === 'image').map(e => e.data.part)
    return { ended: ended()!, images }
  }
  finally {
    globalThis.fetch = realFetch
    await mumu.dispose()
  }
}

test('image 收到 .mp3：抛错（结局 error），文案指路 qq.send file / voice，什么都不发', async () => {
  const r = await run({ path: 'C:\\Users\\me\\Pictures\\luotianyi_antiutopia.mp3' })
  assert.equal(r.ended.outcome, 'error')
  assert.match(r.ended.error!, /这不是图片（\.mp3）/)
  assert.ok(r.ended.error!.includes('qq.send {"op":"file","path":'))
  assert.ok(r.ended.error!.includes('qq.send {"op":"voice","path":'))
  assert.equal(r.images.length, 0)
})

test('image 扩展名像图、身体服务回的却不是图片：同样抛错指路', async () => {
  const audio = (async () => new Response(Buffer.alloc(8), { headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch
  const r = await run({ path: 'C:\\nope\\cover.jpg' }, audio)
  assert.equal(r.ended.outcome, 'error')
  assert.match(r.ended.error!, /这不是图片（audio\/mpeg）.*qq\.send/)
  assert.equal(r.images.length, 0)
})

test('image 发本机的 png：结局 done，发出一个 image Part', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mumu-pic-')), 'cat.png')
  writeFileSync(file, png)
  const r = await run({ path: file, alt: '一只猫' })
  assert.equal(r.ended.outcome, 'done')
  assert.equal(r.images.length, 1)
  assert.deepEqual((r.images[0] as { data: { mime: string, alt: string } }).data.mime, 'image/png')
})
