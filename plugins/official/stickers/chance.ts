/**
 * 发不发：纯函数，测试直接调。
 *
 * - 对方明说要（「发个表情」「来张图」「斗图」）→ 一定发，不看间隔（asked）。
 * - 她自己写了 <|sticker:…|>（explicit）或只写了 <|emo:…|>（顺手配一张）→ 概率 = 基础概率 × 状态系数：
 *   心情好、兴奋 → 高；低落 → 低；聊得热（别人近几分钟说得多）→ 高，冷清 → 低；对方刚发了表情包 → 高；
 *   认真话题（导演让她认真答 / 她这句已经说了一大段 / 对方发了一大段）→ 不发。
 * - 刚发过就别连发：同一频道离上一张不到 minGapSec，或她上一条发言就带了表情包 → 不发。
 * 返回 why：每个因子一句人话，落日志 sticker.decided，网页和调试时看得懂她为什么发 / 不发。
 */
export interface Mood { valence: number, arousal: number }

export interface ChanceInput {
  track: 'sticker' | 'emo'
  asked: boolean
  base: number // sticker 用 chance，emo 用 emoChance
  mood?: Mood
  othersRecent: number // 别人近 heatWindowSec 秒说了几句
  otherSticker: boolean // 对方最近一两句里发了表情包
  deep: boolean // 这次是导演让她认真答（tier deep）
  saidChars: number // 她这条发言到这个标记为止说了几个字
  otherChars: number // 对方最近一句多长
  sinceLastSec: number // 这个频道离她上一张表情包多少秒（没发过 = Infinity）
  lastUttHad: boolean // 她上一条发言带了表情包
  minGapSec: number
  seriousChars?: number // 她这条说到这么长就算在认真说事
  longOther?: number // 对方一句这么长就算在认真说事
}

export interface Chance { p: number, why: string[] }

export function chance(i: ChanceInput): Chance {
  if (i.asked)
    return { p: 1, why: ['对方要表情包'] }
  if (i.deep)
    return { p: 0, why: ['在认真答问题'] }
  if (i.saidChars >= (i.seriousChars ?? 60))
    return { p: 0, why: [`这句已经说了 ${i.saidChars} 字，在认真说事`] }
  if (i.lastUttHad)
    return { p: 0, why: ['上一条刚带过表情包'] }
  if (i.sinceLastSec < i.minGapSec)
    return { p: 0, why: [`${Math.round(i.sinceLastSec)} 秒前刚发过`] }
  const why: string[] = [`基础 ${i.base}`]
  let p = i.base
  const mul = (k: number, text: string): void => {
    p *= k
    why.push(`${text} ×${k}`)
  }
  if (i.mood) {
    if (i.mood.valence >= 0.35)
      mul(1.5, '心情好')
    else if (i.mood.valence <= -0.2)
      mul(0.4, '心情不好')
    if (i.mood.arousal >= 0.6)
      mul(1.2, '兴奋')
    else if (i.mood.arousal <= 0.2)
      mul(0.6, '没精神')
  }
  if (i.othersRecent >= 5)
    mul(1.5, '聊得正热')
  else if (i.othersRecent === 0)
    mul(0.6, '冷清')
  if (i.otherSticker)
    mul(1.8, '对方刚发了表情包')
  if (i.otherChars >= (i.longOther ?? 50))
    mul(0.3, '对方说了一大段')
  return { p: Math.min(1, Math.round(p * 1000) / 1000), why }
}

/** 默认的「对方在要表情包」说法；配置 askPatterns 可替换（是对方的原话，不是模型输出） */
export const ASK_PATTERNS = [
  // 「发个表情」「来个表达你心情的表情包」；「你发的表情」「我发了个表情」不算
  '(发|来|整|甩|丢|给我|再来|再发)(?![的了过])[^，,。！!？?]{0,10}(表情|斗图|动图)',
  '(发|来|整|甩)(个|张|一张|几张|点)图',
  '斗图',
]

export function isAsk(text: string, patterns: string[] = ASK_PATTERNS): boolean {
  const t = text.replace(/\s+/g, '')
  if (!t || t.startsWith('[表情包') || t.startsWith('[图片'))
    return false
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(t)
    }
    catch {
      return false // 配置写坏的那条不算
    }
  })
}
