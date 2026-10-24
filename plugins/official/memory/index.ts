/**
 * 长期记忆（设计见 README）：按人组织，三层——短期（history）、中期摘要、长期印象。
 *
 * 写：log.appended → Collector 按会话攒（collect.ts）→ 攒够一段或安静下来 → 一次 memory.summarize
 *     出摘要 + 人物印象 / 事实 + 群印象（summarize.ts）→ mem_* 表（store.ts）。同一时刻只压一段，省钱也免得抢模型。
 * 读：reply/prompt（action-reply 的水线）按这次的频道与对象召回一段「你记得的」（recall.ts，按来源过滤）；
 *     beat/gather 给导演唤醒原因里那几个人的一句话印象。
 * 记忆跨频道共享（她是同一个人），但群里的私事不往别的群说——过滤在召回时做，存的时候每条都带来源。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryTurn, LogEvent, MaterialBlock, Plugin, Sender, WakeReason } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import type { ReplyPrompt } from '../action-reply/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { BotsService } from '../group-policy/index.ts'
import { Collector, SELF } from './collect.ts'
import { briefOf, recall } from './recall.ts'
import { MemoryStore } from './store.ts'
import type { Person } from './store.ts'
import { buildPrompt, digest } from './summarize.ts'
import { webExtras } from './web.ts'

interface MemoryConfig {
  botName?: string
  ownerName?: string
  role?: string
  groupPrefixes?: string[]
  webChannels?: string[]
  aliases?: Record<string, string>
  chunk?: number
  groupChunk?: number
  minTurns?: number
  idleSec?: number
  checkSec?: number
  maxFacts?: number
  recallChars?: number
  recallEpisodes?: number
  recallPeople?: number
  timeZone?: string
}

const plugin: Plugin<MemoryConfig> = {
  name: 'memory',
  inject: ['db', 'commands'],
  apply(ctx, cfg = {}) {
    const store = new MemoryStore(ctx.use<DatabaseSync>('db'))
    const web = cfg.webChannels ?? ['main', 'c:']
    const isWeb = (ch: string): boolean => web.some(w => ch === w || (w.endsWith(':') && ch.startsWith(w)))
    const isGroup = (ch: string): boolean => (cfg.groupPrefixes ?? ['qq:group:']).some(p => ch.startsWith(p))
    const aliases = cfg.aliases ?? {}
    const timeZone = cfg.timeZone ?? 'Asia/Shanghai'

    /** 人的 id：<平台>:<sender.id>，aliases 把同一个人的不同号并成一个；网页用户默认叫「主人」 */
    const personOf = (sender: Sender, channel: string): { id: string, name: string } => {
      const platform = isWeb(channel) ? 'web' : channel.split(':')[0] || 'web'
      const raw = `${platform}:${sender.id}`
      return { id: aliases[raw] ?? raw, name: sender.name ?? (isWeb(channel) ? cfg.ownerName ?? '主人' : sender.id) }
    }
    const label = (ch: string): string =>
      isGroup(ch) ? `群 ${ch.split(':').pop()}` : ch.includes(':private:') ? '私聊' : isWeb(ch) ? '网页对话' : ch

    const collector = new Collector(store, {
      chunk: cfg.chunk ?? 30,
      groupChunk: cfg.groupChunk ?? 60,
      minTurns: cfg.minTurns ?? 6,
      idleSec: cfg.idleSec ?? 300,
    }, personOf, isGroup)
    collector.replay(ctx.log.events)
    // 日志清空时清桶：看长度不看序号（别的插件在 log.appended 里再写日志时序号会「倒退」）
    let seen = ctx.log.events.length
    ctx.on<LogEvent>('log.appended', (e) => {
      if (ctx.log.events.length < seen)
        collector.reset()
      seen = ctx.log.events.length
      collector.observe(e)
      noteTemper(e)
    })
    /**
     * 她决定不理 / 拉黑了谁（group-policy 的 temper，日志 temper.ignored）：这是她对这个人的印象的一部分，下次见到还记得。
     * 拉黑写进印象 + 事实；只是不理一阵子就记一条事实。只听日志，不 import 那个插件
     */
    const noteTemper = (e: LogEvent): void => {
      if (e.type !== 'temper.ignored' || !e.data?.key)
        return
      const d = e.data
      const raw = String(d.key)
      const id = aliases[raw] ?? raw
      const channel = String(d.channel ?? '')
      const name = String(d.name ?? raw)
      const why = String(d.why ?? '').trim()
      const day = new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric' }).format(e.at)
      const block = d.mode === 'block'
      const fact = `${day} 我${block ? '拉黑' : '不理'}了他${why ? `：${why}` : ''}`
      store.note(id, name, channel, e.at, block ? `我拉黑过他${why ? `（${why}）` : ''}，烦` : '', fact, cfg.maxFacts ?? 20)
    }

    // ── 压摘要：同一时刻只压一段 ──
    let working: Promise<void> | undefined
    /**
     * 群里的机器人（group-policy 的服务 bots）不建人物印象、不算跟她打过交道的人。
     * 不 inject：没装 group-policy 时就当没有机器人；服务现取，名单改了立刻生效
     */
    const isBot = (id: string): boolean => {
      try {
        const i = id.indexOf(':')
        return ctx.use<BotsService>('bots').isBot(id.slice(0, i), id.slice(i + 1))
      }
      catch {
        return false // 没人提供 bots 服务：见上
      }
    }
    const compress = async (channel: string): Promise<string> => {
      const taken = collector.take(channel)
      const turns = taken.turns
      const engaged = taken.engaged.filter(id => !isBot(id))
      const last = turns[turns.length - 1]
      if (!last)
        return `${channel}：没有攒着的`
      store.setCursor(channel, last.at)
      if (!turns.some(t => t.who !== SELF))
        return `${channel}：只有 ${turns.length} 条，跳过`
      const group = isGroup(channel)
      const people = engaged.map(id => store.person(id)).filter((p): p is Person => !!p)
      const messages = buildPrompt({
        bot: cfg.botName ?? '沐沐',
        where: group ? `QQ ${label(channel)}（群聊）` : `${label(channel)}（一对一）`,
        turns,
        people,
        groupImpression: group ? store.groupImpression(channel) : undefined,
        timeZone,
        oneToOne: !group,
      })
      let d
      try {
        d = await digest(req => ctx.model.complete(req), cfg.role ?? 'memory.summarize', messages)
      }
      catch (e) {
        ctx.log.append('memory.failed', { channel, turns: turns.length, error: e instanceof Error ? e.message : String(e) })
        return `${channel}：模型调用失败`
      }
      if (!d) {
        ctx.log.append('memory.failed', { channel, turns: turns.length, error: '输出不是合法 JSON' })
        return `${channel}：输出解析不了，这段丢掉`
      }
      // 摘要关联的人：一对一里所有说话的人；群里只记跟她打过交道的（几万人的群不给路人建档）
      const members = group ? engaged : [...new Set(turns.filter(t => t.who !== SELF && !isBot(t.who)).map(t => t.who))]
      store.addEpisode({ channel, fromAt: turns[0].at, toAt: last.at, summary: d.summary, cues: d.cues, people: members })
      for (const p of d.people) {
        if (engaged.includes(p.id))
          store.update(p.id, p.impression, p.facts.map(text => ({ text, channel, at: last.at })), cfg.maxFacts ?? 20, !group)
      }
      if (group && d.group)
        store.setGroupImpression(channel, d.group)
      ctx.log.append('memory.summarized', { channel, turns: turns.length, people: d.people.map(p => p.id), chars: d.summary.length })
      return `${channel}：${turns.length} 条 → 摘要 ${d.summary.length} 字，更新 ${d.people.length} 人`
    }
    const runDue = (): void => {
      if (working)
        return
      const ch = collector.due(Date.now())[0]
      if (!ch)
        return
      working = compress(ch).then(() => {}, e => console.error('[memory] 压摘要出错:', e)).finally(() => { working = undefined })
    }
    ctx.effect(() => {
      const t = setInterval(runDue, (cfg.checkSec ?? 20) * 1000)
      return () => clearInterval(t)
    })

    // ── 读：发言者 ──
    ctx.intercept<ReplyPrompt>('reply/prompt', async (p, next) => {
      try {
        const text = recall(store, collector, { recallChars: cfg.recallChars ?? 1400, recallEpisodes: cfg.recallEpisodes ?? 4, recallPeople: cfg.recallPeople ?? 8, timeZone }, {
          channel: p.channel,
          history: p.history.slice(-p.limit),
          label,
        })
        if (text)
          p.extras.push({ id: 'memory', audience: 'performer', order: PROMPT_ORDER.memory, render: () => text })
      }
      catch (e) {
        // 召回出错不能耽误她开口：这次就不带记忆
        console.error('[memory] 召回失败:', e)
      }
      return next()
    })

    // ── 读：导演 ──
    ctx.intercept<{ reasons: WakeReason[], history: HistoryTurn[], blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      const max = cfg.recallPeople ?? 8
      const ids: string[] = []
      const channels = new Map<string, string>()
      const add = (sender: Sender, channel: string): void => {
        const id = personOf(sender, channel).id
        if (!ids.includes(id))
          ids.push(id)
        if (!channels.has(id))
          channels.set(id, channel)
      }
      for (const r of m.reasons) {
        if (r.sender && r.channel)
          add(r.sender, r.channel)
      }
      // 唤醒原因所在对话的窗口里说过话的人也想一想是谁（最后说话的在前）：群里她要接的人未必是刚 @ 她的那个。
      // 本插件排在 group-policy 里层，这时群的历史已经换成它的阅读窗口
      const chans = new Set(channels.values())
      for (const t of [...m.history].reverse()) {
        if (ids.length >= max)
          break
        if (t.role === 'other' && t.sender && chans.has(t.channel))
          add(t.sender, t.channel)
      }
      const text = briefOf(store, ids.slice(0, max), isGroup, channels)
      if (text)
        m.blocks.push({ from: 'memory', order: 25, text })
      return next()
    })

    /** 把攒着的全压掉（命令与网页「现在就整理」共用），一段一段来 */
    const flush = async (want?: string): Promise<string[]> => {
      await working
      const out: string[] = []
      const chans = collector.pending().map(x => x.channel).filter(ch => !want || want === 'all' || ch === want || ch.endsWith(`:${want}`))
      for (const ch of chans) {
        working = compress(ch).then((line) => { out.push(line) }).finally(() => { working = undefined })
        await working
      }
      return out
    }

    webExtras(ctx, { store, label, pending: () => collector.pending(), flushAll: () => flush('all') })

    // ── 命令 ──
    const commands = ctx.use<CommandService>('commands')
    ctx.effect(() => commands.register({
      name: 'memory',
      usage: 'memory [flush [频道|all] | who <名字或id> | forget <id>]',
      description: '长期记忆：各层条数、现在就压摘要、看某人的印象、忘掉某人',
      async run(args, io) {
        const [op, ...rest] = args
        if (!op) {
          const s = store.stats()
          io.print(`  人 ${s.people}（打过交道 ${s.interacted}）· 中期摘要 ${s.episodes} 段 · 群印象 ${s.groups} 个 · 约 ${Math.round(s.bytes / 1024)} KB`)
          const pend = collector.pending().filter(x => x.turns)
          // 挂着几百个会话时只列攒得最多的几个
          const top = [...pend].sort((a, b) => b.turns - a.turns).slice(0, 8)
          io.print(`  攒着还没压的：${pend.length ? `${pend.length} 个会话共 ${pend.reduce((n, x) => n + x.turns, 0)} 条，最多的 ${top.map(x => `${x.channel} ${x.turns} 条`).join('、')}` : '无'}`)
          return
        }
        if (op === 'flush') {
          const lines = await flush(rest[0])
          io.print(lines.length ? lines.map(l => `  ${l}`).join('\n') : '  没有攒着的')
          return
        }
        if (op === 'who') {
          const q = rest.join(' ')
          const found = store.person(q) ? [store.person(q)!] : store.findByName(q)
          if (!found.length)
            io.print(`  不认识 ${q}`)
          for (const p of found) {
            io.print(`  ${p.id} ${p.name}${p.names.length > 1 ? `（也叫 ${p.names.join('、')}）` : ''}${p.interacted ? '' : ' · 没打过交道，只记名字'}`)
            if (p.impression)
              io.print(`    印象：${p.impression}`)
            if (p.privateImpression)
              io.print(`    私下印象（只在单聊时想起）：${p.privateImpression}`)
            for (const f of p.facts.slice(-8))
              io.print(`    · ${f.text}（${label(f.channel)}）`)
          }
          return
        }
        if (op === 'forget') {
          io.print(store.forget(rest[0] ?? '') ? `  忘掉了 ${rest[0]}` : `  没有 ${rest[0]}`)
          return
        }
        throw new Error('用法: /memory [flush [频道|all] | who <名字或id> | forget <id>]')
      },
    }))
  },
}

export default plugin
