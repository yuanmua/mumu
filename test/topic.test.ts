import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { PolicyConfig } from '../plugins/official/group-policy/judge.ts'
import { judge } from '../plugins/official/group-policy/judge.ts'
import type { Entry } from '../plugins/official/group-policy/rooms.ts'
import { SELF } from '../plugins/official/group-policy/rooms.ts'
import type { Topic } from '../plugins/official/group-policy/topics.ts'
import { isCloser, Topics } from '../plugins/official/group-policy/topics.ts'

// 默认值就用清单里的：测的是出厂行为；时段系数去掉，免得跑测试的钟点影响概率
const defaults = JSON.parse(readFileSync(new URL('../plugins/official/group-policy/package.json', import.meta.url), 'utf8')).mumu.defaults as PolicyConfig
const cfg: PolicyConfig = { ...defaults, timeRules: [] }
// 测「收束句 / 没人接 / 换话题」这些收尾机制时，接轮数上限固定 3：不跟着出厂的安全上限（现在 5，曾经是 1）变
const mech: PolicyConfig = { ...cfg, topic: { ...cfg.topic, maxTurns: 3 } }
const G = 'qq:group:1'

/** 一个群的小剧本：按顺序喂话，她说的话走 onSelf，别人的话走 onOther 并打分 */
function room(c: PolicyConfig = cfg) {
  const events: { type: string, why?: string }[] = []
  const topics = new Topics(() => c.topic ?? {}, (type, t: Topic) => events.push({ type, why: t.why }))
  const list: Entry[] = []
  let at = 1_000_000
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  return {
    events,
    topics,
    /** 别人说一句，返回这句的打分 */
    other(who: string, text: string, opts: { direct?: boolean, after?: number } = {}) {
      at += opts.after ?? 5000
      const e: Entry = { at, who, name: who, text, direct: opts.direct }
      list.push(e)
      topics.onOther(G, e)
      return judge(c, e, list.slice(0, -1), { ...idle, topic: topics.view(G, e, at) })
    },
    /** 她说一句（回的是别人的最后一句） */
    self(text: string, after = 5000) {
      at += after
      const replyTo = list.findLast(x => x.who !== SELF)
      const e: Entry = { at, who: SELF, text }
      list.push(e)
      topics.onSelf(G, e, replyTo)
    },
    view: () => topics.view(G, undefined, at),
  }
}

test('话题：对方说「哈哈好」就收尾，之后话题里的人再说不接，别人换的新话题按普通意愿', () => {
  const r = room(mech)
  r.other('小林', '你们觉得周末去爬山怎么样？')
  r.self('爬山好啊，我想去看日出')
  assert.equal(r.view()?.status, 'open')
  const closer = r.other('小林', '哈哈好')
  assert.equal(r.view()?.status, 'closed')
  assert.match(r.view()?.why ?? '', /收尾了：「哈哈好」/)
  assert.ok(closer.p <= (cfg.topic?.afterClose ?? 0.03), `收束句本身不该叫醒她（p=${closer.p}）`)
  const sameGuy = r.other('小林', '我也想吃火锅')
  assert.ok(sameGuy.why.some(w => w.includes('话题已收尾')), sameGuy.why.join('、'))
  // 刚收尾的 cooldownSec 内，别人的新话题先缓一缓（× cooldownFactor）；过了就回到基础意愿
  const soon = r.other('阿哲', '今晚吃啥')
  assert.ok(Math.abs(soon.p - (cfg.base ?? 0.25) * (cfg.topic?.cooldownFactor ?? 0.3)) < 0.002, `刚收尾：${soon.p}（${soon.why.join('、')}）`)
  assert.ok(soon.why.some(w => w.includes('缓一会儿')))
  const later = r.other('阿哲', '楼下新开了家店', { after: ((cfg.topic?.cooldownSec ?? 60) + 5) * 1000 })
  assert.equal(later.p, cfg.base, `缓过之后新话题回到基础意愿（${later.why.join('、')}）`)
})

test('话题：她主动接满 maxTurns 轮就收尾，之后同一话题的追问（哪怕是问句）压到 afterClose', () => {
  const r = room()
  const max = cfg.topic?.maxTurns ?? 2
  r.other('老王', '有人懂相机吗？')
  for (let i = 0; i < max; i++) {
    assert.equal(r.view()?.status ?? 'open', 'open', `第 ${i + 1} 轮之前话题还开着`)
    r.self(`第 ${i + 1} 轮：相机入门先买套机`)
    if (i < max - 1)
      r.other('老王', '那相机镜头呢？')
  }
  assert.equal(r.view()?.status, 'closed')
  assert.match(r.view()?.why ?? '', new RegExp(`主动接了 ${max} 轮`))
  const ask = r.other('老王', '相机电池能用多久？')
  assert.ok(ask.p <= (cfg.topic?.afterClose ?? 0.03), `收尾后的追问 p=${ask.p}（${ask.why.join('、')}）`)
  assert.ok(ask.why.some(w => w.includes('话题已收尾')))
})

test('话题：回 @ 她的话不算主动接；被 @ 后答完开出新话题', () => {
  const r = room({ ...cfg, topic: { ...cfg.topic, maxTurns: 2 } })
  r.other('老王', '@沐沐 有人懂相机吗', { direct: true })
  r.self('懂一点，你想拍啥')
  assert.equal(r.view()?.turns, 0, '回 @ 的那句不计轮数')
  assert.equal(r.view()?.status, 'open')
  r.other('老王', '拍风景的相机呢？')
  r.self('风景的话广角镜头')
  r.other('老王', '广角镜头贵吗？')
  r.self('看牌子')
  assert.equal(r.view()?.status, 'closed', '主动接满两轮收尾')
  r.other('老王', '@沐沐 你倒是说说嘛', { direct: true })
  r.self('预算多少嘛')
  assert.equal(r.view()?.status, 'open', '@ 后答完是个新话题')
  assert.deepEqual(r.events.map(e => e.type), ['topic.opened', 'topic.closed', 'topic.opened'])
})

test('话题：她说完 replyWindowSec 内没人接就收尾', () => {
  const r = room(mech)
  r.other('七七', '有人看了昨晚的比赛吗')
  r.self('看了！最后那个球太绝了')
  const win = (cfg.topic?.replyWindowSec ?? 120) * 1000
  r.other('阿哲', '今天好冷', { after: win + 1000 })
  assert.equal(r.view()?.status, 'closed')
  assert.match(r.view()?.why ?? '', /没人接/)
})

test('话题：连续 switchAfter 句不相关就算换话题', () => {
  const r = room(mech)
  r.other('小林', '周末去爬山怎么样')
  r.self('爬山好啊')
  r.other('小林', '爬山要早起吗') // 参与者紧接着她的回话：还在聊
  const n = cfg.topic?.switchAfter ?? 3
  const unrelated = ['今晚吃啥', '火锅吧', '我想吃烧烤', '那就烧烤']
  for (let i = 0; i < n; i++)
    r.other(['阿哲', '糖糖', '七七', '老王'][i], unrelated[i])
  assert.equal(r.view()?.status, 'closed')
  assert.match(r.view()?.why ?? '', /换话题/)
})

test('收束句：整句或很短且由收尾字组成才算；正常的接话不算', () => {
  const c = cfg.topic ?? {}
  for (const s of ['哈哈好', '好的谢谢', '晚安~', '行吧行吧', '嗯嗯', 'ok'])
    assert.ok(isCloser(s, c), s)
  for (const s of ['好啊那周六见', '哈哈哈你也太逗了', '好吃吗', '行不行啊你'])
    assert.ok(!isCloser(s, c), s)
})
