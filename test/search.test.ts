import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Ctx, Plugin } from '../src/index.ts'
import { Mumu } from '../src/index.ts'
import actionSearch from '../plugins/official/action-search/index.ts'
import { parseLook } from '../plugins/official/action-search/look.ts'
import { bingItems } from '../plugins/official/action-search/providers.ts'
import type { SearchDeps } from '../plugins/official/action-search/search.ts'
import { imageType, normalize, runSearch } from '../plugins/official/action-search/search.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const png = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16, n)])

const DS = {
  results: [
    { title: 'SpaceX 星舰第 14 次试飞', url: 'https://a.example/1', site_name: '新华网', date: '2026-10-20T16:00:00+00:00', snippet: '星舰首次入轨，基本成功。', summary: '长摘要' },
    { title: 'SpaceX 三季度营收 146 亿美元', url: 'https://b.example/2', site_name: '东方财富', date: '2026-10-21T16:00:00+00:00', snippet: '净利润 44 亿美元。' },
    { title: '没有链接的一条', url: '' },
  ],
}

interface Call { url: string, init?: RequestInit }
function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): { fetch: typeof fetch, calls: Call[] } {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return { fetch: f, calls }
}

const deps = (f: typeof fetch, key: string | null = 'sk-test', extra: Partial<SearchDeps> = {}): SearchDeps =>
  ({ fetch: f, key: name => name === 'deepseek' && key ? key : undefined, now: () => Date.parse('2026-10-22T08:00:00Z'), ...extra })

test('搜索成功：带密钥调 DeepSeek，结果整理成标题、摘要、链接，缺链接的跳过', async () => {
  const m = mockFetch(() => json(DS))
  const r = await runSearch({ query: 'SpaceX', count: 3 }, {}, deps(m.fetch))
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'web')
  assert.equal(r.hits?.length, 2)
  assert.equal(m.calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal((m.calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(String(m.calls[0].init?.body)), { query: 'SpaceX', count: 3 })
  assert.match(r.text, /搜「SpaceX」（网页，DeepSeek）找到 2 条/)
  assert.match(r.text, /1\. SpaceX 星舰第 14 次试飞（新华网 · 2026-10-20）\n {3}星舰首次入轨，基本成功。\n {3}https:\/\/a\.example\/1/)
  assert.ok(!r.text.includes('没有链接'))
})

test('新闻：查询补上 after:最近几天，按发布时间从新到旧', async () => {
  const m = mockFetch(() => json(DS))
  const r = await runSearch({ query: 'SpaceX', kind: 'news' }, { newsDays: 3 }, deps(m.fetch))
  assert.equal(JSON.parse(String(m.calls[0].init?.body)).query, 'SpaceX after:2026-10-19')
  assert.equal(r.hits?.[0].title, 'SpaceX 三季度营收 146 亿美元')
  assert.match(r.text, /（新闻，DeepSeek）/)
})

test('超时：搜索服务不回，到时限写清「超时」，不抛错', async () => {
  const m = mockFetch((_u, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
  const t0 = Date.now()
  const r = await runSearch({ query: 'SpaceX' }, { timeoutMs: 80 }, deps(m.fetch))
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(r.ok, false)
  assert.match(r.error!, /搜索超时/)
  assert.match(r.text, /搜「SpaceX」没搜成：搜索超时/)
})

test('没密钥：不发请求，原因里写清去哪填', async () => {
  const m = mockFetch(() => json(DS))
  const r = await runSearch({ query: 'SpaceX' }, { apiKeyRef: 'deepseek' }, deps(m.fetch, null))
  assert.equal(r.ok, false)
  assert.equal(m.calls.length, 0)
  assert.match(r.error!, /没有搜索密钥.*「deepseek」.*\/secret set deepseek/)
})

test('服务报错：401 说密钥不对，空关键词直接失败', async () => {
  const m = mockFetch(() => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401 }))
  const r = await runSearch({ query: 'x' }, {}, deps(m.fetch))
  assert.match(r.error!, /密钥不对/)
  assert.match((await runSearch({ query: '  ' }, {}, deps(m.fetch))).error!, /没给关键词/)
})

test('搜图：原图下不来用缩略图，存进本地目录；看图说不合适的扔掉；结果给路径和图里是什么', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mumu-search-'))
  const m = mockFetch((url) => {
    if (url.startsWith('https://image.so.com/j'))
      return json({ list: [
        { title: '<em>大肥鱼</em>表情', img: 'https://img/1.jpg', thumb: 'https://thumb/1.jpg', site: 'a.com', link: 'https://a.com/p' },
        { title: '不合适的图', img: 'https://img/2.jpg', site: 'b.com' },
        { title: '第三张', img: 'https://img/3.jpg', site: 'c.com' },
      ] })
    if (url === 'https://img/1.jpg')
      return new Response('forbidden', { status: 403 }) // 防盗链
    if (url === 'https://thumb/1.jpg')
      return new Response(png(1))
    if (url === 'https://img/2.jpg')
      return new Response(png(2))
    return new Response('<html>不是图</html>')
  })
  const looked: string[] = []
  const look: SearchDeps['look'] = async (bytes, _mime, query) => {
    looked.push(query)
    return bytes.equals(png(2)) ? { ok: false, why: '擦边' } : { ok: true, desc: '一条胖胖的卡通鱼' }
  }
  const r = await runSearch({ query: '可爱大肥鱼', kind: 'image', count: 3 }, { dir }, deps(m.fetch, null, { look }))
  assert.equal(r.ok, true)
  assert.equal(r.images?.length, 1)
  assert.equal(r.dropped, 1)
  const img = r.images![0]
  assert.equal(img.title, '大肥鱼表情')
  assert.equal(img.desc, '一条胖胖的卡通鱼')
  assert.ok(img.path.startsWith(dir) && img.path.endsWith('.png'))
  assert.ok(existsSync(img.path))
  assert.ok(readFileSync(img.path).equals(png(1)))
  assert.deepEqual(looked, ['可爱大肥鱼', '可爱大肥鱼'])
  assert.match(r.text, /搜图「可爱大肥鱼」（必应图片 \+ 360 图片搜索）找到 1 张.*另有 1 张看过不合适发/)
  assert.ok(r.text.includes(`路径：${img.path}`))
})

