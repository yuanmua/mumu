/**
 * 对话探针：对着运行中的沐沐（surface-web，默认 3939）跑打断场景，打印带时间戳的时间线，
 * 并自动核对几条不变量。用法：
 *   npx tsx scripts/probe.ts            # 全部场景
 *   npx tsx scripts/probe.ts s3 s4      # 指定场景
 * 不清任何东西（规矩：测试工具不得整库清空）：每个场景用自己新开的测试频道 c:probe-<时间>-<场景>，
 * 那里没有历史，效果和清空一样；别的频道同时在用她也不串——事件按频道过滤。
 * 送达自己报（像浏览器打字机一样每秒约 40 字地报），不需要开着浏览器。
 */
import process from 'node:process'

const BASE = process.env.MUMU_URL ?? 'http://127.0.0.1:3939'
const RUN = Date.now().toString(36)

interface Ev { t: number, type: string, data: any, seq?: number }
const events: Ev[] = []
let t0 = Date.now()
const rel = (t: number): string => `+${String(t - t0).padStart(5)}ms`

/** 当前场景的测试频道；只收它的事件（没有频道的拍、模型调用照收） */
let current = ''
const idChannel = new Map<string, string>()
const chanOf = (d: any): string | undefined =>
  typeof d?.channel === 'string' ? d.channel : idChannel.get(d?.id) ?? idChannel.get(d?.actionId)

/** 替浏览器报送达：每 50ms 往前报 2 个字（约 40 字/秒），被打断时 delivered 才会是生成文本的真前缀 */
const typing = new Map<string, { gen: number, shown: number }>()
setInterval(() => {
  for (const [id, u] of typing) {
    if (u.shown >= u.gen)
      continue
    u.shown = Math.min(u.gen, u.shown + 2)
    void post('/api/delivered', { uttId: id, chars: u.shown }).catch(() => {})
  }
}, 50).unref()

function keep(e: Ev): boolean {
  const d = e.data ?? {}
  if (e.type === 'utterance.started' || e.type === 'action.started')
    idChannel.set(d.id, d.channel ?? 'main')
  const ch = chanOf(d)
  if (ch !== undefined && ch !== current)
    return false
  if (e.type === 'utterance.started')
    typing.set(d.id, { gen: 0, shown: 0 })
  else if (e.type === 'utterance.part' && d.part?.kind === 'text' && typing.has(d.id))
    typing.get(d.id)!.gen += String(d.part.text ?? '').length
  else if (e.type === 'utterance.settled')
    typing.delete(d.id)
  return true
}

async function listen(): Promise<void> {
  const res = await fetch(`${BASE}/api/events`)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  ;(async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      buf += dec.decode(value, { stream: true })
      let i: number
      // eslint-disable-next-line no-cond-assign
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: '))
            continue
          const e = JSON.parse(line.slice(6))
          const ev = { t: Date.now(), type: e.type, data: e.data, seq: e.seq }
          if (e.type === '__live__' || keep(ev))
            events.push(ev)
        }
      }
    }
  })()
  await until(() => events.some(e => e.type === '__live__'), 5000)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(pred: () => boolean, timeout: number): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (pred())
      return true
    await sleep(25)
  }
  return pred()
}

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok)
    throw new Error(`${path} ${res.status}`)
}

const say = async (text: string): Promise<void> => {
  console.log(`${rel(Date.now())}  USER     ${text}`)
  await post('/api/input', { text, channel: current })
}

/** 等到一段时间内没有 utterance 在途、没有 beat 在开、也没有新事件 */
async function quiet(ms = 2500, timeout = 40_000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const last = events[events.length - 1]?.t ?? 0
    const open = new Set<string>()
    let beating = false
    for (const e of events) {
      if (e.type === 'utterance.started')
        open.add(e.data.id)
      if (e.type === 'utterance.settled')
        open.delete(e.data.id)
      if (e.type === 'beat.opened')
        beating = true
      if (e.type === 'beat.closed' || e.type === 'beat.failed')
        beating = false
    }
    const running = new Set<string>()
    for (const e of events) {
      if (e.type === 'action.started')
        running.add(e.data.id)
      if (e.type === 'action.ended')
        running.delete(e.data.id)
    }
    if (!open.size && !beating && !running.size && Date.now() - last > ms)
      return
    await sleep(100)
  }
  console.log('  (quiet 超时)')
}

