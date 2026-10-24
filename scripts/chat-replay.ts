/**
 * 私聊回放：把一段真实对话里「对方说的话」按原来的节奏，重新发给她（新的测试频道，不清库），
 * 看她现在怎么回；结束后用 bench 的两个裁判打分（逐条 + 整段），出一份 JSON 报告。调回复策略时做改前改后对比用。
 *
 * 用法：
 *   npx tsx scripts/chat-replay.ts --from qq:private:10001 [--since 毫秒] [--until 毫秒] [--tag before] [--cap 30] [--judge 3]
 *   npx tsx scripts/chat-replay.ts --lines 对话.tsv …        # 每行「秒数<TAB>文本」，秒数从 0 起
 * 选项：
 *   --channel    测试频道，默认 c:tune-<tag>-<时间>
 *   --cap        两句之间最多等几秒（原对话里的长空档压短，连发的节奏原样保留），默认 30
 *   --typing 0   关掉「像 QQ 一样打字」：默认按 surface-onebot 出口节流的默认值（400ms + 每字 180ms，两条间隔 0.6～1.4s）
 *                模拟一段一段地发出去再报送达，这样对方连发时她没发出去的话会像真 QQ 一样被作废
 *   --judge N    整段裁判打 N 次取平均（裁判本身波动不小），默认 3；0 = 不打分
 *   --out        报告路径，默认 data/replay-reports/chat-<tag>-<时间>.json
 * 依赖 bench 插件（/api/bench/thread、/api/bench/judge、/api/bench/judge-thread）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def
}
const BASE = opt('mumu', process.env.MUMU_URL ?? 'http://127.0.0.1:3939')
const TAG = opt('tag', 'run')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const CHANNEL = opt('channel', `c:tune-${TAG}-${Date.now().toString(36)}`)
const CAP = Number(opt('cap', '30')) * 1000
const TYPING = opt('typing', '1') !== '0'
const JUDGE_N = Number(opt('judge', '3'))
const OUT = opt('out', `data/replay-reports/chat-${TAG}-${STAMP}.json`)

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()
const rel = (): string => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok)
    throw new Error(`${path} ${res.status}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

interface Line { at: number, who: string, text: string, via?: string, truncated?: boolean }

/** 要回放的对方的话：相对秒数 + 文本 */
async function corpus(): Promise<{ off: number, text: string }[]> {
  const file = opt('lines', '')
  if (file) {
    return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map((l) => {
      const [sec, ...rest] = l.split('\t')
      return { off: Number(sec) * 1000, text: rest.join('\t') }
    })
  }
  const from = opt('from', '')
  if (!from)
    throw new Error('要 --from <频道> 或 --lines <文件>')
  const t = await api<{ lines: Line[] }>(`/api/bench/thread?channel=${encodeURIComponent(from)}&since=${opt('since', '0')}&until=${opt('until', String(Date.now()))}`)
  const others = t.lines.filter(l => l.who === 'other')
  return others.map(l => ({ off: l.at - others[0].at, text: l.text }))
}

// —— 替表现端报送达：像 QQ 一样一段一段发 ——
interface Utt { gen: string, ready: number, timer?: NodeJS.Timeout }
const utts = new Map<string, Utt>()
let lastSend = 0
const typingMs = (chars: number): number => Math.min(6000, 400 + chars * 180) * (0.75 + Math.random() * 0.5)
/** 生成到 upTo 字的这一段「发出去」：等打字时间、和上一条隔开，然后报送达 */
function sendSegment(id: string, upTo: number): void {
  const u = utts.get(id)
  if (!u)
    return
  const chars = upTo - u.ready
  if (chars <= 0)
    return
  u.ready = upTo
  if (!TYPING) {
    void api('/api/delivered', { uttId: id, chars: upTo }).catch(() => {})
    return
  }
  const at = Math.max(Date.now() + typingMs(chars), lastSend + 600 + Math.random() * 800)
  lastSend = at
  setTimeout(() => void api('/api/delivered', { uttId: id, chars: upTo }).catch(() => {}), at - Date.now())
}

// —— 首字延迟：对方最近一句 → 她这次发言的第一个字（不算模拟打字，那是表现端的事） ——
let lastOther = 0
const viaOfAction = new Map<string, string>()
const viaOfUtt = new Map<string, string>()
const firstChar: { via: string, ms: number }[] = []

function onEvent(type: string, d: any): void {
  if (type === 'percept.received' && d.channel === CHANNEL && d.sender) {
    lastOther = Date.now()
  }
  else if (type === 'utterance.started' && d.channel === CHANNEL) {
    utts.set(d.id, { gen: '', ready: 0 })
    viaOfUtt.set(d.id, viaOfAction.get(d.action) ?? '?')
  }
  else if (type === 'utterance.part' && utts.has(d.id)) {
    const u = utts.get(d.id)!
    if (d.part?.kind === 'text') {
      if (!u.gen && lastOther)
        firstChar.push({ via: viaOfUtt.get(d.id) ?? '?', ms: Date.now() - lastOther })
      u.gen += String(d.part.text ?? '')
    }
    else if (d.part?.kind === 'break')
      sendSegment(d.id, u.gen.length)
    // 流停了 600ms 当作这一段写完了（事件流里看不到「生成结束」）
    clearTimeout(u.timer)
    u.timer = setTimeout(() => sendSegment(d.id, u.gen.length), 600)
  }
  else if (type === 'utterance.settled' && utts.has(d.id)) {
    clearTimeout(utts.get(d.id)!.timer)
    utts.delete(d.id)
    console.log(`${rel()}  她：${String(d.delivered ?? '')}${d.truncated ? `（被打断，${d.cause}）` : ''}`)
  }
  else if (type === 'action.started' && d.channel === CHANNEL && String(d.id).startsWith('reply#')) {
    const p = d.params ?? {}
    viaOfAction.set(d.id, p.reflex ? 'reflex' : p.append ? 'append' : p.tier === 'deep' ? 'deep' : 'mind')
    console.log(`${rel()}  ${p.reflex ? '反射' : p.append ? '导演补充' : p.tier === 'deep' ? '导演认真答' : '导演'}起 ${d.id}${p.guidance ? `：${String(p.guidance).slice(0, 60)}` : ''}`)
  }
  else if (type === 'reflex.route' && d.channel === CHANNEL) {
    console.log(`${rel()}  分流 ${d.path}（${(d.why ?? []).join('、')}）`)
  }
}

