/**
 * 兴趣表怎么变（纯函数套在 store 上，测试直接调）：
 *
 * | 来自 | 怎么变 |
 * |---|---|
 * | 她投入地聊了一段（模型判 engaged） | 表里有 → +step.engaged；候选 → 次数 +1，满 autoAdd.after 次进表（起步 autoAdd.startScore）；都没有 → 新候选 |
 * | 她说了喜欢（stance like） | 不等次数，直接进表，至少 startScore，再 +step.like |
 * | 她说了不感兴趣（stance dislike） | 分压到 0.02、floor 归 0（还留着这一条，记得她不喜欢）；没有就新建一条 0 分的 |
 * | 聊到了她没接，连续 ignoreAfter 次 | -step.ignored，扣不穿 floor（人设的爱好不因为群里没接就没了） |
 * | 大脑起 interest 动作 | like：同「说了喜欢」但加 step.action；dislike：同「不感兴趣」 |
 * | 用户在网页 / 命令里 | 直接设分、加、删；来源改成 user |
 * 来源只在新建和用户改时写：她自己聊涨了人设里的爱好，来源还是「人设」。
 */
import type { Interest, InterestStore, Source } from './store.ts'
import type { Reading } from './read.ts'

export interface LearnConfig {
  autoAdd: { after: number, startScore: number }
  step: { engaged: number, ignored: number, like: number, action: number }
  ignoreAfter: number
}

export interface Change { name: string, from?: number, to?: number, state?: string, why: string }

const mergeKw = (a: string[], b: string[], name: string): string[] => [...new Set([...a, ...b])].filter(k => k && k !== name).slice(0, 12)
/**
 * 关键词怎么来（模型每段给的词里总混着「图片」「眼睛」「太阳」这种到处都有的，吸多了无关的话也会被打成兴趣）：
 * - 候选阶段：每段给的词各记一票（votes），关键词先取并集——只用来认「下一段是不是同一个话题」，候选不参与打分；
 * - 进表那一刻：只留至少两段都出现过的词 + 进表这一段的词，票清掉（一段里混进来的泛词多半只出现一次）；
 * - 进表以后：不再从闲聊里吸词；大脑 / 用户明说的照收。
 */
function vote(it: Interest, keywords: string[]): void {
  for (const k of new Set(keywords)) it.votes[k] = (it.votes[k] ?? 0) + 1
  it.keywords = mergeKw(it.keywords, keywords, it.name)
}
function promote(it: Interest, keywords: string[]): void {
  it.keywords = mergeKw(Object.keys(it.votes).filter(k => it.votes[k] >= 2), keywords, it.name)
  it.votes = {}
  it.state = 'on'
}

/** 描述只在还没有时写：第一次认出这个话题的那段给的。之后每段的说法都不一样，跟着换的话这条兴趣的向量也跟着漂 */
function described(it: Interest, desc = ''): void {
  if (!it.desc && desc)
    it.desc = desc
}

function blank(name: string, keywords: string[], source: Source, now: number): Interest {
  return { name, desc: '', keywords: [], votes: {}, score: 0, floor: 0, source, state: 'candidate', hits: 0, misses: 0, lastAt: now, updatedAt: now, note: '', createdAt: now }
}

/** 喜欢：没有就新建，候选直接进表，至少 startScore 再加 bonus；explicit = 关键词是大脑明说的，照收 */
export function like(store: InterestStore, c: LearnConfig, name: string, keywords: string[], bonus: number, why: string, source: Source, now = Date.now(), explicit = false, desc = ''): Change {
  const found = store.find(name, keywords, now)
  const it = found ?? blank(name, keywords, source, now)
  const from = found?.state === 'on' ? found.score : undefined
  described(it, desc)
  if (it.state === 'candidate')
    promote(it, keywords)
  else if (explicit)
    it.keywords = mergeKw(it.keywords, keywords, it.name)
  it.score = Math.min(1, Math.max(it.score, c.autoAdd.startScore - bonus) + bonus)
  it.state = 'on'
  it.misses = 0
  it.lastAt = now
  it.updatedAt = now
  it.note = why
  store.put(it)
  return { name: it.name, from, to: store.get(it.name, now)?.score, state: 'on', why }
}

