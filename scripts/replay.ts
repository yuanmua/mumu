/**
 * 真实语料回放压测（第 5 步）。在后端那台机器上、后端在跑、3001 空着时跑：
 *   npx tsx scripts/replay.ts                      # 默认：A 段 3000 条 + 检查点 1 万 / 3 万 / 5 万
 *   npx tsx scripts/replay.ts --a 600 --total 3000 --checkpoints 3000   # 小规模试跑
 * 选项：--a A 段条数  --total 总条数  --checkpoints 逗号分隔  --speed B 段每分钟条数（默认 400）  --seed 随机种子  --no-judge
 *
 * A 段（行为 + 费率）：四个群按各自的节奏放语料（每群每分钟几句，隔 12 分钟安静 2.5 分钟），中间插埋好的记忆考点和怪情况；
 *   结束后取 /api/bench/usage 算每个模型角色的花费，抽样她的发言交 /api/bench/judge 打分，统计 @ 她的答没答、刷没刷屏。
 * B 段（记忆规模）：这四个群临时设 talkValue 0（她不开口、不花回复的钱），高速灌到总条数，只让记忆按块整理。
 * 检查点：压完攒着的 → 在没有历史的会话里问考点（私聊用这个人的新小号，memory aliases 并到本人）→ 记命中、泄密、耗时、记忆体量。
 * 全程不清任何东西（真源日志、记忆、工作记忆都在累积态下量）：测试工具不得整库清空。
 * 会改的配置（group-policy.groups、memory.checkSec）结束时还原。结果写 data/replay-reports/<时间>.json，并打印摘要。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { FakeNapCat } from './fake-onebot/napcat.ts'
import { ensureImages, imageDir } from './fake-onebot/images.ts'
import type { Line } from './replay/corpus.ts'
import { groupStream, loadDialogs, rng } from './replay/corpus.ts'
import { Emitter } from './replay/events.ts'
import { Observer } from './replay/observe.ts'
import type { Question } from './replay/plan.ts'
import { ADMIN, FAKE_HER, GROUPS, members, PLANTS, QUESTIONS, WEIRD } from './replay/plan.ts'
import { analyze } from './replay/analyze.ts'

const args = process.argv.slice(2)
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const MUMU = opt('mumu', 'http://127.0.0.1:3939')
const PORT = Number(opt('port', '3001'))
const A = Number(opt('a', '3000'))
const TOTAL = Number(opt('total', '50000'))
const CHECKS = opt('checkpoints', '10000,30000,50000').split(',').map(Number).filter(n => n > A && n <= TOTAL)
const SPEED = Number(opt('speed', '400'))
const SEED = Number(opt('seed', '20261021'))
const JUDGE = !args.includes('--no-judge')

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const log = (s: string): void => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`)

async function command(line: string): Promise<string> {
  const res = await fetch(`${MUMU}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line }) })
  const body = await res.json().catch(() => ({})) as { lines?: string[] }
  return (body.lines ?? []).join('\n')
}
async function getJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${MUMU}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return await res.json() as T
}

// ── 准备 ──
const dialogs = loadDialogs(['data/corpus/lccc_base_valid.jsonl.gz', 'data/corpus/lccc_base_test.jsonl.gz'])
log(`语料：${dialogs.length} 段对话，${dialogs.reduce((n, d) => n + d.length, 0)} 句`)
const rand = rng(SEED)
const stickers = ensureImages().filter(f => f.startsWith('sticker-'))
const nap = new FakeNapCat(PORT, imageDir())
for (const g of GROUPS) nap.groups.set(g.id, g.name)
for (const m of [...members, FAKE_HER, ADMIN]) nap.members.set(m.id, { name: m.name, role: m.id === ADMIN.id ? 'admin' : 'member' })
const outs: { at: number, channel: string, text: string }[] = []
nap.onSent = s => outs.push({ at: Date.now(), channel: s.channel, text: JSON.stringify(s.message) })
await nap.start()
const em = new Emitter(nap, stickers)
const obs = new Observer(MUMU)
await obs.start()
log(`假 NapCat 在 3001，等 surface-onebot 连上…`)
const deadline = Date.now() + 40_000
while (!nap.open && Date.now() < deadline) await sleep(200)
if (!nap.open) {
  console.error('40 秒内 surface-onebot 没连上来')
  process.exit(1)
}
await sleep(2000)

const restore = new Map<string, string>()
async function setConfig(path: string, value: unknown): Promise<void> {
  const plugin = path.split('.').slice(0, 2).join('.')
  if (!restore.has(plugin)) {
    const old = (await command(`/config get ${plugin}`)).trim()
    restore.set(plugin, !old || old === 'undefined' ? '{}' : old)
  }
  await command(`/config set ${path} ${JSON.stringify(value)}`)
}

const streams = new Map(GROUPS.map((g, i) => [g.id, groupStream(g, dialogs, i * 7919, 4, rand)]))
let sent = 0
const nextLine = (group: number): Line => streams.get(group)!.next().value as Line

// 压测期间她可能同时在别处干活：别的对话让她用电脑时，群聊策略会按「忙」把群里的插话全压掉，压测就测不到插话了。
// 所以压测期间临时关掉「忙」的判定，结束还原；报告里注明
await setConfig('plugins.group-policy.busyActions', [])
// 时段表也临时置空（系数 1，按白天测）：压测常在深夜跑，深夜系数 0.2 会让她几乎不说话，测不出白天的样子
await setConfig('plugins.group-policy.timeRules', [])

// ── A 段 ──
const report: Record<string, unknown> = { startedAt: Date.now(), seed: SEED, a: A, total: TOTAL, corpus: 'thu-coai LCCC-base（valid + test）', groups: GROUPS.map(g => ({ id: g.id, name: g.name, perMinute: g.perMinute, members: g.members.length })) }
const weirdLog: { label: string, group: number, at: number, what: string }[] = []
const plantLog: { who: string, where: string, at: number, text: string }[] = []
const aStart = Date.now()
log(`A 段开始：${A} 条，四个群合计约 ${GROUPS.reduce((n, g) => n + g.perMinute, 0)} 句/分钟`)
const pendingPlants = [...PLANTS]
const pendingWeird = [...WEIRD]
const lullOffset = new Map(GROUPS.map((g, i) => [g.id, i * 3.1 * 60_000]))
while (sent < A) {
  const tick = Date.now()
  for (const g of GROUPS) {
    // 每个群 12 分钟热闹、2.5 分钟安静（压缩的「夜里」，冷场逻辑靠它触发），各群错开
    const phase = (tick - aStart + lullOffset.get(g.id)!) % (14.5 * 60_000)
    if (phase > 12 * 60_000)
      continue
    if (rand() < g.perMinute / 60) {
      const l = nextLine(g.id)
      em.text(l.group, l.who, l.text)
      sent++
    }
  }
  while (pendingPlants.length && sent >= pendingPlants[0].at * A) {
    const p = pendingPlants.shift()!
    em.toHer(p.where, p.who, p.text)
    plantLog.push({ who: p.who, where: String(p.where), at: Date.now(), text: p.text })
  }
  while (pendingWeird.length && sent >= pendingWeird[0].at * A) {
    const w = pendingWeird.shift()!
    const g = GROUPS.find(x => x.id === w.group)!
    const pool = [...g.members].sort(() => rand() - 0.5).slice(0, 3)
    const at = Date.now()
    void em.weird(w.kind, w.group, pool).then(what => weirdLog.push({ label: w.label, group: w.group, at, what }))
  }
  if (sent % 250 === 0)
    log(`A 段 ${sent}/${A}，她开口 ${obs.count('utterance.started')} 次`)
  await sleep(1000)
}
await obs.quiet(8000, 180_000)
const aEnd = Date.now()
log(`A 段结束：${Math.round((aEnd - aStart) / 60_000)} 分钟`)

const usageA = await getJson<{ roles: unknown[] }>(`/api/bench/usage?since=${aStart}&until=${aEnd}`)
report.phaseA = analyze(obs, outs, { start: aStart, end: aEnd, sent: A, groups: GROUPS.map(g => g.id), weird: weirdLog, plants: plantLog })
report.usageA = usageA.roles

if (JUDGE) {
  const items = (report.phaseA as { samples: unknown[] }).samples
  log(`裁判打分：${items.length} 条`)
  report.judge = (await getJson<{ results: unknown[] }>('/api/bench/judge', { items })).results
  report.judgeItems = items
}

// ── 检查点 ──
const checkpoints: unknown[] = []
async function checkpoint(label: string): Promise<void> {
  log(`检查点 ${label}：先把攒着的压成记忆…`)
  const t0 = Date.now()
  // 只压回放用到的会话（四个群 + 埋考点的私聊）；flush all 会连之前模拟器留下的几十个小群一起压，白等
  const chans = [...GROUPS.map(g => `qq:group:${g.id}`), ...PLANTS.filter(p => p.where === 'private').map(p => `qq:private:${members.find(m => m.name === p.who)!.id}`)]
  let flush = ''
  for (const ch of chans) flush += `${await command(`/memory flush ${ch}`)}\n`
  const flushMs = Date.now() - t0
  const stats = await command('/memory')
  const usage = await getJson<{ roles: unknown[] }>(`/api/bench/usage?since=${phaseStart}&until=${Date.now()}`)
  // 不清任何东西（测试工具不得整库清空）。私聊提问用这个人的「新小号」：新私聊里没有历史，答得上只能靠记忆；
  // 小号经 memory 的 aliases 并到同一个人，记忆认得是谁。群里的提问照常在原群——几千条之后考点早滚出阅读窗口了
  round++
  // 在原有别名上追加（主人的 QQ → 网页主人那种是真配置，跑的过程中也别冲掉）
  const raw = (await command('/config get plugins.memory.aliases')).trim()
  const aliases: Record<string, string> = raw.startsWith('{') ? JSON.parse(raw) : {}
  for (let k = 1; k <= round; k++) {
    for (const m of members) aliases[`qq:${m.id + k * 1000}`] = `qq:${m.id}`
  }
  for (const m of members) nap.members.set(m.id + round * 1000, { name: m.name })
  await setConfig('plugins.memory.aliases', aliases)
  await sleep(2000)
  const answers: unknown[] = []
  for (const q of QUESTIONS) answers.push(await ask(q))
  checkpoints.push({ label, sent, flushMs, flushLines: flush.split('\n').length, stats, usageSinceLast: usage.roles, answers })
  log(`检查点 ${label}：命中 ${answers.filter((a: any) => a.hit).length}/${QUESTIONS.filter(q => q.expect).length}，泄密 ${answers.filter((a: any) => a.leak).length}`)
  savePartial()
  phaseStart = Date.now()
}

async function ask(q: Question): Promise<Record<string, unknown>> {
  const before = outs.length
  const at = Date.now()
  const channel = em.toHer(q.where, q.who, q.text, q.where === 'private' ? round * 1000 : 0)
  await sleep(1500)
  await obs.quiet(6000, 60_000)
  const said = outs.slice(before).filter(o => o.channel === channel)
  const text = said.map(o => o.text).join(' ')
  return {
    about: q.about,
    where: channel,
    question: q.text,
    answer: said.map(o => plain(o.text)).join(' / '),
    firstOutMs: said[0] ? said[0].at - at : null,
    hit: q.expect ? q.expect.test(text) : undefined,
    leak: q.forbid ? q.forbid.test(text) : undefined,
  }
}

let phaseStart = Date.now()
let round = 0

// 每个检查点落一份中间报告（连同改过的配置原值）：中途停掉也不丢已跑出的数据，配置也能照着手动还原
mkdirSync('data/replay-reports', { recursive: true })
const partialFile = `data/replay-reports/partial-${new Date(report.startedAt as number).toISOString().replace(/[:.]/g, '-')}.json`
function savePartial(): void {
  writeFileSync(partialFile, JSON.stringify({ ...report, checkpoints, partial: true, sent, restore: Object.fromEntries(restore) }, null, 1))
}
await checkpoint(`A 段结束（${A} 条）`)

// ── B 段 ──
if (CHECKS.length) {
  await setConfig('plugins.group-policy.groups', Object.fromEntries(GROUPS.map(g => [`qq:group:${g.id}`, { talkValue: 0 }])))
  await setConfig('plugins.memory.checkSec', 3)
  await sleep(2000)
  const weights = GROUPS.map(g => g.perMinute)
  const wsum = weights.reduce((a, b) => a + b, 0)
  for (const target of CHECKS) {
    log(`B 段：灌到 ${target} 条（每分钟 ${SPEED} 条）`)
    const bStart = Date.now()
    while (sent < target) {
      let r = rand() * wsum
      const g = GROUPS.find((_, i) => (r -= weights[i]) < 0) ?? GROUPS[0]
      const l = nextLine(g.id)
      em.text(l.group, l.who, l.text)
      sent++
      if (sent % 2000 === 0)
        log(`B 段 ${sent}/${target}，记忆已整理 ${obs.count('memory.summarized')} 段`)
      await sleep(60_000 / SPEED)
    }
    log(`B 段到 ${target}：用了 ${Math.round((Date.now() - bStart) / 60_000)} 分钟`)
    await obs.quiet(5000, 120_000)
    await checkpoint(`${target} 条`)
  }
}
report.checkpoints = checkpoints
unlinkSync(partialFile)
report.memorySummarized = obs.count('memory.summarized')
report.memoryFailed = obs.count('memory.failed')

// ── 收尾 ──
for (const [plugin, old] of restore)
  await command(`/config set ${plugin} ${old}`)
report.endedAt = Date.now()
mkdirSync('data/replay-reports', { recursive: true })
const file = `data/replay-reports/${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify(report, null, 1))
log(`报告：${file}`)
await nap.close()
process.exit(0)

function plain(json: string): string {
  try {
    const segs = JSON.parse(json) as { type: string, data?: Record<string, unknown> }[]
    return segs.map(s => s.type === 'text' ? String(s.data?.text ?? '') : `[${s.type}]`).join('')
  }
  catch {
    return json
  }
}

