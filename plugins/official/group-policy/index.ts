/**
 * 群聊读空气 + 多会话调度（设计见 README）。
 *
 * - percept/pre-beat：给「群里不是冲她说的话」打接话概率，掷骰子决定要不要唤醒大脑（judge.ts）。
 *   唤醒之后接不接仍由大脑定；被压掉的话照样在日志里，下一次唤醒大脑都看得到。
 *   @ 她、叫她名字的消息 surface-onebot 已改成 message + urgent，交给大脑（cold.ts 只管「此刻想不想接」）。
 * - beat/gather：「手机上现在的情况」（phone.ts），所有活跃会话的未读与最后几句，像通知栏。
 * - reply/prompt（action-reply 的水线）：群频道的阅读窗口（reading.ts）。
 * - 话题生命周期（topics.ts）：她接话就开一个话题，没人接 / 对方收尾 / 换话题就收尾（轮数只是安全上限）；
 *   话题开着时她可以主动接（judge.ts inTopic），收尾后不再因为「接她的话」被叫醒；beat/gather 给大脑一块「话题」。
 * - 正在对话（convo.ts）：她回了某人（rooms.ts 按叫醒那拍大脑的原因认）、或某人 @ 了她，就和那人「聊着」；对方接着说的话不用 @，
 *   按 judge.ts 的「在聊」分支打分（起点 followUp、按她接过几句衰减，不再直通 p=1），大脑材料「你正在和人聊」、发言者窗口里带着这段。
 *   主人不特殊：在跟别人说就不叫醒；像要她做事的话谁说都叫醒（机器人说的除外：它只走带机器人系数的打分）。
 * - 机器人的话（及群友只冲着机器人说的话）从大脑和发言者的历史里拿掉，她不会对着它们接话。
 * - 每群意愿（rates.ts / affinity.ts）：base × talkValue × 群倍率（手动 / 她自己 group.rate）× 好感（从日志推算）× 心情 × 时段；
 *   beat/gather 给大脑一块「群的感觉」。
 * - /freq：此刻各群的意愿分项与最近的判断；/freq set 调倍率。
 * - 群里的其他机器人（bots.ts / bot-actions.ts）：名单 + 自动打分认出来；它的普通话吸引力乘 bots.attraction、它 @ 她按冷 @ 叫醒大脑，
 *   材料里标着「机器人的套话」，回不回大脑自己定（不再一律不理）；不加好感；服务 bots 给 surface-onebot 查「这人是不是机器人 / 她正不理谁」（是就不按 @ 打断她）。
 * - 按人累积的脾气（temper.ts）：谁老拿低俗话 @ 她、反复点名、骂她、让她自证 AI，攒多烦；beat/gather 给大脑【读空气】（这句带什么词、
 *   机器人说的、这人今天第几次 @、她对他多烦——只摆情况），reply/prompt 给发言者一句态度；大脑用动作 group.ignore 决定不理 / 拉黑 / 原谅，
 *   本插件最外层执行：被不理的人的话不叫醒她、@ 也当没看见，到期自动恢复。内容类的「不接」一条都不写死，判断权在她。
 *
 * 次序：本插件的 pre-beat 必须包在 mind-default 外面——大脑在 next() 之前读 wake 来决定要不要作废
 * 正在进行的思考，被压掉的群消息不该打断它。首次启动按 id 字母序成立；本插件被热重载后排到最里层，
 * 所以装上时若 mind-default 已在，就请装配层把它也重载一次。
 */
import type { BeatMaterial, ConfigService, HistoryTurn, LogEvent, Percept, Plugin, PluginLoader } from '../../../src/index.ts'
import { MAIN_CHANNEL, PROMPT_ORDER } from '../../../src/index.ts'
import type { ReplyPrompt } from '../action-reply/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { EmotionService } from '../emotion/index.ts'
import type { InterestScore } from '../interests/index.ts'
import type { PersonaNames } from '../persona/index.ts'
import type { PolicyConfig } from './judge.ts'
import { Affinity, moodFactor } from './affinity.ts'
import type { BotDeps } from './bot-actions.ts'
import { botAction, botCommand, ownerHint, renderBots, writeMarks } from './bot-actions.ts'
import { BOT_NOTE_MIND, BOT_NOTE_PERFORMER } from './bot-text.ts'
import { botKey, Bots } from './bots.ts'
import type { ConvoView } from './convo.ts'
import { asks, Convos, convoSection, renderConvos } from './convo.ts'
import { renderWakes } from './wakes.ts'
import type { Entry } from './rooms.ts'
import { setupFocus } from './focus.ts'
import { setupColdAt } from './cold.ts'
import { forChannel, judge } from './judge.ts'
import type { PeopleDeps } from './people.ts'
import { peopleSection, renderPeople } from './people.ts'
import { renderPhone } from './phone.ts'
import { freqCommand, rateAction, rateOf, renderFeel, setRate, willingness } from './rates.ts'
import { mergeWindow, readingWindow } from './reading.ts'
import { tagWho } from './who.ts'
import { Rooms, SELF } from './rooms.ts'
import { ignoreAction, renderAir, Temper } from './temper.ts'
import type { Topic } from './topics.ts'
import { Topics } from './topics.ts'
import type { Decision } from './web.ts'
import { webExtras } from './web.ts'

