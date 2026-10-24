/**
 * 真实群记录回放的报告（replay-real.ts 用）：从克隆实例的库里按 seq 段取这个回放群的事件，算数、逐条列她的开口，并和当天线上对照。
 * 只读库。数的口径：
 * - 别人消息：percept.received（group.message / message）；她开口：utterance.settled 有字的（发图 / 表情包另计）
 * - 叫醒：group.policy wake（含 @ 她、机器人 @ 她）+ convo.pending wake（说完补判）；理由按 why 归类（cat）
 * - 她在回谁：开口那拍大脑的原因（mind.decision.reasons 的 sender；没有就按原因文字对回感知）
 * - 追着说：她连着对同一个人开口、中间这人没回她（@ / 引用 / 叫名字她，或这人的话和她那句有两个以上共有的双字词），隔 5 分钟算断
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

export interface CorpusRow {
  t: 'msg' | 'poke' | 'recall' | 'her' | 'policy' | 'pending' | 'decision'
  seq: number
  at: number
  who: string
  name: string
  text: string
  kind?: string
  bot?: boolean
  mentioned?: boolean
  replyTo?: string
  messageId?: string
  role?: string
  p?: number
  wake?: boolean
  why?: string[]
  convo?: boolean
  task?: boolean
  atHer?: boolean
}

interface Ev { seq: number, at: number, type: string, data: Record<string, any> }

const OWNERS = ['10001'] // 克隆库 guard.owners / group-policy.owners

export const localTime = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(0, 5)

/** why → 叫醒理由类别（先认硬入口，再认分支） */
export function cat(why: string[]): string {
  const s = why.join('；')
  const rules: [RegExp, string][] = [
    [/主人点名/, '主人点名机器人'],
    [/它 @ 了你/, '机器人 @ 她'],
    [/被 @ |叫名字/, '@ / 叫她'],
    [/像是要她做事/, '做事直通'],
    [/正在和她聊，接着跟她说的/, '旧：正在聊直通'],
    [/主人说的话，一律叫醒/, '旧：主人直通'],
    [/你说话时到的，说完再判/, '说完补判'],
    [/正在和她聊的/, '在聊：正在聊的人'],
    [/在聊：/, '在聊：话题 / 接话'],
    [/她参与的话题还在聊|接她刚才的话|还在聊她参与的话题/, '在聊：话题 / 接话'],
    [/有人在问|有人认真在问|问句/, '有人在问'],
    [/感兴趣/, '兴趣'],
    [/没在聊这个群|普通一句/, '没在聊：普通一句'],
    [/刷屏|灌水|纯表情|复读|指令|在跟别人说|对聊|收尾|缓一会儿/, '没在聊：压低了仍掷中'],
  ]
  return rules.find(([re]) => re.test(s))?.[1] ?? s.slice(0, 14)
}

const grams = (s: string): Set<string> => {
  const t = s.replace(/[^\p{L}\p{N}]/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}
const overlap = (a: string, b: string): number => {
  const x = grams(a)
  return [...grams(b)].filter(g => x.has(g)).length
}
const clip = (s: string, n: number): string => s.length > n ? `${s.slice(0, n)}…` : s
const pct = (a: number, b: number): string => b ? `${(a / b * 100).toFixed(1)}%` : '—'
const tally = (xs: string[]): string => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、') || '无'
}

export interface ReportInput {
  db: string
  fromSeq: number
  toSeq: number
  channel: string
  live: CorpusRow[] // 语料里这一段（含当天她说的 / 读空气，做对照）
  label: string
  corpus: string
  range: string
  sent: { seq: number, at: number, sentAt: number }[] // 每条回放消息：语料 seq、原时间、回放时刻
}

