/**
 * 全量聊天测试的统计（2026-10-22 起）：从日志库 events 表算大脑决策耗时、首字、脊椎分流、作废拍、模型调用与 token。
 * 只读，不碰实例。用法：
 *   npx tsx scripts/test-stats.ts <fromSeq> [toSeq] [库文件]     # 默认 data/mumu.db；跑之前记下 max(seq) 当 fromSeq
 * 首字的定义：对话类感知（message / group.message）到同频道下一条发言的第一个字，且那条发言在下一条感知之前开始——
 * 合流的几句会从第一句起算，所以比探针「最后一句→首字」偏长，两个数都看。
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const from = Number(process.argv[2])
const to = Number(process.argv[3] ?? Number.MAX_SAFE_INTEGER)
const dbFile = process.argv[4] ?? 'data/mumu.db'
if (!Number.isFinite(from)) {
  console.error('用法：npx tsx scripts/test-stats.ts <fromSeq> [toSeq] [库文件]')
  process.exit(1)
}

interface Row { seq: number, at: number, type: string, data: Record<string, any> }
const TYPES = ['percept.received', 'utterance.started', 'utterance.part', 'mind.decision', 'reflex.route', 'reflex.quick-demoted',
  'intent.blocked', 'model.request', 'model.response', 'reflex.started', 'guard.blocked', 'temper.ignored', 'convo.started', 'group.policy']
const sql = `select seq, at, type, data from events where seq>${from} and seq<=${to} and type in (${TYPES.map(t => `'${t}'`).join(',')}) order by seq`
const raw = execFileSync('sqlite3', ['-readonly', '-json', dbFile, sql], { maxBuffer: 1 << 30 }).toString()
const rows: Row[] = raw ? (JSON.parse(raw) as { seq: number, at: number, type: string, data: string }[]).map(r => ({ ...r, data: JSON.parse(r.data) })) : []

const pct = (xs: number[], p: number): number => {
  if (!xs.length)
    return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const fmt = (xs: number[]): string => xs.length ? `n=${xs.length} p50=${pct(xs, 0.5)} p90=${pct(xs, 0.9)} max=${Math.max(...xs)}` : 'n=0'
const count = (type: string): number => rows.filter(r => r.type === type).length

// 大脑
const dec = rows.filter(r => r.type === 'mind.decision')
const live = dec.filter(r => !r.data.aborted)
console.log(`大脑决策 tookMs（未作废） ${fmt(live.map(r => r.data.tookMs))}`)
if (live.some(r => r.data.lean !== undefined))
  console.log(`  精简拍 ${fmt(live.filter(r => r.data.lean).map(r => r.data.tookMs))}；完整拍 ${fmt(live.filter(r => !r.data.lean).map(r => r.data.tookMs))}`)
console.log(`被作废的大脑拍 ${dec.length - live.length}/${dec.length} = ${(100 * (dec.length - live.length) / Math.max(1, dec.length)).toFixed(1)}%`)
const quick = live.filter(r => (r.data.intents ?? []).some((i: any) => i.params?.quick)).length
const replies = live.filter(r => (r.data.intents ?? []).some((i: any) => i.action === 'reply')).length
console.log(`大脑起 reply 的拍 ${replies}（quick ${quick}）；空拍 ${live.filter(r => !(r.data.intents ?? []).length).length}`)

// 脊椎
const routes = rows.filter(r => r.type === 'reflex.route')
const byPath: Record<string, number> = {}
for (const r of routes) byPath[r.data.path] = (byPath[r.data.path] ?? 0) + 1
console.log(`reflex.route ${JSON.stringify(byPath)}；脊椎兜底占比 ${(100 * (byPath.fallback ?? 0) / Math.max(1, routes.length)).toFixed(1)}%；quick 被降级 ${count('reflex.quick-demoted')}；脊椎自己开口 ${count('reflex.started')}`)
const blocked: Record<string, number> = {}
for (const r of rows.filter(r => r.type === 'intent.blocked')) blocked[r.data.why] = (blocked[r.data.why] ?? 0) + 1
console.log(`intent.blocked ${JSON.stringify(blocked)}`)

// 首字
const firstPart = new Map<string, number>()
for (const r of rows.filter(r => r.type === 'utterance.part')) {
  if (r.data.part?.kind === 'text' && String(r.data.part.text ?? '').trim() && !firstPart.has(r.data.id))
    firstPart.set(r.data.id, r.at)
}
const starts = rows.filter(r => r.type === 'utterance.started').map(r => ({ ch: r.data.channel as string, at: r.at, first: firstPart.get(r.data.id) }))
const percepts = rows.filter(r => r.type === 'percept.received' && ['message', 'group.message'].includes(r.data.kind) && r.data.channel)
const ft: Record<string, number[]> = { all: [] }
for (let i = 0; i < percepts.length; i++) {
  const p = percepts[i]
  const next = percepts.slice(i + 1).find(q => q.data.channel === p.data.channel)
  const u = starts.find(s => s.ch === p.data.channel && s.at >= p.at && s.first && (!next || s.at < next.at))
  if (!u)
    continue
  const ms = u.first! - p.at
  ft.all.push(ms)
  ;(ft[p.data.kind] ??= []).push(ms)
}
console.log(`首字（感知→第一个字） ${fmt(ft.all)}`)
for (const [k, xs] of Object.entries(ft)) {
  if (k !== 'all')
    console.log(`  ${k} ${fmt(xs)}`)
}

// 模型
const resps = rows.filter(r => r.type === 'model.response')
const byRole: Record<string, { n: number, prompt: number, completion: number, models: Set<string> }> = {}
for (const r of resps) {
  const b = (byRole[r.data.role] ??= { n: 0, prompt: 0, completion: 0, models: new Set() })
  b.n++
  b.prompt += r.data.usage?.prompt ?? 0
  b.completion += r.data.usage?.completion ?? 0
  b.models.add(r.data.model)
}
console.log(`model.request ${count('model.request')} 次 / model.response ${resps.length} 次`)
let tp = 0
let tc = 0
for (const [role, b] of Object.entries(byRole)) {
  tp += b.prompt
  tc += b.completion
  console.log(`  ${role.padEnd(16)} n=${b.n} prompt=${b.prompt} completion=${b.completion} ${[...b.models].join('/')}`)
}
console.log(`  合计 prompt=${tp} completion=${tc}`)
console.log(`其他：guard.blocked ${count('guard.blocked')}，temper.ignored ${count('temper.ignored')}，convo.started ${count('convo.started')}，group.policy ${count('group.policy')}`)
