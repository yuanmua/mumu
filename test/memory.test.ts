import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { HistoryTurn, LogEvent, Sender } from '../src/index.ts'
import { Collector } from '../plugins/official/memory/collect.ts'
import { briefOf, recall } from '../plugins/official/memory/recall.ts'
import { MemoryStore } from '../plugins/official/memory/store.ts'
import { parse } from '../plugins/official/memory/summarize.ts'

const isGroup = (ch: string): boolean => ch.startsWith('qq:group:')
const personOf = (s: Sender, ch: string): { id: string, name: string } =>
  ({ id: `${ch.startsWith('qq:') ? 'qq' : 'web'}:${s.id}`, name: s.name ?? s.id })
const label = (ch: string): string => isGroup(ch) ? `群 ${ch.split(':').pop()}` : ch.includes(':private:') ? '私聊' : '网页对话'

function setup() {
  const store = new MemoryStore(new DatabaseSync(':memory:'))
  const c = new Collector(store, { chunk: 30, groupChunk: 60, minTurns: 6, idleSec: 300 }, personOf, isGroup)
  let seq = 0
  const ev = (type: string, data: Record<string, unknown>, at = Date.now()): LogEvent => ({ seq: ++seq, at, type, data })
  return { store, c, ev }
}

const turn = (role: 'self' | 'other', text: string, channel: string, sender?: Sender): HistoryTurn =>
  ({ role, text, at: Date.now(), channel, kind: role === 'self' ? 'utterance' : 'message', sender })
const OPTS = { recallChars: 700, recallEpisodes: 3, recallPeople: 8, timeZone: 'Asia/Shanghai' }

test('记忆：群里只给跟她打过交道的人建档（@ 她的、她接话的人），路人只记名字', () => {
  const { store, c, ev } = setup()
  const g = 'qq:group:1'
  c.observe(ev('percept.received', { kind: 'group.message', channel: g, sender: { id: '1', name: '路人' }, text: '今天好热' }))
  c.observe(ev('percept.received', { kind: 'message', channel: g, sender: { id: '2', name: '小林' }, text: '@沐沐 在吗' }))
  c.observe(ev('percept.received', { kind: 'group.message', channel: g, sender: { id: '3', name: '糖糖' }, text: '我也想问' }))
  c.observe(ev('utterance.settled', { channel: g, delivered: '在呀' }))
  assert.equal(store.person('qq:1')?.interacted, false)
  assert.equal(store.person('qq:2')?.interacted, true, '@ 她的')
  assert.equal(store.person('qq:3')?.interacted, true, '她开口前最后说话的')
  assert.deepEqual(c.take(g).engaged.sort(), ['qq:2', 'qq:3'])
})

test('记忆召回：群里的私事不往别的群说，一对一里都能想起并标来源', () => {
  const { store } = setup()
  const c = new Collector(store, { chunk: 30, groupChunk: 60, minTurns: 6, idleSec: 300 }, personOf, isGroup)
  store.seen('qq:2', '小林', 'qq:group:1', 1, true)
  store.update('qq:2', '爱吃火锅的程序员', [
    { text: '小林下周三去成都出差', channel: 'qq:group:1', at: 1 },
    { text: '小林失恋了', channel: 'qq:private:2', at: 2 },
  ], 20)
  const inGroup2 = recall(store, c, OPTS, {
    channel: 'qq:group:9',
    history: [turn('other', '沐沐在吗', 'qq:group:9', { id: '2', name: '小林' })],
    label,
  }) ?? ''
  assert.match(inGroup2, /爱吃火锅的程序员/, '印象跨群可见')
  assert.doesNotMatch(inGroup2, /成都|失恋/, '别的群和私聊里的事不出现')

  const inGroup1 = recall(store, c, OPTS, {
    channel: 'qq:group:1',
    history: [turn('other', '沐沐在吗', 'qq:group:1', { id: '2', name: '小林' })],
    label,
  }) ?? ''
  assert.match(inGroup1, /成都/, '本群的事能想起')
  assert.doesNotMatch(inGroup1, /失恋/, '私聊的事不在群里出现')

  const inPrivate = recall(store, c, OPTS, {
    channel: 'qq:private:2',
    history: [turn('other', '在吗', 'qq:private:2', { id: '2', name: '小林' })],
    label,
  }) ?? ''
  assert.match(inPrivate, /成都.*（群 1）/, '一对一里别处的事标来源')
  assert.match(inPrivate, /失恋/)
})

test('记忆召回：私聊里提到别人，只想起那人的印象和群里公开说过的事，不想起那人的私聊', () => {
  const { store } = setup()
  const c = new Collector(store, { chunk: 30, groupChunk: 60, minTurns: 6, idleSec: 300 }, personOf, isGroup)
  store.seen('qq:5', '七七', 'qq:private:5', 1, true)
  store.update('qq:5', '刚毕业在找工作', [
    { text: '七七明天面试字节', channel: 'qq:private:5', at: 1 },
    { text: '七七养了一盆多肉', channel: 'qq:group:1', at: 2 },
  ], 20)
  const text = recall(store, c, OPTS, {
    channel: 'qq:private:2',
    history: [turn('other', '七七最近在忙啥', 'qq:private:2', { id: '2', name: '阿哲' })],
    label,
  }) ?? ''
  assert.match(text, /刚毕业在找工作/)
  assert.match(text, /多肉/, '群里公开说的可以')
  assert.doesNotMatch(text, /面试|字节/, '七七私聊里说的不给阿哲')
})

