/**
 * 网页对话驱动：不开浏览器，替浏览器跟她聊几句并报送达，打印带时间戳的时间线。
 *
 * 网页频道的发言要等「表现端回报实际显示了多少字」才结算（I2）；平时是浏览器报，这里自己报——
 * 收到 utterance.part 就按累计字数 POST /api/delivered。所以跑它时最好没有浏览器开着同一个对话。
 *
 * 用法：npx tsx scripts/web-chat.ts [--channel c:test] [--wait 120] [--listen 秒] "第一句" "第二句" …
 *   每句发出后等她安静（没有在途发言、没有在跑的动作、导演没在想、N 秒没动静）再发下一句；
 *   动作（computer / extend …）跑完才算安静，最多等 --wait 秒。
 */
import process from 'node:process'

const args = process.argv.slice(2)
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args.splice(i, 2)[1] : def
}
const BASE = opt('mumu', 'http://127.0.0.1:3939')
const CHANNEL = opt('channel', `c:web-chat-${Date.now().toString(36)}`)
const WAIT = Number(opt('wait', '240')) * 1000
const LISTEN = Number(opt('listen', '0')) * 1000 // 说完以后再只听这么久（等定时触发的事）
const lines = args.filter(a => !a.startsWith('--'))

const t0 = Date.now()
const rel = (): string => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const open = new Map<string, string>() // 本频道在途发言 → 已显示的文字
const acting = new Set<string>()
let beating = false
let last = Date.now()
const mine = new Set<string>() // 本频道的发言 id

async function listen(): Promise<void> {
  const res = await fetch(`${BASE}/api/events`)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let live = false
  void (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        console.log(`${rel()}  （日志流断了）`)
        return
      }
      buf += dec.decode(value, { stream: true })
      let i: number
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
            void onEvent(e.type, e.data ?? {})
        }
      }
    }
  })()
  while (!live) await sleep(50)
}

async function onEvent(type: string, d: any): Promise<void> {
  last = Date.now()
  switch (type) {
    case 'utterance.started':
      if (d.channel === CHANNEL) {
        mine.add(d.id)
        open.set(d.id, '')
      }
      break
    case 'utterance.part':
      if (mine.has(d.id) && d.part?.kind === 'text') {
        const text = (open.get(d.id) ?? '') + String(d.part.text ?? '')
        open.set(d.id, text)
        await post('/api/delivered', { uttId: d.id, chars: text.length }) // 替浏览器报：全显示了
      }
      break
    case 'utterance.settled':
      if (mine.has(d.id)) {
        open.delete(d.id)
        console.log(`${rel()}  她：${String(d.delivered ?? '').replace(/\s+/g, ' ')}${d.truncated ? `（被打断：${d.cause}）` : ''}`)
      }
      break
    case 'action.started':
      acting.add(d.id)
      if (!String(d.id).startsWith('reply#'))
        console.log(`${rel()}  动作 ${d.id} ${JSON.stringify(d.params ?? {}).slice(0, 200)}`)
      break
    case 'action.ended':
      acting.delete(d.id)
      if (!String(d.id).startsWith('reply#'))
        console.log(`${rel()}  动作 ${d.id} 结束：${d.outcome}${d.error ? ` ${d.error}` : ''}`)
      break
    case 'beat.opened': beating = true; break
    case 'beat.closed': case 'beat.failed': beating = false; break
    case 'mind.decision':
      console.log(`${rel()}  导演 ${d.aborted ? '(作废) ' : ''}${d.note ?? ''}${d.intents?.length ? ` ⇒ ${JSON.stringify(d.intents).slice(0, 240)}` : ''}`)
      break
    case 'extend.attempt':
      console.log(`${rel()}  extend ${d.name} 第 ${d.n} 次没过：${(d.problem ?? []).join('；').slice(0, 400)}`)
      break
    case 'extend.installed':
      console.log(`${rel()}  extend ${d.name} 装上了（${d.tries} 次）：${d.summary}`)
      break
    case 'guard.blocked':
      console.log(`${rel()}  guard 拦下 ${d.action}（${d.who}：${d.why}）`)
      break
    case 'percept.received':
      if (!d.sender && d.channel === CHANNEL)
        console.log(`${rel()}  感知 ${d.kind}：${String(d.text ?? '').slice(0, 300)}`)
      else if (!d.sender && d.kind && !String(d.kind).startsWith('performer'))
        console.log(`${rel()}  感知 ${d.kind}（${d.channel}）：${String(d.text ?? '').slice(0, 200)}`)
      break
  }
}

async function quiet(): Promise<void> {
  const end = Date.now() + WAIT
  await sleep(1500)
  while (Date.now() < end) {
    if (!open.size && !acting.size && !beating && Date.now() - last > 15_000)
      return
    await sleep(250)
  }
  console.log(`${rel()}  （${WAIT / 1000} 秒没安静下来）`)
}

await listen()
console.log(`频道 ${CHANNEL}`)
for (const text of lines) {
  console.log(`${rel()}  我：${text}`)
  await post('/api/input', { text, channel: CHANNEL })
  await quiet()
}
if (LISTEN) {
  console.log(`${rel()}  （只听 ${LISTEN / 1000} 秒）`)
  await sleep(LISTEN)
  await quiet()
}
process.exit(0)
