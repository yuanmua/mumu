import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StickerBook, canSend } from '../plugins/official/stickers/book.ts'
import type { ChanceInput } from '../plugins/official/stickers/chance.ts'
import { ASK_PATTERNS, chance, isAsk } from '../plugins/official/stickers/chance.ts'
import { parseReview } from '../plugins/official/stickers/review.ts'
import type { Provider } from '../plugins/official/stickers/search.ts'
import { Hunter, imgTags } from '../plugins/official/stickers/search.ts'
import type { OutItem } from '../plugins/official/surface-onebot/outbox.ts'
import { Outbox } from '../plugins/official/surface-onebot/outbox.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'mumu-stk-'))
// 最小的真图片头：PNG / GIF，内容不同摘要就不同
const png = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16, n)])
const gif = (n: number): Buffer => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, n)])

const base: ChanceInput = {
  track: 'emo', asked: false, base: 0.2, mood: { valence: 0.1, arousal: 0.4 }, othersRecent: 2, otherSticker: false,
  deep: false, saidChars: 5, otherChars: 6, sinceLastSec: Infinity, lastUttHad: false, minGapSec: 120,
}

test('发不发：对方要就一定发；认真答 / 刚发过 / 上一条带过 / 说了一大段都不发', () => {
  assert.equal(chance({ ...base, asked: true, lastUttHad: true, sinceLastSec: 1 }).p, 1)
  assert.equal(chance({ ...base, deep: true }).p, 0)
  assert.equal(chance({ ...base, lastUttHad: true }).p, 0)
  assert.equal(chance({ ...base, sinceLastSec: 30 }).p, 0)
  assert.equal(chance({ ...base, saidChars: 80 }).p, 0)
  assert.equal(chance(base).p, 0.2)
})

test('发不发：心情好、聊得热、对方刚发了表情包 → 概率高；心情差、冷清、对方说了一大段 → 低', () => {
  const hi = chance({ ...base, mood: { valence: 0.6, arousal: 0.7 }, othersRecent: 6, otherSticker: true })
  const lo = chance({ ...base, mood: { valence: -0.5, arousal: 0.1 }, othersRecent: 0, otherChars: 80 })
  assert.ok(hi.p > 0.8, `高：${hi.p}`)
  assert.ok(lo.p < 0.01, `低：${lo.p}`)
  assert.ok(hi.why.some(w => w.includes('对方刚发了表情包')))
  assert.equal(chance({ ...base, base: 0.9, mood: { valence: 0.9, arousal: 0.9 }, othersRecent: 9, otherSticker: true }).p, 1) // 封顶
})

test('认得出对方在要表情包，别的提到表情的话不算', () => {
  for (const t of ['发个表情包', '@沐沐 发个表达你现在心情的表情我看看？', '来张图', '斗图！', '再来一个表情', '发表情'])
    assert.ok(isAsk(t, ASK_PATTERNS), t)
  for (const t of ['你发的表情好可爱', '我发了个表情', '表情包', '先给你几个我的表情包', '[表情包：猫猫]', '这表情绝了'])
    assert.ok(!isAsk(t, ASK_PATTERNS), t)
})

test('审核：全满足才过；沾上规则、不是表情包、描述有禁词都拦下并写原因；不是 JSON 算没审', () => {
  const ok = parseReview('好的 {"desc":"猫猫比心","emotion":"开心","tags":["开心","比心"],"usage":"夸人时","isSticker":true,"flags":[],"ok":true}')
  assert.equal(ok?.ok, true)
  assert.deepEqual(ok?.tags, ['开心', '比心'])
  const flagged = parseReview('{"desc":"一张自拍","isSticker":true,"flags":[4],"ok":false}')
  assert.equal(flagged?.ok, false)
  assert.match(flagged!.reason!, /真人照片/)
  const lying = parseReview('{"desc":"海报","isSticker":false,"flags":[],"ok":true}') // 模型说 ok 但不是表情包
  assert.equal(lying?.ok, false)
  const words = parseReview('{"desc":"带二维码的猫","isSticker":true,"flags":[],"ok":true}', { blockWords: ['二维码'] })
  assert.equal(words?.ok, false)
  assert.match(words!.reason!, /二维码/)
  assert.equal(parseReview('看不清'), undefined)
})

test('库：没审的群里收的不能发，主人放的可以，禁用的不行；pick 只挑能发的', () => {
  const d = dir()
  writeFileSync(join(d, '开心-比心.png'), png(1)) // 手放的
  const book = new StickerBook(d, 10, 3)
  const g = book.add(gif(2), 'image/gif', { desc: '猫猫大笑', tags: ['大笑'], source: { kind: 'group', channel: 'qq:group:1' } })!
  assert.equal(canSend(g), false)
  assert.equal(book.pick('大笑', 'c'), undefined)
  book.reviewed(g.file, { ok: true, tags: ['笑死'], review: { at: 0, version: 2 } })
  assert.equal(book.pick('大笑', 'c')?.file, g.file)
  assert.equal(book.pick('开心', 'c')?.source?.kind, 'manual')
  book.setDisabled(g.file, true)
  assert.equal(book.pick('大笑', 'c'), undefined)
  assert.ok(book.remove(g.file))
  assert.ok(book.isRejected(g.file))
  assert.ok(!existsSync(join(d, g.file)))
})

