import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { LogEvent } from '../src/index.ts'
import type { LearnConfig } from '../plugins/official/interests/learn.ts'
import { applyMiss, applyReading, dislike, like, setByUser } from '../plugins/official/interests/learn.ts'
import { buildRatePrompt, parse, parseRate } from '../plugins/official/interests/read.ts'
import type { SemanticConfig } from '../plugins/official/interests/semantic.ts'
import { clean, cosine, itemText, nearness, Semantic } from '../plugins/official/interests/semantic.ts'
import type { Seed } from '../plugins/official/interests/store.ts'
import { decayed, InterestStore } from '../plugins/official/interests/store.ts'
import type { WatchConfig } from '../plugins/official/interests/watch.ts'
import { Watcher } from '../plugins/official/interests/watch.ts'
import { parseInput } from '../plugins/official/interests/web.ts'

// 出厂值就用清单里的：测的是装上即得的行为
const defaults = JSON.parse(readFileSync(new URL('../plugins/official/interests/package.json', import.meta.url), 'utf8')).mumu.defaults as {
  seed: Seed[], autoAdd: LearnConfig['autoAdd'], step: LearnConfig['step'], ignoreAfter: number, personaFloor: number
  settleSec: number, minTurns: number, missWindowSec: number, positiveEmo: string[], questionWords: string[], likeWords: string[], dislikeWords: string[], keepLines: number
}
const learn: LearnConfig = { autoAdd: defaults.autoAdd, step: defaults.step, ignoreAfter: defaults.ignoreAfter }
const DAY = 86_400_000
const T0 = 1_800_000_000_000

function fresh(halfLife = 21): InterestStore {
  const s = new InterestStore(new DatabaseSync(':memory:'), () => halfLife)
  s.seed(defaults.seed, defaults.personaFloor, T0)
  return s
}

test('interests: 人设种下一次，删掉的不会再长回来', () => {
  const s = fresh()
  assert.deepEqual(s.active(T0).map(i => i.name).sort(), ['冷知识', '新科技', '猫', '甜食', '航天', '音乐'].sort())
  assert.ok(s.active(T0).every(i => i.source === 'persona'))
  s.remove('猫')
  assert.equal(s.seed(defaults.seed, defaults.personaFloor, T0), 0)
  assert.equal(s.get('猫', T0), undefined)
})

/**
 * 假的向量模型：几个「概念」维度，兴趣按名字、消息按整句查表，查不到的落在「别的」维度上（和谁都不近）。
 * 测的是打分怎么用相似度（阈值、加权、限时、失败、缓存），不是模型好不好——那个在模拟器场景 interest-sem 里量。
 */
const AXES = ['航天', '猫', '音乐', '甜食', '新科技', '冷知识', '摄影', '体育', '别的']
const at = (pairs: Record<string, number>): number[] => AXES.map(a => pairs[a] ?? 0)
const SENT: Record<string, number[]> = {
  猎鹰九号那个回收你们看了吗: at({ 航天: 1, 新科技: 0.2 }),
  火箭队今晚比赛谁去看: at({ 体育: 1, 航天: 0.15 }), // 字面带「火箭」，说的是篮球
  边听歌边撸主子: at({ 音乐: 0.6, 猫: 0.5, 别的: 1 }), // 两条都沾点边，都不算满
  我新买了个二手机身准备去拍夜景: at({ 摄影: 1 }),
}
function fakeEmbed(calls: string[] = []): (text: string) => Promise<number[]> {
  return async (text) => {
    calls.push(text)
    const name = AXES.find(a => text.startsWith(`${a}：`) || text === a)
    return SENT[text] ?? (name ? at({ [name]: 1 }) : at({ 别的: 1 }))
  }
}
const semCfg: SemanticConfig = { threshold: 0.3, full: 0.6, background: [], query: '', cacheSize: 100 }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

