/**
 * 脊椎（插件 id 仍是 reflex）：只管不用过脑子的事，说什么、做什么由大脑（mind-default）决定。
 *
 * 历史：原来叫「反射」，对话消息 350ms 后直接起 reply，大脑据 reflex.fired 作废本拍——首字快，
 * 但真群里反射抢答让任务丢了（主人「……用电脑试试看」→ 反射「电脑碰不到嘛…」→ 大脑信了，computer 没起）、
 * 复读历史里的错话、给自己编来历。补了 actionWords 词表、主人特判，靠词表永远追不上措辞。
 * 2026-10-22 改成「大脑门控」：像人一样，脊椎只控制动作，话都过脑子。
 *
 * 现在做的：
 * - 合流：私聊 / 网页里对方连着发，先压住内核的即时唤醒（wake=false），停下再叫醒大脑一次，免得对方还在打字时就想好一句。
 *   群频道（groupPrefixes）不合流，内核照常即时唤醒。
 * - 给大脑贴提示（beat/gather【脊椎】）：对方还在发 / 像是要你做事 / 是主人说的 / 很简单可以 quick。
 * - 兜底：白名单里的招呼（纯表情包，或很短不带问号、不像要她做事、不是主人说的）在 fallbackMs 内
 *   大脑既没决定、频道里也没起 reply → 脊椎先起一条简短 reply（reflex.route path=fallback）。别的消息只等大脑。
 * - 硬闸（intent/pre-dispatch）：同频道同一时刻最多一个 reply、她在别的频道说话时别处不开口（busy-elsewhere，像人一样
 *   一次只在一个会话里说话；被拦的念头记下，说完那拍提醒大脑「刚才想在那说的还没说」）、合流中不回、取材料时已有 reply 在跑的不回、
 *   脊椎兜底之后才派发的不回；同拍动作被 guard 拦下时改 reply 的念头（别嘴上答应、别说电脑坏了）。
 * - 连发提醒：对方连发了几条，告诉发言者看完一起回。
 * 被打断立刻停嘴在内核（urgent 打断），表情 / 动作标记在 expression 插件，游戏按键回路在身体服务（body_reflex），都不在这里。
 */
import type { ConfigService, Intent, LogEvent, MaterialBlock, Percept, Plugin, Sender, WakeInput } from '../../../src/index.ts'
import { MAIN_CHANNEL, PROMPT_ORDER } from '../../../src/index.ts'
import type { ReplyPrompt } from '../action-reply/index.ts'
import type { RouteConfig } from './route.ts'
import { ACTION_WHY, OWNER_WHY, classify, spineCandidate, stickerPattern } from './route.ts'

interface ReflexConfig {
  delayMs?: number // 轻消息的合流窗口
  kinds?: string[] // 算对话消息的感知 kind
  groupPrefixes?: string[] // 这些频道不合流：内核即时唤醒大脑
  lightMaxChars?: number // 不带问号、不超过这么多字（去掉表情包后）算轻消息
  stickerPrefix?: string // 表现端把表情包写成「[表情包…]」：去掉这种片段后什么都不剩 = 纯表情包
  thinkDelayMs?: number // 要过脑子的消息先等这么久再叫大脑（对方可能还在打字）
  burstGapMs?: number // 和对方上一句隔这么近算连发
  burstDelayMs?: number // 连发时的合流窗口：对方停下这么久才算说完
  lightCooldownMs?: number // 她这么久之内刚开过口，轻消息不兜底
  lightReplyChance?: number // 轻消息兜底的概率
  fallbackMs?: number // 白名单里的招呼，大脑这么久还没决定就由脊椎先应一声；0 = 不兜底
  burstHint?: boolean // 对方连发了几条时，提醒发言者看完一起回
  actionWords?: string[] // 含这些词 = 像是要她做事：给大脑提示，且不兜底
  quickGuardKinds?: string[] // 这些感知算「对方说的话」：大脑放行了快回、对方最近一句像要她做事，就降成正常回复
  reportKinds?: string[] // 这些感知算动作结果：汇报它的 reply 被同频道正在说的话拦下时记下，说完那拍提醒大脑
}