async function listen(): Promise<void> {
  const res = await fetch(`${BASE}/api/events`)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let live = false
  void (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        return
      buf += dec.decode(value, { stream: true })
      let i: number
      // eslint-disable-next-line no-cond-assign
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const l of frame.split('\n')) {
          if (!l.startsWith('data: '))
            continue
          const e = JSON.parse(l.slice(6)) as { type: string, data?: any }
          if (e.type === '__live__')
            live = true
          else if (live)
            onEvent(e.type, e.data ?? {})
        }
      }
    }
  })()
  while (!live) await sleep(50)
}

async function main(): Promise<void> {
  const lines = await corpus()
  await listen()
  console.log(`频道 ${CHANNEL}，${lines.length} 句，空档最多 ${CAP / 1000}s，${TYPING ? '模拟 QQ 打字' : '立即送达'}`)
  const since = Date.now()
  let shift = 0 // 压掉的空档累计
  let prev = 0
  for (const l of lines) {
    shift += Math.max(0, l.off - prev - CAP)
    prev = l.off
    const due = since + l.off - shift
    if (due > Date.now())
      await sleep(due - Date.now())
    console.log(`${rel()}  对方：${l.text}`)
    await api('/api/input', { text: l.text, channel: CHANNEL })
  }
  // 等她安静：没有在途发言、20 秒没新的对话行
  let stable = 0
  let count = -1
  while (stable < 20) {
    await sleep(1000)
    const t = await api<{ lines: Line[] }>(`/api/bench/thread?channel=${encodeURIComponent(CHANNEL)}&since=${since}`)
    stable = !utts.size && t.lines.length === count ? stable + 1 : 0
    count = t.lines.length
  }
  const t = await api<{ lines: Line[], stats: Record<string, number>, transcript: string }>(`/api/bench/thread?channel=${encodeURIComponent(CHANNEL)}&since=${since}`)
  const ms = firstChar.map(f => f.ms).sort((a, b) => a - b)
  const latency = { n: ms.length, median: ms[Math.floor(ms.length / 2)] ?? null, p90: ms[Math.floor(ms.length * 0.9)] ?? null, items: firstChar }
  console.log('\n—— 数 ——')
  console.log(JSON.stringify(t.stats))
  console.log(`首字延迟（对方最近一句 → 第一个字）中位 ${latency.median}ms，p90 ${latency.p90}ms，${latency.n} 次`)

  const report: Record<string, unknown> = { tag: TAG, channel: CHANNEL, at: new Date().toISOString(), typing: TYPING, cap: CAP, stats: t.stats, latency, lines: t.lines, transcript: t.transcript }
  if (JUDGE_N > 0) {
    // 逐条：她每句话 + 之前 6 行
    const items = t.lines.flatMap((l, i) => l.who !== 'self'
      ? []
      : [{ id: `r${i}`, scene: 'QQ 私聊，对方是熟人（男生），深夜', context: t.lines.slice(Math.max(0, i - 6), i).map(c => `${c.who === 'self' ? '沐沐' : '对方'}：${c.text}`), reply: `${l.text}${l.truncated ? '（说到这被打断）' : ''}` }])
    const per = await api<{ results: { id: string, score: number | null, problems?: string[] }[] }>('/api/bench/judge', { items })
    const scored = per.results.filter(r => typeof r.score === 'number')
    const runs: any[] = []
    for (let i = 0; i < JUDGE_N; i++)
      runs.push(...(await api<{ results: any[] }>('/api/bench/judge-thread', { threads: [{ id: `${TAG}#${i + 1}`, transcript: t.transcript }] })).results)
    const ok = runs.filter(r => typeof r.score === 'number')
    const counts: Record<string, number> = {}
    for (const r of ok) {
      for (const [k, v] of Object.entries(r.counts ?? {}))
        counts[k] = (counts[k] ?? 0) + Number(v) / ok.length
    }
    report.judge = {
      perLine: { avg: scored.length ? scored.reduce((s, r) => s + r.score!, 0) / scored.length : null, results: per.results },
      thread: { avg: ok.length ? ok.reduce((s, r) => s + r.score, 0) / ok.length : null, counts, runs },
    }
    console.log(`逐条均分 ${(report.judge as any).perLine.avg?.toFixed(2)}，整段均分 ${(report.judge as any).thread.avg?.toFixed(2)}（${ok.length} 次）`)
    console.log(`整段问题（平均次数）${JSON.stringify(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`)
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`报告 ${OUT}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