test('记忆：私下印象（一对一里形成的）只在跟本人一对一时想起，群里只见公开印象', () => {
  const { store } = setup()
  const c = new Collector(store, { chunk: 30, groupChunk: 60, minTurns: 6, idleSec: 300 }, personOf, isGroup)
  store.seen('qq:5', '七七', 'qq:private:5', 1, true)
  store.update('qq:5', '爱聊动漫', [], 20, false)
  store.update('qq:5', '最近在准备面试，有点焦虑', [], 20, true)
  const opts = OPTS
  const inGroup = recall(store, c, opts, { channel: 'qq:group:1', history: [turn('other', '在吗', 'qq:group:1', { id: '5', name: '七七' })], label }) ?? ''
  assert.match(inGroup, /爱聊动漫/)
  assert.doesNotMatch(inGroup, /面试/)
  const alone = recall(store, c, opts, { channel: 'qq:private:5', history: [turn('other', '在吗', 'qq:private:5', { id: '5', name: '七七' })], label }) ?? ''
  assert.match(alone, /爱聊动漫.*面试/)
  const other = recall(store, c, opts, { channel: 'qq:private:2', history: [turn('other', '七七呢', 'qq:private:2', { id: '2', name: '阿哲' })], label }) ?? ''
  assert.doesNotMatch(other, /面试/, '别人私聊里提到她也看不到')
})

test('记忆召回：新开的网页对话带上一个对话还没整理的最后几句', () => {
  const { store, c, ev } = setup()
  c.observe(ev('percept.received', { kind: 'message', channel: 'c:old', sender: { id: 'web-user' }, text: '我在学吉他，手指好疼' }))
  c.observe(ev('utterance.settled', { channel: 'c:old', delivered: '刚开始都这样' }))
  const text = recall(store, c, OPTS, {
    channel: 'c:new',
    history: [turn('other', '嗨', 'c:new', { id: 'web-user' })],
    label,
  }) ?? ''
  assert.match(text, /上次在网页对话里最后聊到.*吉他/)
})

test('记忆召回：阅读窗口里说过话的人都想起来，不只最后几句里的那三个；最后说话的排前面', () => {
  const { store } = setup()
  const c = new Collector(store, { chunk: 30, groupChunk: 60, minTurns: 6, idleSec: 300 }, personOf, isGroup)
  const g = 'qq:group:1'
  for (const [id, name, imp] of [['2', '小林', '爱吃火锅'], ['3', '阿哲', '下周三去成都出差'], ['4', '糖糖', '刚换了工作'], ['5', '老王', '群里的老好人']]) {
    store.seen(`qq:${id}`, name, g, 1, true)
    store.update(`qq:${id}`, imp, [], 20)
  }
  // 阿哲在窗口开头说了一句，后面十几句都是别人
  const history = [
    turn('other', '我下周三去成都出差', g, { id: '3', name: '阿哲' }),
    ...Array.from({ length: 12 }, (_, i) => turn('other', `闲聊 ${i}`, g, i % 2 ? { id: '2', name: '小林' } : { id: '4', name: '糖糖' })),
    turn('other', '@沐沐 还记得我去哪吗', g, { id: '3', name: '阿哲' }),
  ]
  const text = recall(store, c, OPTS, { channel: g, history, label }) ?? ''
  assert.match(text, /阿哲：下周三去成都出差/)
  assert.match(text, /小林：爱吃火锅/)
  assert.match(text, /糖糖：刚换了工作/)
  assert.doesNotMatch(text, /老王/, '没在窗口里说话、也没被提到的人不想')
  assert.ok(text.indexOf('阿哲') < text.indexOf('糖糖'), '最后说话的排前面')
  const few = recall(store, c, { ...OPTS, recallPeople: 1 }, { channel: g, history, label }) ?? ''
  assert.match(few, /阿哲/)
  assert.doesNotMatch(few, /小林|糖糖/, 'recallPeople 限人数')
})

test('给大脑的印象：带两条本群来源的事实，别处的不进群；没印象只有事实的人也列', () => {
  const { store } = setup()
  store.seen('qq:2', '小林', 'qq:group:1', 1, true)
  store.update('qq:2', '爱吃火锅的程序员', [
    { text: '小林下周三去成都出差', channel: 'qq:group:1', at: 1 },
    { text: '小林失恋了', channel: 'qq:private:2', at: 2 },
    { text: '小林在学吉他', channel: 'qq:group:1', at: 3 },
  ], 20)
  store.seen('qq:3', '阿哲', 'qq:group:1', 1, true)
  store.update('qq:3', '', [{ text: '阿哲养了只猫', channel: 'qq:group:1', at: 1 }], 20)
  const inGroup = briefOf(store, ['qq:2', 'qq:3'], isGroup, new Map([['qq:2', 'qq:group:1'], ['qq:3', 'qq:group:1']])) ?? ''
  assert.match(inGroup, /小林：爱吃火锅的程序员（记得：小林下周三去成都出差；小林在学吉他）/)
  assert.doesNotMatch(inGroup, /失恋/, '私聊的事不进群')
  assert.match(inGroup, /阿哲：还不太熟（记得：阿哲养了只猫）/)
  const alone = briefOf(store, ['qq:2'], isGroup, new Map([['qq:2', 'qq:private:2']])) ?? ''
  assert.match(alone, /失恋/, '一对一里本人的事都能想起')
})

test('摘要解析：容忍外层文字，缺 summary 视为失败，字段类型不对就丢掉', () => {
  const d = parse('好的：\n{"summary":"小林说要去成都","recall_cues":["出差",1],"people":[{"id":"qq:2","impression":"程序员","facts":["小林去成都"]},{"x":1}],"group":"火锅群"}')
  assert.deepEqual(d, { summary: '小林说要去成都', cues: ['出差'], people: [{ id: 'qq:2', impression: '程序员', facts: ['小林去成都'] }], group: '火锅群' })
  assert.equal(parse('{"summary":""}'), undefined)
  assert.equal(parse('不是 JSON'), undefined)
})
