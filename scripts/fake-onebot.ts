/**
 * 假 NapCat：群聊模拟器。不用真 QQ 登录，就能看沐沐在群里的表现。
 *
 * 它在 3001 口开一个 OneBot v11 WebSocket 服务端（NapCat 的「正向 WS」那一侧），surface-onebot 照常连上来；
 * 剧本里的五个假群友按时间发群消息 / 私聊 / @ / 图片 / 表情包，她发出的每条消息都记下来。
 * 同时订阅后端日志（surface-web 的 /api/events），把接话策略的打分、导演的念头、开口与说完对上时间线。
 * 最后出一份带时间戳的报告：她在哪些消息上开口、沉默多久、每分钟几条、有没有刷屏、每次回的是哪句。
 *
 * 用法（在后端那台机器上、后端已在跑、没有真 NapCat 占着 3001 时）：
 *   npx tsx scripts/fake-onebot.ts                # 全部场景
 *   npx tsx scripts/fake-onebot.ts at name        # 指定场景（id 见 fake-onebot/scenes.ts）
 *   npx tsx scripts/fake-onebot.ts mem-teach mem-recall   # 记忆验收（会压摘要、写记忆表），只在点名时跑
 *   npx tsx scripts/fake-onebot.ts --list         # 列场景
 * 选项：--port 3001  --mumu http://127.0.0.1:3939
 *       --keep-groups  用剧本里的原群号（默认每轮加偏移换新群，免得上一轮的聊天混进历史；测记忆跨天时要固定群号）
 *       --collect-stickers  表情包不标 sim，让她收进库（只对 retest-clone.sh 的克隆实例用，拒绝 3939）
 * 报告另存一份到 data/sim-reports/。不清日志：模拟的群聊留在真源里，记忆插件也能学到。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { ensureImages, imageDir } from './fake-onebot/images.ts'
import { Timeline } from './fake-onebot/report.ts'
import type { Scene, Step } from './fake-onebot/scenes.ts'
import { MEMBERS, SCENES } from './fake-onebot/scenes.ts'
import { FakeNapCat } from './fake-onebot/napcat.ts'

const SELF = { id: 10000, name: '沐沐' }
const args = process.argv.slice(2)
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args.splice(i, 2)[1] : def
}
const PORT = Number(opt('port', '3001'))
const MUMU = opt('mumu', 'http://127.0.0.1:3939')
const HOLD = Number(opt('hold', '0')) // 跑完后图片服务再开多少秒（网页上要看群友发的图时用）
const GROUP_OFFSET = args.includes('--keep-groups') ? 0 : (Math.floor(Date.now() / 60_000) % 9000 + 1000) * 1000
// 表情包不带 sim、让她收进库：只给 retest-clone.sh 的一次性克隆用（库随克隆目录删掉），sticker-feed → sticker-use 才测得到发图
const COLLECT_STICKERS = args.includes('--collect-stickers')
if (COLLECT_STICKERS && /:3939\b/.test(MUMU)) {
  console.error('--collect-stickers 只许对着一次性克隆实例用，3939 是正式实例')
  process.exit(1)
}

if (args.includes('--list')) {
  for (const s of SCENES) console.log(`${s.id.padEnd(12)} ${s.title}${s.manual ? '（点名才跑）' : ''}`)
  process.exit(0)
}
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? SCENES.filter(s => names.includes(s.id)) : SCENES.filter(s => !s.manual)
if (!chosen.length) {
  console.error('没有这些场景，--list 看全部')
  process.exit(1)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(pred: () => boolean, timeout: number): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (pred())
      return true
    await sleep(100)
  }
  return pred()
}

// ── 假 NapCat（协议层在 fake-onebot/napcat.ts）──
let current: Timeline | undefined
const herMsgs = new Map<string, number>() // 频道 → 她最近一条的 message_id（「回复她」用）
let hashes: Map<string, string> | undefined // 剧本图片的内容摘要 → 文件名（认出她发的是哪张表情包）
const open = new Set<string>() // 后端里在途的发言
const acting = new Set<string>() // 后端里在跑的动作
let beating = false
let lastEventAt = 0

const images = ensureImages()
const nap = new FakeNapCat(PORT, imageDir())
for (const m of Object.values(MEMBERS)) nap.members.set(m.id, { name: m.name })
nap.onConnect = () => console.log('· surface-onebot 连上来了')
nap.onSent = ({ channel, messageId, message }) => {
  herMsgs.set(channel, messageId)
  keepImages(message)
  if (current?.has(channel))
    current.outs.push({ t: Date.now(), ch: channel, text: show(message) })
  else
    console.log(`  （场景外）${channel} 沐沐：${show(message)}`)
}
// 群名在连上之前就登记好：surface-onebot 一连上就拉 get_group_list，场景开始时再登记就晚了
for (const scene of chosen) {
  for (const st of scene.steps) {
    const ch = 'who' in st ? channelOf(scene, st) : scene.group ? `qq:group:${gid(scene.group)}` : ''
    if (ch.startsWith('qq:group:'))
      nap.groups.set(Number(ch.slice('qq:group:'.length)), `模拟·${scene.id}`)
  }
}
await nap.start()
console.log(`· 假 NapCat 在 ws://127.0.0.1:${PORT}（图片 http://${nap.imageHost}:${PORT}/img/），图片 ${images.length} 张；等 surface-onebot 连上…`)

// ── 后端日志 ──
await listen()
const policyCfg = await groupPolicyConfig()
if (!await until(() => nap.open, 40_000)) {
  console.error('✗ 40 秒内 surface-onebot 没连上来（它在跑吗？url 是不是 ws://127.0.0.1:3001？）')
  await nap.close()
  process.exit(1)
}
await sleep(1500) // 让它拿完登录信息、注册好表现端

const results: { scene: Scene, tl: Timeline, stats: string, checks: string[] }[] = []
for (const scene of chosen) {
  const target = scene.group ? undefined : firstSpeaker(scene)
  const channel = scene.group ? `qq:group:${gid(scene.group)}` : `qq:private:${target!.id}`
  const tl = new Timeline(scene, channel, policyCfg)
  for (const st of scene.steps) {
    if ('who' in st)
      tl.channels.add(channelOf(scene, st))
  }
  for (const ch of tl.channels) {
    if (ch.startsWith('qq:group:'))
      nap.groups.set(Number(ch.slice('qq:group:'.length)), `模拟·${scene.id}`)
  }
  current = tl
  console.log(`\n══════ ${scene.id} · ${scene.title}（${[...tl.channels].join('、')}）══════`)
  const restore = await runSteps(scene, tl)
  await quiet(channel, scene.settleMs)
  const end = Date.now()
  current = undefined
  for (const [plugin, old] of restore)
    await command(`/config set plugins.${plugin} ${old}`)
  for (const l of tl.render()) console.log(l)
  const checks = scene.check(tl)
  const stats = tl.stats(end).line
  console.log(`  —— ${stats}`)
  for (const p of tl.pairs()) console.log(p)
  for (const c of checks) console.log(`  ${c}`)
  results.push({ scene, tl, stats, checks })
  await sleep(3000)
}

// ── 汇总 ──
const summary: string[] = ['', '══════ 汇总 ══════']
let fails = 0
for (const r of results) {
  fails += r.tl.failed
  summary.push(`${r.tl.failed ? '✗' : '✓'} ${r.scene.id.padEnd(9)} ${r.stats}`)
}
summary.push(fails ? `${fails} 项核对没过` : '全部核对通过')
for (const l of summary) console.log(l)

mkdirSync('data/sim-reports', { recursive: true })
const file = `data/sim-reports/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
writeFileSync(file, results.map(r => [
  `══════ ${r.scene.id} · ${r.scene.title}（${[...r.tl.channels].join('、')}）`,
  ...r.tl.render(),
  `  —— ${r.stats}`,
  ...r.tl.pairs(),
  ...r.checks.map(c => `  ${c}`),
  '',
].join('\n')).join('\n') + summary.join('\n'))
console.log(`报告：${file}`)
if (HOLD > 0) {
  console.log(`· 图片服务再开 ${HOLD} 秒（http://${nap.imageHost}:${PORT}/img/）`)
  await sleep(HOLD * 1000)
}
await nap.close()
process.exit(fails ? 1 : 0)

// ── 剧本执行 ──
/** 返回要还原的配置：插件 id → 改之前库里的那份（没有就是 {}） */
async function runSteps(scene: Scene, tl: Timeline): Promise<Map<string, string>> {
  const restore = new Map<string, string>()
  for (const step of scene.steps) {
    if ('wait' in step) {
      await sleep(step.wait)
      continue
    }
    if ('command' in step) {
      const line = step.command.replace('{channel}', tl.channel)
        .replace(/\{private:([^}]+)\}/g, (_m, who: string) => `qq:private:${MEMBERS[who]?.id ?? who}`)
      const out = (await command(line))?.trim() ?? '（命令失败）'
      tl.commandOut.push(out.replace(/\s*\n\s*/g, '；'))
      console.log(`  命令 ${line} →\n${out}`)
      continue
    }
    if ('config' in step) {
      const plugin = step.plugin ?? 'group-policy'
      if (!restore.has(plugin)) {
        const old = (await command(`/config get plugins.${plugin}`))?.trim()
        restore.set(plugin, !old || old === 'undefined' ? '{}' : old)
      }
      for (const [k, v] of Object.entries(step.config))
        await command(`/config set plugins.${plugin}.${k} ${JSON.stringify(v)}`)
      await sleep(1500) // 等插件按新配置重载
      continue
    }
    if (step.react) { // 等她在这个频道发出下一条再「秒回」（她一直不说就到点照发）
      const ch = channelOf(scene, step)
      const seen = tl.outs.filter(o => o.ch === ch).length
      await until(() => tl.outs.filter(o => o.ch === ch).length > seen, step.react)
    }
    await sleep(step.after ?? 2000)
    send(scene, step, tl)
  }
  return restore
}

