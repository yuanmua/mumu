/**
 * 表情包：库、审核、联网找、发不发。表现端只管「怎么发出去」，挑哪张、该不该发、库里没有怎么办都在这里。
 *
 * 流程：
 * - 收：群友发的表情包由 surface-onebot 看过后交给 collect()，收进库、排队审核（review.ts），审过才能发；见一次学一次用法。
 * - 发：发言里的 <|sticker:描述|>（她明说要发）或 <|emo:词|>（顺手配一张）→ decide()：
 *   对方要表情包就一定发；否则按她此刻的状态算概率（chance.ts），刚发过不连发，一条发言最多一张。
 *   库里没有合适的 → 联网找（search.ts，审核通过才入库）→ 还没有 → 对方要的话给导演一条 sticker.missing，让她说一声。
 * - 两条出路：频道前缀在 selfServed 里的（qq:）由那个表现端经 stickers 服务 resolve() 拿图、按自己的节奏发，发出后回调 sent()；
 *   其余频道（网页）这里自己兑现：拷进媒体目录，记一条 surface.media，网页把图挂到那条发言上（docs/web-protocol.md §5）。
 * - 她自己知道：发出后进工作记忆「刚发了一张…」；发言者每次看到这个会话最近发过什么、对方是不是在要；导演看到库里有多少、最近发过什么。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Disposer, LogEvent, Plugin } from '../../../src/index.ts'
import type { EmotionService } from '../emotion/index.ts'
import type { Sticker } from './book.ts'
import { StickerBook, mimeOf } from './book.ts'
import type { SeeArgs, SeeResult } from './collect.ts'
import { seer } from './collect.ts'
import { chance, isAsk } from './chance.ts'
import type { ReviewConfig } from './review.ts'
import { REVIEW_VERSION, review } from './review.ts'
import type { SearchConfig } from './search.ts'
import { Hunter } from './search.ts'
import { closeShrink, shrink } from './shrink.ts'
import { promptParts } from './prompt.ts'
import { webParts } from './web.ts'

export interface StickersConfig {
  dir?: string
  mediaDir?: string
  max?: number
  maxContexts?: number
  collect?: boolean
  learn?: boolean
  teachTags?: number
  chance?: number
  emoChance?: number
  minGapSec?: number
  heatWindowSec?: number
  seriousChars?: number
  askPatterns?: string[]
  searchOn?: 'asked' | 'explicit' | 'never'
  selfServed?: string[]
  recheck?: boolean
  review?: ReviewConfig
  search?: SearchConfig
}

/** 挑中的一张：表现端拿字节去发 */
export interface StickerPick { file: string, desc: string, mime: string, bytes: Buffer }

/** 服务 `stickers`：表现端（surface-onebot）用；契约随本文件导出，消费方只 import type */
export interface StickerService {
  /** 发言里的一个标记要不要配表情包：不发返回 undefined（同步）；要发返回 Promise（库里挑 / 联网找，可能落空） */
  resolve: (r: { channel: string, uttId: string, track: string, value: string }) => Promise<StickerPick | undefined> | undefined
  /** 表现端真的发出去了 */
  sent: (pick: StickerPick, channel: string, uttId: string) => void
  /**
   * 群友发的表情包：看一眼（给感知用的描述）并顺手收进库。库里有 / 刚看过的不调模型；新的一次调用同时出描述和审核结论。
   * view：表现端缩好的图（懒取，命中库就不缩）；budget：真要调模型前扣表现端的看图额度，不给就返回 { refused }
   */
  see: (a: SeeArgs) => Promise<SeeResult>
}

interface Utt { channel: string, action: string, at: number, said: number, done: boolean, emoTried: boolean }