test('搜图：有对得上的就只留对得上的，对不上的不列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mumu-search-'))
  const m = mockFetch((url) => {
    if (url.startsWith('https://image.so.com/j'))
      return json({ list: [{ title: '王者荣耀鲲', img: 'https://img/1.jpg' }, { title: '胖鱼', img: 'https://img/2.jpg' }] })
    if (url.startsWith('https://www.bing.com/'))
      return new Response('<html></html>')
    return new Response(png(url.endsWith('1.jpg') ? 1 : 2))
  })
  const look: SearchDeps['look'] = async bytes => bytes.equals(png(1)) ? { ok: true, desc: '游戏角色', fit: false } : { ok: true, desc: '胖胖的鱼', fit: true }
  const r = await runSearch({ query: '大肥鱼', kind: 'image' }, { dir }, deps(m.fetch, null, { look }))
  assert.equal(r.unfit, undefined)
  assert.deepEqual(r.images?.map(i => i.desc), ['胖胖的鱼'])
  assert.match(r.text, /另有 1 张跟要找的对不上，没列/)
})

test('搜图：全都对不上 → 不叫她发，附上网页说的这个词指什么，叫她换词再搜', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mumu-search-'))
  const m = mockFetch((url) => {
    if (url.startsWith('https://api.deepseek.com/'))
      return json({ results: [{ title: 'DeepSeek 吉祥物', url: 'https://x/1', snippet: '「蓝色大肥鱼」是中文社区给 DeepSeek 蓝鲸 logo 起的爱称' }] })
    if (url.startsWith('https://image.so.com/j'))
      return json({ list: [{ title: '王者荣耀鲲', img: 'https://img/1.jpg' }] })
    if (url.startsWith('https://www.bing.com/'))
      return new Response('<html></html>')
    return new Response(png(1))
  })
  const look: SearchDeps['look'] = async () => ({ ok: true, desc: '游戏角色鲲', fit: false })
  const r = await runSearch({ query: '可爱大肥鱼', kind: 'image' }, { dir }, deps(m.fetch, 'sk-test', { look }))
  assert.equal(r.ok, true)
  assert.equal(r.unfit, true)
  assert.match(r.text, /看过都跟「可爱大肥鱼」对不上，先别发/)
  assert.match(r.text, /网上说的「可爱大肥鱼」：\n- DeepSeek 吉祥物：「蓝色大肥鱼」是中文社区给 DeepSeek 蓝鲸 logo 起的爱称/)
  assert.match(r.text, /换个更准的词再 search 一次/)
})

