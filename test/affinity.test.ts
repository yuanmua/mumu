import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEvent } from '../src/index.ts'
import { Affinity, moodFactor } from '../plugins/official/group-policy/affinity.ts'
import type { PolicyConfig } from '../plugins/official/group-policy/judge.ts'
import { atChance, judge } from '../plugins/official/group-policy/judge.ts'
import { feelOf, parseRate } from '../plugins/official/group-policy/rates.ts'
import { SELF as SELF_ID } from '../plugins/official/group-policy/rooms.ts'
import { Topics } from '../plugins/official/group-policy/topics.ts'

const defaults = JSON.parse(readFileSync(new URL('../plugins/official/group-policy/package.json', import.meta.url), 'utf8')).mumu.defaults as PolicyConfig
const cfg: PolicyConfig = { ...defaults, timeRules: [] }
const G = 'qq:group:1'
const isGroup = (ch: string): boolean => ch.startsWith('qq:group:')

function feed() {
  const a = new Affinity(() => cfg.affinity ?? {}, isGroup)
  let seq = 0
  let at = 1_000_000
  const ev = (type: string, data: Record<string, unknown>, after = 5000): void => {
    at += after
    a.observe({ seq: ++seq, at, type, data } as LogEvent)
  }
  return {
    a,
    now: () => at,
    self: (text: string, after?: number) => ev('utterance.settled', { channel: G, delivered: text }, after),
    other: (text: string, kind = 'group.message', after?: number) => ev('percept.received', { channel: G, kind, sender: { id: '7', name: '小林' }, text }, after),
  }
}

test('好感：说话被接住、被 @ 往上；说完没人接、被怼往下；有界', () => {
  const up = feed()
  for (let i = 0; i < 5; i++) {
    up.self('今天吃火锅吗')
    up.other('吃！') // 窗口内有人接
    up.other('@沐沐 你也来', 'message')
  }
  const liked = up.a.get(G, up.now())
  assert.ok(liked.value > 1.2, `被接住 + 被 @ 五轮后好感 ${liked.value}`)
  assert.match(liked.why, /被接住 5 次/)

  const down = feed()
  for (let i = 0; i < 5; i++) {
    down.self('有人在吗')
    down.other('沐沐你就是个人机', 'message', 200_000) // 说完很久才有人说话（没接住）+ 被怼
  }
  const hated = down.a.get(G, down.now())
  assert.ok(hated.value < 0.6, `冷场 + 被怼五轮后好感 ${hated.value}`)
  assert.ok(hated.value >= (cfg.affinity?.min ?? 0.3), '不低于下限')
  assert.match(hated.why, /被怼 5 次/)
})

test('好感：没事时按半衰期回到中性', () => {
  const f = feed()
  for (let i = 0; i < 6; i++) {
    f.self('有人在吗')
    f.other('沐沐闭嘴', 'message', 200_000)
  }
  const low = f.a.get(G, f.now()).value
  const half = (cfg.affinity?.halfLifeDays ?? 3) * 86_400_000
  const later = f.a.get(G, f.now() + half).value
  assert.ok(Math.abs((1 - later) - (1 - low) / 2) < 0.02, `一个半衰期后离中性的距离减半：${low} → ${later}`)
})

test('心情系数：平时 = 1，开心多说、低落少说，有界', () => {
  const m = cfg.mood ?? {}
  assert.equal(moodFactor({ valence: m.baseValence ?? 0.25, arousal: m.baseArousal ?? 0.45 }, m), 1)
  assert.ok(moodFactor({ valence: 0.9, arousal: 0.8 }, m) > 1.2)
  assert.ok(moodFactor({ valence: -0.8, arousal: 0.2 }, m) < 0.6 + 1e-9)
  assert.equal(moodFactor(undefined, m), 1, '没装 emotion 当 1')
})

test('群倍率：词与数都认；0 = 只在被 @ 时答，judge 直接不唤醒；好感、倍率都乘进概率', () => {
  assert.equal(parseRate('quiet', 1), 0)
  assert.equal(parseRate('只回@', 1), 0)
  assert.equal(parseRate('less', 1), 0.5)
  assert.equal(parseRate('more', 1), 1.5)
  assert.equal(parseRate('normal', 0.2), 1)
  assert.equal(parseRate('9', 1), 3, '夹到上限')
  assert.equal(parseRate('随便', 1), undefined)

  const cur = { at: 2_000_000, who: '7', name: '小林', text: '今天好热' }
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const plain = judge(cfg, cur, [], { ...idle })
  const muted = judge(cfg, cur, [], { ...idle, rate: 0 })
  assert.equal(muted.p, 0)
  assert.match(muted.why[0], /倍率 0/)
  const disliked = judge(cfg, cur, [], { ...idle, affinity: 0.5, rate: 0.5 })
  assert.ok(Math.abs(disliked.p - plain.p * 0.25) < 0.002, `${plain.p} × 0.5 × 0.5 ≈ ${disliked.p}`)
  assert.equal(disliked.factors.affinity, 0.5)
  assert.equal(disliked.factors.rate, 0.5)
})