test('interests: 语义打分——相近的话题按相近度 × 兴趣分；无关的 0；字面带关键词但说别的事也是 0', async () => {
  const s = fresh()
  const sem = new Semantic({ embed: fakeEmbed() }, () => semCfg)
  const rocket = await sem.near('猎鹰九号那个回收你们看了吗', s.active(T0), 300)
  assert.equal(rocket[0]?.name, '航天', '没有「火箭」二字也认得出是航天')
  assert.equal(rocket[0]?.near, 1)
  assert.equal(rocket[0]?.score, s.get('航天', T0)!.score, '满相近 = 兴趣自己的分')
  assert.deepEqual(await sem.near('火箭队今晚比赛谁去看', s.active(T0), 300), [], '字面命中不算')
  assert.deepEqual(await sem.near('今天中午吃的面条', s.active(T0), 300), [])
  const both = await sem.near('边听歌边撸主子', s.active(T0), 300)
  assert.deepEqual(both.map(h => h.name), ['音乐', '猫'], '近的都列出来，感兴趣程度高的在前')
  assert.ok(both.every(h => h.near > 0 && h.near < 1 && h.score < h.near))
  // 阈值：余弦刚过 threshold 才开始算，到 full 算满
  assert.equal(nearness(0.3, semCfg), 0)
  assert.ok(Math.abs(nearness(0.45, semCfg) - 0.5) < 1e-9)
  assert.equal(nearness(0.9, semCfg), 1)
  assert.ok(Math.abs(cosine([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-9)
})

test('interests: 语义打分——先减去每条兴趣的「平时」：带泛词、和什么闲话都沾边的兴趣不再吸住「在吗」', async () => {
  // 「面试」的向量一半落在「别的」上（关键词是紧张、准备这种泛词）：不减平时，「在吗」对它也有 0.7
  const vec: Record<string, number[]> = { '面试：紧张、准备': [0.7, 0.7], '在吗': [0, 1], '好的': [0, 1], '明天二面好紧张': [1, 0.2] }
  const items = [{ name: '面试', keywords: ['紧张', '准备'], score: 1 }]
  const embed = async (t: string): Promise<number[]> => vec[t] ?? [0, 1]
  const raw = new Semantic({ embed }, () => ({ ...semCfg, threshold: 0.3, full: 0.6 }))
  assert.equal((await raw.near('在吗', items, 300))[0]?.name, '面试', '不减：闲话也算面试')
  const fair = new Semantic({ embed }, () => ({ ...semCfg, threshold: 0.05, full: 0.3, background: ['好的'] }))
  assert.deepEqual(await fair.near('在吗', items, 300), [], '减了平时：闲话不算')
  assert.equal((await fair.near('明天二面好紧张', items, 300))[0]?.name, '面试', '真在聊面试照样认得')
})

test('interests: 语义打分——这句话那头也减平时：贴着某类日常闲话的短句（「吃了吗」）不再沾甜食，真聊甜品的照样认得', async () => {
  // 维度：甜食、吃饭、六句别的闲话各占一维。甜食这条兴趣本身就和「吃」沾边
  const v = (a: number, b: number, k = -1): number[] => [a, b, ...[0, 1, 2, 3, 4, 5].map(i => (i === k ? 1 : 0))]
  const vec: Record<string, number[]> = {
    '甜食：甜品': v(1, 0.6), '吃了吗': v(0.15, 1), '楼下新开了家甜品店': v(1, 0.2),
    '吃饭了没': v(0, 1), '中午吃什么好': v(0.1, 1), '饿了': v(0.05, 1),
    '好的': v(0, 0, 0), '晚安': v(0, 0, 1), '下班了': v(0, 0, 2), '我到家了': v(0, 0, 3), '收到': v(0, 0, 4), '出门了': v(0, 0, 5),
  }
  const items = [{ name: '甜食', keywords: ['甜品'], score: 1 }]
  const embed = async (t: string): Promise<number[]> => vec[t] ?? v(0, 0)
  const others = ['好的', '晚安', '下班了', '我到家了', '收到', '出门了']
  const eat = new Semantic({ embed }, () => ({ ...semCfg, threshold: 0.1, full: 0.5, background: ['吃饭了没', '中午吃什么好', '饿了', ...others] }))
  assert.deepEqual(await eat.near('吃了吗', items, 300), [], '它离吃饭那几句闲话最近：是闲话')
  assert.equal((await eat.near('楼下新开了家甜品店', items, 300))[0]?.name, '甜食')
  const noEat = new Semantic({ embed }, () => ({ ...semCfg, threshold: 0.1, full: 0.5, background: others }))
  assert.equal((await noEat.near('吃了吗', items, 300))[0]?.name, '甜食', '闲话里没有吃饭那类：只减兴趣那头的平时，压不住')
})

test('interests: 进向量前剥掉占位与转发壳，剥完不足 2 个字的直接 0、不去算', async () => {
  assert.equal(clean('[聊天记录：墨羽：[图片]；墨羽：[图片]；墨羽：[表情包：狗头]]'), '')
  assert.equal(clean('[回复 墨羽「哈哈哈」] 笑死'), '笑死')
  assert.equal(clean('@小林 你看这个 https://b23.tv/abc 猎鹰回收了'), '你看这个 猎鹰回收了')
  assert.equal(clean('[语音：猎鹰九号回收了]'), '猎鹰九号回收了', '语音转写是他说的话，留着')
  assert.equal(clean('[图片：一只橘猫趴在键盘上]哈'), '', '看图的描述不是他说的话；剩一个字当没说')
  assert.equal(clean('666 ！！'), '')
  assert.equal(clean('[表情] 草'), '')
  const calls: string[] = []
  const sem = new Semantic({ embed: fakeEmbed(calls) }, () => semCfg)
  assert.deepEqual(await sem.near('[聊天记录：墨羽：[图片]；墨羽：音乐好听]', fresh().active(T0), 300), [])
  assert.deepEqual(calls, [], '没正文的不去算向量')
})

test('interests: 预热——兴趣表这头先算好，之后每句只算它自己；没预热完时至少等 1 秒，不回 0', async () => {
  const s = fresh()
  const calls: string[] = []
  const quick = fakeEmbed(calls)
  const slow = new Semantic({ embed: async (t) => { await sleep(t.includes('：') ? 120 : 5); return quick(t) } }, () => semCfg)
  // 没预热：兴趣那头要 120 毫秒，限时 50 也等它（这次要连兴趣一起算）
  assert.equal((await slow.near('猎鹰九号那个回收你们看了吗', s.active(T0), 50))[0]?.name, '航天', '冷着时不按 50 毫秒回 0')
  const warmed = new Semantic({ embed: async (t) => { await sleep(t.includes('：') ? 120 : 5); return quick(t) } }, () => semCfg)
  await warmed.warm(s.active(T0))
  const n = calls.length
  assert.equal((await warmed.near('猎鹰九号那个回收你们看了吗', s.active(T0), 50))[0]?.name, '航天')
  assert.equal(calls.length, n + 1, '预热过：只算这句')
  // 表里新加一条：增量预热只算新的那条
  s.put({ ...s.get('猫', T0)!, name: '摄影', desc: '', keywords: [] })
  await warmed.warm(s.active(T0))
  assert.equal(calls.length, n + 2)
})

test('interests: 描述——人设种子带一句描述拼进向量文本；早先种下没描述的按同名种子补；新学来的用认话题时模型给的那句，之后不换', () => {
  assert.equal(itemText({ name: '航天', desc: '火箭发射与回收', keywords: ['火箭', '卫星'] }), '航天：火箭发射与回收。火箭、卫星')
  assert.equal(itemText({ name: '航天', keywords: ['火箭'] }), '航天：火箭')
  const s = fresh()
  assert.ok(s.get('航天', T0)!.desc, '种子带描述')
  s.change('航天', (it) => { it.desc = '' }, T0)
  s.change('猫', (it) => { it.desc = '我自己写的' }, T0)
  s.describe(defaults.seed)
  assert.equal(s.get('航天', T0)!.desc, defaults.seed.find(x => x.name === '航天')!.desc, '空的按种子补')
  assert.equal(s.get('猫', T0)!.desc, '我自己写的', '有的不盖')

  assert.equal(parse('{"topic":"摄影","desc":"拿相机拍照，聊镜头和构图","engaged":true,"stance":"none","keywords":[],"why":""}')?.desc, '拿相机拍照，聊镜头和构图')
  assert.equal(parse('{"topic":"","desc":"随便聊","engaged":true}')?.desc, '', '没话题就没描述')
  const r = { topic: '摄影', keywords: ['镜头'], engaged: true, stance: 'none' as const, why: '' }
  applyReading(s, learn, { ...r, desc: '拿相机拍照，聊镜头和构图' }, T0)
  applyReading(s, learn, { ...r, desc: '聊二手机身' }, T0 + 1000)
  assert.equal(s.get('摄影', T0 + 1000)!.desc, '拿相机拍照，聊镜头和构图', '第一次给的留着')
})

test('interests: 语义打分——端点失败 / 超时 / 还在加载都回 0 不抛；结果按文本缓存', async () => {
  const s = fresh()
  const errors: unknown[] = []
  const broken = new Semantic({ embed: async () => { throw new Error('连不上') } }, () => semCfg, e => errors.push(e))
  assert.deepEqual(await broken.near('猎鹰九号那个回收你们看了吗', s.active(T0), 300), [])
  assert.equal(errors.length, 1)

  const calls: string[] = []
  const quick = fakeEmbed(calls)
  const slow = new Semantic({ embed: async (t) => { await sleep(80); return quick(t) } }, () => semCfg)
  await slow.warm(s.active(T0)) // 兴趣表这头先算好：限时只等这句自己
  assert.deepEqual(await slow.near('猎鹰九号那个回收你们看了吗', s.active(T0), 20), [], '超时当 0')
  await sleep(150)
  assert.equal((await slow.near('猎鹰九号那个回收你们看了吗', s.active(T0), 20))[0]?.name, '航天', '超时那次算出来的进了缓存，下一次直接用')
  const n = calls.length
  await slow.near('猎鹰九号那个回收你们看了吗', s.active(T0), 300)
  assert.equal(calls.length, n, '重复的消息、没变的兴趣都不重算')
  s.change('航天', (it) => { it.keywords.push('猎鹰') }, T0)
  await slow.near('猎鹰九号那个回收你们看了吗', s.active(T0), 300)
  assert.equal(calls.length, n + 1, '兴趣改了关键词：只重算这一条')

  const loading = new Semantic({ embed: async () => { throw new Error('不该调') }, ready: () => false }, () => semCfg, e => errors.push(e))
  assert.deepEqual(await loading.near('猎鹰九号那个回收你们看了吗', s.active(T0), 300), [])
  assert.equal(errors.length, 1, '还在加载：直接 0，不去调')
})

test('interests: 模型打分（没有向量模型时的退路）——给兴趣名 + 相近度，乘兴趣分；认不出的名字、坏输出当 0', async () => {
  const s = fresh()
  const sem = new Semantic({ rate: async t => t.includes('猎鹰') ? parseRate('{"topic":"航天","near":0.8}') : parseRate('{"topic":"篮球","near":0.9}') }, () => semCfg)
  const r = await sem.near('猎鹰九号那个回收你们看了吗', s.active(T0), 300)
  assert.deepEqual(r, [{ name: '航天', near: 0.8, score: Math.round(0.8 * s.get('航天', T0)!.score * 1000) / 1000 }])
  assert.deepEqual(await sem.near('火箭队今晚比赛谁去看', s.active(T0), 300), [], '不是她的兴趣')
  assert.equal(parseRate('不是 JSON'), undefined)
  assert.deepEqual(parseRate('```json\n{"topic":"猫","near":"1.4"}\n```'), { topic: '猫', near: 1 })
  assert.ok(buildRatePrompt('沐沐', s.active(T0), 'x')[0].content.includes('航天（'))
})

test('interests: 衰减往 floor 回落，人设的淡不到 0', () => {
  assert.equal(decayed(0.8, 0, T0, T0 + 21 * DAY, 21), 0.4)
  const s = fresh()
  const later = s.get('音乐', T0 + 365 * DAY)!
  assert.ok(later.score >= defaults.personaFloor - 0.001 && later.score < 0.35, String(later.score))
})

test('interests: 投入地聊三次新话题才进表，之后打分明显高于无关话题', async () => {
  const s = fresh()
  const sem = new Semantic({ embed: fakeEmbed() }, () => semCfg)
  const r = { topic: '摄影', keywords: ['相机', '镜头', '拍照'], engaged: true, stance: 'none' as const, why: '她追问了镜头' }
  applyReading(s, learn, { ...r, keywords: [...r.keywords, '太阳'] }, T0) // 第一段混进来一个泛词
  applyReading(s, learn, r, T0 + 1000)
  assert.equal(s.get('摄影', T0 + 1000)?.state, 'candidate')
  assert.deepEqual(await sem.near('我新买了个二手机身准备去拍夜景', s.active(T0 + 1000), 300), [], '候选不参与打分')
  // 第三次模型换了个说法，按关键词认成同一个话题
  const c = applyReading(s, learn, { ...r, topic: '拍照', keywords: ['相机', '镜头', '夜景'] }, T0 + 2000)
  assert.equal(c?.name, '摄影')
  assert.equal(c?.state, 'on')
  const it = s.get('摄影', T0 + 2000)!
  assert.equal(it.source, 'self')
  assert.ok(it.keywords.includes('夜景'), '进表那一段的词留下')
  assert.ok(it.keywords.includes('拍照'), '两段都出现过的词留下')
  assert.ok(!it.keywords.includes('太阳'), '只在一段里出现过的泛词丢掉')
  assert.ok((await sem.near('我新买了个二手机身准备去拍夜景', s.active(T0 + 3000), 300))[0].score >= defaults.autoAdd.startScore)
  assert.deepEqual(await sem.near('今天地铁好挤', s.active(T0 + 3000), 300), [])
  // 进表以后再聊，不再吸模型给的泛词
  applyReading(s, learn, { ...r, keywords: ['相机', '图片'] }, T0 + 4000)
  assert.ok(!s.get('摄影', T0 + 4000)!.keywords.includes('图片'))
})

test('interests: 不投入、没话题不动表；说喜欢直接进表；说不感兴趣压到底', async () => {
  const s = fresh()
  assert.equal(applyReading(s, learn, { topic: '股票', keywords: [], engaged: false, stance: 'none', why: '' }, T0), undefined)
  assert.equal(applyReading(s, learn, { topic: '', keywords: [], engaged: true, stance: 'none', why: '' }, T0), undefined)
  assert.equal(s.get('股票', T0), undefined)
  const l = applyReading(s, learn, { topic: '天文', keywords: ['星空', '望远镜'], engaged: true, stance: 'like', why: '' }, T0)
  assert.equal(l?.state, 'on')
  assert.ok(s.get('天文', T0)!.score >= defaults.autoAdd.startScore)
  dislike(s, '猫', [], '她说不感兴趣', 'self', T0)
  const sem = new Semantic({ embed: fakeEmbed() }, () => semCfg)
  assert.deepEqual(await sem.near('猫', s.active(T0), 300), [], '压到底的不算相近')
  assert.equal(s.get('猫', T0)?.source, 'persona', '来源只在新建和用户改时写')
})

test('interests: 聊到了连着几次没接才降分；大脑标有意思加分；用户设分改来源', () => {
  const s = fresh()
  const before = s.get('甜食', T0)!.score
  for (let i = 0; i < defaults.ignoreAfter - 1; i++)
    assert.equal(applyMiss(s, learn, '甜食', T0), undefined)
  const c = applyMiss(s, learn, '甜食', T0)
  assert.ok(c && c.to! < before)
  const up = like(s, learn, '航天', ['火箭'], learn.step.action, '大脑标的', 'self', T0)
  assert.ok(up.to! > up.from!)
  setByUser(s, '新科技', 0.9, [], T0)
  assert.equal(s.get('新科技', T0)?.score, 0.9)
  assert.equal(s.get('新科技', T0)?.source, 'user')
})

test('interests: 自己学来的淡到 0、很久没提就忘掉；人设的不忘', () => {
  const s = fresh()
  applyReading(s, learn, { topic: '摄影', keywords: [], engaged: true, stance: 'none', why: '' }, T0)
  dislike(s, '音乐', [], '', 'self', T0)
  assert.deepEqual(s.sweep(T0 + 40 * DAY, 30), ['摄影'])
  assert.ok(s.get('音乐', T0 + 40 * DAY))
})

const watchCfg: WatchConfig = {
  settleSec: defaults.settleSec,
  minTurns: defaults.minTurns,
  missWindowSec: defaults.missWindowSec,
  positiveEmo: defaults.positiveEmo,
  questionWords: defaults.questionWords,
  words: [...defaults.likeWords, ...defaults.dislikeWords],
  keepLines: defaults.keepLines,
}

/** 小剧本：别人说、她说（可带表情）、大脑醒 */
function feed(w: Watcher) {
  let seq = 0
  let at = T0
  const ev = (type: string, data: unknown, after = 5000): LogEvent => ({ seq: seq++, at: (at += after), type, data } as LogEvent)
  return {
    get at() { return at },
    // names：这句提到的兴趣（插件里由语义打分认出、随事件传进来）
    other: (ch: string, text: string, names: string[] = []) => w.observe(ev('percept.received', { kind: 'message', channel: ch, sender: { id: 'u1', name: '小林' }, text }), names),
    her: (ch: string, text: string, emo?: string) => {
      const id = `u${seq}`
      w.observe(ev('utterance.started', { id, channel: ch }, 0))
      if (emo)
        w.observe(ev('utterance.part', { id, part: { kind: 'marker', data: { track: 'emo', value: emo } } }, 0))
      return w.observe(ev('utterance.settled', { id, channel: ch, delivered: text }, 1000))
    },
    // text：叫醒大脑的那句（原因里是感知原文）
    beat: (ch: string, text: string) => w.observe(ev('beat.opened', { reasons: [{ source: 'group.message', text, channel: ch }] }, 100)),
  }
}

test('interests: 她在一段里接了两轮 → 安静下来交一份 Job；只应了一句不交', () => {
  const w = new Watcher(() => watchCfg)
  const f = feed(w)
  f.other('c:a', '我最近在学摄影')
  f.her('c:a', '诶真的嘛')
  f.other('c:a', '买了个二手相机')
  f.her('c:a', '哪个牌子的')
  f.other('c:b', '在吗')
  f.her('c:b', '在')
  assert.equal(w.due(f.at).length, 0, '还没安静下来')
  const jobs = w.due(f.at + watchCfg.settleSec * 1000 + 1)
  assert.deepEqual(jobs.map(j => j.channel), ['c:a'])
  assert.equal(jobs[0].signals.turns, 2)
  assert.equal(jobs[0].lines[0].text, '我最近在学摄影', '带上她开口前别人起的话头')
  // 收过的段回放不再开（重载后接着攒）
  const again = new Watcher(() => watchCfg, w.seen(f.at))
  const g = feed(again)
  g.her('c:a', '哪个牌子的')
  assert.equal(again.open().length, 0)
})

test('interests: 一句话也算投入——追问、开心的表情、说喜欢', () => {
  const w = new Watcher(() => watchCfg)
  const f = feed(w)
  f.her('c:q', '那你拍过星空？')
  f.her('c:w', '多少钱收的呀，成色咋样') // 口语追问不打问号
  f.her('c:e', '哇', '好奇')
  f.her('c:l', '我也好喜欢这个')
  f.her('c:n', '嗯', '困')
  const jobs = w.flush()
  assert.deepEqual(jobs.map(j => j.channel).sort(), ['c:e', 'c:l', 'c:q', 'c:w'])
  assert.deepEqual(jobs.find(j => j.channel === 'c:e')?.signals.emo, ['好奇'])
})

test('interests: 聊到兴趣——大脑醒了她没接算没接；她接了 / 大脑没醒都不算', () => {
  const w = new Watcher(() => watchCfg)
  const f = feed(w)
  assert.deepEqual(f.other('g:1', '猎鹰九号又炸了', ['航天']), { channel: 'g:1', names: ['航天'] })
  f.beat('g:1', '猎鹰九号又炸了')
  f.other('g:2', '一级回收成功了', ['航天'])
  f.her('g:2', '好厉害')
  f.other('g:3', '下一次什么时候发射', ['航天']) // 大脑没醒：她没看到
  assert.equal(f.other('g:4', '火箭队今晚比赛'), undefined, '没认出提到兴趣的不记')
  assert.deepEqual(w.misses(f.at + watchCfg.missWindowSec * 1000 + 1), ['航天'])
  assert.deepEqual(w.misses(f.at + watchCfg.missWindowSec * 2000), [], '判过的不再判')
})

test('interests: 大脑是被同群别的话叫醒的，提到兴趣那句不算她看到了（真群 10-22：热闹的群里猫被一路扣到 0）', () => {
  const w = new Watcher(() => watchCfg)
  const f = feed(w)
  f.other('g:1', '我家猫又把杯子推下去了', ['猫'])
  f.other('g:1', '今晚吃啥')
  f.beat('g:1', '今晚吃啥') // 读空气掷中的是这句，不是说猫的那句
  assert.deepEqual(w.misses(f.at + watchCfg.missWindowSec * 1000 + 1), [], '没被那句叫醒：不算没接')
  f.other('g:2', '你们看今晚的星舰发射没', ['航天'])
  f.beat('g:2', '你刚才说话时 小林 又说的，你那段没看到：「你们看今晚的星舰发射没」') // 说完补判叫醒的，原话引在「」里
  assert.deepEqual(w.misses(f.at + watchCfg.missWindowSec * 1000 + 1), ['航天'])
})

test('interests: 没接扣分扣不穿人设的下限；在下限以下的不动、也不往上抬', () => {
  const s = fresh()
  const floor = s.get('猫', T0)!.floor
  assert.ok(floor > 0, '人设种的有下限')
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < defaults.ignoreAfter; i++) applyMiss(s, learn, '猫', T0)
  }
  assert.equal(s.get('猫', T0)?.score, floor, '扣到下限为止')
  dislike(s, '甜食', [], '', 'self', T0) // 说了不感兴趣：分压到 0.02、floor 归 0
  const low = s.get('甜食', T0)!.score
  for (let i = 0; i < defaults.ignoreAfter; i++) applyMiss(s, learn, '甜食', T0)
  assert.ok(s.get('甜食', T0)!.score <= low, '不会被没接抬上去')
})

test('interests: 模型输出解析、输入框解析', () => {
  assert.deepEqual(parse('好的\n```json\n{"topic":"摄影","engaged":true,"stance":"like","keywords":["相机","摄影",""],"why":"追问"}\n```'),
    { topic: '摄影', desc: '', keywords: ['相机'], engaged: true, stance: 'like', why: '追问' })
  assert.equal(parse('不是 JSON'), undefined)
  assert.equal(parse('{"topic":"x","stance":"讨厌"}')?.stance, 'none')
  assert.deepEqual(parseInput('摄影=0.6'), { name: '摄影', score: 0.6 })
  assert.deepEqual(parseInput('猫 80'), { name: '猫', score: 0.8 })
  assert.deepEqual(parseInput('Space X'), { name: 'Space X' })
  assert.equal(parseInput('  '), undefined)
})
