/**
 * 召回：她开口前，按「这次在哪、对谁说、在聊什么」从记忆里取几条，带来源。
 *
 * 规则（README「群里的私事不往别处说」）：
 * - 一对一（网页、私聊）：这个人的一切都能想起，别处来的标明来源。
 * - 群 X：人的印象 + 只有来源是群 X 的事实与摘要 + 群 X 的印象。
 * 打分不上向量：双字词重合 + 新近程度。没整理成摘要的上一个对话，带最后几句原话（新对话开头「上次聊到」）。
 */
import type { HistoryTurn } from '../../../src/index.ts'
import type { Collector } from './collect.ts'
import { SELF } from './collect.ts'
import type { Episode, MemoryStore, Person } from './store.ts'

export interface RecallConfig {
  recallChars: number
  recallEpisodes: number
  recallPeople: number // 最多想起几个人：窗口里说过话的（最后说话的在前）+ 话里提到的
  timeZone: string
}

export interface RecallInput {
  channel: string
  history: HistoryTurn[]
  label: (channel: string) => string // 「群 123」「私聊」「网页对话」
}

export function recall(store: MemoryStore, collector: Collector, cfg: RecallConfig, input: RecallInput): string | undefined {
  const { channel, history } = input
  const group = collector.isGroup(channel)
  const now = Date.now()
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: cfg.timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

  // 这次在跟谁说：窗口里说过话的人都想一想（最后说话的排第一）——群里热闹时她要回的人未必在最后几句里，
  // 原来只看最后 8 句、3 个人，阅读窗口里更早那几个人她就「不认识」了
  const ids: string[] = []
  for (const t of [...history].reverse()) {
    if (t.role !== 'other' || !t.sender)
      continue
    const id = collector.personOf(t.sender, channel).id
    if (!ids.includes(id))
      ids.push(id)
    if (ids.length >= cfg.recallPeople)
      break
  }
  // 话里提到了谁（「老王是干啥的」）：也想起这个人。名字至少两个字，免得单字误认
  const recentText = history.slice(-3).filter(t => t.role === 'other').map(t => t.text).join(' ')
  for (const k of store.knownNames()) {
    if (ids.length >= cfg.recallPeople + 2)
      break
    if (!ids.includes(k.id) && k.names.some(n => n.length >= 2 && recentText.includes(n)))
      ids.push(k.id)
  }
  const people = ids.map(id => store.person(id)).filter((p): p is Person => !!p && p.interacted && !!(p.impression || p.privateImpression || p.facts.length))
  // 可见性：群里只见本群来源；一对一里，对方本人的事全可见，提到的别人只见群里公开说过的（别人的私聊永远不见）
  const me = group ? undefined : ids[0]
  const factVisible = (owner: string, ch: string): boolean =>
    group ? ch === channel : owner === me || collector.isGroup(ch)
  const episodeVisible = (e: Episode): boolean =>
    e.channel === channel || (!group && !!me && e.people.includes(me))
  const src = (ch: string): string => ch === channel ? '' : `（${input.label(ch)}）`

  const lines: string[] = []
  for (const p of people) {
    const facts = p.facts.filter(f => factVisible(p.id, f.channel)).slice(-5).map(f => `${f.text}${src(f.channel)}`)
    // 私下印象只在跟本人一对一时想起
    const imp = [p.impression, p.id === me ? p.privateImpression : ''].filter(Boolean).join('；')
    lines.push(`- ${p.name}：${imp || '还不太熟'}${facts.length ? `\n  记得：${facts.join('；')}` : ''}`)
  }

  // 摘要：本会话里比当前窗口更早的 + 对方参与过的（按来源过滤）+ 按话题打分
  const oldest = history[0]?.at ?? now
  const query = history.slice(-4).map(t => t.text).join(' ')
  const pool = new Map<number, Episode>()
  for (const e of store.episodesOf(channel, 6)) {
    if (e.toAt <= oldest)
      pool.set(e.id, e)
  }
  for (const id of ids.slice(0, 2)) {
    for (const e of store.episodesWith(id, 12)) {
      if (episodeVisible(e) && !(e.channel === channel && e.toAt > oldest))
        pool.set(e.id, e)
    }
  }
  const ranked = [...pool.values()]
    .map(e => ({ e, score: overlap(query, `${e.summary} ${e.cues.join(' ')}`) + (e.channel === channel ? 2 : 0) + recency(now - e.toAt) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.recallEpisodes)
    .sort((a, b) => a.e.toAt - b.e.toAt)
  const eps = ranked.map(({ e }) => `- ${fmt.format(e.toAt)}${src(e.channel)}：${e.summary}`)

  // 新开的一对一对话：上一个对话还没压成摘要的，带最后几句原话
  const tail: string[] = []
  if (!group && history.length <= 4 && ids[0]) {
    const t = collector.tailWith(ids[0], channel, 4)
    if (t.length)
      tail.push(`上次在${input.label(t[0].channel)}里最后聊到：${t.map(x => `${x.who === SELF ? '你' : x.name}「${x.text.slice(0, 40)}」`).join(' ')}`)
  }

  const groupImp = group ? store.groupImpression(channel) : ''
  const parts: string[] = []
  if (groupImp)
    parts.push(`这个群：${groupImp}`)
  if (lines.length)
    parts.push(`你对他们的印象：\n${lines.join('\n')}`)
  if (eps.length)
    parts.push(`之前聊过的：\n${eps.join('\n')}`)
  if (tail.length)
    parts.push(tail.join('\n'))
  if (!parts.length)
    return undefined
  const body = clip(parts.join('\n'), cfg.recallChars)
  const rule = group ? '（括号里是来源：别的群、私聊里的事别在这里说出来。）' : '（括号里是来源，别处的事自己心里有数就行，用得上再提。）'
  return `【你记得的】${rule}\n${body}`
}

/**
 * 给大脑的一句话印象：唤醒原因里的人 + 对话窗口里在说话的人（channelOf 记着各自在哪个频道），
 * 再带两条这里能说的事——群里只带本群来源的（别处的私事不进群；这拍里只要有群，一对一的人也不带事实，大脑一块材料是全局的）
 */
export function briefOf(store: MemoryStore, ids: string[], group: (ch: string) => boolean, channelOf: Map<string, string>): string | undefined {
  const lines: string[] = []
  const anyGroup = [...channelOf.values()].some(group)
  for (const id of ids) {
    const p = store.person(id)
    if (!p?.interacted)
      continue
    const ch = channelOf.get(id)
    const facts = ch && group(ch)
      ? p.facts.filter(f => f.channel === ch).slice(-2)
      : anyGroup ? [] : p.facts.slice(-2)
    if (!p.impression && !facts.length)
      continue
    lines.push(`- ${p.name}：${p.impression || '还不太熟'}${facts.length ? `（记得：${facts.map(f => f.text).join('；')}）` : ''}`)
  }
  const groups = [...new Set(channelOf.values())].filter(group)
  for (const ch of groups) {
    const g = store.groupImpression(ch)
    if (g)
      lines.push(`- [${ch}]：${g}`)
  }
  return lines.length ? `【你对他们的印象】\n${lines.join('\n')}` : undefined
}

function recency(ms: number): number {
  const days = ms / 86_400_000
  return days < 1 ? 1.5 : days < 7 ? 0.8 : 0.2
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 两段文字共有的双字词个数（汉字、字母、数字） */
export function overlap(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/[^\p{L}\p{N}]/gu, '')
    const out = new Set<string>()
    for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
    return out
  }
  const x = grams(a)
  let n = 0
  for (const g of grams(b)) {
    if (x.has(g))
      n++
  }
  return n
}
