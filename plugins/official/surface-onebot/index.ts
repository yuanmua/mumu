/**
 * QQ 表现端：OneBot v11（NapCat）正向 WebSocket。
 *
 * 映射（这是本插件的全部策略）：
 * - 私聊 → Percept{ kind:'message', channel:'qq:private:<QQ号>' }，默认 urgent（像网页一样，新消息打断她正在打的字）。
 *   reflex 认 'message'，350ms 后自动开口。
 * - 群聊 → kind:'group.message'，channel:'qq:group:<群号>'，sender.name 取群名片；
 *   @ 她、叫她名字、回复她的消息 → 改成 'message' 并 urgent（必答，且打断她在这个群里正说的话）。
 *   发的人是群里的机器人（group-policy 的 bots 服务认的）→ 不 urgent（不被它打断），data.bot = true；理不理由 group-policy 定。
 *   其余群消息要不要接话不归本插件管（group-policy 之类在 percept/pre-beat 上决定）。
 * - 通知 / 请求（戳她、撤回、进出群、她被禁言、加好友…）→ kind:'qq.*' 感知，见 notices.ts。
 * - 发出：见 outbox.ts。只服务 qq:* 频道（服务列表随新频道增长，内核每次都现读），
 *   且只在连上 NapCat 时才注册为「有回执的表现端」——断线时不该有人替她记「已送达」。
 *   发言里的 <|quote|> / <|at:名字|> 并进下一条消息（引用、@）。
 * - 发不出去（断线、风控）：停掉那条发言的动作，内核按已回执的前缀结算（I2），而不是等超时记全文。
 * - 说话以外的事（发图 / 语音 / 文件、戳一戳、群管、查询、任意 NapCat 接口）是给导演的动作：actions.ts / queries.ts。
 *
 * 地址在 defaults.url；token 不进文件：`/secret set onebot <token>`（名字可由 tokenRef 改）。
 */
import type { Disposer, LogEvent, Plugin } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { BotsService } from '../group-policy/index.ts'
import type { PersonaNames } from '../persona/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import type { StickerPick, StickerService } from '../stickers/index.ts'
import type { TtsService } from '../tts/index.ts'
import type { ActionDeps } from './actions.ts'
import { manageAction, parseChannel, sendAction } from './actions.ts'
import { Memory, people } from './cache.ts'
import { inlineSegment, mediaItem, toMessage } from './compose.ts'
import type { OneBotConfig } from './config.ts'
import type { ImagesService } from './inline.ts'
import { makeInline, pickInline } from './inline.ts'
import { MediaStore, mediaKit } from './media.ts'
import type { Pending } from './notices.ts'
import { OneBot } from './onebot.ts'
import type { OutItem } from './outbox.ts'
import { Outbox } from './outbox.ts'
import { callAction, queryAction } from './queries.ts'
import { receiver } from './receive.ts'
import type { OneBotEvent, Segment } from './segments.ts'
import { plainText } from './segments.ts'
import { Gate, isRead } from './throttle.ts'
import { closeShrink } from './shrink.ts'
import { Vision } from './vision.ts'
import { webExtras } from './web.ts'


export type { ImagesService, InlinedTurn } from './inline.ts'

const PREFIX = 'qq:'

