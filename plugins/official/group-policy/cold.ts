/**
 * 想聊就聊，不想理就不理：@ 她不再是 100% 必答。
 *
 * - percept/pre-beat：群里 @ 她 / 叫她名字（surface-onebot 标成 message）时，按「此刻想不想聊这个群」掷一次：
 *   接的概率 = at.base × (好感 × 心情)^at.sensitivity（judge.ts atChance；平时约 0.95，烦的群 + 心情差会低很多）。
 *   没掷中 → 这一拍把 kind 换成 message.cold：脊椎不抢答，大脑照常被唤醒，自己决定敷衍一句还是不回。
 *   刚敷衍过、同一个人刚 @ 过、带低俗词、斗嘴够了：也都只是「不抢着回」，大脑一定会被叫醒，材料里写着这句的情况
 *   （2026-10-22 之前「刚敷衍过 / 刚答过他」是 wake=false 连想都不想；现在不写死，让她自己判断；按人累积的烦在 temper.ts）。
 *   主人（guard 的 owners ∪ 本插件 owners）@ 她必答，不掷。大脑决定不理的人在 index.ts 最外层就拦下了，到不了这里。
 *   必须登记在 focus.ts（排队）之前：冷下来的 @ 不该被当成「有人找她」排进队。
 * - 内核唤醒大脑时用的是原感知的 kind（仍是 message），大脑会以为脊椎已经回了——
 *   所以 beat/gather 另给一块「冷 @」：谁 @ 了你、你此刻为什么懒得理、脊椎没替你回。
 * - reply/prompt：在一个「懒得理」的群里开口时，给发言者一句态度（敷衍、短）；「想聊」时也说一声。
 */
import type { ConfigService, Ctx, LogEvent, Percept, Section } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import type { ReplyPrompt } from '../action-reply/index.ts'
import type { PolicyConfig } from './judge.ts'
import { isCommand } from './bot-text.ts'
import { atChance, tabooIn } from './judge.ts'
import type { RateDeps } from './rates.ts'
import { feelOf, willingness } from './rates.ts'

interface ColdAt { at: number, channel: string, who: string, text: string, why: string }

export interface ColdDeps {
  cfg: PolicyConfig
  config: ConfigService
  rate: RateDeps
  isGroup: (ch: string) => boolean
  record: (r: { at: number, channel: string, who: string, p: number, why: string[], wake: boolean }) => void
  isOwner: (key: string) => boolean
  /** 群里的机器人：它的话在 index.ts 的闸里已经判过（放行 = 主人解锁 / 额度），这里不再掷一次 */
  isBot: (ch: string, who: string) => boolean
  /** 这句 @ 到达前她就在和这人聊着（convo.ts）：接着聊的 @ 不算「刚 @ 过又 @」，也不算斗嘴 */
  inConvo: (ch: string, who: string) => boolean
  /** 这个群当前的话题（topics.ts）：被 @ 着接了几轮 */
  topicAt: (ch: string, now: number) => { status: 'open' | 'closed', atTurns: number } | undefined
  /** 这句 @ 的情况（temper.ts）：带什么词、这人今天第几次 @ 她、她对他多烦——只是材料 */
  hints: (ch: string, who: string, now: number) => string[]
}