interface PreBeat {
  percept: Percept
  channel: string
  wake: boolean
  incoming?: unknown
}

/** 服务 bots：表现端在把消息交给内核之前问一声「这人是不是机器人」「她是不是正不理这人」（是就别按 @ 打断她） */
export interface BotsService {
  isBot: (platform: string, id: string) => boolean
  /** 大脑决定不理 / 拉黑了这个人（temper.ts），还在期限内 */
  ignored: (platform: string, id: string) => boolean
}

const plugin: Plugin<PolicyConfig> = {
  name: 'group-policy',
  inject: ['commands', 'loader', 'config'],
  apply(ctx, cfg = {}) {
    const prefixes = cfg.channelPrefixes ?? ['qq:group:']
    const kinds = new Set(cfg.kinds ?? ['group.message'])
    // 她的名字：persona/names（真名 + 各平台网名，现取）∪ 配置补充；没装 persona 时只剩配置
    const names = async (): Promise<string[]> => {
      const fromPersona = await ctx.bus.waterfall<PersonaNames, PersonaNames>('persona/names', { names: [] }, async p => p)
        .then(p => p.names, () => [] as string[])
      return [...new Set([...fromPersona, ...(cfg.names ?? [])].filter(Boolean))]
    }
    const isGroup = (ch: string): boolean => prefixes.some(p => ch.startsWith(p))
    const rooms = new Rooms(cfg.keep ?? 200)
    const recent: Decision[] = []
    let replaying = true // 启动时重放存量只恢复状态，不再写 topic.* 日志（那不是新事实）
    /**
     * 这句离她哪个兴趣近：问 interests 插件（水线 interests/score：语义相近度 × 兴趣分，她自己维护的兴趣表）。
     * 没装它时水线原样回来（0 分）= 不相近；不再退回关键词（那是「傻乎乎的匹配」，见 handbook §9.3）。
     */
    const interestOf = async (text: string): Promise<{ word: string, near: number, score: number } | undefined> => {
      const got = await ctx.bus.waterfall<InterestScore, InterestScore>('interests/score', { text, score: 0, hits: [] }, async p => p).catch(() => undefined)
      const top = got?.hits[0]
      return got && got.score > 0 && top ? { word: top.name, near: top.near, score: Math.round(got.score * 100) / 100 } : undefined
    }
    // 频道 → 最近一句群消息的感兴趣程度：话题开的时候看「是不是兴趣话题」（≥ 0.3：相近度过半的人设兴趣、刚学会的兴趣贴得很近也算）
    const lastInterest = new Map<string, number>()
    const topics = new Topics(() => cfg.topic ?? {}, (type: 'topic.opened' | 'topic.closed', t: Topic) => {
      if (!replaying)
        ctx.log.append(type, { channel: t.channel, id: t.id, why: t.why, participants: [...t.participants], turns: t.herTurns, interesting: t.interesting })
    }, (_text, ch) => (lastInterest.get(ch) ?? 0) >= 0.3)
    const convos = new Convos(() => cfg.convo ?? {}, () => cfg.topic ?? {}, (type, c) => {
      if (!replaying)
        ctx.log.append(type, { channel: c.channel, who: c.who, name: c.name, why: c.why, herLines: c.herLines })
    })

    const config = ctx.use<ConfigService>('config')
    /** 主人（guard 的 owners ∪ 本插件 owners），认号不认名：「qq:12345」或「12345」都行 */
    const isOwner = (key: string): boolean => {
      const owners = new Set([...(config.get<string[]>('plugins.guard.owners') ?? []), ...(cfg.owners ?? [])].map(String))
      return owners.has(key) || owners.has(key.slice(key.indexOf(':') + 1))
    }
    const bots = new Bots(() => cfg.bots ?? {}, isOwner)
    /** 群里的机器人：名单 / 自动认出的，或表现端在感知里标了 data.bot 的（真群甲 的「小鱼」就是后者） */
    const isBot = (ch: string, who: string): boolean => who !== SELF && (bots.is(botKey(ch, who)) || !!rooms.list(ch).findLast(e => e.who === who)?.bot)
    /** 机器人的话从「群里的人在说什么」里拿掉；主人解锁了跟它聊的那会儿除外 */
    const hide = (ch: string, e: Entry): boolean => isBot(ch, e.who) && !bots.unlocked(ch, botKey(ch, e.who), Date.now())

    // 日志被清空（/api/clear）时跟着清。不能看序号倒退：别的插件在 log.appended 里再写日志时，
    // 嵌套的那条先送到这里，外层那条后到、序号反而小——会误判成清空
    const affinity = new Affinity(() => cfg.affinity ?? {}, isGroup, isBot)
    // 按人累积的脾气（temper.ts）：谁老拿低俗话 @ 她、反复点名、骂她，攒多烦；大脑决定不理谁也从日志投影
    const temper = new Temper({
      cfg: () => cfg.temper ?? {},
      tabooWords: () => cfg.tabooWords ?? [],
      insultWords: () => cfg.affinity?.insultWords ?? [],
      isOwner,
      isBot: key => bots.is(key),
      isGroup,
    })
    // 正在跑的动作（observe 回放存量时也会问「她在不在说」，所以定义在它前面）
    const running = (): { id: string, channel: string, note: string, runningMs: number }[] =>
      ctx.actions.snapshot().map(r => ({ ...r, channel: r.channel ?? MAIN_CHANNEL }))
    const busyRuns = (): ReturnType<typeof running> =>
      running().filter(r => (cfg.busyActions ?? ['computer']).some(b => r.id.startsWith(`${b}#`)))
    let seen = 0
    let learnTimer: NodeJS.Timeout | undefined
    const observe = (e: LogEvent): void => {
      if (ctx.log.events.length < seen) {
        rooms.clear()
        topics.clear()
        convos.clear()
        affinity.clear()
        bots.clear()
        temper.clear()
      }
      seen = ctx.log.events.length
      rooms.observe(e)
      bots.onLog(e.type, e.data ?? {}, e.at)
      if (!replaying) {
        affinity.observe(e)
        temper.observe(e)
      }
      const ch = String(e.data?.channel ?? '')
      if (!isGroup(ch))
        return
      const list = rooms.list(ch)
      const last = list.at(-1)
      if (e.type === 'percept.received' && e.data?.sender && e.data?.text && last && last.who !== SELF) {
        bots.observe(ch, last, list.slice(0, -1))
        if (!hide(ch, last)) {
          // 先于话题：回填 last.convo。这句到时她正在这个群说话 → 谁都没看到，说完补判（convo.pending）
          convos.onOther(ch, last, running().some(r => r.id.startsWith('reply#') && r.channel === ch))
          topics.onOther(ch, last)
        }
        if (!replaying && bots.toLearn().length && !learnTimer)
          learnTimer = setTimeout(learn, 2000) // 攒一下再写：写配置会让本插件重载
      }
      else if (e.type === 'utterance.started') {
        convos.onSpeak(ch, e.at) // 她一开口，正在聊的人在这之前说的就算看过了（账在这里销，不等说完）
      }
      else if (e.type === 'utterance.settled' && e.data?.delivered && last?.who === SELF) {
        const before = list.slice(0, -1)
        const targets = replyTargets(ch, before, last)
        // 话题的参与者也按她真在回谁认，不再取「她开口前别人那句」：真群乙 23:21:59 她回青山，话题却记成恰好在她前面说猫咖的人
        const replyTo = targets.at(-1)
        const answering = !!replyTo && convos.isIn(ch, replyTo.who, last.at)
        convos.onSelf(ch, last, [...askedOf(ch, before, last), ...targets], rooms.lastStart(ch, last.at))
        topics.onSelf(ch, last, replyTo, answering)
        if (!replaying)
          nudgeTimers.push(setTimeout(() => { nudge(ch).catch(e => console.error('[group-policy] 说完补判失败:', e instanceof Error ? e.message : e)) }, 1500))
      }
    }
    /**
     * 她说话那会儿正在聊的人又说了（群消息不打断她，那拍大脑被 reply-running 拦下）：说完再叫一次大脑，唤醒原因就是那句。
     * 只靠「reply 完成」那拍的材料不够——那拍里大脑多半判「刚说完不用补」（模拟器 convo-bot-noise 两次都这样漏了追问）
     */
    const nudged = new Set<string>()
    const nudgeTimers: NodeJS.Timeout[] = []
    ctx.effect(() => () => nudgeTimers.forEach(clearTimeout))
    const nudge = async (ch: string): Promise<void> => {
      if (running().some(r => r.id.startsWith('reply#') && r.channel === ch))
        return // 还在说（append 的下一段）：等这段说完那次
      if (nudged.size > 500)
        nudged.clear()
      for (const c of convos.list(Date.now(), ch)) {
        if (hide(ch, { at: 0, who: c.who, text: '' }))
          continue // 此刻按机器人算的（主人解锁的轮数用完了）：不再按「还没接」补叫大脑（解锁只管两轮，聊完恢复不理）
        const lines = convos.pending(c).filter(l => !nudged.has(`${ch}|${l.who}|${l.at}`))
        if (!lines.length)
          continue
        for (const l of lines) nudged.add(`${ch}|${l.who}|${l.at}`)
        // 补叫也掷骰子，用的就是「在聊」那套分（judge），不是直通：她说话时到的那句到达时打了 p=0「正在说话」，等于没判过；
        // 原来一律叫醒——模拟器 convo-follow 里六句追问全在她说话时到，六句全补叫、接了五句，和直通 p=1 没区别（真群 17:53「多押韵」也是这么来的）
        const list = rooms.list(ch)
        const at = lines[lines.length - 1].at
        const idx = list.findIndex(e => e.who === c.who && e.at === at)
        const cur = list[idx]
        const v = cur ? await score(ch, cur, list.slice(0, idx)) : undefined
        const p = v?.p ?? 0
        const wake = p > 0 && Math.random() < p
        const why = v ? [`你说话时到的，说完再判：${v.why.join('、')}`] : ['你说话时到的那句已不在最近的记录里']
        record({ at: Date.now(), channel: ch, who: c.name ?? c.who, p, why, wake, state: v?.state })
        ctx.log.append('convo.pending', { channel: ch, who: c.who, name: c.name, lines: lines.length, p, why, wake })
        if (!wake)
          continue
        if (cur)
          cur.woke = true
        ctx.mind.wake({ source: 'group.convo', text: `你刚才说话时 ${c.name ?? '对方'} 又说的，你那段没看到：${lines.map(l => `「${l.text}」`).join('')}`, channel: ch, sender: { id: c.who, name: c.name }, external: true })
      }
    }
    /**
     * 她这次开口是在回谁：叫醒那拍大脑的原因里说话的人（rooms.ts 记在她这句的 `to`），各取他上次开口后最后那句。
     * 原来靠猜（上次开口后 @ 她的 / 对话中的 / 最后叫醒过她的那句 / 她开口前别人那句），真群里把恰好在她开口前后说话的路人也算成了「正在和她聊」。
     * 没有决策信息（脊椎兜底应的一声）时只算冲她说的（@ / 回复她）。
     */
    const replyTargets = (ch: string, before: Entry[], self: Entry): Entry[] => {
      const since = before.slice(before.findLastIndex(x => x.who === SELF) + 1).filter(x => !hide(ch, x))
      if (!self.to)
        return since.filter(x => x.direct)
      return self.to.flatMap(id => since.findLast(x => x.who === id) ?? before.findLast(x => x.who === id && !hide(ch, x)) ?? [])
    }
    /**
     * 她这句是问句、点名问了谁（话里有他的群名片 / @ 他；叫「主人」就是主人）：他也算她在回的人，他的下一句就是在答她（convo.ts askedAt）。
     * 「她在回谁」（to）只认叫醒那拍的人：路人要她发文件、她转头问主人「发吗」，主人不在 to 里，主人回「发吧」原来按普通一句打分
     */
    const askedOf = (ch: string, before: Entry[], self: Entry): Entry[] => {
      if (!asks(self.text))
        return []
      const last = new Map(before.filter(x => x.who !== SELF && self.at - x.at < 600_000 && !hide(ch, x)).map(x => [x.who, x]))
      const out = [...last.values()].filter(x => !!x.name && x.name.length >= 2 && self.text.includes(x.name))
      if (self.text.includes('主人')) {
        const platform = ch.split(':')[0]
        const owners = [...(config.get<string[]>('plugins.guard.owners') ?? []), ...(cfg.owners ?? [])].map(String)
        for (const id of owners.filter(o => !o.includes(':') || o.startsWith(`${platform}:`)).map(o => o.split(':').pop()!)) {
          if (!out.some(x => x.who === id))
            out.push(last.get(id) ?? { at: self.at, who: id, name: '主人', text: '' }) // 主人最近没在这个群说话：从她这句聊上
        }
      }
      return out
    }
    /** 自动认出的记进配置。一分钟内记过同一个人就不再记：配置没写进去时不至于重载个没完 */
    const learn = (): void => {
      const just = new Set(ctx.log.events.slice(-500).filter(x => x.type === 'bot.learned' && Date.now() - x.at < 60_000).map(x => String(x.data?.key)))
      const fresh = bots.toLearn().filter(l => !just.has(l.key))
      if (!fresh.length)
        return
      for (const l of fresh) ctx.log.append('bot.learned', { key: l.key, ...l.info })
      writeMarks({ cfg, config }, { learn: fresh })
    }
    // 好感、脾气要看全部历史（每条常数级；拉黑可以长达几天，不能只看最近一段）；最近消息与话题只要最近一段
    for (const e of ctx.log.events) {
      affinity.observe(e)
      temper.observe(e)
    }
    for (const e of ctx.log.events.slice(-3000)) observe(e)
    topics.recent(Date.now(), 0) // 停机期间到期的话题静默收掉：当初收尾时已经记过，重启后不再补一条
    replaying = false
    if (bots.toLearn().length) // 存量里就看得出来的（第一次装上、或改了阈值）
      learnTimer = setTimeout(learn, 0)
    ctx.effect(() => () => clearTimeout(learnTimer))
    const mood = (): number => {
      try {
        return moodFactor(ctx.use<EmotionService>('emotion').state(), cfg.mood ?? {})
      }
      catch {
        return 1 // 没装 emotion：心情不影响意愿
      }
    }
    const rateDeps = { cfg, config, rooms, affinity, mood, isGroup }
    const botDeps: BotDeps = { bots, cfg, config, rooms, isGroup, isOwner, log: (type, data) => ctx.log.append(type, data) }
    ctx.on<LogEvent>('log.appended', observe)

    /** 有私聊 / 网页对话在等她回：最后一句是对方直接对她说的、还没过 privateWaitSec */
    const privateWaiting = (now: number): boolean => rooms.channels().some((ch) => {
      if (isGroup(ch))
        return false
      const last = rooms.list(ch).at(-1)
      return !!last && last.who !== SELF && !!last.direct && now - last.at < (cfg.privateWaitSec ?? 120) * 1000
    })

    const withAsked = (v: ConvoView | undefined, cur: Entry): ConvoView | undefined => v && cur.asked ? { ...v, asked: true } : v
    /** 一句群消息的接话概率（judge.ts）：此刻她在哪说话、忙不忙、这个群的倍率 / 好感 / 心情、话题、兴趣、正在和她聊的人——pre-beat 与说完补判（nudge）用同一套 */
    const score = async (channel: string, cur: Entry, before: Entry[], bot?: number): Promise<ReturnType<typeof judge>> => {
      const runs = running()
      const liked = await interestOf(cur.text)
      lastInterest.set(channel, liked?.score ?? 0)
      return judge(forChannel(cfg, channel), cur, before.filter(e => !hide(channel, e)), {
        replyHere: runs.some(r => r.id.startsWith('reply#') && r.channel === channel),
        replyElsewhere: runs.some(r => r.id.startsWith('reply#') && r.channel !== channel),
        privateWaiting: privateWaiting(cur.at),
        busy: busyRuns()[0]?.id,
        startsLastMinute: rooms.startsWithin(channel, cur.at, 60_000),
        topic: topics.view(channel, cur, cur.at),
        rate: rateOf(cfg, channel),
        affinity: affinity.get(channel, cur.at).value,
        mood: mood(),
        interest: liked,
        ...(bot !== undefined ? { bot } : {}),
        ...(cur.convo ? { convo: withAsked(convos.view(channel, cur.who, cur.at), cur) } : {}),
      })
    }

    ctx.intercept<PreBeat>('percept/pre-beat', async (b, next) => {
      const { percept, channel } = b
      if (!b.wake || b.incoming || !isGroup(channel) || !percept.sender)
        return next()
      // 大脑决定不理 / 拉黑的人（temper.ts，动作 group.ignore）：这是她自己做的决定，这里只执行——
      // 他的话不叫醒她，@ 她也换掉 kind（脊椎、冷 @、排队都只认 message），到期自动恢复。主人进不了这个名单
      const ignored = temper.ignoring(botKey(channel, String(percept.sender.id)), Date.now(), channel) // 按「群 + 人」看：别的群不理他，这个群照常
      if (ignored) {
        const left = Math.max(1, Math.round((ignored.until - Date.now()) / 60_000))
        const why = [`你决定${ignored.mode === 'block' ? '拉黑' : '不理'}他了（${ignored.why}），还有 ${left} 分钟`]
        b.wake = false
        if (percept.kind === 'message')
          b.percept = { ...percept, kind: 'message.ignored' }
        record({ at: Date.now(), channel, who: percept.sender.name ?? percept.sender.id, p: 0, why, wake: false })
        ctx.log.append('group.policy', { channel, sender: percept.sender, p: 0, why, wake: false, ignored: ignored.mode })
        return next()
      }
      // 群里的机器人：不再一律不理。它 @ 她 → 冷 @（脊椎不替她应）按 bots.atWake 叫醒大脑；它的普通话 → 照常打分、吸引力乘 bots.attraction
      const gate = isBot(channel, String(percept.sender.id)) ? bots.gate(channel, botKey(channel, String(percept.sender.id)), Date.now()) : undefined
      if (gate && !gate.allow && percept.kind === 'message')
        return botAt(b, next, gate.why)
      if (gate?.allow)
        ctx.log.append('bot.allowed', { channel, key: botKey(channel, String(percept.sender.id)), via: gate.via })
      // 主人 @ 她点名「那个 XX 是机器人 / 你跟它聊两句」：脊椎先应一声的话，大脑那拍被作废、回头只看到「reply 完成」，
      // 常常想不起来记（真机实测）。所以这句换个 kind 不走脊椎，大脑一拍里应声并 start group.bot（材料里有提示）
      if (percept.kind === 'message' && isOwner(botKey(channel, String(percept.sender.id)))) {
        const cur = rooms.list(channel).at(-1)
        if (cur && cur.who === String(percept.sender.id) && ownerHint(botDeps, channel, cur, Date.now()).length) {
          b.percept = { ...percept, kind: 'message.owner' }
          ctx.log.append('group.policy', { channel, sender: percept.sender, p: 1, why: ['主人点名说了群里的机器人：交给大脑应声并记下'], wake: true })
          return next()
        }
      }
      if (!kinds.has(percept.kind))
        return next()
      const list = rooms.list(channel)
      const cur = list[list.length - 1] // log.appended 先于本水线，当前这句已在表里
      if (!cur || cur.who !== String(percept.sender.id))
        return next()
      // 没 @ 她的群消息一律打分，没有直通：「正在和她聊的人接着说」并进了 judge 的「在聊」分支；「像是要她做事」（任务词子串匹配 p=1）已删——
      // 「运行」「搜」「帮我」在闲聊里到处都是（真群 23:29 Novas「日语模块分成三份独立运行了」就被叫醒），这种匹配太粗糙。
      // 碰到她喜欢的话题，兴趣分照样把 p 抬上去；真要她做事会 @ 她（冷 @ 那条）
      const tv = topics.view(channel, cur, cur.at)
      const v = await score(channel, cur, list.slice(0, -1), gate && !gate.allow ? gate.factor : undefined)
      // 硬闸（忙、正在说话…）提前返回时 judge 不带话题，日志里照样写上，网页上看得出话题走到哪了
      const ts = v.topic ?? (tv ? { status: tv.status, why: tv.why, turns: tv.turns, maxTurns: tv.maxTurns } : undefined)
      const topic = ts ? (ts.status === 'open' ? `进行中 ${ts.turns}/${ts.maxTurns} 轮` : `已收尾：${ts.why}`) : undefined
      const wake = v.p > 0 && Math.random() < v.p
      cur.woke = wake
      b.wake = wake
      const why = wake ? [...v.why, ...temper.hintFor(channel, cur, cur.at).filter(h => !v.why.some(w => w.includes(h.slice(0, 6))))] : v.why
      recent.push({ at: cur.at, channel, who: percept.sender.name ?? percept.sender.id, p: v.p, why, wake, topic, attraction: v.factors.attraction, state: v.state })
      if (recent.length > 50)
        recent.shift()
      ctx.log.append('group.policy', { channel, sender: percept.sender, p: v.p, why, wake, factors: v.factors, topic: ts, state: v.state, ...(gate ? { bot: true } : {}), ...(cur.convo ? { convo: true } : {}) })
      return next()
    })

    /**
     * 机器人 @ 她（主人没解锁）：不是「不理」，是「不抢着回」——kind 换成 message.cold（脊椎、排队都只认 message），
     * 按 bots.atWake 的概率叫醒大脑，材料【读空气】里写着「说话的是群里的机器人」，回不回它自己定。
     * 原来 wake=false、p=0 一律不理；现在可以回，但要完全明白那是机器人的无用废话
     */
    const botAt = async (b: PreBeat, next: () => Promise<PreBeat>, gateWhy: string): Promise<PreBeat> => {
      const { percept, channel } = b
      const sender = percept.sender!
      const now = Date.now()
      const p = Math.max(0, Math.min(1, cfg.bots?.atWake ?? 0.5))
      const wake = Math.random() < p
      const cur = rooms.list(channel).at(-1)
      if (cur && cur.who === String(sender.id))
        cur.woke = wake
      b.wake = wake
      b.percept = { ...percept, kind: 'message.cold' }
      const why = [`${gateWhy}；它 @ 了你${wake ? '，叫醒大脑自己定' : `，这次没叫醒（p=${p}）`}`, ...(cur ? temper.hintFor(channel, cur, now).filter(h => !h.includes('机器人')) : [])]
      record({ at: now, channel, who: sender.name ?? sender.id, p, why, wake })
      ctx.log.append('group.policy', { channel, sender, p, why, wake, bot: true, at: true })
      return next()
    }

    // @ 不是 100% 必答（cold.ts）；必须在 focus（排队）之前登记，冷下来的 @ 不进队
    const record = (r: Decision): void => {
      recent.push(r)
      if (recent.length > 50)
        recent.shift()
    }
    /**
     * 群里机器人的话在大脑和发言者的历史里留着、打上标记（她可以回机器人，但要完全明白那是机器人的废话）：
     * 机器人说的「（机器人）」/ 在接她的「（机器人，在接你的话）」；群友冲机器人说的「（在跟机器人 X 说）」；她的网名标「（就是你）」（who.ts）。
     * 真群乙（12:35）：她该报 DSH 结果，发言者历史最后一句是「Brix：@DeepSeek酱 你不是一个真正的存在」，
     * 她当成在跟她说，回了「那你还回我，图啥呢」。原来一度整段剔掉，后来改回：留着，标清楚
     */
    const tagBots = async <T extends HistoryTurn>(list: T[], channel?: string): Promise<{ list: T[], tagged: boolean }> =>
      tagWho(list, channel ?? MAIN_CHANNEL, {
        isGroup,
        isBot,
        botNames: ch => rooms.list(ch).filter(e => e.name && isBot(ch, e.who)).map(e => e.name!),
        names: await names(),
      })

    const cold = setupColdAt(ctx, {
      cfg,
      config,
      rate: rateDeps,
      isGroup,
      record,
      isOwner,
      isBot,
      inConvo: (ch, who) => !!rooms.list(ch).at(-1)?.convo && rooms.list(ch).at(-1)?.who === who,
      topicAt: (ch, now) => topics.view(ch, undefined, now),
      hints: (ch, who, now) => {
        const cur = rooms.list(ch).at(-1)
        return cur && cur.who === who ? temper.hintFor(ch, cur, now) : []
      },
    })

    setupFocus(ctx, { enabled: cfg.queue?.enabled !== false, maxWaitSec: cfg.queue?.maxWaitSec ?? 90 }, isGroup)

    /**
     * 群频道的阅读窗口（reading.ts），大脑与发言者同一套：pool 是按时间排的候选池（发言者的来自 action-reply，
     * 大脑的从日志现取），正在和她聊的那段整段带上（对方从这段对话开头起的话和她的话）。不打机器人标记，调用方自己打
     */
    const windowFor = async (ch: string, pool: HistoryTurn[], now: number): Promise<HistoryTurn[]> => {
      const talks = convos.list(now, ch)
      const inConvo = (t: HistoryTurn): boolean => talks.some(c => t.at >= (c.lines[0]?.at ?? c.startedAt)
        && (t.role === 'self' || String(t.sender?.id) === c.who))
      return readingWindow(pool, await names(), cfg.reading ?? {}, now, talks.length ? inConvo : undefined)
    }
    const peopleDeps: PeopleDeps = {
      entries: ch => rooms.list(ch),
      isOwner,
      isBot,
      inConvo: (ch, who) => convos.isIn(ch, who, Date.now()),
      temper: (key, ch) => temper.status(key, Date.now(), ch),
      names,
    }

    ctx.intercept<BeatMaterial>('beat/gather', async (m, next) => {
      const now = Date.now()
      // 唤醒原因里的群：大脑的历史换成这个群的阅读窗口（内核给的最近几十条是所有频道混着的，热闹的群几秒就刷满，
      // 大脑只看得到眼前几句，接不上几分钟前的话），窗口里出现的人各是谁另给一块（people.ts）
      const groupChans = [...new Set(m.reasons.flatMap(r => r.sender && r.channel && isGroup(r.channel) ? [r.channel] : []))]
      const windows: { channel: string, window: HistoryTurn[] }[] = []
      for (const ch of groupChans) {
        const window = await windowFor(ch, ctx.log.history({ channel: ch, limit: cfg.reading?.pool ?? 200 }), now)
        m.history = mergeWindow(m.history, ch, window)
        windows.push({ channel: ch, window })
      }
      const tb = await tagBots(m.history)
      m.history = tb.list
      if (tb.tagged)
        m.blocks.push({ from: 'group-policy', order: 35, text: BOT_NOTE_MIND })
      const pl = await renderPeople(windows, peopleDeps, cfg.reading ?? {}, now)
      if (pl)
        m.blocks.push({ from: 'group-policy', order: 27, text: pl })
      const text = renderPhone(rooms, cfg.phone ?? {}, isGroup, busyRuns(), Date.now(), hide)
      if (text)
        m.blocks.push({ from: 'group-policy', order: 30, text })
      const bl = renderBots(botDeps, Date.now())
      if (bl)
        m.blocks.push({ from: 'group-policy', order: 34, text: bl })
      const cl = renderConvos(convos, Date.now(), cfg.convo?.lines ?? 10)
      if (cl)
        m.blocks.push({ from: 'group-policy', order: 29, text: cl })
      const tl = renderTopics(topics.recent(Date.now(), 10 * 60_000))
      if (tl)
        m.blocks.push({ from: 'group-policy', order: 31, text: tl })
      const feel = renderFeel(rateDeps, Date.now())
      if (feel)
        m.blocks.push({ from: 'group-policy', order: 32, text: feel })
      const coldAt = cold.block(Date.now())
      if (coldAt)
        m.blocks.push({ from: 'group-policy', order: 33, text: coldAt })
      // 读空气（temper.ts）：这几句各是什么情况、谁让她烦、她正不理谁——只摆情况，接不接她定
      const air = renderAir(temper, rooms, isGroup, Date.now())
      if (air)
        m.blocks.push({ from: 'group-policy', order: 28, text: air })
      // 这次为什么叫醒你（wakes.ts）：在聊 / 没在聊——没在聊只是刷到一眼，有想说的就说；叫醒 ≠ 开口
      const wk = renderWakes(recent, Date.now())
      if (wk)
        m.blocks.push({ from: 'group-policy', order: 27, text: wk })
      return next()
    })

    ctx.intercept<ReplyPrompt>('reply/prompt', async (p, next) => {
      if (isGroup(p.channel)) {
        const now = Date.now()
        const window = await windowFor(p.channel, p.history, now)
        const tb = await tagBots(window, p.channel)
        p.history = tb.list
        p.limit = Math.max(p.limit, p.history.length)
        if (tb.tagged)
          p.extras = [...p.extras, { id: 'group-bots', audience: 'performer', order: PROMPT_ORDER.thought, render: () => BOT_NOTE_PERFORMER }]
        const s = convoSection(convos, convos.list(now, p.channel))
        if (s)
          p.extras = [...p.extras, s]
        // 在场的人各是谁、最近在干嘛、窗口里没带上的话（people.ts）
        const pl = await peopleSection(p.channel, window, peopleDeps, cfg.reading ?? {}, now)
        if (pl)
          p.extras = [...p.extras, pl]
        // 她这次要回的那几个人里有让她烦的 / 正在不理的：给发言者一句态度（可以不耐烦、冷淡，但不对骂）
        const whos = p.history.slice(-6).filter(t => t.role === 'other' && t.sender).map(t => String(t.sender!.id))
        const attitude = temper.attitude(p.channel, whos, Date.now())
        if (attitude)
          p.extras = [...p.extras, { id: 'group-temper', audience: 'performer', order: PROMPT_ORDER.thought, render: () => attitude }]
      }
      return next()
    })

    const commands = ctx.use<CommandService>('commands')
    ctx.effect(() => commands.register(freqCommand({ ...rateDeps, recent, busy: () => busyRuns().map(r => r.id) })))
    ctx.effect(() => ctx.actions.register(rateAction(rateDeps)))
    ctx.effect(() => commands.register(botCommand(botDeps)))
    ctx.effect(() => ctx.actions.register(botAction(botDeps)))
    ctx.effect(() => ctx.actions.register(ignoreAction({
      temper,
      cfg: () => cfg.temper ?? {},
      isOwner,
      isGroup,
      resolve: (who, channels) => bots.resolve(who, channels),
      nameOf: key => bots.status(key).name,
      log: (type, data) => ctx.log.append(type, data),
    })))
    ctx.provide('bots', {
      isBot: (platform: string, id: string) => bots.is(`${platform}:${id}`),
      ignored: (platform: string, id: string) => !!temper.ignoring(`${platform}:${id}`, Date.now()),
    } satisfies BotsService)

    webExtras(ctx, { cfg, rooms, recent, isGroup, hide, bots: botDeps, temper, log: (type, data) => ctx.log.append(type, data), willing: (ch, now) => willingness(rateDeps, ch, now), setRate: (ch, r) => setRate(rateDeps, ch, r), rateOf: ch => rateOf(cfg, ch) })

    // 见文件头「次序」：热重载后让 mind-default 重新排到本插件里层
    const loader = ctx.use<PluginLoader>('loader')
    if (loader.list().some(p => p.id === 'mind-default' && p.loaded)) {
      const t = setTimeout(() => {
        loader.reload('mind-default').catch(e => console.error('[group-policy] 重排 mind-default 失败:', e instanceof Error ? e.message : e))
      }, 0)
      ctx.effect(() => () => clearTimeout(t))
    }
  },
}

export default plugin

/** 给大脑看的「话题」：进行中的可以接着聊；收尾的说清为什么、别再接 */
function renderTopics(list: Topic[]): string {
  if (!list.length)
    return ''
  const lines = list.map((t) => {
    const where = `群 ${t.channel.split(':').pop()}`
    const gist = t.text.slice(0, 16).replace(/\s+/g, ' ')
    return t.status === 'open'
      ? `- ${where}：你参与的话题「${gist}…」还在聊（你主动接了 ${t.herTurns} 轮${t.interesting ? '，你感兴趣的' : ''}）——别人说了新东西可以接着聊，不必等人问`
      : `- ${where}：「${gist}…」这个话题已经收尾（${t.why}）——别再接、别追问、别补一句；有人 @ 你或直接问你才答`
  })
  return `【话题】\n${lines.join('\n')}`
}