export function dislike(store: InterestStore, name: string, keywords: string[], why: string, source: Source, now = Date.now(), desc = ''): Change {
  const found = store.find(name, keywords, now)
  const it = found ?? blank(name, keywords, source, now)
  const from = found?.state === 'on' ? found.score : undefined
  described(it, desc)
  if (it.state === 'candidate')
    promote(it, keywords)
  it.score = 0.02
  it.floor = 0
  it.updatedAt = now
  it.note = why
  store.put(it)
  return { name: it.name, from, to: 0.02, state: 'on', why }
}

/** 一段读完：按表态 / 投入改表；没话题或不投入就不动 */
export function applyReading(store: InterestStore, c: LearnConfig, r: Reading, now = Date.now()): Change | undefined {
  if (!r.topic)
    return undefined
  const why = r.why || (r.engaged ? '投入地聊了一段' : '')
  if (r.stance === 'like')
    return like(store, c, r.topic, r.keywords, c.step.like, `她说喜欢：${why}`, 'self', now, false, r.desc)
  if (r.stance === 'dislike')
    return dislike(store, r.topic, r.keywords, `她说不感兴趣：${why}`, 'self', now, r.desc)
  if (!r.engaged)
    return undefined
  const found = store.find(r.topic, r.keywords, now)
  const it = found ?? blank(r.topic, r.keywords, 'self', now)
  const from = found?.score
  described(it, r.desc)
  if (it.state === 'candidate')
    vote(it, r.keywords)
  it.hits++
  it.misses = 0
  it.lastAt = now
  it.score = Math.min(1, it.score + c.step.engaged)
  it.note = why
  if (it.state === 'candidate' && it.hits >= c.autoAdd.after) {
    promote(it, r.keywords)
    it.score = Math.max(it.score, c.autoAdd.startScore)
    it.note = `投入地聊了 ${it.hits} 次，进表：${why}`
  }
  it.updatedAt = now
  store.put(it)
  return { name: it.name, from, to: store.get(it.name, now)?.score, state: it.state, why: it.note }
}

/** 聊到了没接：攒够 ignoreAfter 次降一档 */
export function applyMiss(store: InterestStore, c: LearnConfig, name: string, now = Date.now()): Change | undefined {
  const it = store.get(name, now)
  if (!it || it.state !== 'on')
    return undefined
  it.misses++
  if (it.misses < c.ignoreAfter) {
    store.put(it) // 只记次数；分值与 updatedAt 不动，衰减照旧
    return undefined
  }
  const from = it.score
  // 扣到 floor 为止（已经在 floor 以下的不动，也不往上抬）：原来 Math.max(0, …) 直接扣穿人设的下限——
  // 真群 10-22 猫从 0.65 扣到 0，只能等半衰期（以天计）慢慢回来，兴趣不再抬接话概率，她开口更少、更多「没接」（2026-10-23 真群回放）
  it.score = Math.max(Math.min(it.score, it.floor), it.score - c.step.ignored)
  it.misses = 0
  it.updatedAt = now
  it.note = `聊到了 ${c.ignoreAfter} 次都没接`
  store.put(it)
  return { name, from, to: store.get(name, now)?.score, why: it.note }
}

/** 用户直接设分（0～1）；没有就新建。来源改成 user */
export function setByUser(store: InterestStore, name: string, score: number, keywords: string[] = [], now = Date.now()): Change {
  const old = store.get(name, now)
  const it = old ?? blank(name, keywords, 'user', now)
  if (it.state === 'candidate')
    promote(it, keywords)
  it.keywords = mergeKw(it.keywords, keywords, name)
  it.score = Math.max(0, Math.min(1, score))
  it.source = 'user'
  it.misses = 0
  it.updatedAt = now
  it.note = '用户改的'
  store.put(it)
  return { name, from: old?.score, to: it.score, state: 'on', why: '用户改的' }
}
