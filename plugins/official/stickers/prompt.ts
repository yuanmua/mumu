/**
 * 让她知道手里有什么、该不该发：
 * - 发言者段落（全局）：<|sticker:描述|> 怎么写、什么时候发；库空着也教（库里没有会去网上找）。
 * - reply/prompt（按频道）：对方刚要了表情包 → 这条一定写一个；这个会话最近发过什么 → 别连发。
 * - beat/gather（导演）：库里几张、今天发了几张，唤醒原因所在会话最近发过什么；对方要表情包就让她发。
 */
import type { Ctx, MaterialBlock, WakeReason } from '../../../src/index.ts'
import { PROMPT_ORDER, formatElapsed } from '../../../src/index.ts'
import type { ReplyPrompt } from '../action-reply/index.ts'
import type { StickerBook } from './book.ts'
import type { StickersConfig } from './index.ts'

export interface PromptDeps {
  book: StickerBook
  askedIn: (channel: string) => boolean
  lastAt: Map<string, number>
  cfg: StickersConfig
}

export function promptParts(ctx: Ctx, d: PromptDeps): void {
  const online = d.cfg.search?.enabled !== false && (d.cfg.searchOn ?? 'explicit') !== 'never'

  ctx.effect(() => ctx.prompt.section({
    id: 'sticker-teaching',
    audience: 'performer',
    order: PROMPT_ORDER.teaching + 1,
    render: () => {
      if (!d.book.size && !online)
        return ''
      return '【表情包】在聊天软件里，<|sticker:描述|> 会单独发一张表情包。描述写你想表达的情绪或意思（如「无语」「笑死」「抱抱」「得意」），不限于上面词表里的词。'
        + '对方要你发表情包时一定写一个；平时情绪真到了才偶尔发，大多数回复不带，一条回复最多一个，认真说事的时候不发，刚发过就别再发。'
    },
  }))

  /** 这个会话里她最近发过的表情包（10 分钟内，最新在后） */
  const recent = (channel: string): { desc: string, at: number }[] => {
    const out: { desc: string, at: number }[] = []
    const since = Date.now() - 10 * 60_000
    for (let i = ctx.log.events.length - 1, n = 0; i >= 0 && n < 3000; i--, n++) {
      const e = ctx.log.events[i]
      if (e.at < since)
        break
      if (e.type === 'sticker.sent' && e.data?.channel === channel)
        out.unshift({ desc: String(e.data.desc ?? ''), at: e.at })
    }
    return out.slice(-3)
  }

  ctx.intercept<ReplyPrompt>('reply/prompt', async (p, next) => {
    const lines: string[] = []
    if (d.askedIn(p.channel))
      lines.push(`对方在要表情包：这条回复里一定写一个 <|sticker:描述|>，描述写你此刻想表达的${online ? '（库里没有会去网上找）' : ''}。`)
    else {
      const r = recent(p.channel)
      if (r.length)
        lines.push(`你刚才在这里发过表情包：${r.map(x => `「${x.desc}」（${formatElapsed(Date.now() - x.at)}前）`).join('、')}。别连着发。`)
    }
    if (lines.length) {
      p.extras.push({
        id: 'sticker-now',
        audience: 'performer',
        order: PROMPT_ORDER.thought + 1,
        render: () => `【表情包】${lines.join('')}`,
      })
    }
    return next()
  })

  ctx.intercept<{ reasons: WakeReason[], blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
    const channels = [...new Set(m.reasons.map(r => r.channel).filter((c): c is string => Boolean(c)))]
    const today = new Date().setHours(0, 0, 0, 0)
    let sent = 0
    for (let i = ctx.log.events.length - 1, n = 0; i >= 0 && n < 20_000; i--, n++) {
      const e = ctx.log.events[i]
      if (e.at < today)
        break
      if (e.type === 'sticker.sent')
        sent++
    }
    const tags = d.book.topTags(8)
    const lines = [`库里 ${d.book.size} 张能发${tags.length ? `（常见：${tags.join('、')}）` : ''}，今天发了 ${sent} 张。`]
    for (const ch of channels) {
      const r = recent(ch)
      if (r.length)
        lines.push(`${ch}：${formatElapsed(Date.now() - r.at(-1)!.at)}前刚发了「${r.at(-1)!.desc}」`)
      if (d.askedIn(ch))
        lines.push(`${ch}：对方在要表情包，还没给`)
    }
    lines.push(`对方要表情包就让她发：start reply，guidance 写「发一张xx的表情包」。${online ? '库里没有她会去网上找，找不到会告诉你。' : ''}`)
    m.blocks.push({ from: 'stickers', order: 60, text: `【表情包】${lines.join('\n')}` })
    return next()
  })
}
