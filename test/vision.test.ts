import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ModelRequest } from '../src/index.ts'
import { StickerBook } from '../plugins/official/stickers/book.ts'
import { seer } from '../plugins/official/stickers/collect.ts'
import { Vision, parsePhoto } from '../plugins/official/surface-onebot/vision.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'mumu-vis-'))
// 不是真图：缩图认不出就原样返回，正好测别的
const img = (n: number): { bytes: Buffer, mime: string } => ({ bytes: Buffer.alloc(64, n), mime: 'image/jpeg' })
const photo = { url: 'http://x/1.jpg', sticker: false }
const sticker = { url: 'http://x/s.gif', sticker: true }

function model(reply: string | (() => string)) {
  const calls: ModelRequest[] = []
  const complete = async (req: ModelRequest): Promise<string> => {
    calls.push(req)
    return typeof reply === 'function' ? reply() : reply
  }
  return { calls, complete }
}

const PHOTO = '{"kind":"截图","desc":"微信聊天，有人约周末爬山","text":"周六七点集合","vibe":""}'

test('看图描述：截图标成「截图」带上图上的字；照片带梗；模型没按 JSON 回也照用那句话', () => {
  assert.deepEqual(parsePhoto(PHOTO), { what: '截图', desc: '微信聊天，有人约周末爬山，上面写着「周六七点集合」', tags: [] })
  assert.equal(parsePhoto('{"kind":"带字图","desc":"猫瘫在键盘上","text":"","vibe":"上班摸鱼"}')?.desc, '猫瘫在键盘上（上班摸鱼）')
  assert.equal(parsePhoto('一只橘猫趴在窗台上')?.desc, '一只橘猫趴在窗台上')
  assert.equal(parsePhoto('{"kind":"照片","desc":"","text":""}'), undefined)
})

test('看图：同一张图只问一次模型（换会话、重启都认得）', async () => {
  const file = join(dir(), 'cache.json')
  const m = model(PHOTO)
  const v = new Vision(m.complete, { cacheFile: file })
  const a = await v.see(photo, img(1), { channel: 'qq:group:1' })
  const b = await v.see(photo, img(1), { channel: 'qq:group:2' })
  assert.equal(m.calls.length, 1)
  assert.equal(a?.what, '截图')
  assert.deepEqual(a, b)
  await new Promise(r => setTimeout(r, 5200)) // 落盘是攒 5 秒写一次
  const again = new Vision(m.complete, { cacheFile: file })
  await again.see(photo, img(1), { channel: 'qq:group:3' })
  assert.equal(m.calls.length, 1)
})

test('看图：每会话每分钟上限、排队太久的不看，写「没顾上看」；失败写「没看清」', async () => {
  const m = model(PHOTO)
  const v = new Vision(m.complete, { cacheFile: '', perMinute: 2, staleSec: 30 })
  await v.see(photo, img(1), { channel: 'c' })
  await v.see(photo, img(2), { channel: 'c' })
  assert.deepEqual(await v.see(photo, img(3), { channel: 'c' }), { desc: '没顾上看', tags: [], failed: true })
  assert.equal((await v.see(photo, img(3), { channel: 'd' }))?.failed, undefined) // 别的会话不受影响
  assert.equal((await v.see(photo, img(4), { channel: 'e', sentAt: Date.now() / 1000 - 60 }))?.desc, '没顾上看')
  assert.equal(m.calls.length, 3)
  const bad = new Vision(async () => { throw new Error('超时') }, { cacheFile: '' })
  assert.equal((await bad.see(photo, img(5), { channel: 'c' }))?.desc, '没看清')
  assert.equal((await bad.see(photo, undefined, { channel: 'c' }))?.desc, '没看清') // 有地址但没下下来
  assert.equal(await bad.see({ sticker: true }, undefined, { channel: 'c' }), undefined) // 本来就没地址（商城表情）：交给 summary
})

test('表情包只看一次：库里有不调模型，新的一次调用出描述 + 审核并入库，同时来两张也只看一次', async () => {
  const book = new StickerBook(dir(), 50, 3)
  const m = model('{"desc":"猫猫叉腰配字得意","emotion":"得意","tags":["得意","嘚瑟"],"usage":"被夸时","isSticker":true,"flags":[],"ok":true}')
  const see = seer({ book, complete: m.complete, review: {}, collect: true, learn: true, alive: () => true, contextOf: () => undefined, log: () => {}, changed: () => {} })
  const v = new Vision(m.complete, { cacheFile: '' }, () => see)
  const [a, b] = await Promise.all([v.see(sticker, img(7), { channel: 'g' }), v.see(sticker, img(7), { channel: 'g' })])
  assert.equal(m.calls.length, 1)
  assert.deepEqual(a, { what: '表情包', desc: '猫猫叉腰配字得意', tags: ['得意', '嘚瑟'] }) // 情绪已在描述里，不重复
  assert.deepEqual(a, b)
  assert.equal(book.usable().length, 1) // 带着这次的审核结论入库，不用再排队审
  await v.see(sticker, img(7), { channel: 'g' })
  assert.equal(m.calls.length, 1)
})

test('模拟器的图（sim）照常描述但不进表情包库；库目录不能指到归档里', async () => {
  const book = new StickerBook(dir(), 50, 3)
  const m = model('{"desc":"灰底黑字无语","emotion":"无语","tags":["无语"],"isSticker":true,"flags":[],"ok":true}')
  const see = seer({ book, complete: m.complete, review: {}, collect: true, learn: true, alive: () => true, contextOf: () => undefined, log: () => {}, changed: () => {} })
  const v = new Vision(m.complete, { cacheFile: '' }, () => see)
  const r = await v.see({ ...sticker, sim: true }, img(11), { channel: 'qq:group:7438300' })
  assert.equal(r?.desc, '灰底黑字无语')
  assert.equal(book.all().length, 0)
  assert.throws(() => new StickerBook(join(dir(), 'backups', 'test-archive', 'stickers'), 50, 3), /归档/)
})

test('表情包审核没过：不进库、不落盘，再见到用记下的描述', async () => {
  const book = new StickerBook(dir(), 50, 3)
  const m = model('{"desc":"一张自拍","emotion":"开心","tags":["自拍"],"isSticker":true,"flags":[4],"ok":false}')
  const see = seer({ book, complete: m.complete, review: {}, collect: true, learn: true, alive: () => true, contextOf: () => undefined, log: () => {}, changed: () => {} })
  const first = await see({ raw: img(9), view: async () => ({ ...img(9), frames: 1 }), channel: 'g', budget: () => undefined })
  assert.deepEqual(first, { desc: '一张自拍', tags: ['自拍'], emotion: '开心' })
  assert.equal(book.all().length, 0)
  await see({ raw: img(9), view: async () => ({ ...img(9), frames: 1 }), channel: 'g', budget: () => undefined })
  assert.equal(m.calls.length, 1)
  assert.deepEqual(await see({ raw: img(10), view: async () => undefined, channel: 'g', budget: () => '没顾上看' }), { refused: '没顾上看' })
})