export function setupColdAt(ctx: Ctx, d: ColdDeps): { block: (now: number) => string } {
  const colds: ColdAt[] = []
  // 在一个不招她喜欢的群里（@ 接的概率低于 at.onceBelow）被 @ 之后她开了口——不管那次是掷中了接还是大脑决定敷衍——记下时刻。
  // at.onceSec 内这个群再有人 @，就不理了：回一次就够，不是有问必答（掷骰只管「这一次想不想接」，管不住接二连三）
  const lowAt = new Map<string, number>()
  const answeredAt = new Map<string, number>() // 「频道|发送者」→ 上次接他的 @ 的时刻
  const brushedOff = new Map<string, number>()
  ctx.on<LogEvent>('log.appended', (e) => {
    const ch = String(e.data?.channel ?? '')
    if (e.type === 'utterance.started' && e.at - (lowAt.get(ch) ?? 0) < 180_000)
      brushedOff.set(ch, e.at)
  })

  ctx.intercept<{ percept: Percept, channel: string, wake: boolean, incoming?: unknown }>('percept/pre-beat', async (b, next) => {
    const { percept, channel } = b
    if (!b.wake || b.incoming || !d.isGroup(channel) || percept.kind !== 'message' || !percept.sender)
      return next()
    if (d.isOwner(`${channel.split(':')[0]}:${percept.sender.id}`) || d.isBot(channel, String(percept.sender.id)))
      return next()
    const now = Date.now()
    const w = willingness(d.rate, channel, now)
    const p = atChance(d.cfg, w.affinity, w.mood)
    const low = p < (d.cfg.at?.onceBelow ?? 0.7)
    if (low)
      lowAt.set(channel, now)
    const who = String(percept.sender.id)
    // 正在和她聊的人接着 @：下面「刚答过他」「刚敷衍过」「被 @ 着接够了」都不算——
    // 原来同一个人两分钟内第二次 @ 直接不理，聊一个问题得 @ 她好多遍（主人才没被这条挡）。
    // 「@ 她让她做事」原来也豁免，靠任务词子串匹配，2026-10-23 随做事直通一起删了（被 @ 照样叫醒大脑，只是不抢着回、她自己定）
    const talking = d.inConvo(channel, who)
    const once = !talking && low && now - (brushedOff.get(channel) ?? 0) < (d.cfg.at?.onceSec ?? 180) * 1000
    // 同一个人 perPersonSec 内连着 @ 她：答过一次就够了，再 @ 连想都不想（主人除外，上面已放行）
    const samePerson = !talking && now - (answeredAt.get(`${channel}|${who}`) ?? 0) < (d.cfg.at?.perPersonSec ?? 120) * 1000
    // 带涉黄 / 低俗 / 骂战 / 政治的词：不抢着回（脊椎不替她应），叫醒大脑让她自己看着办——接、岔开、不理都行
    const taboo = tabooIn(percept.text ?? '', d.cfg)
    // 「/ccb @沐沐」：发给群里机器人的指令，@ 她只是参数（真群 2026-10-22 她每次都接「又ccb我」）——也不抢着回，材料里写明
    const command = isCommand(percept.text ?? '')
    // 斗嘴也有个头：同一个话题里被 @ 着已经接了 atMaxTurns 轮，再 @ 就不抢着回，交给大脑看要不要接
    const t = d.topicAt(channel, now)
    const atMax = d.cfg.topic?.atMaxTurns ?? 2
    const enough = !talking && t?.status === 'open' && atMax > 0 && t.atTurns >= atMax
    const answer = !once && !samePerson && !taboo && !command && !enough && Math.random() < p
    const f = feelOf(w, d.cfg.feel ?? {})
    // 这句的情况（temper.ts：带什么词、是不是指令、这人今天第几次 @、她对他多烦）——只是材料，给大脑和日志
    const hints = d.hints(channel, who, now)
    const coldWhy = [
      taboo && !hints.some(h => h.includes('低俗')) ? `带低俗 / 骂人 / 政治的词（${taboo}）` : '',
      command && !hints.some(h => h.includes('指令')) ? '是发给机器人的指令' : '',
      once ? '刚在这个群敷衍过一句' : '',
      samePerson ? '这个人刚 @ 过、已经答过一次' : '',
      enough ? `这个话题被 @ 着已经接了 ${t!.atTurns} 轮` : '',
      ...hints,
    ].filter(Boolean).join('，') || (f.reasons.join('，') || f.level)
    // 原来「刚敷衍过 / 刚答过他」直接 wake=false（连想都不想）；现在一律叫醒大脑，理不理由她定（不写死，让她自己判断）
    const why = answer
      ? [`被 @ / 叫名字，接（p=${p}）${hints.length ? `；${hints.join('；')}` : ''}`]
      : taboo || command || once || samePerson || enough
        ? [`被 @ / 叫名字，但${coldWhy}，不抢着回、她自己定`]
        : [`被 @ / 叫名字，但此刻${f.level}${f.reasons.length ? `（${f.reasons.join('，')}）` : ''}，不抢着回（p=${p}）${hints.length ? `；${hints.join('；')}` : ''}`]
    if (answer)
      answeredAt.set(`${channel}|${who}`, now)
    else {
      b.percept = { ...percept, kind: 'message.cold' } // 脊椎只认 message；日志里记的仍是原感知
      colds.push({ at: now, channel, who: percept.sender.name ?? percept.sender.id, text: percept.text ?? '', why: coldWhy })
      if (colds.length > 20)
        colds.shift()
    }
    d.record({ at: now, channel, who: percept.sender.name ?? percept.sender.id, p, why, wake: b.wake })
    ctx.log.append('group.policy', { channel, sender: percept.sender, p, why, wake: b.wake, at: true, answered: answer, factors: { affinity: w.affinity, mood: w.mood } })
    return next()
  })

  ctx.intercept<ReplyPrompt>('reply/prompt', async (p, next) => {
    if (d.isGroup(p.channel)) {
      const w = willingness(d.rate, p.channel, Date.now())
      const f = feelOf(w, d.cfg.feel ?? {})
      const why = f.reasons.length ? `（${f.reasons.join('，')}）` : ''
      const text = f.level === '懒得理'
        ? `【此刻对这个群】你现在懒得理这个群${why}。要回就敷衍一句，短，别热情、别追问、别找话题。`
        : f.level === '想聊' ? `【此刻对这个群】你挺想在这个群聊${why}，可以多说两句。` : ''
      if (text) {
        const s: Section = { id: 'group-feel', audience: 'performer', order: PROMPT_ORDER.thought, render: () => text }
        p.extras = [...p.extras, s]
      }
    }
    return next()
  })

  return {
    block(now) {
      const recent = colds.filter(c => now - c.at < 180_000)
      if (!recent.length)
        return ''
      const lines = recent.map(c => `- 群 ${c.channel.split(':').pop()} ${c.who} @ 了你：「${c.text.slice(0, 30)}」——你没抢着回（${c.why}），脊椎也没替你回`)
      return `【冷 @】（想敷衍就 start reply，guidance 写敷衍一句；不想理就不动，不回也行）\n${lines.join('\n')}`
    },
  }
}
