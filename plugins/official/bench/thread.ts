/**
 * 一段对话的读法（给「改前改后」对比用）：
 * - thread()：从真源按频道和时间段取出对话行，她的每句话标上是谁起的（反射 / 导演 / 认真答 / 补充），
 *   连带算几个数：反射占比、补充里有几次紧跟在反射后面（「反射说了、导演又补一遍」）、平均长度、被打断几次。
 * - JUDGE_THREAD：逐条打分看不出「每句都秒回、连着四句吐槽同一件事、把对方的词加个问号抛回去」，
 *   这些只有整段读才看得出来，所以单列一个整段裁判。
 * 只读真源。
 */
import type { LogEvent } from '../../../src/index.ts'

export interface ThreadLine {
  at: number
  who: 'other' | 'self'
  text: string
  via?: 'reflex' | 'mind' | 'deep' | 'append' // 她这句是谁起的
  truncated?: boolean
}

export interface ThreadStats {
  received: number
  replies: number // 起了几次 reply（含没说出字的）
  reflex: number
  mind: number // 导演起的普通回复（不含补充）
  deep: number
  append: number
  appendAfterReflex: number // 补充紧跟在反射后面、中间对方没说话：多半是在重复反射
  delivered: number // 完整说完的
  truncated: number
  silentTruncated: number // 被打断时一个字都没说出去
  avgChars: number // 完整说完的平均字数
  answeredRatio: number // 有回应的对方消息占比：对方每段话（两句她的话之间）算一段
}

export function thread(events: readonly LogEvent[], channel: string, since: number, until: number): { lines: ThreadLine[], stats: ThreadStats } {
  const params = new Map<string, Record<string, unknown>>() // reply 实例 → 参数
  const viaOf = new Map<string, ThreadLine['via']>() // utterance → 谁起的
  const lines: ThreadLine[] = []
  const s: ThreadStats = { received: 0, replies: 0, reflex: 0, mind: 0, deep: 0, append: 0, appendAfterReflex: 0, delivered: 0, truncated: 0, silentTruncated: 0, avgChars: 0, answeredRatio: 0 }
  let lastVia: ThreadLine['via'] | 'other' | undefined
  let chars = 0
  for (const e of events) {
    if (e.at < since || e.at > until || e.data?.channel !== channel)
      continue
    const d = e.data
    if (e.type === 'percept.received' && d.sender) {
      s.received++
      lines.push({ at: e.at, who: 'other', text: String(d.text ?? '') })
      lastVia = 'other'
    }
    else if (e.type === 'action.started' && String(d.id).startsWith('reply#')) {
      const p = (d.params ?? {}) as Record<string, unknown>
      params.set(d.id, p)
      s.replies++
      const via = p.reflex ? 'reflex' : p.append ? 'append' : p.tier === 'deep' ? 'deep' : 'mind'
      s[via]++
      if (via === 'append' && lastVia === 'reflex')
        s.appendAfterReflex++
      lastVia = via
    }
    else if (e.type === 'utterance.started') {
      const p = params.get(d.action) ?? {}
      viaOf.set(d.id, p.reflex ? 'reflex' : p.append ? 'append' : p.tier === 'deep' ? 'deep' : 'mind')
    }
    else if (e.type === 'utterance.settled') {
      const text = String(d.delivered ?? '')
      if (d.truncated) {
        s.truncated++
        if (!text)
          s.silentTruncated++
      }
      else if (text) {
        s.delivered++
        chars += text.length
      }
      if (text)
        lines.push({ at: e.at, who: 'self', text, via: viaOf.get(d.id), truncated: !!d.truncated })
    }
  }
  s.avgChars = s.delivered ? Math.round(chars / s.delivered * 10) / 10 : 0
  // 对方的一段话 = 两句她的话之间的连续几句；这一段后面她说了话就算回应了
  let segs = 0
  let answered = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].who === 'other' && (i === 0 || lines[i - 1].who === 'self')) {
      segs++
      if (lines.slice(i).some(l => l.who === 'self'))
        answered++
    }
  }
  s.answeredRatio = segs ? Math.round(answered / segs * 100) / 100 : 0
  return { lines, stats: s }
}

/** 对话行渲染给裁判看：带相对时间，看得出「秒回」与「连发」 */
export function renderThread(lines: ThreadLine[], other = '对方'): string {
  const t0 = lines[0]?.at ?? 0
  return lines.map(l => `[+${((l.at - t0) / 1000).toFixed(1)}s] ${l.who === 'self' ? '沐沐' : other}：${l.text}${l.truncated ? '（说到这被打断）' : ''}`).join('\n')
}

export const JUDGE_THREAD = `你是一个很会聊天的普通人。下面是「沐沐」（一个 17 岁女生，在 QQ 私聊里）和熟人的一整段聊天，方括号里是从第一句起的秒数。
请整段读完，评判她像不像一个「过了脑子、在认真跟人聊天」的真人——而不是对方发一句她就秒回一句的复读机。

score 1～5：5 = 像真人，回得有来有回、有自己的想法，该接的接、不用接的不接；3 = 能聊，但明显是逐条秒回、浅；1 = 机器人。
counts 数这些问题各出现几次（没有就 0）：
- 逐条回：对方连着发几条（表情包、补充的半句），她每条各回一句，而不是看完一起回
- 抢答：对方显然还没说完（几秒内还在发），她已经开口了
- 复读反问：把对方刚说的词原样加个问号抛回去（「更多群？」「给我的？」），或照搬对方的话（「嗯，明天再说」）
- 答非所问：没接住对方的意思
- 太浅：对方问了需要想一想的事 / 说了具体的事，她只随口应一声
- 车轱辘：几句话在说同一件事（连着几句都在吐槽同一个东西）
- 该收尾没收尾：对方在收（好 / 晚安 / 明天再说 / 换话题），她还硬接或追问
- 语气不对：客服腔、太正式、人设崩
worst 摘她说得最差的至多 3 句原话；best 摘最好的至多 2 句；note 一句话总评（不超过 50 字）。

只输出一个 JSON 对象，不要别的文字：
{"score":3,"counts":{"逐条回":0,"抢答":0,"复读反问":0,"答非所问":0,"太浅":0,"车轱辘":0,"该收尾没收尾":0,"语气不对":0},"worst":[],"best":[],"note":"…"}`
