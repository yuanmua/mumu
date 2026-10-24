/**
 * 真实群记录回放（2026-10-23）：把真机某一天某个群的记录（scripts/replay/real-corpus.ts 取出的语料）按原顺序、按压缩过的原间隔
 * 发给一个独立克隆实例（scripts/retest-clone.sh），看她现在的代码和参数在同样的群聊里会怎么开口。
 *   npx tsx scripts/replay-real.ts --corpus data/corpus/real-2026-10-22-900902.jsonl --from 11:00 --to 18:00 \
 *     --mumu http://127.0.0.1:39412 --port 30013 --db /tmp/mumu-retest-12/data/mumu.db --label r1
 *   npx tsx scripts/replay-real.ts --report-only --corpus … --from … --to … --db … --group <回放群号> --from-seq N [--to-seq M] --label …
 * 选项：--speed 时间压缩倍数（默认 4）  --min-gap 两条最短间隔秒（默认 1.5，让她说得完）  --max-gap 最长间隔秒（默认 150，冷场不白等）
 *       --group-name 群名（默认按语料群号取原群名）
 *       --life 回放期间她「在干嘛」（默认「刷手机」，life 插件的 /life set，结束 /life clear）：life 按真实钟点排作息，深夜回放她会在睡觉，
 *              大脑材料「睡着时没人找她就别主动开口」会把回放压低（10-23 第二、三轮就这样作废）；没装 life 时这条命令无效、无害
 *       --group 回放用的新群号（默认随机；规矩：要「没有历史」就开新群号，不清库）  --time-factor 时段系数（默认 0.8，按原时段白天算，回放常在深夜跑）
 * 消息段按渲染后的文字拆回去：「@沐沐」→ @ 她，「@群友名」→ @ 那人，「[回复你「…」]」→ 引用她在回放里最近说的一句，
 * 「[回复 X「…」]」→ 引用回放里那条（找不到就留成文字）；图片 / 表情包留着看图后的文字，不再看图。机器人还是那些号，由克隆库里的名单认。
 * 主人的 @ 与任务原样发（电脑 / DSH 在本地会失败，看她怎么说）。她自己的话不回放，由她现场说。
 * 不清任何东西；改了的配置（timeRules）结束时还原。报告：data/replay-reports/real-<label>-<时间>.md / .json（scripts/replay/real-report.ts）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import type { Segment } from '../plugins/official/surface-onebot/segments.ts'
import { ev, seg } from '../plugins/official/surface-onebot/segments.ts'
import { FakeNapCat } from './fake-onebot/napcat.ts'
import { imageDir } from './fake-onebot/images.ts'
import { Observer } from './replay/observe.ts'
import type { CorpusRow } from './replay/real-report.ts'
import { localTime, realReport } from './replay/real-report.ts'

const args = process.argv.slice(2)
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const CORPUS = opt('corpus', '')
const FROM = opt('from', '00:00')
const TO = opt('to', '24:00')
const MUMU = opt('mumu', 'http://127.0.0.1:39412')
const PORT = Number(opt('port', '30013'))
const DB = opt('db', '')
const LABEL = opt('label', 'run')
const SPEED = Number(opt('speed', '4'))
const MIN_GAP = Number(opt('min-gap', '1.5')) * 1000
const MAX_GAP = Number(opt('max-gap', '150')) * 1000
const TIME_FACTOR = Number(opt('time-factor', '0.8'))
const LIFE = opt('life', '刷手机')
const GROUP = Number(opt('group', String(700_000_000 + Math.floor(Math.random() * 99_999_999))))
const SELF = { id: 10000, name: '沐沐小号' } // 真机小号：认自己网名（who.ts）要用真名字
if (!CORPUS || !DB) {
  console.error('要 --corpus 语料文件 和 --db 克隆实例的库（报告从库里算）')
  process.exit(1)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const log = (s: string): void => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`)
const maxSeq = (): number => Number(execFileSync('sqlite3', ['-readonly', DB, 'select max(seq) from events']).toString().trim() || 0)

const all = readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CorpusRow)
const inRange = (r: CorpusRow): boolean => localTime(r.at) >= FROM && localTime(r.at) < TO
const rows = all.filter(inRange)
const sendable = rows.filter(r => r.t === 'msg' || r.t === 'poke' || r.t === 'recall')
const NAMES: Record<string, string> = { 900902: '群乙', 900901: '群甲', 900903: '测试群' } // 原群名（大脑材料里有群名）
const groupName = opt('group-name', NAMES[CORPUS.match(/(\d+)\.jsonl$/)?.[1] ?? ''] ?? '回放')

if (args.includes('--report-only')) {
  const fromSeq = Number(opt('from-seq', '0'))
  const toSeq = Number(opt('to-seq', String(Number.MAX_SAFE_INTEGER)))
  realReport({ db: DB, fromSeq, toSeq, channel: `qq:group:${GROUP}`, live: rows, label: LABEL, corpus: CORPUS, range: `${FROM}–${TO}`, sent: [] })
  process.exit(0)
}

// ── 假 NapCat：群友名单取自语料（名字、管理员身份），她用真机的号和网名 ──
const nap = new FakeNapCat(PORT, imageDir())
Object.assign(nap.self, SELF)
nap.groups.set(GROUP, groupName)
const members = new Map<string, { name: string, role?: string }>()
for (const r of all) {
  if (r.t === 'msg' && r.who && r.name)
    members.set(r.who, { name: r.name, role: r.role })
}
for (const [id, m] of members) nap.members.set(Number(id), { name: m.name, role: m.role === 'owner' || m.role === 'admin' ? m.role : 'member' })
const herSent: number[] = [] // 她在回放里发出的消息 id（「[回复你「…」]」引用最近一条）
nap.onSent = (s) => {
  if (s.channel === `qq:group:${GROUP}`)
    herSent.push(s.messageId)
}
await nap.start()
const obs = new Observer(MUMU)
await obs.start()
log(`假 NapCat 在 ${PORT}，等 surface-onebot 连上…`)
const deadline = Date.now() + 40_000
while (!nap.open && Date.now() < deadline) await sleep(200)
if (!nap.open) {
  console.error('40 秒内 surface-onebot 没连上来')
  process.exit(1)
}
await sleep(2000)

async function command(line: string): Promise<string> {
  const res = await fetch(`${MUMU}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line }) })
  const body = await res.json().catch(() => ({})) as { lines?: string[] }
  return (body.lines ?? []).join('\n')
}
// 时段系数按原来那段白天算（回放常在深夜，深夜 0.2 会让她几乎不说话）；结束还原
const oldTime = (await command('/config get plugins.group-policy.timeRules')).trim()
await command(`/config set plugins.group-policy.timeRules ${JSON.stringify([{ time: '00:00-23:59', value: TIME_FACTOR }])}`)
await sleep(4000) // 配置一改插件重载
log(`在干嘛：${(await command(`/life set ${LIFE} 600`)).trim() || '（没装 life）'}`)

// ── 渲染后的文字拆回消息段 ──
const names = [...new Set([...members.values()].map(m => m.name))].filter(n => n.length >= 1).sort((a, b) => b.length - a.length)
const idOf = new Map([...members].map(([id, m]) => [m.name, Number(id)]))
const SELF_NAMES = ['沐沐', SELF.name]
const newId = new Map<string, number>() // 原消息 id → 回放里的 id
const byWho: { who: string, text: string, id: number }[] = [] // 撤回按「这人说过的这句」找回放里的 id

function toSegments(text: string): Segment[] {
  const out: Segment[] = []
  let rest = text
  const quote = rest.match(/^\[回复(你| [^「]*)「[^」]*」\] ?|^\[回复(你)?\] ?/)
  if (quote) {
    // 留给调用方填引用（需要原 replyTo）；这里只剥掉前缀
    rest = rest.slice(quote[0].length)
  }
  let buf = ''
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '@' && rest[i - 1] !== '[') {
      const tail = rest.slice(i + 1)
      const self = SELF_NAMES.find(n => tail.startsWith(n))
      const other = self ? undefined : tail.startsWith('全体成员') ? '全体成员' : names.find(n => tail.startsWith(n))
      if (self || other) {
        if (buf)
          out.push(seg.text(buf))
        buf = ''
        out.push(self ? seg.at(SELF.id) : other === '全体成员' ? seg.atAll() : seg.at(idOf.get(other!)!))
        i += (self ?? other)!.length
        continue
      }
    }
    buf += rest[i]
  }
  if (buf)
    out.push(seg.text(buf))
  return out
}

function quoteSeg(r: CorpusRow): { seg?: Segment, keep?: string } {
  const m = r.text.match(/^\[回复(你| [^「]*)「[^」]*」\] ?|^\[回复(你)?\] ?/)
  if (!m)
    return {}
  const toHer = m[1] === '你' || m[2] === '你'
  if (toHer) {
    const last = herSent.at(-1)
    return last ? { seg: seg.reply(last) } : { seg: seg.at(SELF.id) } // 她在回放里还没说过话：当成 @ 她
  }
  const id = r.replyTo ? newId.get(r.replyTo) : undefined
  return id ? { seg: seg.reply(id) } : { keep: m[0] } // 引用的那条不在回放里：留成文字（「在跟别人说」照样认得出）
}

// ── 回放 ──
const fromSeq = maxSeq()
const start = Date.now()
const sent: { seq: number, at: number, sentAt: number }[] = []
log(`回放 ${CORPUS} ${FROM}–${TO}：${sendable.length} 条（消息 ${sendable.filter(r => r.t === 'msg').length}），群号 ${GROUP}，压缩 ×${SPEED}、间隔 ${MIN_GAP / 1000}～${MAX_GAP / 1000} 秒，起始 seq ${fromSeq}`)
let due = Date.now()
for (let k = 0; k < sendable.length; k++) {
  const r = sendable[k]
  if (k > 0)
    due += Math.min(MAX_GAP, Math.max(MIN_GAP, (r.at - sendable[k - 1].at) / SPEED))
  const wait = due - Date.now()
  if (wait > 0)
    await sleep(wait)
  const who = Number(r.who)
  if (r.t === 'poke')
    nap.push(ev.poke(SELF.id, who, SELF.id, GROUP) as unknown as Record<string, unknown>)
  else if (r.t === 'recall') {
    const said = r.text.match(/「([\s\S]*)」$/)?.[1]
    const hit = byWho.findLast(x => x.who === r.who && (!said || x.text === said || said.startsWith(x.text.slice(0, 20))))
    if (!hit)
      continue
    nap.push(ev.groupRecall(SELF.id, GROUP, who, who, hit.id) as unknown as Record<string, unknown>)
  }
  else {
    const q = quoteSeg(r)
    const body = toSegments(q.keep ? r.text.slice(q.keep.length) : r.text)
    const message = [...(q.seg ? [q.seg] : []), ...(q.keep ? [seg.text(q.keep)] : []), ...body]
    const id = nap.nextId()
    if (r.messageId)
      newId.set(r.messageId, id)
    byWho.push({ who: r.who, text: r.text, id })
    const m = members.get(r.who)
    const role = m?.role === 'owner' || m?.role === 'admin' ? m.role : 'member'
    nap.push(ev.groupMessage(SELF.id, GROUP, { user: who, name: r.name, card: r.name, role }, message, id) as unknown as Record<string, unknown>)
  }
  sent.push({ seq: r.seq, at: r.at, sentAt: Date.now() })
  if (k % 100 === 0)
    log(`${k}/${sendable.length}（原 ${localTime(r.at)}），她开口 ${obs.count('utterance.settled')} 次`)
}
log('发完了，等她说完…')
await obs.quiet(15_000, 300_000)
await command(`/config set plugins.group-policy.timeRules ${!oldTime || oldTime === 'undefined' ? '[]' : oldTime}`)
await command('/life clear')
log(`用时 ${Math.round((Date.now() - start) / 60_000)} 分钟`)
realReport({ db: DB, fromSeq, toSeq: maxSeq(), channel: `qq:group:${GROUP}`, live: rows, label: LABEL, corpus: CORPUS, range: `${FROM}–${TO}`, sent })
await nap.close()
process.exit(0)
