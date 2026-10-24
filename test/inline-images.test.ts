import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import type { HistoryTurn, LogEvent } from '../src/index.ts'
import { withImages } from '../plugins/official/mind-default/material.ts'
import { toWire, withoutImages } from '../plugins/official/provider-openai/images.ts'
import type { ImageMessage } from '../plugins/official/provider-openai/images.ts'
import { imageLabel, render } from '../plugins/official/surface-onebot/inbound.ts'
import { makeInline, pickInline } from '../plugins/official/surface-onebot/inline.ts'
import type { MediaRef } from '../plugins/official/surface-onebot/media.ts'
import { MediaStore } from '../plugins/official/surface-onebot/media.ts'
import { shrink } from '../plugins/official/surface-onebot/shrink.ts'

const NOW = 10_000_000
const MIN = 60_000
const G = 'qq:group:1'

/** 一条带图的群消息：日志里的感知 + 历史里对应的那一轮 */
function msg(seq: number, at: number, who: string, text: string, refs: Partial<MediaRef>[], channel = G): { ev: LogEvent, turn: HistoryTurn } {
  const media = refs.map((r, i) => ({ kind: 'image', media: `orig${seq}-${i}.png`, url: '', mime: 'image/png', ...r }))
  return {
    ev: { seq, at, type: 'percept.received', data: { kind: 'group.message', channel, sender: { id: who, name: who }, text, data: media.length ? { media } : {} } },
    turn: { role: 'other', text, at, channel, kind: 'group.message', sender: { id: who, name: who } },
  }
}
const img = (n: number, bytes = 100_000, extra: Partial<MediaRef> = {}): Partial<MediaRef> => ({
  what: '图片', shown: `[图片：描述${n}]`, alt: `描述${n}`, inline: { media: `in${n}.jpg`, bytes }, ...extra,
})

function build(list: { ev: LogEvent, turn: HistoryTurn }[]): { events: LogEvent[], turns: HistoryTurn[] } {
  return { events: list.map(m => m.ev), turns: list.map(m => m.turn) }
}

test('原图选图：每个频道最近 count 张、withinMin 内；更早的照旧是文字；占位换成「[图片]」', () => {
  const { events, turns } = build([
    msg(1, NOW - 20 * MIN, '阿杰', '老图 [图片：描述1]', [img(1)]), // 超过 15 分钟
    msg(2, NOW - 10 * MIN, '阿杰', '看 [图片：描述2]', [img(2)]),
    msg(3, NOW - 9 * MIN, '小林', '[图片：描述3][图片：描述4]', [img(3), img(4)]),
    msg(4, NOW - 8 * MIN, '小林', '好看吗 [图片：描述5]', [img(5)]),
  ])
  const out = pickInline(events, turns, { count: 3, withinMin: 15 }, NOW)
  assert.deepEqual([...out.keys()], [2, 3]) // 最近三张：3、4、5；2 被挤出去
  assert.equal(out.get(2)!.text, '[图片][图片]')
  assert.deepEqual(out.get(2)!.images.map(i => i.media), ['in3.jpg', 'in4.jpg'])
  assert.equal(out.get(3)!.text, '好看吗 [图片]')
  assert.deepEqual(out.get(3)!.swaps, [{ from: '[图片：描述5]', to: '[图片]' }])
  assert.equal(out.get(3)!.images[0].alt, '描述5')
  assert.equal(out.get(3)!.images[0].label, undefined)
})

test('原图选图：她自己的话不带；表情包可关；没有副本的不带；count 0 全关', () => {
  const { events, turns } = build([
    msg(1, NOW - 3 * MIN, '糖糖', '[表情包：笑死]', [img(1, 50_000, { kind: 'sticker', what: '表情包', shown: '[表情包：笑死]' })]),
    msg(2, NOW - 2 * MIN, '糖糖', '[图片：坏图]', [img(2, 50_000, { inline: undefined, shown: '[图片：坏图]' })]),
  ])
  turns.push({ role: 'self', text: '哈哈', at: NOW - MIN, channel: G, kind: 'utterance' })
  assert.deepEqual(pickInline(events, turns, {}, NOW).get(0)?.text, '[表情包]') // 默认表情包也带
  assert.equal(pickInline(events, turns, { stickers: false }, NOW).size, 0)
  assert.equal(pickInline(events, turns, { count: 0 }, NOW).size, 0)
})

test('原图选图：加起来超过 maxBytes 从最旧的退回文字；每个频道各算各的', () => {
  const { events, turns } = build([
    msg(1, NOW - 5 * MIN, '阿杰', '[图片：描述1]', [img(1, 900_000)]),
    msg(2, NOW - 4 * MIN, '七七', '[图片：描述2]', [img(2, 900_000)], 'qq:group:2'),
    msg(3, NOW - 3 * MIN, '阿杰', '[图片：描述3]', [img(3, 900_000)]),
  ])
  const out = pickInline(events, turns, { count: 1, maxBytes: 2_000_000 }, NOW)
  // 群 1 只要最近一张（3），群 2 一张（2）；共 1.8MB 没超
  assert.deepEqual([...out.keys()], [1, 2])
  const tight = pickInline(events, turns, { count: 3, maxBytes: 1_000_000 }, NOW)
  assert.deepEqual([...tight.keys()], [2]) // 只装得下最新那张，更旧的两张留文字
  assert.equal(turns[0].text, '[图片：描述1]') // 不改历史本身
})