type Say = Extract<Step, { who: string }>

/** 群号加本轮偏移：每轮用新群，上一轮的聊天不会混进这一轮的历史（--keep-groups 关掉） */
function gid(n: number): number {
  return n + GROUP_OFFSET
}

function channelOf(scene: Scene, step: Say): string {
  if (step.to === 'private' || (!step.to && !scene.group))
    return `qq:private:${MEMBERS[step.who].id}`
  return `qq:group:${gid((step.to ?? scene.group)!)}`
}

function send(scene: Scene, step: Say, tl: Timeline): void {
  const m = MEMBERS[step.who]
  const ch = channelOf(scene, step)
  const group = ch.startsWith('qq:group:') ? Number(ch.slice('qq:group:'.length)) : undefined
  const segs: { type: string, data: Record<string, unknown> }[] = []
  if (step.replyHer && herMsgs.has(ch))
    segs.push({ type: 'reply', data: { id: String(herMsgs.get(ch)) } })
  if (step.at)
    segs.push({ type: 'at', data: { qq: String(SELF.id), name: SELF.name } })
  if (step.text)
    segs.push({ type: 'text', data: { text: step.at ? ` ${step.text}` : step.text } })
  for (const [file, sticker] of [[step.image, false], [step.sticker, true]] as const) {
    if (!file)
      continue
    if (images.includes(file))
      // sim：模拟器生成的图，surface-onebot 照常描述但不收进表情包库（混进正式库她会在真群里发出去）
      segs.push({ type: 'image', data: { file, url: nap.imageUrl(file), sub_type: sticker ? 1 : 0, summary: sticker ? '[动画表情]' : '', ...(sticker && COLLECT_STICKERS ? {} : { sim: true }) } })
    else
      segs.push({ type: 'text', data: { text: sticker ? '[表情包]' : '[图片]' } })
  }
  const raw = segs.map(s => s.type === 'text' ? String(s.data.text) : s.type === 'at' ? `@${SELF.name}` : `[${s.type}]`).join('')
  const ev = {
    post_type: 'message',
    message_type: group ? 'group' : 'private',
    sub_type: group ? 'normal' : 'friend',
    time: now(),
    self_id: SELF.id,
    user_id: m.id,
    group_id: group,
    message_id: nap.nextId(),
    message: segs,
    raw_message: raw,
    font: 0,
    sender: { user_id: m.id, nickname: m.name, card: group ? m.name : undefined },
  }
  tl.ins.push({ t: Date.now(), ch, who: m.name, text: raw })
  nap.push(ev)
}