function scenarioStart(name: string, id: string): number {
  current = `c:probe-${RUN}-${id}`
  console.log(`\n══════ ${name}（${current}）══════`)
  t0 = Date.now()
  return events.length
}

function printTimeline(from: number): void {
  const utt: Record<string, { text: string, first?: number }> = {}
  for (const e of events.slice(from)) {
    const d = e.data ?? {}
    const r = rel(e.t)
    switch (e.type) {
      case 'percept.received': if (d.sender) console.log(`${r}  percept  ${d.kind} "${d.text}"`); break
      case 'reflex.started': console.log(`${r}  SPINE    ${d.actionId}（脊椎兜底）`); break
      case 'reflex.route': console.log(`${r}  ROUTE    ${d.path}${d.spine ? '（可兜底）' : ''}（${(d.why ?? []).join('、')}，${d.count} 句）`); break
      case 'action.started': console.log(`${r}  action   ${d.id} ${JSON.stringify(d.params)}`); break
      case 'action.ended': console.log(`${r}  action   ${d.id} ${d.outcome}${d.error ? ` ${d.error}` : ''}`); break
      case 'model.request': console.log(`${r}  REQ      ${d.role} (${d.messages.length} msgs)`); break
      case 'model.response': console.log(`${r}  RESP     ${d.role} ${d.chars}字${d.aborted ? ' ABORTED' : ''}`); break
      case 'utterance.started': utt[d.id] = { text: '' }; console.log(`${r}  UTT      ${d.id} 开始`); break
      case 'utterance.part': {
        const u = utt[d.id] ?? (utt[d.id] = { text: '' })
        if (d.part.kind === 'text') {
          if (u.first === undefined) {
            u.first = e.t
            console.log(`${r}  FIRST    ${d.id} 首字 "${d.part.text}"`)
          }
          u.text += d.part.text
        }
        else if (d.part.kind === 'marker') {
          console.log(`${r}  marker   ${d.id} <${d.part.data.track}:${d.part.data.value}> @${u.text.length}`)
        }
        else { console.log(`${r}  part     ${d.id} ${d.part.kind}`) }
        break
      }
      case 'utterance.settled':
        console.log(`${r}  SETTLED  ${d.id} ${d.truncated ? `截断(${d.cause})` : '完整'} delivered=${JSON.stringify(d.delivered)}`)
        if (d.truncated)
          console.log(`${' '.repeat(18)}generated=${JSON.stringify(utt[d.id]?.text ?? '')}`)
        break
      case 'beat.opened': console.log(`${r}  BEAT     开拍 ${d.reasons.map((x: any) => `${x.source}:${(x.text ?? '').slice(0, 20)}`).join(' | ')}`); break
      case 'mind.decision': console.log(`${r}  DECIDE   ${d.aborted ? 'ABORTED ' : ''}${d.tookMs}ms intents=${JSON.stringify(d.intents)} wakeAfter=${d.wakeAfterSec ?? '-'}s\n${' '.repeat(18)}note: ${d.note ?? ''}`); break
      case 'beat.closed': break
      case 'beat.failed': console.log(`${r}  BEAT     FAILED ${d.error}`); break
      case 'emotion.changed': console.log(`${r}  emotion  ${d.label}`); break
      case 'percept.route-error': console.log(`${r}  ERROR    route ${d.error}`); break
      case 'intent.blocked': console.log(`${r}  BLOCKED  start reply（${d.why}）`); break
    }
  }
}