test('搜图：必应和 360 一起搜，结果轮流取；一家挂了另一家照用，两家都挂才算失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mumu-search-'))
  const bingHtml = `<a class="iusc" m="${JSON.stringify({ murl: 'https://b/1.png', turl: 'https://bt/1.png', t: '必应的图', purl: 'https://site.cn/p' }).replace(/"/g, '&quot;')}">`
  let so360Down = false
  const m = mockFetch((url) => {
    if (url.startsWith('https://www.bing.com/'))
      return new Response(bingHtml)
    if (url.startsWith('https://image.so.com/j'))
      return so360Down ? new Response('bad', { status: 500 }) : json({ list: [{ title: '360 的图', img: 'https://s/1.png' }] })
    return new Response(png(url.includes('/b/') ? 7 : 8))
  })
  const r = await runSearch({ query: '猫', kind: 'image', count: 2 }, { dir, look: false }, deps(m.fetch, null))
  assert.deepEqual(r.images?.map(i => i.title), ['必应的图', '360 的图'])
  assert.equal(r.images?.[0].site, 'site.cn')
  assert.equal(r.provider, 'bing+so360')
  so360Down = true
  assert.deepEqual((await runSearch({ query: '猫', kind: 'image' }, { dir, look: false }, deps(m.fetch, null))).images?.map(i => i.title), ['必应的图'])
  const dead = mockFetch(() => new Response('bad', { status: 500 }))
  const failed = await runSearch({ query: '猫', kind: 'image' }, { dir }, deps(dead.fetch, null))
  assert.equal(failed.ok, false)
  assert.match(failed.error!, /必应图片：搜索服务回 500.*360 图片搜索：搜索服务回 500/)
  assert.equal(bingItems(bingHtml)[0].murl, 'https://b/1.png')
})

test('小工具：参数归一、认图片格式、看图结果按 JSON 读', () => {
  assert.deepEqual(normalize({ query: ' 猫 ', kind: 'image', count: 99 }, {}), { query: '猫', kind: 'image', count: 6 })
  assert.deepEqual(normalize({ query: '猫', kind: '乱写' }, { count: 4 }), { query: '猫', kind: 'web', count: 4 })
  assert.equal(imageType(png(1)), '.png')
  assert.equal(imageType(Buffer.from('<html>')), undefined)
  assert.deepEqual(parseLook('好的 {"desc":"猫猫","ok":true,"why":""}'), { ok: true, desc: '猫猫', why: '' })
  assert.equal(parseLook('看不清'), undefined)
})

test('插件：search 动作的结果作为 search.result 感知回到发起的对话、进工作记忆；不标「需要主人」', async () => {
  const mumu = Mumu.create({ cooldownMs: 0 })
  const realFetch = globalThis.fetch
  globalThis.fetch = mockFetch(() => json(DS)).fetch
  try {
    let ctx!: Ctx
    const fake: Plugin = {
      name: 'fake',
      apply(c) {
        ctx = c
        c.provide('commands', { register: () => () => {}, list: () => [], run: async () => false })
        c.provide('secrets', { get: (n: string) => n === 'deepseek' ? 'sk-test' : undefined, set: () => {}, del: () => false, list: () => [] })
      },
    }
    await mumu.use(fake)
    await mumu.use(actionSearch, {})
    const entry = ctx.actions.catalog().find(c => c.name === 'search')
    assert.ok(entry && !entry.description.includes('需要主人'))
    ctx.actions.start('search', { query: 'SpaceX', kind: 'news' }, 'qq:group:1')
    for (let i = 0; i < 50 && !ctx.log.events.some(e => e.type === 'percept.received'); i++)
      await sleep(10)
    const p = ctx.log.events.find(e => e.type === 'percept.received')
    assert.equal(p?.data.kind, 'search.result')
    assert.equal(p?.data.channel, 'qq:group:1')
    assert.equal(p?.data.data.ok, true)
    assert.equal(p?.data.data.hits.length, 2)
    assert.match(p?.data.text, /SpaceX 三季度营收/)
    const note = mumu.prompt.notes(false).find(n => n.text.includes('SpaceX 三季度营收'))
    assert.ok(note, '结果进了工作记忆')
    assert.match(note.text, /别念链接/)
  }
  finally {
    globalThis.fetch = realFetch
    await mumu.dispose()
  }
})