function firstSpeaker(scene: Scene): { id: number, name: string } {
  const s = scene.steps.find(x => 'who' in x) as { who: string } | undefined
  return MEMBERS[s?.who ?? '小林']
}

// ── 后端 ──
/**
 * 订阅后端日志。surface-web 被热重载（比如有人正在改它的代码）时 SSE 会断：断了就重连，
 * 重连时服务端先重放存量——按 seq 去重，只补断线期间新增的那些。第一次连接的重放全跳过。
 */
async function listen(): Promise<void> {
  let lastSeq = -1 // 第一次连接时为 -1：重放的存量不算这次模拟的事
  let ready = false
  const connect = async (): Promise<void> => {
    const res = await fetch(`${MUMU}/api/events`).catch(() => undefined)
    if (!res?.ok || !res.body)
      throw new Error(`连不上后端 ${MUMU}/api/events`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        return
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: '))
            continue
          const e = JSON.parse(line.slice(6)) as { type: string, seq?: number, data?: any }
          if (e.type === '__live__') {
            ready = true
            lastSeq = Math.max(lastSeq, 0)
            continue
          }
          if (e.type === '__reset__') { // 日志被清空，序号从头来
            lastSeq = 0
            continue
          }
          if (typeof e.seq !== 'number')
            continue
          if (!ready) { // 第一次的重放：只记序号
            lastSeq = Math.max(lastSeq, e.seq)
            continue
          }
          if (e.seq <= lastSeq)
            continue
          lastSeq = e.seq
          onEvent(e.type, e.data ?? {})
        }
      }
    }
  }
  void (async () => {
    while (true) {
      try {
        await connect()
        if (ready)
          console.log('  （后端日志流断了，重连中…）')
      }
      catch (e) {
        if (!ready) {
          console.error(`✗ ${e instanceof Error ? e.message : e}`)
          process.exit(1)
        }
      }
      await sleep(1000)
    }
  })()
  await until(() => ready, 5000)
}

