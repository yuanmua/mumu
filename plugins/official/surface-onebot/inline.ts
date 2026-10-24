/**
 * 原图进上下文（配置 images.inline）：聊天里最近几张图以原图跟着那条消息进发言者 / 大脑的上下文，不只给看图模型转译的一句话。
 *
 * 为什么：描述是另一个模型的转述，会偏（看错颜色、漏了图上的字、把梗看成字面），她照着转述接话就和群友看到的图对不上。
 * DeepSeek 与本地 qwen 都直接收图（2026-10-23 实测，见 provider-openai README），所以最近几张给原图，像人一样看图说话；
 * 描述照旧生成（记忆摘要、阅读窗口、搜索、日志都用文字），原图在上下文里的那几条把描述换成简短的「[图片]」，免得描述和原图打架。
 *
 * - 收图时（media.ts 调 makeInline）：另存一份长边 maxSide、JPEG quality 的副本进媒体目录，文件名与大小记进感知 data.media[].inline，
 *   连同感知里那段原文 shown 一起落日志——选图只读日志，重启也认得。转不成 JPEG / PNG 的（个别 webp）不带原图，免得模型端拒收整次请求。
 * - 选图（服务 images 的 inline）：每个频道最近 count 张、withinMin 分钟内的；stickers=false 时表情包不算；
 *   加起来超过 maxBytes 从最旧的开始退回文字。她自己发的图不带：assistant 轮次带不了图，她也知道自己发的是什么。
 * - 谁带、谁不带归调用方：发言者（performer / performer.deep）和大脑带，快回（performer.reflex）只求快、不带。
 */
import type { HistoryTurn, LogEvent } from '../../../src/index.ts'
import type { ImageAttachment } from '../provider-openai/index.ts'
import type { MediaRef, MediaStore } from './media.ts'
import type { Img } from './shrink.ts'
import { shrink } from './shrink.ts'

export interface InlineConfig {
  count?: number // 每个频道最近几张带原图；0 = 关掉（也不再另存副本）
  withinMin?: number // 多少分钟内的
  maxSide?: number // 副本长边像素
  quality?: number // 副本 JPEG 质量
  stickers?: boolean // 表情包也带原图（它常是语气的一部分）
  maxBytes?: number // 一次提示词里原图加起来的上限（副本字节数）
}

export interface InlinedTurn {
  text: string // 原图那几段描述换成「[图片]」之后的文字
  images: ImageAttachment[]
  /** 换了哪几段：同一句话还出现在别处时（大脑的【本次唤醒】也引着这条消息）照这个一起换 */
  swaps: { from: string, to: string }[]
}

/** 服务 `images`：发言者 / 大脑组提示词时问「这段历史里哪几轮带原图」。契约随本文件经 index.ts 导出，消费方只 import type */
export interface ImagesService {
  /**
   * 下标（turns 里的位置）→ 那一轮换过占位的文字 + 附件；不在表里的照旧用文字描述。
   * numbered：附件没法逐轮跟在消息后面时（大脑的【最近对话】是一整段文字），占位和附件编上号对得上
   */
  inline: (turns: HistoryTurn[], opts?: { numbered?: boolean }) => Map<number, InlinedTurn>
}

/** 收图时另存副本；count 为 0、表情包不带时不做 */
export async function makeInline(store: MediaStore, raw: Img, sticker: boolean, cfg: InlineConfig, gifFrames = 4): Promise<MediaRef['inline']> {
  if ((cfg.count ?? 3) <= 0 || (sticker && cfg.stickers === false))
    return undefined
  const v = await shrink(raw, cfg.maxSide ?? 1024, gifFrames, cfg.quality ?? 80)
  if (v.mime !== 'image/jpeg' && v.mime !== 'image/png')
    return undefined
  const media = store.save(v.bytes, v.mime)
  return media ? { media, bytes: v.bytes.length } : undefined
}

interface Pick { turn: number, ref: MediaRef & { inline: { media: string, bytes: number } }, channel: string }

export function pickInline(events: readonly LogEvent[], turns: HistoryTurn[], cfg: InlineConfig, now = Date.now(), numbered = false): Map<number, InlinedTurn> {
  const out = new Map<number, InlinedTurn>()
  const count = cfg.count ?? 3
  if (count <= 0 || !turns.length)
    return out
  const since = now - (cfg.withinMin ?? 15) * 60_000
  // 只翻窗口内的那一段日志：频道 + 时间对上历史那一轮（内核的 history 就是这么从 percept.received 来的）
  const media = new Map<string, MediaRef[]>()
  for (let i = events.length - 1; i >= 0 && events[i].at >= since; i--) {
    const e = events[i]
    const refs = e.type === 'percept.received' ? e.data?.data?.media : undefined
    if (Array.isArray(refs) && refs.length)
      media.set(`${e.data.channel}|${e.at}`, refs as MediaRef[])
  }
  if (!media.size)
    return out

  // 从新到旧挑：每个频道最多 count 张，总字节超了的（必然是更旧的）退回文字
  const perChannel = new Map<string, number>()
  const picks: Pick[] = []
  let total = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t.role !== 'other' || t.at < since)
      continue
    const refs = media.get(`${t.channel}|${t.at}`) ?? []
    for (const ref of [...refs].reverse()) {
      if (!ref.inline || (ref.kind === 'sticker' && cfg.stickers === false))
        continue
      const n = perChannel.get(t.channel) ?? 0
      if (n >= count || total + ref.inline.bytes > (cfg.maxBytes ?? 2_000_000))
        continue
      perChannel.set(t.channel, n + 1)
      total += ref.inline.bytes
      picks.push({ turn: i, ref: ref as Pick['ref'], channel: t.channel })
    }
  }

  // 编号按时间从旧到新（读起来是「图1、图2」）；一轮里几张按消息里的顺序
  picks.reverse()
  picks.forEach((p, k) => {
    const what = p.ref.what ?? (p.ref.kind === 'sticker' ? '表情包' : '图片')
    const short = numbered ? `[${what}${k + 1}]` : `[${what}]`
    const cur = out.get(p.turn) ?? { text: turns[p.turn].text, images: [], swaps: [] }
    // 原文找不到（别的插件改过这一轮的文字）就留着描述照样附图：多一句描述，不至于丢图
    if (p.ref.shown && cur.text.includes(p.ref.shown)) {
      cur.text = cur.text.replace(p.ref.shown, () => short)
      cur.swaps.push({ from: p.ref.shown, to: short })
    }
    cur.images.push({
      media: p.ref.inline.media,
      bytes: p.ref.inline.bytes,
      ...(p.ref.alt ? { alt: p.ref.alt } : {}),
      ...(numbered ? { label: short } : {}),
    })
    out.set(p.turn, cur)
  })
  return out
}
