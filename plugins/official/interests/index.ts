/**
 * 兴趣（设计见 README）：她自己维护的一张兴趣表，决定「这个话题我想不想聊」。
 *
 * 写：log.appended → Watcher 投影「她这段投不投入」「聊到兴趣没接」（watch.ts）→ 有投入信号的段交一次 interests.read
 *     认出话题 / 投入 / 表态（read.ts）→ 改表（learn.ts → store.ts）；大脑 interest 动作、网页面板、/interests 命令也改表。
 * 读：水线 interests/score（给 group-policy 的话题吸引力：一段文字 → 0～1 的感兴趣程度 + 最相近的兴趣，语义打分见 semantic.ts）；
 *     beat/gather「你最近感兴趣的」；发言者段落「你最近在意的事」（短）。
 * 「这句提没提到兴趣」（水线、日志投影、大脑材料）一律用同一个语义分，不再做关键词包含匹配。
 * 用水线不用服务：本插件改配置会重载，注入服务的插件会被连带重载；没装本插件时调用方拿回初值（0 分）自然降级。
 * 改表的日志（interests.changed / interests.removed）只在定时器、动作、网页里写，不在 log.appended 回调里写。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { LogEvent, MaterialBlock, Plugin, WakeReason } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { Change, LearnConfig } from './learn.ts'
import { applyMiss, applyReading, dislike, like, setByUser } from './learn.ts'
import type { LocalConfig } from './local.ts'
import { localBackend } from './local.ts'
import { buildPrompt, buildRatePrompt, parseRate, read } from './read.ts'
import type { Backend, SemanticConfig } from './semantic.ts'
import { Semantic } from './semantic.ts'
import type { Hit, Seed } from './store.ts'
import { InterestStore } from './store.ts'
import type { Job, WatchConfig } from './watch.ts'
import { textOf, Watcher } from './watch.ts'
import { parseInput, webExtras } from './web.ts'

/** 水线 interests/score 的载荷：调用方传 { text, score: 0, hits: [] }，没人认领就原样回来 */
export interface InterestScore {
  text: string
  score: number // 0～1：感兴趣程度 = 相近度 × 兴趣分，取最高的那条
  hits: Hit[] // 相近的兴趣（{ name, near 相近度, score }），感兴趣程度高的在前
}

/** 语义打分的设置（semantic.ts / local.ts）：via local = 本机 CPU 算向量（默认），model = 让聊天模型打分 */
interface SemanticSettings extends SemanticConfig, LocalConfig {
  via: 'local' | 'model'
  timeoutMs: number // 读空气最多等多久（超时当 0，结果照样进缓存）
  role: string // via model 用的模型角色
}

interface InterestsConfig extends Partial<LearnConfig>, Partial<Omit<WatchConfig, 'words'>> {
  semantic?: Partial<SemanticSettings>
  botName?: string
  role?: string
  halfLifeDays?: number
  personaFloor?: number
  forgetDays?: number
  tickSec?: number
  likeWords?: string[]
  dislikeWords?: string[]
  show?: number
  seed?: Seed[]
}

