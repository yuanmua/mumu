/**
 * 一次只在一个会话里：她正在别处说话时，群里找她的先排队，说完再回。
 *
 * 真人用手机不会同时在私聊和两个群里打字。两个会话同时找她时，她会同时在两处开口（模拟器 phone 场景抓到过）。
 * - percept/pre-beat 上，群里直接找她的话（@、叫名字）到达时她正在别的会话里说话 → 把这次的 kind 换掉
 *   （脊椎只认 message，换掉它就不兜底抢答）；大脑照常被唤醒，通知栏里看得到「有人 @ 你」，回不回、什么时候回由大脑定。
 *   不再按感知直接入队：原来入队后等她说完自动起一条脊椎 reply，绕过了大脑（「大脑门控」后不该这样）。
 * - intent/pre-dispatch 上，大脑要在某个群起 reply 而她正在别处说话 → 拦下，连 guidance 一起进队列。
 * - 她那边说完（reply 动作结束）且哪儿都没在说话 → 按到达顺序起队首那个群的 reply，并广播 reflex.fired。
 * 私聊与网页不排队：私聊先回，这正是「先回私聊再回群」。
 */
import type { Ctx, Intent, LogEvent, Percept } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'

interface Queued { channel: string, at: number, params: Record<string, unknown>, why: string }

export interface FocusConfig {
  enabled: boolean
  maxWaitSec: number
}

export function setupFocus(ctx: Ctx, cfg: FocusConfig, isGroup: (ch: string) => boolean): void {
  if (!cfg.enabled)
    return
  const queue: Queued[] = []

  const replying = (): string[] => ctx.actions.snapshot()
    .filter(r => r.id.startsWith('reply#'))
    .map(r => r.channel ?? MAIN_CHANNEL)
  const busyElsewhere = (ch: string): boolean => replying().some(c => c !== ch)

  const enqueue = (q: Queued): void => {
    if (queue.some(x => x.channel === q.channel))
      return
    queue.push(q)
    ctx.log.append('group.queued', { channel: q.channel, why: q.why, waitingFor: replying() })
  }

  ctx.intercept<{ percept: Percept, channel: string, wake: boolean, incoming?: unknown }>('percept/pre-beat', async (b, next) => {
    const { percept, channel } = b
    if (b.incoming || !isGroup(channel) || percept.kind !== 'message' || !busyElsewhere(channel))
      return next()
    // 脊椎只认 kind 'message'：本拍换个 kind 它就不兜底抢答。日志里记的仍是原感知，大脑的唤醒原因也用原 kind
    b.percept = { ...percept, kind: 'message.queued' }
    return next()
  })

  ctx.intercept<{ intent: Intent, allow: boolean }>('intent/pre-dispatch', async (p, next) => {
    const it = p.intent
    if (p.allow && it.do === 'start' && it.action === 'reply' && it.channel && isGroup(it.channel) && busyElsewhere(it.channel)) {
      p.allow = false
      ctx.log.append('intent.blocked', { intent: it, channel: it.channel, why: 'busy-elsewhere' })
      enqueue({ channel: it.channel, at: Date.now(), params: it.params ?? {}, why: '大脑想在这里说话' })
    }
    return next()
  })

  const flush = (): void => {
    const now = Date.now()
    while (queue.length && now - queue[0].at > cfg.maxWaitSec * 1000)
      queue.shift() // 等太久了，话题早过去了，交给大脑看通知栏再定
    if (!queue.length || replying().length)
      return
    const q = queue.shift()!
    try {
      const id = ctx.actions.start('reply', q.params, q.channel)
      ctx.log.append('group.dequeued', { channel: q.channel, actionId: id, waitedMs: now - q.at })
      ctx.bus.emit('reflex.fired', { channel: q.channel, actionId: id })
    }
    catch (e) {
      console.warn('[group-policy] 排队的回复起不来:', e instanceof Error ? e.message : e)
    }
  }
  ctx.on<LogEvent>('log.appended', (e) => {
    const id = String(e.data?.id ?? '')
    if (e.type === 'action.started' && id.startsWith('reply#')) {
      // 那个群已经有人（大脑 / 脊椎）起了回复：排队的需求满足了，别再补一条
      const i = queue.findIndex(q => q.channel === (e.data?.channel ?? MAIN_CHANNEL))
      if (i >= 0)
        queue.splice(i, 1)
    }
    else if (e.type === 'action.ended' && id.startsWith('reply#')) {
      setTimeout(flush, 300) // 等结算的工作记忆写完再看
    }
  })
}