test('每分钟开口上限默认关：开口再多也不因它挡', () => {
  const cur = { at: 2_000_000, who: '7', text: '有人吗？' }
  const v = judge(cfg, cur, [], { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 9 })
  assert.ok(v.p > 0, v.why.join('、'))
})

test('兴趣：是她喜欢的话题就乘上去（× (1 + k × 感兴趣程度)，没 @ 的封在 capNonDirect）；兴趣话题能多接几轮', () => {
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  // 一秒前有人说过话：不算冷场后第一句（那项 0.8 会盖住兴趣）
  const before = [{ at: 1_999_000, who: '8', text: '嗯' }]
  const cur = { at: 2_000_000, who: '7', text: '我家主子今天又把杯子推下桌了' }
  const boring = judge(cfg, cur, before, { ...idle })
  const cats = judge(cfg, cur, before, { ...idle, interest: { word: '猫', near: 0.8, score: 0.52 } })
  const k = cfg.interest?.k ?? 1.5
  assert.equal(cats.factors.interest, Math.round((1 + k * 0.52) * 100) / 100)
  assert.ok(Math.abs(cats.p - boring.p * cats.factors.interest) < 0.002, `是乘法，不是抬到某个值：${cats.p} ≈ ${boring.p} × ${cats.factors.interest}`)
  assert.ok(cats.why.some(w => w.includes('感兴趣的（猫，相近 0.8）×')), cats.why.join('、'))
  assert.equal(boring.factors.interest, undefined, '不相近：不乘')
  // 灌水压低的照样低：兴趣只乘，不托底
  const six = judge(cfg, { ...cur, text: '6' }, before, { ...idle, interest: { word: '猫', near: 1, score: 1 } })
  assert.ok(six.p < 0.05, `灌水 × 兴趣 ${six.p}`)
  // 乘出来不到 1：有人在问 + 满分兴趣 + 系数调大，没 @ 她的话封在 capNonDirect（p=1 只留给被叫到）
  const big = judge({ ...cfg, interest: { k: 4 }, question: 0.6 }, { ...cur, text: '猫为什么老推杯子？' }, before, { ...idle, interest: { word: '猫', near: 1, score: 1 } })
  assert.equal(big.p, cfg.capNonDirect ?? 0.9)
  assert.ok(big.factors.attraction <= 1, String(big.factors.attraction))
  assert.equal(judge({ ...cfg, capNonDirect: 0.7, interest: { k: 4 }, question: 0.6 }, { ...cur, text: '猫为什么老推杯子？' }, before, { ...idle, interest: { word: '猫', near: 1, score: 1 } }).p, 0.7, '封顶可调')

  const t = new Topics(() => cfg.topic ?? {}, () => {}, text => text.includes('火箭'))
  const G2 = 'qq:group:2'
  let at = 1_000_000
  const other = (text: string) => t.onOther(G2, { at: (at += 5000), who: '7', name: '小林', text })
  const self = (text: string) => t.onSelf(G2, { at: (at += 5000), who: SELF_ID, text }, { at, who: '7', text: '' })
  other('你们看昨晚的火箭发射了吗')
  const max = cfg.topic?.interestMaxTurns ?? 8
  assert.ok(max > (cfg.topic?.maxTurns ?? 5), '兴趣话题的上限比普通话题高')
  for (let i = 0; i < max - 1; i++) {
    self(`看了，火箭好帅 ${i}`)
    other('火箭回收那段太稳了')
  }
  assert.equal(t.view(G2, undefined, at)?.status, 'open', `兴趣话题接了 ${max - 1} 轮还开着`)
  self('火箭真的太酷了')
  assert.equal(t.view(G2, undefined, at)?.status, 'closed', `接满 ${cfg.topic?.interestMaxTurns} 轮收尾`)
})

test('@ 不是 100% 必答：平时约 0.95，烦的群 + 心情差打折；想聊 / 懒得理分得开', () => {
  assert.ok(atChance(cfg, 1, 1) >= 0.94)
  assert.ok(atChance(cfg, 0.4, 0.65) < 0.3, `烦 + 心情差：${atChance(cfg, 0.4, 0.65)}`)
  assert.equal(atChance(cfg, 1.6, 1.3), 1, '喜欢 + 心情好：必接')
  assert.equal(atChance({ ...cfg, at: { base: 0.95, sensitivity: 0 } }, 0.3, 0.6), 0.95, '敏感度 0 = 不受影响')
  // 基础意愿跟着出厂值走（2026-10-22 从 0.25 调到 0.1，分界线按比例一起降）
  const base = cfg.base ?? 0.1
  const w = (rate: number, affinity: number, mood: number) => ({ channel: G, base, talkValue: 1, rate, affinity, affinityWhy: '被怼 3 次', mood, time: 1, willing: base * rate * affinity * mood })
  assert.equal(feelOf(w(1, 0.4, 0.65), cfg.feel ?? {}).level, '懒得理')
  assert.equal(feelOf(w(1, 1.5, 1.2), cfg.feel ?? {}).level, '想聊')
  assert.ok(feelOf(w(1, 0.4, 0.65), cfg.feel ?? {}).reasons.some(r => r.includes('被怼')))
})