export function realReport(o: ReportInput): Record<string, unknown> {
  const sql = `select seq, at, type, data from events where seq>${o.fromSeq} and seq<=${o.toSeq} and type in ('percept.received','group.policy','convo.pending','mind.decision','action.started','utterance.started','utterance.settled','sticker.sent') order by seq`
  const evs: Ev[] = (JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', o.db, sql], { maxBuffer: 1 << 30 }).toString() || '[]') as { seq: number, at: number, type: string, data: string }[])
    .map(r => ({ ...r, data: JSON.parse(r.data) }))
  const ch = o.channel
  const mine = evs.filter(e => e.data.channel === ch || (e.type === 'mind.decision' && ((e.data.reasons ?? []) as any[]).some(r => r.channel === ch)))
  const heard = mine.filter(e => e.type === 'percept.received' && (e.data.kind === 'group.message' || e.data.kind === 'message'))
  const bots = new Set(heard.filter(e => e.data.data?.bot).map(e => String(e.data.sender?.id)))
  const policies = mine.filter(e => e.type === 'group.policy')
  const pendings = mine.filter(e => e.type === 'convo.pending')
  // 主人 @ 她不经读空气（cold.ts 放行、不记 group.policy），一律叫醒：单算一类
  const ownerAt = heard.filter(e => e.data.kind === 'message' && OWNERS.includes(String(e.data.sender?.id)))
  const wakes = [...policies.filter(e => e.data.wake), ...pendings.filter(e => e.data.wake), ...ownerAt]
  const settled = mine.filter(e => e.type === 'utterance.settled' && String(e.data.delivered ?? '').trim())
  const origAt = (at: number): string => {
    const s = o.sent.findLast(x => x.sentAt <= at)
    return s ? localTime(s.at) : '?'
  }

  // 她每次开口：哪一拍大脑起的 reply、原因里是谁
  const said = settled.map((u) => {
    const started = mine.find(e => e.type === 'utterance.started' && e.data.id === u.data.id)
    const action = started ? evs.find(e => e.type === 'action.started' && e.data.id === started.data.action) : undefined
    const decision = action ? evs.findLast(e => e.type === 'mind.decision' && e.seq < action.seq) : undefined
    // 动作完成那种补拍的原因不带频道，也算（「动作 reply#2 完成」）；大脑那拍没起这个群的 reply = 脊椎快回 / 兜底说的
    const reasons = ((decision?.data.reasons ?? []) as any[]).filter(r => r.channel === ch || !r.channel)
    const byMind = ((decision?.data.intents ?? []) as any[]).some(i => i.do === 'start' && i.action === 'reply' && i.channel === ch)
    const t0 = started?.seq ?? u.seq
    const targets = new Set<string>()
    for (const r of byMind ? reasons : []) {
      const id = r.sender?.id ? String(r.sender.id) : heard.findLast(h => h.seq < (decision?.seq ?? 0) && r.text && String(h.data.text).startsWith(String(r.text).slice(0, 12)))?.data.sender?.id
      if (id)
        targets.add(String(id))
    }
    if (!byMind) { // 脊椎应的是她开口前最后一句冲她说的
      const to = heard.findLast(h => h.seq < t0 && h.data.kind === 'message')
      if (to)
        targets.add(String(to.data.sender?.id))
    }
    const prev = heard.findLast(h => h.seq < t0)
    // 叫醒这拍的那句的读空气：原因里第一个有人的，取他那句后面紧跟的 group.policy / 补判
    const wakeBy = reasons.find(r => r.source === 'group.message' || r.source === 'message' || r.source === 'group.convo' || r.source === 'qq.poke')
    const pol = wakeBy ? [...policies, ...pendings].filter(p => p.seq < (decision?.seq ?? 0) && String(p.data.sender?.id ?? p.data.who) === String(wakeBy.sender?.id ?? '')).at(-1) : undefined
    return {
      seq: u.seq,
      at: u.at,
      orig: origAt(u.at),
      text: String(u.data.delivered),
      prev: prev ? `${prev.data.sender?.name}：${clip(String(prev.data.text), 80)}` : '',
      source: !byMind ? '脊椎快回 / 兜底' : reasons.map(r => r.source).join('+') || '（无原因）',
      // 被叫到（@ / 引用 / 叫名字 / 戳）、做事汇报（动作 / 电脑 / 搜索结果那拍）、还是自己开口（没 @ 的群消息、说完补判）
      called: !byMind || reasons.some(r => r.source === 'message' || r.source === 'qq.poke'),
      // 她说完一句那拍（action:reply 完成）接着说群里的事算自己开口；电脑 / 搜索 / 截图这类结果那拍才算汇报
      report: byMind && !reasons.some(r => r.source === 'message' || r.source === 'qq.poke' || r.source === 'group.message' || r.source === 'group.convo')
        && reasons.some(r => /^(computer|search|dsh)\.|^action:(?!reply)/.test(String(r.source))),
      policy: pol ? `p=${pol.data.p} ${cat(pol.data.why ?? [])}：${(pol.data.why ?? []).join('、')}` : wakeBy?.source === 'message' && OWNERS.includes(String(wakeBy.sender?.id)) ? '主人 @ 她（不经读空气）' : '',
      note: decision && byMind ? clip(String(decision.data.note ?? ''), 160) : '',
      targets: [...targets],
      toBot: targets.size > 0 && [...targets].every(t => bots.has(t)), // 合流的一拍原因里夹着机器人不算，回的全是机器人才算
    }
  })

  // 追着说：她连着对同一个人开口、中间他没回她
  const streaks: { who: string, name: string, n: number, lines: string[] }[] = []
  const run = new Map<string, { n: number, last: number, lines: string[], lastSeq: number }>()
  for (const s of said) {
    for (const t of s.targets) {
      const r = run.get(t)
      const answered = r && heard.some(h => h.seq > r.lastSeq && h.seq < s.seq && String(h.data.sender?.id) === t
        && (h.data.kind === 'message' || overlap(r.lines.at(-1) ?? '', String(h.data.text)) >= 2))
      if (!r || answered || s.at - r.last > 5 * 60_000)
        run.set(t, { n: 1, last: s.at, lines: [s.text], lastSeq: s.seq })
      else {
        r.n++
        r.last = s.at
        r.lastSeq = s.seq
        r.lines.push(s.text)
        if (r.n >= 3)
          streaks.push({ who: t, name: heard.findLast(h => String(h.data.sender?.id) === t)?.data.sender?.name ?? t, n: r.n, lines: [...r.lines] })
      }
    }
  }
  const maxStreak = Math.max(1, ...[...run.values()].map(r => r.n), ...streaks.map(s => s.n))

  // 当天线上这一段
  const live = o.live
  const liveHeard = live.filter(r => r.t === 'msg')
  const liveSaid = live.filter(r => r.t === 'her' && r.text.trim())
  const liveWakes = live.filter(r => ((r.t === 'policy' || r.t === 'pending') && r.wake) || (r.t === 'msg' && r.kind === 'message' && OWNERS.includes(r.who)))
  const liveP1 = live.filter(r => r.t === 'policy' && (r.p ?? 0) >= 1)

  const sum = {
    label: o.label,
    others: heard.length,
    botLines: heard.filter(e => e.data.data?.bot).length,
    said: settled.length,
    rate: pct(settled.length, heard.length),
    stickers: mine.filter(e => e.type === 'sticker.sent').length,
    wakes: wakes.length,
    wakeWhy: tally(wakes.map(e => e.type === 'convo.pending' ? '说完补判' : e.type === 'percept.received' ? '主人 @ 她' : cat(e.data.why ?? []))),
    p1: tally(policies.filter(e => (e.data.p ?? 0) >= 1).map(e => cat(e.data.why ?? []))),
    botWakes: wakes.filter(e => e.data.bot).length,
    botWakeWhy: tally(wakes.filter(e => e.data.bot).map(e => cat(e.data.why ?? []))),
    toBot: said.filter(s => s.toBot).length,
    called: said.filter(s => s.called).length,
    report: said.filter(s => !s.called && s.report).length,
    self: said.filter(s => !s.called && !s.report).length,
    maxStreak,
    live: { others: liveHeard.length, said: liveSaid.length, rate: pct(liveSaid.length, liveHeard.length), wakes: liveWakes.length, wakeWhy: tally(liveWakes.map(r => r.t === 'pending' ? '说完补判' : r.t === 'msg' ? '主人 @ 她' : cat(r.why ?? []))), p1: tally(liveP1.map(r => cat(r.why ?? []))) },
  }

  const md: string[] = [
    `# 真实群记录回放 · ${o.label}`,
    '',
    `语料 \`${o.corpus}\` ${o.range}；库 \`${o.db}\` seq ${o.fromSeq}～${o.toSeq}；回放群 ${ch}`,
    '',
    '| 项 | 回放 | 当天线上 |',
    '|---|---|---|',
    `| 别人消息 | ${sum.others}（机器人 ${sum.botLines}） | ${sum.live.others} |`,
    `| 她开口（有字） | **${sum.said}**（${sum.rate}），另发表情包 ${sum.stickers} | ${sum.live.said}（${sum.live.rate}） |`,
    `| 叫醒 | ${sum.wakes} | ${sum.live.wakes} |`,
    `| 叫醒理由 | ${sum.wakeWhy} | ${sum.live.wakeWhy} |`,
    `| p=1 来源 | ${sum.p1} | ${sum.live.p1} |`,
    `| 机器人那句叫醒了她 | ${sum.botWakes}（${sum.botWakeWhy}） | — |`,
    `| 其中被叫到才说 / 做事汇报 / 自己开口 | ${sum.called} / ${sum.report} / ${sum.self}（${pct(sum.self, heard.length)}） | — |`,
    `| 她冲机器人开口 | ${sum.toBot} | — |`,
    `| 对没回她的人最长连着说 | ${sum.maxStreak} | — |`,
    '',
    ...(streaks.length ? ['## 追着说（≥3 句、对方中间没回她）', '', ...streaks.map(s => `- ${s.name}（${s.n} 句）：${s.lines.map(l => `「${clip(l, 40)}」`).join(' → ')}`), ''] : []),
    '## 她每次开口',
    '',
    ...said.map((s, i) => [
      `### ${i + 1}. seq ${s.seq} · 原 ${s.orig}${s.toBot ? ' · **冲机器人**' : ''}`,
      `- 上一条：${s.prev}`,
      `- 叫醒：${s.source}${s.policy ? `；${s.policy}` : ''}`,
      `- 大脑：${s.note}`,
      `- 她：**${s.text}**`,
      '',
    ].join('\n')),
  ]
  mkdirSync('data/replay-reports', { recursive: true })
  const base = `data/replay-reports/real-${o.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  writeFileSync(`${base}.md`, md.join('\n'))
  writeFileSync(`${base}.json`, JSON.stringify({ ...sum, said, streaks }, null, 1))
  console.log(md.slice(0, 16).join('\n'))
  console.log(`报告：${base}.md`)
  return sum
}