function onEvent(type: string, d: any): void {
  const t = Date.now()
  const tl = current
  if (type === 'utterance.started')
    open.add(d.id)
  else if (type === 'utterance.settled')
    open.delete(d.id)
  else if (type === 'beat.opened')
    beating = true
  else if (type === 'beat.closed' || type === 'beat.failed')
    beating = false
  else if (type === 'action.started')
    acting.add(d.id)
  else if (type === 'action.ended')
    acting.delete(d.id)
  if (!tl)
    return
  if (type === 'action.started' && d.type !== 'reply')
    tl.actions.push({ t, id: d.id, type: d.type, ch: d.channel, params: d.params })
  else if (type === 'guard.blocked')
    tl.guards.push({ t, action: String(d.action ?? ''), who: String(d.who ?? ''), why: String(d.why ?? '') })
  else if (type === 'guard.confirmed' || type === 'guard.denied')
    // 主人点头 / 不让做（guard 规则 5、6）：点头后是 guard 替她起的动作，不是大脑
    tl.marks.push({ t, type, text: `${d.label ?? ''}（${d.who ?? ''} 要的）← 主人「${d.answer ?? ''}」` })
  else if (type === 'temper.ignored' || type === 'temper.forgiven')
    tl.marks.push({ t, type, text: `${d.name ?? d.key}${d.mode ? `（${d.mode}${d.minutes ? ` ${d.minutes} 分钟` : ''}）` : ''}：${d.why ?? ''}`, until: typeof d.until === 'number' ? d.until : undefined })
  else if (type === 'convo.pending' && typeof d.channel === 'string' && tl.has(d.channel))
    // 她说话时正在聊的人又说了：说完补判（group-policy nudge），记下掷了多少、叫没叫醒
    tl.marks.push({ t, type, text: `${d.name ?? d.who} ${d.lines} 句 p=${d.p} ${d.wake ? '叫醒' : '没叫醒'}` })
  else if ((type === 'convo.started' || type === 'convo.ended') && typeof d.channel === 'string' && tl.has(d.channel))
    // 和谁聊上 / 为什么放下（「没接她的话」「群里在聊别的了」）：real-ignored 核对用
    tl.marks.push({ t, type, text: `${d.name ?? d.who}${d.why ? `：${d.why}` : ''}` })
  const mine = typeof d.channel === 'string' && tl.has(d.channel)
  if (mine || type === 'mind.decision')
    lastEventAt = t
  if (type === 'percept.received' && mine && d.sender)
    tl.percept(d.channel, String(d.text ?? ''), String(d.sender.name ?? d.sender.id))
  else if (type === 'group.policy' && mine)
    tl.policy(d.channel, { t, p: d.p, why: d.why ?? [], wake: !!d.wake }, String(d.sender?.name ?? d.sender?.id))
  else if (type === 'utterance.started' && mine)
    tl.startList.push({ t, ch: d.channel, id: d.id, action: d.action })
  else if (type === 'utterance.settled' && mine)
    tl.settles.push({ t, id: d.id, delivered: String(d.delivered ?? ''), cause: d.cause })
  else if (type === 'mind.decision')
    tl.thinks.push({ t, note: String(d.note ?? ''), intents: d.intents ?? [], aborted: d.aborted })
  else if (type === 'intent.blocked' && mine)
    tl.blocks.push({ t, why: String(d.why ?? '') })
}