interface Check { name: string, ok: boolean, detail?: string }
function invariants(from: number, lastUserText: string): Check[] {
  const es = events.slice(from)
  const checks: Check[] = []
  // I-a 同一频道不同时有两条 utterance
  let open = 0
  let overlap = false
  for (const e of es) {
    if (e.type === 'utterance.started' && ++open > 1)
      overlap = true
    if (e.type === 'utterance.settled')
      open--
  }
  checks.push({ name: 'I-a 同频道不并行说话', ok: !overlap })
  // I-b delivered 是 generated 的前缀
  const gen: Record<string, string> = {}
  let prefixOk = true
  for (const e of es) {
    if (e.type === 'utterance.started')
      gen[e.data.id] = ''
    if (e.type === 'utterance.part' && e.data.part.kind === 'text')
      gen[e.data.id] += e.data.part.text
    if (e.type === 'utterance.settled' && !(gen[e.data.id] ?? '').startsWith(e.data.delivered))
      prefixOk = false
  }
  checks.push({ name: 'I-b delivered 是生成文本的前缀', ok: prefixOk })
  // I-c 最后一条用户消息之后，只有一条完整回复，且它在该消息之后开始
  const lastUser = [...es].reverse().find(e => e.type === 'percept.received' && e.data.text === lastUserText)
  const after = lastUser ? es.slice(es.indexOf(lastUser)) : es
  const completed = after.filter(e => e.type === 'utterance.settled' && !e.data.truncated && e.data.delivered)
  const staleCompleted = es.filter(e => e.type === 'utterance.settled' && !e.data.truncated && e.data.delivered && lastUser && e.t < lastUser.t)
  checks.push({ name: 'I-c 最后一句之后恰有一条完整回复', ok: completed.length === 1, detail: `完整回复 ${completed.length} 条` })
  checks.push({ name: 'I-c2 没有过时的完整回复晚于新消息开始', ok: !after.some(e => e.type === 'utterance.settled' && !e.data.truncated && e.data.delivered && es.find(s => s.type === 'utterance.started' && s.data.id === e.data.id)!.t < (lastUser?.t ?? 0)) || staleCompleted.length === 0 })
  // I-d 大脑门控（2026-10-22 起）：每次合流结束有一条 reflex.route（path=think，spine 标兜底白名单）。
  // 脊椎不抢先开口：reflex.started 只能是兜底——紧跟一条 path=fallback 的 route，且距对方那句 ≥ 2000ms
  // （兜底默认 2500ms，从合流结束算起）。别的开口都是大脑起的 reply（quick 或带 guidance）
  const lastU = lastUser ?? es.find(e => e.type === 'percept.received' && e.data.sender)
  const routes = es.filter(e => e.type === 'reflex.route')
  const lastRfx = lastU ? es.find(e => e.type === 'reflex.started' && e.t >= lastU.t) : undefined
  const spineOk = routes.some(r => r.data.path === 'think') && es.filter(e => e.type === 'reflex.started').every((rfx) => {
    const before = [...es].reverse().find(e => e.type === 'percept.received' && e.data.sender && e.t <= rfx.t)
    const fb = es.find(e => e.type === 'reflex.route' && e.data.path === 'fallback' && e.t >= rfx.t && e.t - rfx.t < 200)
    return !!before && !!fb && rfx.t - before.t >= 2000
  })
  checks.push({
    name: 'I-d 脊椎不抢先开口（只在大脑 ≥2s 没决定时兜底）',
    ok: spineOk,
    detail: routes.map(r => `${r.data.path}${r.data.spine ? '*' : ''}(${(r.data.why ?? []).join('、')})`).join(' → ') || '没有分流记录',
  })
  // I-e 没有失败
  const bad = es.filter(e => e.type === 'beat.failed' || (e.type === 'action.ended' && e.data.outcome === 'error') || e.type === 'percept.route-error')
  checks.push({ name: 'I-e 没有 beat.failed / 动作出错', ok: bad.length === 0, detail: bad.map(b => b.type).join(',') })
  // I-f 首字延迟（大脑门控）：快回（大脑放行的 quick，或脊椎兜底，reply 带 reflex）< 3s——探针走网页私聊，
  // 先有 0.35–0.8s 合流窗口，再一次决策（约 1s）+ 简短发言首字（约 0.7s）；群里不合流，「在吗」实测开口 1–1.8s。
  // 大脑带想法回的是正常发言、guidance 更长，< 5s
  const first = lastU ? es.find(e => e.type === 'utterance.part' && e.data.part.kind === 'text' && e.t >= lastU.t) : undefined
  const firstReply = lastU ? es.find(e => e.type === 'action.started' && e.data.type === 'reply' && e.t >= lastU.t) : undefined
  const quickPath = !!firstReply?.data.params?.reflex
  const budget = quickPath ? 3000 : 5000
  const how = lastRfx ? `脊椎兜底 ${lastRfx.t - lastU!.t}ms` : quickPath ? 'quick' : '大脑带想法'
  checks.push({ name: `I-f 最后一句之后首字 < ${budget / 1000}s`, ok: !!lastU && !!first && first.t - lastU.t < budget, detail: lastU && first ? `${first.t - lastU.t}ms（${how}）` : '无首字' })
  const blocked = es.filter(e => e.type === 'intent.blocked')
  checks.push({ name: 'I-g 硬闸拦截次数（信息）', ok: true, detail: `${blocked.length} 次 ${blocked.map(b => b.data.why).join(',')}` })
  return checks
}