test('fabiaoqing 页面：按属性名取图', () => {
  const html = '<div><img class="ui image lazy" data-original="https://img.x/1.jpg" src="/t.gif" title="无语_表情" alt="无语"/><img src="/logo.png"></div>'
  const tags = imgTags(html)
  assert.equal(tags[0]['data-original'], 'https://img.x/1.jpg')
  assert.equal(tags[0].title, '无语_表情')
  assert.equal(tags[1].src, '/logo.png')
})

/** 假来源 + 假下载：url → 字节 */
function fakeNet(files: Record<string, Buffer>) {
  return (async (url: string) => {
    const b = files[url]
    return b ? new Response(b) : new Response('nope', { status: 404 })
  }) as unknown as (url: string, init: { headers: Record<string, string>, signal: AbortSignal }) => Promise<Response>
}

test('联网找：第一个来源挂了换下一个；不合适的拦下不落盘、记原因；合适的带来源入库', async () => {
  const d = dir()
  const book = new StickerBook(d, 10, 3)
  const logs: { type: string, data: Record<string, unknown> }[] = []
  const providers: Record<string, Provider> = {
    broken: { id: 'broken', title: '坏的', search: async () => { throw new Error('连不上') } },
    good: {
      id: 'good',
      title: '好的',
      search: async () => [
        { provider: 'good', url: 'u/bad', alt: '一张自拍' },
        { provider: 'good', url: 'u/html' }, // 下下来不是图（防盗链网页）
        { provider: 'good', url: 'u/ok', page: 'p/ok' },
      ],
    },
  }
  const hunter = new Hunter({
    book,
    cfg: { providers: ['broken', 'good'], perSearch: 3, perHour: 2 },
    blockWords: ['色情'],
    providers,
    fetch: fakeNet({ 'u/bad': png(7), 'u/html': Buffer.from('<html>forbidden</html>'), 'u/ok': gif(8) }),
    review: async bytes => bytes.equals(png(7))
      ? { tags: [], isSticker: true, flags: ['真人照片'], ok: false, reason: '沾上了：真人照片', desc: '自拍' }
      : { tags: ['无语'], isSticker: true, flags: [], ok: true, desc: '猫猫无语', usage: '对方说废话时' },
    log: (type, data) => { logs.push({ type, data }) },
  })
  const r = await hunter.find('无语', '对方要')
  assert.equal(r.sticker?.desc, '猫猫无语')
  assert.deepEqual(r.sticker?.source, { kind: 'web', provider: 'good', url: 'u/ok', page: 'p/ok', query: '无语' })
  assert.equal(r.rejected.length, 1)
  assert.equal(book.all().length, 1) // 拦下的那张不在库里
  assert.equal(readdirSync(d).filter(f => f.endsWith('.png')).length, 0) // 也没落盘
  assert.match(readFileSync(join(d, 'rejected.json'), 'utf8'), /真人照片/)
  assert.ok(logs.some(l => l.type === 'sticker.rejected' && String(l.data.reason).includes('真人照片')))
  assert.ok(logs.some(l => l.type === 'sticker.search' && l.data.ok === true))

  assert.match((await hunter.find('色情图', '她想发')).error!, /不合适的词/)
  await hunter.find('抱抱', '她想发')
  assert.match((await hunter.find('开心', '她想发')).error!, /这一小时已经找了 2 次/)
})

test('发件箱：还在找的表情包按位置占一格，后面的话等它；落空就跳过；等的时候被打断就什么都不发', async () => {
  const run = async (found: boolean, stopEarly: boolean): Promise<string[]> => {
    const sent: string[] = []
    let release!: (v: OutItem | undefined) => void
    const box = new Outbox({
      split: { minChars: 2 },
      send: async (_c, item) => {
        sent.push(item.kind === 'text' ? item.text : 'IMG')
        return 'ok'
      },
      report: () => {},
      failed: () => {},
      extra: () => new Promise<OutItem | undefined>((r) => { release = r }),
    })
    const e = (part: Record<string, unknown>) => box.handle({ type: 'part', uttId: 'u1', channel: 'qq:private:1', part: part as { kind: string } })
    e({ kind: 'text', text: '好呀给你找找。' })
    e({ kind: 'marker', data: { track: 'sticker', value: '开心' } })
    e({ kind: 'text', text: '这张怎么样' })
    box.handle({ type: 'end', uttId: 'u1', channel: 'qq:private:1' })
    await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(sent, ['好呀给你找找'])
    if (stopEarly)
      box.handle({ type: 'stop', uttId: 'u1', channel: 'qq:private:1' })
    release(found ? { kind: 'extra', part: { kind: 'image', data: {} }, raw: 0 } : undefined)
    await new Promise(r => setTimeout(r, 10))
    return sent
  }
  assert.deepEqual(await run(true, false), ['好呀给你找找', 'IMG', '这张怎么样'])
  assert.deepEqual(await run(false, false), ['好呀给你找找', '这张怎么样'])
  assert.deepEqual(await run(true, true), ['好呀给你找找'])
})