/** 等她这个频道安静下来：没有在途发言、导演没在想、8 秒内没有新动静 */
async function quiet(channel: string, timeout = 180_000): Promise<void> {
  // 最后一句刚发出时她可能还没反应（反射 350ms、导演要想一两秒），所以也从最后一句发出算起
  const lastIn = current?.ins.at(-1)?.t ?? 0
  // 电脑任务之类的动作也等它做完（做完会回报导演、她再开口），默认最多三分钟（场景可以自己定 settleMs）
  const ok = await until(() => !open.size && !acting.size && !beating && Date.now() - lastEventAt > 8000
    && Date.now() - (current?.outs.at(-1)?.t ?? 0) > 8000 && Date.now() - lastIn > 10_000, timeout)
  if (!ok)
    console.log(`  （${channel} ${Math.round(timeout / 1000)} 秒没安静下来，强行进下一个场景）`)
}

/** 她发出的图片存一份到 data/sim-reports/，报告里写路径，人能打开看是不是真截图 / 真找到的图 */
function keepImages(message: unknown): void {
  if (!Array.isArray(message))
    return
  for (const s of message as { type: string, data?: Record<string, unknown> }[]) {
    const file = String(s.data?.file ?? '')
    if (s.type !== 'image' || !file.startsWith('file://'))
      continue // 表情包是 base64，按摘要认（show），不另存
    const src = decodeURIComponent(file.replace(/^file:\/\/\/?/, '/'))
    try {
      // 文件名不用模块级计数器：顶层 await 跑场景时，写在文件末尾的 let 还没初始化
      const out = `data/sim-reports/img-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}${src.slice(src.lastIndexOf('.'))}`
      mkdirSync('data/sim-reports', { recursive: true })
      writeFileSync(out, readFileSync(src))
      s.data = { ...s.data, kept: out }
    }
    catch (e) {
      // 读不到（NapCat 不在同机时路径对不上）：报告里照样记「[图片]」，只是没留底
      console.log(`  （她发的图 ${src} 读不到：${e instanceof Error ? e.message : e}）`)
    }
  }
}

async function command(line: string): Promise<string | undefined> {
  const res = await fetch(`${MUMU}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ line }) })
  if (!res.ok)
    return undefined
  const body = await res.json() as { lines?: string[] }
  return (body.lines ?? []).join('\n')
}

/** group-policy 此刻实际生效的配置（清单默认 + 库里覆盖），核对里比上限用 */
async function groupPolicyConfig(): Promise<Record<string, unknown>> {
  let defaults: Record<string, unknown> = {}
  try {
    defaults = JSON.parse(readFileSync('plugins/official/group-policy/package.json', 'utf8')).mumu?.defaults ?? {}
  }
  catch {
    // 不在仓库根目录跑：核对用默认数
  }
  const raw = (await command('/config get plugins.group-policy'))?.trim()
  let patch: Record<string, unknown> = {}
  try {
    patch = raw && raw !== 'undefined' ? JSON.parse(raw) : {}
  }
  catch {
    // 打印格式变了：只用清单默认
  }
  return { ...defaults, ...patch }
}

function show(message: unknown): string {
  if (typeof message === 'string')
    return message
  if (!Array.isArray(message))
    return String(message)
  return message.map((s: { type: string, data?: Record<string, unknown> }) => {
    if (s.type === 'text')
      return String(s.data?.text ?? '')
    if (s.type === 'file')
      return `[文件 ${s.data?.name ?? ''} ← ${s.data?.file ?? ''}]`
    if (s.type !== 'image')
      return `[${s.type}]`
    // 她发的表情包是 base64：按内容摘要认出是剧本里的哪一张
    const file = String(s.data?.file ?? '')
    if (file.startsWith('base64://')) {
      const name = knownImages().get(createHash('sha1').update(Buffer.from(file.slice(9), 'base64')).digest('hex'))
      if (name)
        return `[表情包:${name.replace(/^sticker-|\.png$/g, '')}]`
    }
    return `[图片${s.data?.summary ? ` ${s.data.summary}` : ''}${s.data?.kept ? ` → ${s.data.kept}` : ''}]`
  }).join('')
}

function knownImages(): Map<string, string> {
  hashes ??= new Map(images.map(f => [createHash('sha1').update(readFileSync(join(imageDir(), f))).digest('hex'), f]))
  return hashes
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}