test('原图选图：编号（给大脑）按时间从旧到新，附件带同样的标签；描述原文找不到时照样附图', () => {
  const { events, turns } = build([
    msg(1, NOW - 5 * MIN, '阿杰', '[图片：描述1]', [img(1)]),
    msg(2, NOW - 4 * MIN, '七七', '（机器人）[截图：描述2]', [img(2, 1000, { what: '截图', shown: '[截图：描述2]' })]),
    msg(3, NOW - 3 * MIN, '阿杰', '被别的插件改过的文字', [img(3)]),
  ])
  const out = pickInline(events, turns, {}, NOW, true)
  assert.equal(out.get(0)!.text, '[图片1]')
  assert.equal(out.get(1)!.text, '（机器人）[截图2]')
  assert.deepEqual(out.get(1)!.images[0].label, '[截图2]')
  assert.equal(out.get(2)!.text, '被别的插件改过的文字')
  assert.equal(out.get(2)!.images[0].label, '[图片3]')
  assert.deepEqual(out.get(2)!.swaps, [])
})

test('感知里的图片原文与收图时记下的 shown 是同一个函数写的：换得掉', async () => {
  const ref = { url: 'http://x/1.jpg', sticker: false }
  const seen = { what: '照片', desc: '一只黑猫  坐在\n草地上' }
  const r = await render([{ type: 'text', data: { text: '看我家猫 ' } }, { type: 'image', data: { url: ref.url } }], {
    selfName: '沐沐', names: ['沐沐'], ownMessages: new Set(), describe: async () => seen,
  })
  assert.ok(r.text.includes(imageLabel(ref, seen)), r.text)
  assert.equal(imageLabel(ref, seen), '[照片：一只黑猫 坐在 草地上]')
})

test('provider：消息上的 images 附件在发请求时才变成多模态 content；读不到退回描述；没图的原样', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mumu-inl-'))
  writeFileSync(join(dir, 'a.jpg'), Buffer.from('JPEGDATA'))
  const messages: ImageMessage[] = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '阿杰：看 [图片]', images: [{ media: 'a.jpg', bytes: 8, alt: '黑猫' }] },
    { role: 'user', content: '大脑那段', images: [{ media: 'a.jpg', bytes: 8, label: '[图片1]' }, { media: 'gone.jpg', bytes: 8, alt: '没了', label: '[图片2]' }] },
  ]
  const wire = toWire(messages, dir)
  assert.deepEqual(wire[0], { role: 'system', content: '规则' })
  assert.deepEqual(wire[1].content, [
    { type: 'text', text: '阿杰：看 [图片]' },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('JPEGDATA').toString('base64')}` } },
  ])
  const parts = wire[2].content as { type: string, text?: string }[]
  assert.deepEqual(parts.map(p => p.type), ['text', 'text', 'image_url', 'text'])
  assert.equal(parts[1].text, '[图片1]')
  assert.equal(parts[3].text, '[图片2][图片：没了]')
  // 日志里那份（网关记的是原消息）只有文件名和字节数
  assert.ok(!JSON.stringify(messages).includes('base64'))
  // 端点拒收图：退回纯文字，附件换回描述
  assert.deepEqual(withoutImages(messages)[1], { role: 'user', content: '阿杰：看 [图片] [图片：黑猫]' })
})

test('大脑：编号占位整段一起换（【本次唤醒】里引着同一句），原图附在末尾', () => {
  const state = '【最近对话】\n阿杰: 看 [图片：一只白狗]\n\n【本次唤醒】\n- (message) 阿杰：看 [图片：一只白狗]'
  const m = withImages(state, [{ text: '看 [图片1]', images: [{ media: 'a.jpg', bytes: 1, label: '[图片1]' }], swaps: [{ from: '[图片：一只白狗]', to: '[图片1]' }] }])
  assert.ok(!m.content.includes('白狗'), m.content)
  assert.equal(m.content.split('[图片1]').length - 1, 3) // 两处占位 + 末尾一句说明
  assert.equal(m.images?.length, 1)
  assert.deepEqual(withImages(state, []), { role: 'user', content: state })
})

/** 纯色 PNG（不靠 data/ 里的图） */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x60)])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const dims = (bytes: Buffer): number[] => {
  const f = join(mkdtempSync(join(tmpdir(), 'mumu-inl-')), 'x.jpg')
  writeFileSync(f, bytes)
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' })
  return [...out.matchAll(/pixel(?:Width|Height): (\d+)/g)].map(m => Number(m[1]))
}

test('原图副本：长边缩到 maxSide 的 JPEG、小图不放大，存进媒体目录；表情包可关', { skip: process.platform !== 'darwin' && '缩图在 macOS 用 sips、Windows 用 PowerShell，别的平台原样返回' }, async () => {
  const big = await shrink({ bytes: png(1600, 900), mime: 'image/png' }, 1024, 4, 80)
  assert.equal(big.mime, 'image/jpeg')
  assert.deepEqual(dims(big.bytes), [1024, 576])
  const small = await shrink({ bytes: png(240, 240), mime: 'image/png' }, 1024, 4, 80)
  assert.deepEqual(dims(small.bytes), [240, 240])

  const store = new MediaStore(mkdtempSync(join(tmpdir(), 'mumu-inl-')), 8_000_000)
  const inl = await makeInline(store, { bytes: png(1600, 900), mime: 'image/png' }, false, { maxSide: 1024, quality: 80 })
  assert.ok(inl && inl.media.endsWith('.jpg'))
  assert.equal(readFileSync(join(store.dir, inl.media)).length, inl.bytes)
  assert.equal(await makeInline(store, { bytes: png(64, 64), mime: 'image/png' }, true, { stickers: false }), undefined)
  assert.equal(await makeInline(store, { bytes: png(64, 64), mime: 'image/png' }, false, { count: 0 }), undefined)
})