const plugin: Plugin<StickersConfig> = {
  name: 'stickers',
  apply(ctx, cfg = {}) {
    const book = new StickerBook(cfg.dir ?? 'data/stickers', cfg.max ?? 500, cfg.maxContexts ?? 5)
    const mediaDir = resolve(cfg.mediaDir ?? 'data/media')
    const selfServed = cfg.selfServed ?? ['qq:']
    const blockWords = cfg.review?.blockWords ?? []
    /** 自己看（联网找来的、重审库里的）：先缩图，动图抽帧拼起来 */
    const look = async (bytes: Buffer, mime: string, signal?: AbortSignal) => {
      const v = await shrink({ bytes, mime }, 512, 4)
      return review(req => ctx.model.complete(req), v.bytes, v.mime, cfg.review ?? {}, signal, v.frames > 1)
    }
    ctx.effect(() => () => closeShrink())
    const hunter = new Hunter({
      book,
      cfg: cfg.search ?? {},
      blockWords,
      review: look,
      log: (type, data) => { ctx.log.append(type, data) },
      alive: () => alive,
    })

    // 词汇：库里最常见的标签登记成 sticker 通道的 marker（进 expression-basic 的词表），库变了就刷新
    let vocab: Disposer[] = []
    const teach = (): void => {
      for (const d of vocab) d()
      vocab = book.topTags(cfg.teachTags ?? 16).map(value => ctx.io.markers.add({ track: 'sticker', value }))
    }
    teach()
    ctx.effect(() => () => { for (const d of vocab) d() })

    // ── 审核队列：群里收的、旧规则审过的，一次一张 ──
    const queue: string[] = []
    let looking = false
    // 卸载后后台那张还在看：看完别再写盘——新实例已经接手 index.json，旧实例一写就把别人的改动盖掉（实测并库时丢过）
    let alive = true
    ctx.effect(() => () => { alive = false })
    const recheck = (file: string): void => {
      if (!queue.includes(file))
        queue.push(file)
      void drain()
    }
    const drain = async (): Promise<void> => {
      if (looking)
        return
      looking = true
      try {
        while (queue.length && alive) {
          const s = book.has(queue.shift()!)
          if (!s)
            continue
          const r = await look(book.read(s), mimeOf(s.file))
          if (!alive)
            return
          if (!r)
            continue // 看不了：保持原结论（没审的就还不能发），下次启动再试
          book.reviewed(s.file, { ...r, review: { at: Date.now(), version: REVIEW_VERSION, emotion: r.emotion, isSticker: r.isSticker, flags: r.flags } })
          ctx.log.append('sticker.analyzed', { file: s.file, desc: r.desc, tags: r.tags, usage: r.usage, ok: r.ok, reason: r.reason, flags: r.flags })
          teach()
        }
      }
      finally {
        looking = false
      }
    }
    if (cfg.recheck !== false) {
      for (const s of book.all()) {
        if ((s.review?.version ?? 1) < REVIEW_VERSION)
          queue.push(s.file)
      }
      // 启动时别抢模型：等一会儿再在后台慢慢审
      const t = setTimeout(() => void drain(), 20_000)
      t.unref()
      ctx.effect(() => () => clearTimeout(t))
    }

    // ── 她的发言：哪个频道、哪个动作、说了几个字、配过表情包没有 ──
    const utts = new Map<string, Utt>()
    const lastAt = new Map<string, number>() // 频道 → 她上一张表情包的时间
    const lastSettled = new Map<string, string>() // 频道 → 她上一条发言
    const stickered = new Set<string>() // 带了表情包的发言
    for (let i = ctx.log.events.length - 1, n = 0; i >= 0 && n < 5000; i--, n++) {
      const e = ctx.log.events[i]
      if (e.type === 'sticker.sent' && !lastAt.has(e.data?.channel))
        lastAt.set(e.data.channel, e.at)
    }

    const mood = () => {
      try {
        return ctx.use<EmotionService>('emotion').state()
      }
      catch {
        return undefined // 没装 emotion：心情不影响
      }
    }

    /** 对方最近一句是不是在要表情包，且她之后还没给过 */
    const askedIn = (channel: string): boolean => {
      const last = ctx.log.history({ channel, limit: 6 }).filter(t => t.role === 'other').at(-1)
      if (!last || Date.now() - last.at > 5 * 60_000 || (lastAt.get(channel) ?? 0) > last.at)
        return false
      return isAsk(last.text, cfg.askPatterns)
    }

    const deepOf = (action: string): boolean => {
      for (let i = ctx.log.events.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
        const e = ctx.log.events[i]
        if (e.type === 'action.started' && e.data?.id === action)
          return e.data.params?.tier === 'deep'
      }
      return false
    }

    const missing = (channel: string, query: string, why: string): void => {
      ctx.log.append('sticker.missed', { channel, query, why })
      void ctx.io.percept({
        kind: 'sticker.missing',
        channel,
        text: `[表情包没找到] 你想发一张「${query}」的表情包，库里和网上都没找到合适的（${why}）。对方在等，跟对方说一声，一句就好，比如「没找到合适的图，下次补上」。`,
        data: { query, why },
      })
    }

    /** 这个标记配不配表情包；要配返回挑 / 找的 Promise */
    const decide = (channel: string, uttId: string, track: string, value: string): Promise<Sticker | undefined> | undefined => {
      if (track !== 'sticker' && track !== 'emo')
        return undefined
      const u = utts.get(uttId) ?? { channel, action: '', at: Date.now(), said: 0, done: false, emoTried: false }
      utts.set(uttId, u)
      if (u.done || (track === 'emo' && u.emoTried))
        return undefined
      if (track === 'emo')
        u.emoTried = true
      const history = ctx.log.history({ channel, limit: 12 })
      const others = history.filter(t => t.role === 'other')
      const windowMs = (cfg.heatWindowSec ?? 180) * 1000
      const prev = lastSettled.get(channel)
      const asked = askedIn(channel)
      const c = chance({
        track,
        asked,
        base: track === 'sticker' ? cfg.chance ?? 0.5 : cfg.emoChance ?? 0.15,
        mood: mood(),
        othersRecent: others.filter(t => Date.now() - t.at < windowMs).length,
        otherSticker: others.slice(-2).some(t => t.text.includes('[表情包')),
        deep: u.action ? deepOf(u.action) : false,
        saidChars: u.said,
        otherChars: [...(others.at(-1)?.text ?? '')].length,
        sinceLastSec: (Date.now() - (lastAt.get(channel) ?? 0)) / 1000,
        lastUttHad: prev !== undefined && stickered.has(prev),
        minGapSec: cfg.minGapSec ?? 120,
        seriousChars: cfg.seriousChars,
      })
      const send = Math.random() < c.p
      ctx.log.append('sticker.decided', { channel, uttId, track, query: value, p: c.p, why: c.why, send })
      if (!send)
        return undefined
      u.done = true
      return (async () => {
        const query = value.trim() || mood()?.last || '开心'
        let s = book.pick(query, channel)
        const search = cfg.searchOn ?? 'explicit'
        let why = '库里没有合适的'
        if (!s && (search === 'explicit' ? track === 'sticker' || asked : search === 'asked' && asked)) {
          const r = await hunter.find(query, asked ? '对方要' : '她想发')
          s = r.sticker
          why = r.error ?? why
        }
        // 对方明说要、网上也没找到：库里有就随便发一张最接近的
        s ??= asked ? book.pick(query, channel, 0) : undefined
        if (!s) {
          u.done = false
          if (asked)
            missing(channel, query, why)
          else ctx.log.append('sticker.missed', { channel, query, why })
        }
        return s
      })()
    }

    const toPick = (s: Sticker): StickerPick => ({ file: s.file, desc: s.desc, mime: mimeOf(s.file), bytes: book.read(s) })

    const sent = (pick: StickerPick, channel: string, uttId: string): void => {
      book.markSent(pick.file, channel)
      lastAt.set(channel, Date.now())
      stickered.add(uttId)
      if (stickered.size > 500)
        stickered.delete(stickered.values().next().value!)
      ctx.log.append('sticker.sent', { channel, uttId, file: pick.file, desc: pick.desc })
      const action = utts.get(uttId)?.action
      if (action)
        ctx.prompt.addNote(`刚发了一张表情包（${pick.desc}）。`, { source: action, beats: 3 })
    }

    /** 网页等没有自己发表情包的频道：拷进媒体目录、记 surface.media，网页按 utt 挂到那条发言上 */
    const showOnWeb = (s: Sticker, channel: string, uttId: string): void => {
      try {
        mkdirSync(mediaDir, { recursive: true })
        const to = join(mediaDir, s.file)
        if (!existsSync(to))
          copyFileSync(join(book.dir, s.file), to)
      }
      catch (e) {
        console.warn('[stickers] 拷进媒体目录失败（网页看不到这张）:', e instanceof Error ? e.message : e)
        return
      }
      ctx.log.append('surface.media', { uttId, utt: uttId, channel, platform: 'web', kind: 'sticker', media: s.file, url: `/api/media/${encodeURIComponent(s.file)}`, mime: mimeOf(s.file), alt: s.desc })
      sent(toPick(s), channel, uttId)
    }

    ctx.on<LogEvent>('log.appended', (e) => {
      const d = e.data ?? {}
      if (e.type === 'utterance.started') {
        utts.set(d.id, { channel: d.channel ?? 'main', action: d.action ?? '', at: e.at, said: 0, done: false, emoTried: false })
        if (utts.size > 200)
          utts.delete(utts.keys().next().value!)
      }
      else if (e.type === 'utterance.part') {
        const u = utts.get(d.id)
        if (!u)
          return
        if (d.part?.text)
          u.said += [...String(d.part.text)].length
        else if (d.part?.kind === 'marker' && !selfServed.some(p => u.channel.startsWith(p))) {
          const p = decide(u.channel, d.id, String(d.part.data?.track ?? ''), String(d.part.data?.value ?? ''))
          void p?.then((s) => { if (s) showOnWeb(s, u.channel, d.id) }).catch(err => console.warn('[stickers] 配表情包出错:', err))
        }
      }
      else if (e.type === 'utterance.settled' && (d.delivered || stickered.has(d.id))) {
        lastSettled.set(d.channel ?? 'main', d.id)
      }
    })

    const contextOf = (channel: string): { text: string, channel: string, at: number } | undefined => {
      // 群友发它之前紧挨着的那一句：学用法（多取一句会把上一个话题也算进来，实测串味）
      const h = ctx.log.history({ channel, limit: 3 }).filter(t => t.role === 'other' && !t.text.includes('[表情包'))
      const last = h.at(-1)?.text.slice(0, 60)
      return last ? { text: last, channel, at: Date.now() } : undefined
    }

    const service: StickerService = {
      resolve: ({ channel, uttId, track, value }) => decide(channel, uttId, track, value)?.then(s => s && toPick(s)),
      sent,
      see: seer({
        book,
        complete: req => ctx.model.complete(req),
        review: cfg.review ?? {},
        collect: cfg.collect !== false,
        learn: cfg.learn !== false,
        alive: () => alive,
        contextOf,
        log: (type, data) => { ctx.log.append(type, data) },
        changed: teach,
      }),
    }
    ctx.provide('stickers', service)

    promptParts(ctx, { book, askedIn, lastAt, cfg })
    webParts(ctx, { book, hunter, recheck, teach, queue: () => queue.length })
  },
}

export default plugin