interface PreBeat {
  percept: Percept
  channel: string
  wake: boolean
  incoming?: unknown // 有值 = 流式感知的中途更新
}

/** 一个频道正在合流的几句话 */
interface Pending {
  timer?: NodeJS.Timeout
  count: number
  heavy: boolean
  burst: boolean
  owner: boolean
  why: Set<string>
  wakes: WakeInput[]
}

/** 大脑想在这个频道开口、却因为她正在别处说话被拦下的念头：那边说完再提醒大脑一次 */
interface Deferred {
  at: number
  thought: string // 当时的念头（guidance，快回则是 note）
  busy: string // 当时在哪个频道说话
  report?: string // 有值 = 被同频道正在说的话拦下的「汇报动作结果」，值是那件事（任务原文开头）
}

/** 交给大脑、还没有回应的消息 */
interface Handed {
  at: number
  count: number
  why: string[]
  texts: string[] // 据此认出大脑的哪次决定看过它们
  spine: boolean // 在兜底白名单里
  timer?: NodeJS.Timeout
}

const plugin: Plugin<ReflexConfig> = {
  name: 'reflex',
  apply(ctx, cfg = {}) {
    const delay = cfg.delayMs ?? 350
    const kinds = new Set(cfg.kinds ?? ['message'])
    const groups = cfg.groupPrefixes ?? ['qq:group:']
    const rc: RouteConfig = {
      lightMaxChars: cfg.lightMaxChars ?? 4,
      sticker: stickerPattern(cfg.stickerPrefix ?? '[表情包'),
      lightCooldownMs: cfg.lightCooldownMs ?? 10_000,
      lightReplyChance: cfg.lightReplyChance ?? 0.85,
      actionWords: cfg.actionWords ?? [],
    }
    const thinkDelay = cfg.thinkDelayMs ?? 800
    const burstGap = cfg.burstGapMs ?? 4000
    const burstDelay = cfg.burstDelayMs ?? 1800
    const fallbackMs = cfg.fallbackMs ?? 2500
    const talkKinds = new Set(cfg.quickGuardKinds ?? ['message', 'group.message', 'message.queued'])
    const reportKinds = new Set(cfg.reportKinds ?? ['computer.result', 'dsh.result', 'extend.result'])
    const pending = new Map<string, Pending>() // 私聊 / 网页：合流中
    const lastIn = new Map<string, number>() // 频道 → 对方上一句的时刻
    const handed = new Map<string, Handed>()
    const spoke = new Map<string, number>() // 频道 → 脊椎兜底开口的时刻（硬闸用）
    const deferred = new Map<string, Deferred>() // 频道 → 想在这开口却被 busy-elsewhere 拦下的念头

    const isGroup = (ch: string): boolean => groups.some(p => ch.startsWith(p))
    /** 她此刻在哪些频道说话：reply 动作从起到那句 utterance 结算都算在说（动作等结算才结束） */
    const speaking = (): string[] =>
      [...new Set(ctx.actions.snapshot().filter(r => r.id.startsWith('reply#')).map(r => r.channel ?? MAIN_CHANNEL))]
    const replyRunning = (channel: string): boolean => speaking().includes(channel)
    /** 她正在别的频道说话 → 那个频道；没有 → undefined */
    const busyElsewhere = (channel: string): string | undefined => speaking().find(c => c !== channel)
    /**
     * 这个频道里有一条动作结果，是在正在说的那句开口之后才回来的（那句不是在汇报它）→ 返回那件事（任务原文开头）。
     * 结果 kind 与 action-reply 的 resultKinds 一致
     */
    const unreported = (channel: string): string | undefined => {
      const since = lastReplyAt(channel)
      const r = ctx.log.events.findLast(e => e.type === 'percept.received' && reportKinds.has(e.data?.kind) && (e.data.channel ?? MAIN_CHANNEL) === channel)
      if (!r || r.at < since)
        return undefined
      return String(r.data.data?.task ?? r.data.text ?? '那件事').split(/\s+/).join(' ').slice(0, 30)
    }
    /** 这个对话最近一句有人说的话（对话类感知）像是要她做事；戳一戳这类不是对话的不算 */
    const asksForAction = (channel: string): boolean => {
      const last = ctx.log.events.findLast(e => e.type === 'percept.received' && !!e.data?.sender && (e.data.channel ?? MAIN_CHANNEL) === channel)
      return !!last && talkKinds.has(last.data.kind) && classify(String(last.data.text ?? ''), rc).why === ACTION_WHY
    }
    const lastReplyAt = (channel: string): number =>
      ctx.log.events.findLast(e => e.type === 'action.started' && String(e.data?.id).startsWith('reply#') && (e.data.channel ?? MAIN_CHANNEL) === channel)?.at ?? 0

    /**
     * 主人 = guard 的 owners ∪ group-policy 的 owners（认号不认名，「qq:123」或「123」）。
     * 读配置库而不 inject：没装存储插件（单测、裸内核）时就当没认主人——只是少一条提示、少一层兜底保护。
     */
    const isOwner = (s: Sender | undefined, channel: string): boolean => {
      if (!s)
        return false
      let list: unknown[] = []
      try {
        const c = ctx.use<ConfigService>('config')
        list = [...(c.get<string[]>('plugins.guard.owners') ?? []), ...(c.get<string[]>('plugins.group-policy.owners') ?? [])]
      }
      catch {
        // 没有 config 服务：见上，当作没认主人
      }
      const platform = channel.split(':')[0]
      return list.map(String).some(o => o === s.id || o === `${platform}:${s.id}`)
    }

    ctx.intercept<PreBeat>('percept/pre-beat', async (p, next) => {
      const out = await next() // 先让内核做默认处理（urgent 打断），再决定什么时候叫醒大脑
      const { percept, channel } = p
      const direct = kinds.has(percept.kind) && !!percept.text && !!percept.sender && !p.incoming
      if (!direct)
        return out
      const c = classify(percept.text!, rc)
      const owner = isOwner(percept.sender, channel)
      if (isGroup(channel)) {
        // 群里不合流：内核已即时叫醒大脑，这里只记下、需要时排兜底
        const { spine, why } = spineCandidate({
          heavy: !c.light,
          burst: false,
          owner,
          count: 1,
          why: [c.why],
          sinceReplyMs: Date.now() - lastReplyAt(channel),
          roll: Math.random(),
        }, rc)
        hand(channel, { count: 1, why, texts: [percept.text!], spine })
        return out
      }
      if (out.wake) {
        out.wake = false
        const now = Date.now()
        const pend = pending.get(channel) ?? { count: 0, heavy: false, burst: false, owner: false, why: new Set<string>(), wakes: [] }
        pend.count++
        pend.heavy ||= !c.light
        pend.owner ||= owner
        pend.why.add(c.why)
        pend.burst ||= pend.count > 1 || now - (lastIn.get(channel) ?? 0) < burstGap
        pend.wakes.push({ source: percept.kind, text: percept.text!, channel, sender: percept.sender, external: true })
        lastIn.set(channel, now)
        clearTimeout(pend.timer)
        pend.timer = setTimeout(() => settle(channel), pend.burst ? burstDelay : pend.heavy ? thinkDelay : delay)
        pending.set(channel, pend)
      }
      return out
    })

    /** 合流结束：记下交给大脑，再叫醒它 */
    const settle = (channel: string): void => {
      const pend = pending.get(channel)
      if (!pend)
        return
      pending.delete(channel)
      const { spine, why } = spineCandidate({
        heavy: pend.heavy,
        burst: pend.burst,
        owner: pend.owner,
        count: pend.count,
        why: [...pend.why],
        sinceReplyMs: Date.now() - lastReplyAt(channel),
        roll: Math.random(),
      }, rc)
      hand(channel, { count: pend.count, why, texts: pend.wakes.map(w => w.text), spine })
      wakeOnce(pend)
    }

    const hand = (channel: string, h: Omit<Handed, 'at' | 'timer'>): void => {
      clearTimeout(handed.get(channel)?.timer)
      const entry: Handed = { ...h, at: Date.now() }
      ctx.log.append('reflex.route', { channel, path: 'think', why: h.why, count: h.count, spine: h.spine })
      if (h.spine && fallbackMs > 0)
        entry.timer = setTimeout(() => fallback(channel, entry), fallbackMs)
      handed.set(channel, entry)
    }

    /** 大脑想太久：白名单里的招呼由脊椎先应一声 */
    const fallback = (channel: string, h: Handed): void => {
      if (handed.get(channel) !== h || replyRunning(channel) || lastReplyAt(channel) >= h.at)
        return
      if (fire(channel))
        ctx.log.append('reflex.route', { channel, path: 'fallback', why: [...h.why, `大脑 ${fallbackMs}ms 没决定`], count: h.count, spine: true })
    }

    /** 合流的几句并成一个唤醒原因：逐句 wake 会在第一拍开着时触发 rethink，白白多想一拍 */
    const wakeOnce = (pend: Pending): void => {
      const last = pend.wakes[pend.wakes.length - 1]
      if (!last)
        return
      ctx.mind.wake(pend.wakes.length > 1 ? { ...last, text: pend.wakes.map(w => w.text).join(' / ') } : last)
    }

    /** 起兜底 reply；没起来（已有 reply 在跑、她正在别处说话、reply 动作没装）返回 false */
    const fire = (channel: string): boolean => {
      // 她正在别的会话说话时脊椎也不替她在这开口：一次只在一个会话里。那几句仍在 handed 里，说完那拍大脑看得到「还没人回」
      if (speaking().length)
        return false
      try {
        const id = ctx.actions.start('reply', { reflex: true }, channel)
        spoke.set(channel, Date.now())
        ctx.log.append('reflex.started', { channel, actionId: id })
        ctx.bus.emit('reflex.fired', { channel, actionId: id })
        return true
      }
      catch (e) {
        // reply 动作没装（action-reply 被停用）时脊椎无事可做，大脑那拍照常
        console.warn('[reflex] 无法启动 reply:', e instanceof Error ? e.message : e)
        return false
      }
    }

    // 大脑对这个频道有了决定（回、起动作或有意不回），或者频道里已经起了 reply：不用再兜底
    ctx.on<LogEvent>('log.appended', (e) => {
      if (e.type === 'action.started' && String(e.data?.id).startsWith('reply#')) {
        clearTimeout(handed.get(e.data.channel ?? MAIN_CHANNEL)?.timer)
      }
      else if (e.type === 'mind.decision' && !e.data?.aborted) {
        for (const r of (e.data?.reasons ?? []) as { channel?: string, text?: string }[]) {
          const h = handed.get(r.channel ?? MAIN_CHANNEL)
          if (h && h.texts.some(t => String(r.text ?? '').includes(t)))
            clearTimeout(h.timer)
        }
      }
      else if (e.type === 'guard.blocked' && e.data?.action !== 'reply') {
        guardBlocked.set(e.data?.intent?.channel ?? MAIN_CHANNEL, { at: e.at, action: String(e.data?.action), why: String(e.data?.why ?? '') })
      }
    })

    // 这一拍取材料的时刻、那时哪些频道有 reply 在跑。拍是串行的（内核一次只开一拍，派发在下一次取材料之前），
    // 所以它就是「正在派发的这拍看到的世界」，不是跨拍的全局态。
    // 用处：大脑看到 reply 在跑、想了两秒，派发时那条已经说完——这时放行就是把同一件事再说一遍（探针 s6 实测：两遍晚安）。
    // 脊椎兜底同理：大脑取材料之后脊椎才开口，大脑这拍起的 reply 是没看到那句的。真要补，reply 结束那拍会带着新材料再想一次。
    let gatheredAt = 0
    let runningAtGather = new Set<string>()

    ctx.intercept<{ intent: Intent, allow: boolean }>('intent/pre-dispatch', async (p, next) => {
      const it = p.intent
      // 上游（guard、group-policy 的排队）已经拦下的不再重复判、重复记
      if (p.allow && it.do === 'start' && it.action === 'reply') {
        const channel = it.channel ?? MAIN_CHANNEL
        // 同频道在跑的先于 busy-elsewhere：打断自己（append / 作废重说）照旧按 reply-running 处理
        const busy = busyElsewhere(channel)
        const why = pending.has(channel)
          ? 'merge-pending'
          : replyRunning(channel)
            ? 'reply-running'
            : busy
              ? 'busy-elsewhere'
              : runningAtGather.has(channel)
                ? 'stale-running'
                : (spoke.get(channel) ?? 0) > gatheredAt ? 'spine-answered' : undefined
        if (why) {
          p.allow = false
          ctx.log.append('intent.blocked', { intent: it, channel, why, ...(why === 'busy-elsewhere' ? { busy } : {}) })
          // 像人一样一次只在一个会话里说话：跨频道串行原来只靠大脑规则自觉，没守住（模拟器 phone：群里回糖糖的同时私聊也开了口）。
          // 被拦的念头不丢：那边说完（reply 结束会开一拍），材料里提醒大脑「刚才想在这说的还没说」，去不去由它重新定
          const thought = String(it.params?.guidance ?? it.params?.note ?? '').trim()
          if (why === 'busy-elsewhere')
            deferred.set(channel, { at: Date.now(), thought, busy: busy! })
          // 同一套记下再提醒，也用在汇报上：结果回来时她正在这个频道说着别的，汇报被 reply-running 拦掉，
          // 说完那拍大脑看到「刚说完」就判不用补，结果一直没报（全量测试 Q-8，spine-report）
          const report = why === 'reply-running' ? unreported(channel) : undefined
          if (report)
            deferred.set(channel, { at: Date.now(), thought, busy: channel, report })
        }
        else if (it.params?.quick && asksForAction(channel)) {
          // 大脑放行了快回，可对方那句像是要她做事（「截图看看桌面」）：简短模式一个「好」就把事打发了，动作却没起。
          // 降成正常回复，大脑的 note 当念头。只看这一条，不按字数：起初按「不轻」（>4 字）降级，
          // 「你好呀，在干嘛呢」这种招呼也被当正事（全量探针 s1）——大脑明确写了 quick 就以大脑为准，字数门槛只管脊椎自己兜底
          const note = String(it.params.note ?? '').trim()
          p.intent = { ...it, params: { guidance: `${note ? `${note}。` : ''}对方是要你做事，不是打招呼：接住他的意思，正常说一句完整的话，别只回几个字` } }
          ctx.log.append('reflex.quick-demoted', { channel, intent: it })
        }
        else {
          // 同一拍里大脑常是「reply 应一声 + 起动作」，动作被 guard 拦了，reply 的念头却还是「这就去截」——
          // 嘴上答应了、实际没做（假群实测）；或者说成「电脑碰不了」，像坏了（真群实测）。
          // mind-default 把 reply 排在同拍动作之后派发，这里补一句
          const b = guardBlocked.get(channel)
          if (b && Date.now() - b.at < 10_000) {
            const g = String(it.params?.guidance ?? '').trim()
            // 待主人确认：guard 已经把这件事记下了，主人点头就自动做——这句要当面问主人，不是解释为什么不做
            //（模拟器 confirm-flow：她只说了「我问一下他」，没冲主人问，主人回「发吧」不算在答她、没叫醒）
            const tail = b.why === '待主人确认'
              ? `但 ${b.action} 要主人点头才做（已经记下了，主人回「发吧 / 可以」就自动做）：这句就当面问主人——叫「主人」或 @ 他，说清谁要做什么、问他行不行；别说「这就去」「已经在发」，也别说电脑碰不了`
              : `但 ${b.action} 刚被拦下了（${b.why}），没有在做：别说「这就去」「好的」，也别说电脑碰不到、碰不了、坏了——电脑是好的，按工作记忆里拦下的原因用自己的话说清为什么不做`
            p.intent = { ...it, params: { ...it.params, guidance: `${g ? `${g}。` : ''}${tail}` } }
          }
        }
      }
      return next()
    })

    // guard 拦下的动作（只记频道、动作、理由），上面给同拍的 reply 改念头用
    const guardBlocked = new Map<string, { at: number, action: string, why: string }>()

    // 给大脑的提示：对方还在发 / 这几句是什么样的
    ctx.intercept<{ blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      gatheredAt = Date.now()
      runningAtGather = new Set(ctx.actions.snapshot().filter(r => r.id.startsWith('reply#')).map(r => r.channel ?? MAIN_CHANNEL))
      const lines: string[] = []
      const now = speaking()
      if (now.length)
        lines.push(`你正在 ${now.join('、')} 说话：这拍别在别的频道 start reply（会被拦下），说完会再叫你，到时再定要不要去。`)
      for (const [ch, d] of deferred) {
        if (lastReplyAt(ch) >= d.at || Date.now() - d.at > 120_000) {
          deferred.delete(ch) // 已经在那说过了 / 太久了，话题早过去
          continue
        }
        const head = d.report
          ? `频道 ${ch} 你刚想汇报「${d.report}」的结果还没说${d.thought ? `（当时的念头「${d.thought}」）` : ''}：上一拍被拦下了，因为你那会儿正在这里说着别的`
          : `频道 ${ch} 你想在这说的话还没说${d.thought ? `（当时的念头「${d.thought}」）` : ''}：上一拍被拦下了，因为你正在 ${d.busy} 说话`
        if (now.length) {
          lines.push(`${head}；现在还在说，说完会再叫你。`)
          continue
        }
        lines.push(d.report
          ? `${head}；现在说完了，start reply 把结果告诉对方（结论、关键数字，没做成就说卡在哪）——刚才那句不是在说这个。`
          : `${head}；现在说完了，要不要去答由你定，想答就 start reply（不想了就不动）。`)
        deferred.delete(ch) // 提醒一次就够：大脑不去是它的决定，别每拍催
      }
      for (const ch of pending.keys())
        lines.push(`频道 ${ch} 对方还在发（还没停下），这拍别 start reply，他停下后会再叫你。`)
      for (const [ch, h] of handed) {
        if (lastReplyAt(ch) >= h.at || Date.now() - h.at > 120_000) {
          handed.delete(ch)
          continue
        }
        const hints: string[] = []
        if (h.why.includes(OWNER_WHY))
          hints.push('是主人说的：不管怎么措辞，要你做事就同一拍 start reply 应一声并 start 对应的动作')
        if (h.why.includes(ACTION_WHY))
          hints.push('像是要你动手做事：同一拍 start reply（应一声）和对应的动作（截桌面发图 screenshot、网上找图 / 查资料 / 看新闻 search、打开 / 下载 / 算东西 computer），只应不做就是没做')
        if (h.spine)
          hints.push(`很简单，想应一声就 quick:true；你 ${Math.round(fallbackMs / 1000 * 10) / 10} 秒内没决定，脊椎会先替你应一声`)
        lines.push(`频道 ${ch} 对方刚发的 ${h.count} 条还没人回（${h.why.join('、')}）${hints.length ? `：${hints.join('；')}` : ''}。`)
      }
      if (lines.length)
        m.blocks.push({ from: 'reflex', order: 5, text: `【脊椎】\n${lines.map(l => `- ${l}`).join('\n')}` })
      return next()
    })

    // 对方连发了几条：提醒发言者看完一起回，别一条一条地回
    if (cfg.burstHint ?? true) {
      ctx.intercept<ReplyPrompt>('reply/prompt', async (p, next) => {
        if (!p.append && !isGroup(p.channel)) {
          let n = 0
          for (let i = p.history.length - 1; i >= 0 && p.history[i].role === 'other'; i--) n++
          if (n >= 2) {
            p.extras.push({
              id: 'reflex-burst',
              audience: 'performer',
              order: PROMPT_ORDER.thought,
              render: () => `【此刻】对方连着发了 ${n} 条，看完一起回，一次说完，别一条一条地回。`,
            })
          }
        }
        return next()
      })
    }

    ctx.effect(() => () => {
      for (const h of handed.values()) clearTimeout(h.timer)
      handed.clear()
      // 卸载时还在合流的话别丢：直接叫醒大脑
      for (const [ch, pend] of pending) {
        clearTimeout(pend.timer)
        wakeOnce(pend)
        pending.delete(ch)
      }
    })
  },
}

export default plugin