const plugin: Plugin<OneBotConfig> = {
  name: 'surface-onebot',
  inject: ['secrets', 'commands'],
  apply(ctx, cfg = {}) {
    const secrets = ctx.use<SecretsService>('secrets')
    const commands = ctx.use<CommandService>('commands')
    const url = cfg.url ?? 'ws://127.0.0.1:3001'
    const tokenRef = cfg.tokenRef ?? 'onebot'
    const token = (): string | undefined => cfg.token || secrets.get(tokenRef)
    const extraNames = cfg.names ?? []
    const memory = new Memory(cfg.keepMessages ?? 80)
    const pending: Pending = { friends: new Map(), groups: new Map() }

    // 服务的频道：从真源里恢复出现过的 qq 频道（导演可能隔很久主动在某个群里说话）
    const served: string[] = []
    const serve = (ch: string): void => { if (!served.includes(ch)) served.push(ch) }
    for (const e of ctx.log.events) {
      if (e.type === 'percept.received' && String(e.data?.channel ?? '').startsWith(PREFIX))
        serve(e.data.channel)
    }

    // 发言 id → 动作 id：发不出去时要停的是动作，表现端只看得到发言 id
    const uttAction = new Map<string, string>()
    ctx.on<LogEvent>('log.appended', (e) => {
      const d = e.data ?? {}
      if (e.type === 'utterance.started' && String(d.channel ?? '').startsWith(PREFIX))
        uttAction.set(d.id, d.action)
      else if (e.type === 'utterance.settled')
        uttAction.delete(d.id)
    })

    let selfId: string | undefined
    let selfNick: string | undefined
    const selfName = (): string => extraNames[0] ?? selfNick ?? '我'
    /**
     * 她的名字：persona/names 水线（真名 + QQ 网名，人格一改立刻是新值，所以每次现取）∪ 配置补充 ∪ 登录昵称兜底。
     * 没装 persona 时水线返回空，就只剩配置与昵称。
     */
    const names = async (): Promise<string[]> => {
      const fromPersona = await ctx.bus.waterfall<PersonaNames, PersonaNames>('persona/names', { platform: 'qq', names: [] }, async p => p)
        .then(p => p.names, () => [] as string[])
      return [...new Set([...fromPersona, ...extraNames, ...(selfNick ? [selfNick] : [])].map(n => n.trim()).filter(Boolean))]
    }
    const ownSet = new Set<string>()

    const vision = new Vision(req => ctx.model.complete(req), cfg.vision ?? {}, () => stickers()?.see)
    /** 表情包归 stickers 插件（库、审核、发不发、联网找）；每次现取，它重载了也拿到新的 */
    const stickers = (): StickerService | undefined => {
      if (cfg.stickers === false)
        return undefined
      try {
        return ctx.use<StickerService>('stickers')
      }
      catch {
        return undefined // 没装 stickers：表情包只看不收、不发
      }
    }
    const tts = (): TtsService | undefined => {
      try {
        return ctx.use<TtsService>('tts')
      }
      catch {
        return undefined // 没装 tts：发语音只能给现成文件
      }
    }

    // 出口节流：所有会在 QQ 里留下痕迹的操作排一条队，按真人手速一件件做（throttle.ts）
    const typingAt = new Map<string, number>()
    const gate = new Gate(cfg.throttle ?? {}, (a, p) => bot.call(a, p), (channel) => {
      const t = parseChannel(channel)
      if (cfg.inputStatus === false || t?.type !== 'private' || Date.now() - (typingAt.get(channel) ?? 0) < 4000)
        return
      typingAt.set(channel, Date.now())
      // NapCat 扩展接口；别的 OneBot 实现没有它也无妨
      bot.call('set_input_status', { user_id: t.id, event_type: 1 }).catch(() => {})
    })
    /** 写操作过门，只读的直连 */
    const call = <T = unknown>(action: string, params: Record<string, unknown> = {}, channel?: string): Promise<T> =>
      isRead(action) ? bot.call<T>(action, params) : gate.run<T>({ action, params, channel })

    /** 发一条（过门）并记下她自己的消息（引用、撤回、「回复了她」都要用） */
    const sendRaw = async (channel: string, message: Segment[], opts: { chars?: number, since?: number, signal?: AbortSignal } = {}): Promise<void> => {
      const t = parseChannel(channel)
      if (!t)
        throw new Error(`不是 QQ 频道：${channel}`)
      const res = await gate.run<{ message_id?: number | string }>({
        action: t.type === 'group' ? 'send_group_msg' : 'send_private_msg',
        params: { [t.type === 'group' ? 'group_id' : 'user_id']: t.id, message },
        channel,
        ...opts,
      })
      if (res?.message_id === undefined)
        return
      const id = String(res.message_id)
      ownSet.add(id)
      memory.remember(channel, { messageId: id, userId: selfId ?? 'self', name: selfName(), text: plainText(message) || message.map(s => `[${s.type}]`).join(''), at: Date.now() })
    }

    const { resolve, nameOf } = people(memory, (a, p) => bot.call(a, p))

    const altOf = new WeakMap<object, string>()
    const pickOf = new WeakMap<object, StickerPick>()
    const store = new MediaStore(cfg.mediaDir ?? 'data/media', cfg.maxMediaBytes ?? 8_000_000)
    const inlineCfg = cfg.images?.inline ?? {}
    const kit = mediaKit({
      store,
      saveMedia: cfg.saveMedia !== false,
      timeoutMs: cfg.vision?.timeoutMs ?? 30_000,
      see: (img, raw, at) => vision.see(img, raw, at),
      inline: (raw, sticker) => makeInline(store, raw, sticker, inlineCfg, cfg.vision?.gifFrames),
      append: (type, data) => { ctx.log.append(type, data) },
      groupName: id => web.groupName(id),
      privateName: id => memory.recent(`${PREFIX}private:${id}`, 30).find(m => m.userId === id)?.name,
    })
    const outbox = new Outbox({
      split: cfg.split ?? {},
      // 图片片段（action-image 等）直接发；marker（<|sticker:…|>、<|emo:…|>）问表情包要不要配一张，要找的话排队等
      extra: (channel, part, uttId) => {
        const item = mediaItem(cfg.mediaDir ?? 'data/media', part)
        if (item || part.kind !== 'marker')
          return item
        const wait = stickers()?.resolve({ channel, uttId, track: String(part.data?.track ?? ''), value: String(part.data?.value ?? '') })
        return wait?.then((pick) => {
          if (!pick)
            return undefined
          const it: OutItem = { kind: 'extra', part: { kind: 'image', data: { file: `base64://${pick.bytes.toString('base64')}`, sub_type: 1, summary: '[动画表情]' } }, raw: 0 }
          altOf.set(it, pick.desc)
          pickOf.set(it, pick)
          return it
        })
      },
      inline: (channel, part) => inlineSegment(memory, selfId, channel, part),
      send: async (channel, item, opts) => {
        // 表情包也要「找一会儿」，按 4 个字算
        const chars = item.kind === 'text' ? [...item.text].length : 4
        try {
          await sendRaw(channel, toMessage(item), { chars, since: opts.since, signal: opts.signal })
          if (item.kind === 'extra' && item.part.kind === 'image')
            kit.sent(channel, opts.uttId, item.part.data, altOf.get(item))
          const pick = pickOf.get(item)
          if (pick)
            stickers()?.sent(pick, channel, opts.uttId)
          return 'ok'
        }
        catch (e) {
          if (e instanceof Error && e.name === 'AbortError')
            return 'aborted'
          console.warn(`[surface-onebot] 发送到 ${channel} 失败:`, e instanceof Error ? e.message : e)
          return 'failed'
        }
      },
      report: (id, chars) => ctx.io.reportDelivered(id, chars),
      failed: (id, error) => {
        const action = uttAction.get(id)
        if (action)
          ctx.actions.stop(action, `qq-${error}`)
      },
    })

    let surfaceDispose: Disposer | undefined
    let lastError = ''
    // 先停在途发言、再撤表现端：顺序反了内核会以为没有回执端，把没发出去的也记成已送达
    const dropAll = (cause: string): void => {
      for (const id of outbox.drop()) {
        const action = uttAction.get(id)
        if (action)
          ctx.actions.stop(action, cause)
      }
      surfaceDispose?.()
      surfaceDispose = undefined
      gate.clear(cause)
    }
    const bot = new OneBot({
      url,
      token,
      reconnectMs: cfg.reconnectMs ?? 5000,
      callTimeoutMs: cfg.callTimeoutMs ?? 10000,
      onOpen: () => {
        void web.refreshGroups()
        lastError = ''
        surfaceDispose ??= ctx.io.connect({
          name: 'qq',
          channels: served,
          capabilities: { deliveredReport: true },
          onExpression: e => outbox.handle(e),
        })
        bot.call<{ user_id?: number, nickname?: string }>('get_login_info').then((info) => {
          selfId = info?.user_id !== undefined ? String(info.user_id) : selfId
          selfNick = info?.nickname ?? selfNick
          console.log(`[surface-onebot] 已连上 NapCat（${url}），QQ ${selfId ?? '?'} ${selfNick ?? ''}`)
        }).catch(e => console.warn('[surface-onebot] 取登录信息失败:', e instanceof Error ? e.message : e))
      },
      onClose: (reason) => {
        dropAll('qq-disconnected')
        // 连不上时每次重试都会走到这里；同样的原因只说一次
        if (reason !== lastError)
          console.warn(`[surface-onebot] NapCat 连接断开/连不上（${url}）：${reason}`)
        lastError = reason
      },
      onEvent: e => enqueue(e),
    })

    // 同一频道的事件按到达顺序进感知（看图、转文字要几秒，不能让后到的插队）
    const chains = new Map<string, Promise<void>>()
    const enqueue = (e: OneBotEvent): void => {
      if (e.self_id !== undefined && selfId === undefined)
        selfId = String(e.self_id)
      const uid = String(e.user_id ?? '')
      const isMsg = e.post_type === 'message' && (e.message_type === 'private' || e.message_type === 'group')
      if (!isMsg && e.post_type !== 'notice' && e.post_type !== 'request')
        return
      if (isMsg && (!uid || uid === selfId))
        return
      const channel = e.group_id !== undefined ? `${PREFIX}group:${e.group_id}` : `${PREFIX}private:${uid}`
      const prev = chains.get(channel) ?? Promise.resolve()
      const next = prev.then(() => isMsg ? perceive(e, channel, uid) : notice(e)).catch((err) => {
        console.error('[surface-onebot] 处理事件出错:', err)
      })
      chains.set(channel, next)
      void next.then(() => { if (chains.get(channel) === next) chains.delete(channel) })
    }

    const { perceive, notice } = receiver({
      percept: p => ctx.io.percept(p),
      call: (action, params) => bot.call(action, params),
      selfId: () => selfId,
      selfName,
      names,
      ownSet,
      memory,
      pending,
      nameOf,
      kit,
      serve,
      notices: cfg.notices ?? {},
      voiceToText: cfg.voiceToText !== false,
      privateUrgent: cfg.privateUrgent !== false,
      // 群里的机器人（group-policy 的 bots 服务）：现取、不注入——注入了它，group-policy 一重载 QQ 连接就跟着断
      isBot: (id) => {
        try {
          return ctx.use<BotsService>('bots').isBot('qq', id)
        }
        catch {
          return false // 没装 group-policy：没人认机器人，照常
        }
      },
      isIgnored: (id) => {
        try {
          return ctx.use<BotsService>('bots').ignored('qq', id)
        }
        catch {
          return false // 没装 group-policy：她没在不理谁
        }
      },
    })

    if (cfg.actions !== false) {
      const deps: ActionDeps = { call, selfId: () => selfId, memory, pending, tts, send: sendRaw, resolve }
      for (const t of [sendAction(deps), manageAction(deps), queryAction(deps, cfg.query ?? {}), callAction(deps, cfg.query ?? {})])
        ctx.effect(() => ctx.actions.register(t))
    }

    if (cfg.inline !== false) {
      ctx.effect(() => ctx.prompt.section({
        id: 'qq-inline',
        audience: 'performer',
        order: PROMPT_ORDER.teaching + 2,
        render: () => '【QQ 里】要 @ 某人写 <|at:对方名字|>；隔了几条才回某人、或群里好几个人在说话时，在开头写 <|quote|> 引用对方那句（引用别人写 <|quote:名字|>）。大多数时候不用。',
      }))
    }
    // 看图有失败、有来不及：别让她对着「[图片：没看清]」编内容
    ctx.effect(() => ctx.prompt.section({
      id: 'qq-images',
      audience: 'performer',
      order: PROMPT_ORDER.teaching + 3,
      render: () => '【图】对方最近发的几张图直接附了原图（文字里写成「[图片]」「[表情包]」，图就跟在那条消息后面），照你看到的图说话。'
        + '更早的图在文字里写成「[图片：…]」「[截图：…]」「[表情包：…]」，冒号后面是你当时看到的内容。'
        + '写着「没看清」「没顾上看」，或只写「[图片]」却没附图的，你没看到内容：别装看懂、别猜画面，想知道就问一句，或者只接文字部分。',
    }))

    // 原图进上下文：发言者 / 大脑组提示词时来问（inline.ts）；每次现读配置与日志
    const images: ImagesService = {
      inline: (turns, opts) => cfg.saveMedia === false ? new Map() : pickInline(ctx.log.events, turns, inlineCfg, Date.now(), opts?.numbered),
    }
    ctx.provide('images', images)

    const web = webExtras(ctx, {
      state: () => ({ open: bot.open, lastError, url, selfId, selfNick }),
      served,
      memory,
      gate,
      pending,
      call: (a, p) => bot.call(a, p),
      commands,
      tokenInfo: () => cfg.token ? '已在配置里设' : secrets.get(tokenRef) ? `已设（/secret ${tokenRef}）` : `未设（需要时网页设置里填，或 /secret set ${tokenRef} <token>）`,
      actionsOn: cfg.actions !== false,
      deny: cfg.query?.denyCall ?? ['bot_exit', 'set_restart'],
      reconnect: () => {
        dropAll('qq-reconnect')
        bot.close()
        bot.start()
      },
    })

    bot.start()

    ctx.effect(() => () => {
      dropAll('plugin-unload')
      bot.close()
      closeShrink()
    })
  },
}

export default plugin