const plugin: Plugin<InterestsConfig> = {
  name: 'interests',
  inject: ['db', 'commands'],
  apply(ctx, cfg = {}) {
    const store = new InterestStore(ctx.use<DatabaseSync>('db'), () => cfg.halfLifeDays ?? 21)
    store.seed(cfg.seed ?? [], cfg.personaFloor ?? 0.3)
    store.describe(cfg.seed ?? [])
    const learn: LearnConfig = {
      autoAdd: { after: 3, startScore: 0.45, ...cfg.autoAdd },
      step: { engaged: 0.08, ignored: 0.06, like: 0.25, action: 0.2, ...cfg.step },
      ignoreAfter: cfg.ignoreAfter ?? 3,
    }
    const watchCfg: WatchConfig = {
      settleSec: cfg.settleSec ?? 90,
      minTurns: cfg.minTurns ?? 2,
      missWindowSec: cfg.missWindowSec ?? 180,
      positiveEmo: cfg.positiveEmo ?? ['开心', '好奇', '心动', '大笑', '惊讶', '得意'],
      questionWords: cfg.questionWords ?? ['吗', '呢', '咋', '啥', '什么', '多少', '怎么', '哪个', '哪儿'],
      words: [...(cfg.likeWords ?? []), ...(cfg.dislikeWords ?? [])],
      keepLines: cfg.keepLines ?? 16,
    }
    let disposed = false
    ctx.effect(() => () => { disposed = true })

    // ── 语义打分（semantic.ts）：这句离哪条兴趣近 ──
    const sc: SemanticSettings = {
      via: 'local',
      model: 'Xenova/bge-base-zh-v1.5',
      dtype: 'q8',
      pooling: 'cls',
      query: '',
      cacheDir: 'data/models',
      remoteHost: 'https://hf-mirror.com/',
      threshold: 0.16,
      full: 0.26,
      background: [], // 清单 defaults 里有一组日常闲话
      cacheSize: 2000,
      timeoutMs: 300,
      role: 'interests.score',
      ...cfg.semantic,
    }
    // 端点不通 / 模型没下下来时每句都会失败：一分钟只记一次，别把日志刷满
    let lastError = 0
    const onError = (e: unknown): void => {
      if (disposed || Date.now() - lastError < 60_000)
        return
      lastError = Date.now()
      ctx.log.append('interests.failed', { stage: 'score', via: sc.via, error: e instanceof Error ? e.message : String(e) })
    }
    let backend: Backend
    if (sc.via === 'model') {
      backend = {
        rate: async (text, items) => parseRate(await ctx.model.complete({ role: sc.role, messages: buildRatePrompt(cfg.botName ?? '沐沐', items, text) })),
      }
    }
    else {
      const local = localBackend(sc, onError)
      ctx.effect(() => () => { void local.dispose() })
      backend = local
    }
    const sem = new Semantic(backend, () => sc, onError)
    // 装上就在后台加载模型、把兴趣表这头算好；表变了（下面 report 里）再预热一次，只算新的
    void sem.warm(store.active())
    const report = (c: Change | undefined, by: string): void => {
      if (!c)
        return
      ctx.log.append('interests.changed', { ...c, by })
      void sem.warm(store.active())
    }
    /** 这段话离哪些兴趣近；timeoutMs 缺省是读空气的限时 */
    const nearOf = (text: string, timeoutMs = sc.timeoutMs): Promise<Hit[]> => sem.near(text, store.active(), timeoutMs)
    const scoreOf = async (text: string): Promise<{ score: number, hits: Hit[] }> => {
      const hits = await nearOf(text)
      return { score: hits[0]?.score ?? 0, hits }
    }

    // ── 写：从日志看她投不投入 ──
    let seen = {}
    const first = store.meta('seen') === undefined
    try {
      seen = JSON.parse(store.meta('seen') ?? '{}') as object
    }
    catch {
      // 游标坏了只会让最近一小时的段再看一遍，不影响别的
    }
    const watcher = new Watcher(() => watchCfg, seen)
    // 重载 / 重启后回放最近一小时接着攒；游标之前看过的段、判过的没接不再算。
    // 回放不做语义打分（模型可能还在加载，一小时的话挨个等会卡住后面的新消息）：回放那段里「提到兴趣没接」的待定不再判，只丢几分钟的
    const since = Date.now() - 3_600_000
    for (const e of ctx.log.events) {
      if (e.at > since)
        watcher.observe(e)
    }
    // 第一次装上：装之前的对话只当上下文，不补问模型（不然一装上就把最近一小时的几十段全问一遍）
    if (first) {
      watcher.flush()
      store.setMeta('seen', JSON.stringify(watcher.seen(Date.now())))
    }
    // 新事件按到达顺序排队喂：有话的先语义打分认出提到了哪些兴趣（异步），不排队的话她的回话可能比前一句的打分先到，「接没接」就判反了。
    // 这边不卡读空气，可以多等一会儿（读空气那头同一句话已经算过就直接用缓存）
    let chain = Promise.resolve()
    ctx.on<LogEvent>('log.appended', (e) => {
      if (e.type.startsWith('interests.'))
        return
      const text = textOf(e)
      chain = chain.then(async () => {
        const names = text ? (await nearOf(text, Math.max(sc.timeoutMs, 3000))).map(h => h.name) : []
        if (disposed)
          return
        const m = watcher.observe(e, names)
        if (m)
          store.touch(m.names, e.at)
      }).catch((err: unknown) => {
        // 一条事件投影坏了只丢这一条；不接住的话链子一直是拒绝态，后面的事件全喂不进去
        console.warn('[interests] 投影日志失败', err)
      })
    })

    /**
     * 待问的段存库：收段时游标已经记下「这段看过了」，重载（改设置、改文件都会）时内存里的队列要是丢了，就再也补不回来。
     * 问完一段才从队列里拿掉；插件已卸载时迟到的回答不落（新实例会从库里接着问这段）。
     */
    let queue: Job[] = []
    try {
      queue = JSON.parse(store.meta('queue') ?? '[]') as Job[]
    }
    catch {
      // 存坏了就当没有待问的，丢几段而已
    }
    const save = (): void => store.setMeta('queue', JSON.stringify(queue))
    // 同一时刻只问一段（省钱、不抢模型）；正在问时再调拿到的是同一个 Promise，它会把后来排进队的也问完
    let working: Promise<void> | undefined
    const work = (): Promise<void> => working ??= drain().finally(() => { working = undefined })
    const drain = async (): Promise<void> => {
      for (let job = queue[0]; job && !disposed; job = queue[0]) {
        const known = store.list().map(i => i.state === 'on' ? i.name : `${i.name}（候选）`)
        let r
        let error = ''
        try {
          r = await read(req => ctx.model.complete(req), cfg.role ?? 'interests.read', buildPrompt(cfg.botName ?? '沐沐', job.lines, job.signals, known))
          if (!r)
            error = '输出不是合法 JSON'
        }
        catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        if (disposed)
          return
        queue.shift()
        save()
        if (!r) {
          ctx.log.append('interests.failed', { channel: job.channel, error })
          continue
        }
        ctx.log.append('interests.read', { channel: job.channel, signals: job.signals, ...r })
        report(applyReading(store, learn, r), 'chat')
      }
    }
    const tick = (now = Date.now()): void => {
      const due = watcher.due(now)
      queue.push(...due)
      // 模型慢或挂了时别越攒越多：只留最近的几段
      if (queue.length > 12)
        queue.splice(0, queue.length - 12)
      if (due.length)
        save()
      for (const name of watcher.misses(now)) report(applyMiss(store, learn, name, now), 'ignored')
      store.setMeta('seen', JSON.stringify(watcher.seen(now)))
      for (const name of store.sweep(now, cfg.forgetDays ?? 30)) ctx.log.append('interests.removed', { name, by: 'forgot' })
      void work()
    }
    ctx.effect(() => {
      const t = setInterval(() => tick(), (cfg.tickSec ?? 10) * 1000)
      t.unref()
      return () => clearInterval(t)
    })

    // ── 读：给 group-policy 等打分 ──
    ctx.intercept<InterestScore>('interests/score', async (p, next) => {
      const s = await scoreOf(p.text)
      p.score = Math.max(p.score, s.score)
      p.hits = [...p.hits, ...s.hits]
      return next()
    })

    // ── 读：大脑 ──
    ctx.intercept<{ reasons: WakeReason[], blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      const top = store.active().filter(i => i.score >= 0.3).slice(0, cfg.show ?? 3)
      const now = [...new Set((await Promise.all(m.reasons.map(r => nearOf(r.text ?? '')))).flat().map(h => h.name))]
      if (top.length || now.length) {
        const lines = [`【你最近感兴趣的】${top.map(i => i.name).join('、') || '（没什么特别的）'}`]
        if (now.length)
          lines.push(`刚才这句聊到了你感兴趣的：${now.join('、')}——想聊就多接两句。`)
        lines.push('觉得哪个话题有意思 / 没意思，可以起 interest 动作记一下（不用每次都记）。')
        m.blocks.push({ from: 'interests', order: 26, text: lines.join('\n') })
      }
      return next()
    })

    // ── 读：发言者（短；只列最近还在意的几个） ──
    ctx.effect(() => ctx.prompt.section({
      id: 'interests-now',
      audience: 'performer',
      order: PROMPT_ORDER.memory,
      render: () => {
        const top = store.active().filter(i => i.score >= 0.3).slice(0, cfg.show ?? 3)
        return top.length ? `【你最近在意的事】${top.map(i => i.name).join('、')}。聊到了可以多说两句、追问；没聊到别硬扯。` : ''
      },
    }))

    // ── 大脑动作：标「这个有意思 / 没意思」 ──
    ctx.effect(() => ctx.actions.register({
      name: 'interest',
      description: '记下你对某个话题的兴趣：聊着觉得有意思、想以后多聊就标 like；觉得没意思、不想再聊就标 dislike。不说话，只记在你心里。',
      paramsHint: '{"topic":"话题名，2～6 字的名词，如 摄影","like":true,"keywords":["相机","镜头"],"why":"一句话"}',
      run: async (a) => {
        const topic = typeof a.params.topic === 'string' ? a.params.topic.trim() : ''
        if (!topic)
          throw new Error('topic 写话题名')
        const kws = Array.isArray(a.params.keywords) ? a.params.keywords.filter((k): k is string => typeof k === 'string') : []
        const why = typeof a.params.why === 'string' ? a.params.why : ''
        const c = a.params.like === false
          ? dislike(store, topic, kws, `你自己标的没意思${why ? `：${why}` : ''}`, 'self')
          : like(store, learn, topic, kws, learn.step.action, `你自己标的有意思${why ? `：${why}` : ''}`, 'self', Date.now(), true)
        report(c, 'action')
        a.remember(`你把「${c.name}」记成了${a.params.like === false ? '没意思' : '有意思'}`)
      },
    }))

    const set = (name: string, score: number): Change => {
      const c = setByUser(store, name, score)
      report(c, 'user')
      return c
    }
    const remove = (name: string): boolean => {
      const ok = store.remove(name)
      if (ok)
        ctx.log.append('interests.removed', { name, by: 'user' })
      return ok
    }
    webExtras(ctx, { store, after: () => learn.autoAdd.after, score: scoreOf, open: () => watcher.open(), set, remove })

    // ── 命令 ──
    const commands = ctx.use<CommandService>('commands')
    ctx.effect(() => commands.register({
      name: 'interests',
      usage: 'interests [score <文字> | set <名字>=<分> | del <名字> | flush]',
      description: '兴趣表：列出来、给一段话打分、改分 / 新加、删掉、现在就看正在攒的段',
      async run(args, io) {
        const [op, ...rest] = args
        if (!op) {
          for (const i of store.list())
            io.print(`  ${i.name.padEnd(6)} ${i.state === 'on' ? i.score.toFixed(2) : `候选 ${i.hits}/${learn.autoAdd.after}`}  ${i.source}  ${i.desc ? `「${i.desc}」` : ''}${i.keywords.slice(0, 5).join('、')}${i.note ? `  · ${i.note}` : ''}`)
          const open = watcher.open()
          io.print(`  正在看：${open.length ? open.map(o => `${o.channel} ${o.turns} 次`).join('、') : '无'}`)
          return
        }
        if (op === 'score') {
          const t0 = performance.now()
          const s = await scoreOf(rest.join(' '))
          io.print(`  ${s.score.toFixed(2)}  ${s.hits.map(h => `${h.name} 相近 ${h.near.toFixed(2)} → ${h.score.toFixed(2)}`).join('、') || '都不相近'}  （${Math.round(performance.now() - t0)} 毫秒）`)
          return
        }
        if (op === 'set') {
          const p = parseInput(rest.join(' '))
          if (!p?.name || p.score === undefined)
            throw new Error('用法: /interests set <名字>=<0～1>')
          const c = set(p.name, p.score)
          io.print(`  ${c.name} → ${c.to?.toFixed(2)}`)
          return
        }
        if (op === 'del') {
          io.print(remove(rest.join(' ')) ? `  删掉了 ${rest.join(' ')}` : `  没有 ${rest.join(' ')}`)
          return
        }
        if (op === 'flush') {
          const jobs = watcher.flush()
          queue.push(...jobs)
          save()
          store.setMeta('seen', JSON.stringify(watcher.seen(Date.now())))
          await work()
          io.print(`  看了 ${jobs.length} 段`)
          return
        }
        throw new Error('用法: /interests [score <文字> | set <名字>=<分> | del <名字> | flush]')
      },
    }))
  },
}

export default plugin
