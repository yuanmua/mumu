/**
 * 群友发的表情包：看一眼（给感知用的描述）并顺手收进库——每张只看一次。
 *
 * - 库里有（按内容摘要）：直接用库里的描述，顺便学一次用法，不调模型。
 * - 看过但没进库的（审核没过 / 不收）：描述记在内存里，再见到不再看；同一张同时来两次（刷屏）只看一次。
 * - 新的：先扣表现端的看图额度（budget，不给就不看），用表现端缩好的图一次调用同时出描述和审核结论；
 *   过了就带着这次的结论入库（不用再排队审一遍），没过只记摘要、图不落盘。
 * 原来是表现端看一遍要描述、入库再看一遍审核，同一张图实测被看 2～5 次。
 * 模拟器的图（sim）只描述不进库、不学用法：2026-10-22 测试图混进正式库，她在真群里发了出去。
 */
import type { ModelRequest } from '../../../src/index.ts'
import type { StickerBook, StickerContext } from './book.ts'
import { fileOf } from './book.ts'
import type { ReviewConfig } from './review.ts'
import { REVIEW_VERSION, review } from './review.ts'

export interface Looked { desc: string, tags: string[], emotion?: string }
export type SeeResult = Looked | { refused: string } | undefined

export interface SeeArgs {
  raw: { bytes: Buffer, mime: string }
  view: () => Promise<{ bytes: Buffer, mime: string, frames: number } | undefined>
  channel: string
  budget: () => string | undefined
  sim?: boolean // 模拟器生成的图：照常描述，不进库（测试图混进正式库她会在真群里发出去）
}

export interface CollectDeps {
  book: StickerBook
  complete: (req: ModelRequest) => Promise<string>
  review: ReviewConfig
  collect: boolean
  learn: boolean
  alive: () => boolean
  contextOf: (channel: string) => StickerContext | undefined
  log: (type: string, data: Record<string, unknown>) => void
  changed: () => void // 库变了（刷新教给她的词）
}

export function seer(d: CollectDeps): (a: SeeArgs) => Promise<SeeResult> {
  const looked = new Map<string, Looked>()
  const seeing = new Map<string, Promise<SeeResult>>()

  const fresh = async ({ raw, view, channel, budget, sim }: SeeArgs, file: string): Promise<SeeResult> => {
    const refused = budget()
    if (refused)
      return { refused }
    const v = await view()
    const r = v && await review(d.complete, v.bytes, v.mime, d.review, undefined, v.frames > 1)
    if (!r || !d.alive())
      return undefined
    const out: Looked = { desc: r.desc || r.tags.join('、') || '表情包', tags: r.tags, emotion: r.emotion }
    looked.set(file, out)
    if (looked.size > 500)
      looked.delete(looked.keys().next().value!)
    d.log('sticker.analyzed', { file, desc: r.desc, tags: r.tags, usage: r.usage, ok: r.ok, reason: r.reason, flags: r.flags, channel })
    if (!r.ok) {
      d.book.reject(file, r.reason ?? '不合适')
      return out
    }
    if (!d.collect || sim)
      return out
    try {
      const s = d.book.add(raw.bytes, raw.mime, {
        desc: out.desc,
        tags: r.tags,
        usage: r.usage,
        ok: true,
        review: { at: Date.now(), version: REVIEW_VERSION, emotion: r.emotion, isSticker: r.isSticker, flags: r.flags },
        source: { kind: 'group', channel },
      })
      if (s && d.learn)
        d.book.learn(s.file, d.contextOf(channel))
      d.changed()
    }
    catch (e) {
      console.warn('[stickers] 存表情包失败:', e instanceof Error ? e.message : e)
    }
    return out
  }

  return (a) => {
    const file = fileOf(a.raw.bytes, a.raw.mime)
    const known = d.book.has(file)
    if (known) {
      if (d.learn && !a.sim)
        d.book.learn(file, d.contextOf(a.channel))
      return Promise.resolve({ desc: known.desc, tags: known.tags, emotion: known.review?.emotion })
    }
    const memo = looked.get(file)
    if (memo)
      return Promise.resolve(memo)
    const busy = seeing.get(file)
    if (busy)
      return busy
    const job = fresh(a, file).finally(() => seeing.delete(file))
    seeing.set(file, job)
    return job
  }
}