const scenarios: Record<string, { title: string, run: () => Promise<string> }> = {
  s1: {
    title: '单句：测首字延迟、大脑怎么回（脊椎不抢先）',
    run: async () => {
      await say('你好呀，在干嘛呢')
      await quiet()
      return '你好呀，在干嘛呢'
    },
  },
  s2: {
    title: '连发两句（间隔 150ms）：只开一次口，回应合并后的内容',
    run: async () => {
      await say('在吗')
      await sleep(150)
      await say('我想问你个事')
      await quiet()
      return '我想问你个事'
    },
  },
  s3: {
    title: '说话中打断（3s 后）：截断、delivered 前缀、新回复回应新话',
    run: async () => {
      await say('给我讲讲你最近喜欢听的歌吧，多说一点')
      await sleep(3000)
      await say('等等，先别说这个，我今天好累')
      await quiet()
      return '等等，先别说这个，我今天好累'
    },
  },
  s4: {
    title: '思考中打断（700ms 后，大脑还在想）：作废重想，不出现过时回复',
    run: async () => {
      await say('你觉得猫好还是狗好')
      await sleep(700)
      await say('算了不问这个，你今天心情怎么样')
      await quiet()
      return '算了不问这个，你今天心情怎么样'
    },
  },
  s5: {
    title: '连续三句（0 / 1.5s / 3s）：每次都切到最新，最后只有一条完整回复',
    run: async () => {
      await say('我跟你说件事')
      await sleep(1500)
      await say('今天上班的时候')
      await sleep(1500)
      await say('算了，太长了，改天再说吧')
      await quiet()
      return '算了，太长了，改天再说吧'
    },
  },
  s6: {
    title: '回复刚结束立刻再说：不抢话、不重复',
    run: async () => {
      await say('晚安')
      await quiet(1500)
      await say('等一下，忘了说，明天记得提醒我买牛奶')
      await quiet()
      return '等一下，忘了说，明天记得提醒我买牛奶'
    },
  },
}

async function main(): Promise<void> {
  const picked = process.argv.slice(2).filter(a => scenarios[a])
  const list = picked.length ? picked : Object.keys(scenarios)
  await listen()
  const summary: { id: string, checks: Check[] }[] = []
  for (const id of list) {
    const sc = scenarios[id]
    const from = scenarioStart(`${id} ${sc.title}`, id)
    const lastUser = await sc.run()
    await sleep(300)
    printTimeline(from)
    const checks = invariants(from, lastUser)
    for (const c of checks)
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `（${c.detail}）` : ''}`)
    summary.push({ id, checks })
    await sleep(1500)
  }
  console.log('\n══════ 汇总 ══════')
  for (const s of summary)
    console.log(`${s.id}: ${s.checks.filter(c => c.ok).length}/${s.checks.length} ${s.checks.filter(c => !c.ok).map(c => `✗${c.name}`).join(' ')}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
