/**
 * 谁是谁：阅读窗口 / 大脑历史里每一句的说话人后面标清楚，她自己的网名出现在别人话里时标「就是你」。
 *
 * 真群甲（2026-10-22 17:47–17:58）她三次分不清：群里另一个机器人「小鱼」的形象是条鱼，灰灰子说「这鱼怎么感觉没那么聪明」
 * 「哦鲸鲸？」「我管你叫哦鲸鲸」都是在说它，她当成在说自己，回「说鱼不聪明的那位你小心点」「哦鲸鲸我认了…看本鲸鱼答不答应」；
 * IIIBeta2III 说「@小鱼 不要和沐沐小号聊天」，她不知道「沐沐小号」就是自己的 QQ 网名，回「那我跟她自己聊总行了吧」；
 * 小鱼接她的话「挑半天也算心意嘛」「手快是好手快 搜的就是不太对」，她看不出那是机器人在跟她说套话。
 * 人设里虽有一句「你在 QQ 上网名叫沐沐小号」，几千字的提示词里模型记不住，得写在话出现的那一行上。
 *
 * 标法（只动 sender.name 与 text，大脑与发言者各自照常渲染）：
 * - 她自己：self 行带 sender.name = 网名，大脑渲染成「你（沐沐小号）」；别人话里出现她的网名 → 「沐沐小号（就是你）」。
 * - 机器人说的：「小鱼（机器人）」；它回复她、或紧跟在她之后（中间没别的群友）、或和她最近几句有共有的双字词：「小鱼（机器人，在接你的话）」。
 * - 群友冲机器人说的：@ 它 / 回复它（没 @ 她）→「（在跟机器人小鱼说）」；机器人刚说过话（前 4 句内、90 秒内），这句没 @ 她、
 *   又提到它的名字、名字里它自己也常用的字（小鱼 → 「鱼」：它说「我这条鱼是野生的」）、或和它刚说的话有共有的双字词 → 同样标。
 *   「叫法」不写词表：从它自己的话里取，别的机器人换个形象照样认。
 */
import type { HistoryTurn } from '../../../src/index.ts'
import { botAnswersTag, botTag, SELF_MARK, toBotTag } from './bot-text.ts'
import { overlap, stripEmoji } from './judge.ts'

export interface WhoDeps {
  isGroup: (ch: string) => boolean
  isBot: (ch: string, who: string) => boolean
  botNames: (ch: string) => string[] // 这个群里认出来的机器人的名字（窗口里没说过话的也算）
  names: string[] // 她的名字：第一个是真名，后面是各平台网名（persona/names 的次序）
}

export interface Tagged<T> { list: T[], tagged: boolean }

const BOT_RECENT_TURNS = 4
const BOT_RECENT_MS = 90_000
const ANSWER_MS = 120_000 // 她说完多久内、中间没别的群友插话，机器人这句算在接她
const ANSWER_OVERLAP_MS = 300_000 // 和她最近几句有共有双字词的，放宽到这么久（它回得慢）

/** 去掉开头的引用块和 @，剩下这人自己打的字 */
export function ownWords(text: string): string {
  return text.replace(/^\[回复[^\]]*\]\s*/, '').replace(/^(?:\s*@\S+)+\s*/, '').trim()
}

/**
 * 机器人的「叫法」：它的名字，加上名字里它自己的话也常用的字（在它至少两句话里出现过）——
 * 「小鱼」说「我这条鱼是野生的」「天青色瞪眼鱼」，群友说的「鱼」就多半是在说它；「小」它没自称过就不算
 */
export function botTerms(name: string, ownTexts: string[]): string[] {
  const terms = [name]
  for (const c of new Set(name.match(/\p{Script=Han}/gu) ?? [])) {
    if (ownTexts.filter(t => t.includes(c)).length >= 2)
      terms.push(c)
  }
  return terms
}

export function tagWho<T extends HistoryTurn>(list: T[], channel: string | undefined, d: WhoDeps): Tagged<T> {
  let tagged = false
  const aliases = d.names.slice(1).filter(Boolean)
  const atHer = (text: string): boolean => text.startsWith('[回复你') || d.names.some(n => n && text.includes(`@${n}`))
  // 按频道各算各的：大脑的历史是所有频道混着的
  const byChannel = new Map<string, number[]>()
  list.forEach((t, i) => {
    const ch = t.channel ?? channel ?? ''
    if (d.isGroup(ch))
      byChannel.set(ch, [...(byChannel.get(ch) ?? []), i])
  })
  const out = [...list]
  for (const [ch, idxs] of byChannel) {
    const turns = idxs.map(i => list[i])
    const botTexts = new Map<string, string[]>() // 机器人 id → 它在窗口里自己打的字
    const botName = new Map<string, string>()
    for (const t of turns) {
      if (t.role === 'other' && t.sender && d.isBot(ch, String(t.sender.id))) {
        botTexts.set(String(t.sender.id), [...(botTexts.get(String(t.sender.id)) ?? []), ownWords(t.text)])
        botName.set(String(t.sender.id), t.sender.name ?? String(t.sender.id))
      }
    }
    const terms = new Map<string, string[]>()
    for (const [id, name] of botName) terms.set(id, botTerms(name, botTexts.get(id) ?? []))
    const allBotNames = new Set([...botName.values(), ...d.botNames(ch)])

    const selfTexts: { at: number, text: string }[] = []
    let humanSinceSelf = false
    const recentBots: { k: number, id: string, text: string, at: number }[] = [] // 最近几句里机器人说的
    turns.forEach((t, k) => {
      const i = idxs[k]
      if (t.role === 'self') {
        selfTexts.push({ at: t.at, text: t.text })
        humanSinceSelf = false
        if (aliases[0])
          out[i] = { ...t, sender: { id: t.sender?.id ?? 'self', name: aliases[0] } }
        return
      }
      if (!t.sender)
        return
      const id = String(t.sender.id)
      const name = t.sender.name ?? id
      let text = t.text
      // 别人话里她的网名：标「就是你」（真名不用标，她认得）
      for (const a of aliases) {
        if (text.includes(a) && !text.includes(`${a}${SELF_MARK}`))
          text = text.replace(a, `${a}${SELF_MARK}`)
      }
      const own = ownWords(t.text)
      if (d.isBot(ch, id)) {
        tagged = true
        const last = selfTexts[selfTexts.length - 1]
        const recent = selfTexts.filter(s => t.at - s.at <= ANSWER_OVERLAP_MS).slice(-4).map(s => s.text).join(' ')
        // 引用了别人的话就是在回别人，紧跟在她后面也不算
        const quotesOther = t.text.startsWith('[回复 ')
        const answers = t.text.startsWith('[回复你')
          || (!quotesOther && !!last && t.at - last.at <= ANSWER_MS && !humanSinceSelf)
          || (!quotesOther && !!recent && overlap(recent, stripEmoji(own)) >= 1)
        recentBots.push({ k, id, text: own, at: t.at })
        out[i] = { ...t, text, sender: { ...t.sender, name: `${name}${answers ? botAnswersTag() : botTag()}` } }
        return
      }
      humanSinceSelf = true
      let to: string | undefined
      if (!atHer(t.text)) {
        // @ 它 / 回复它
        to = [...allBotNames].find(n => n && (t.text.includes(`@${n}`) || t.text.startsWith(`[回复 ${n}「`)))
        // 机器人刚说过话，这句提到它的叫法、或在接它刚说的；或者机器人紧接着回了这句（它的回话和这句有共有的双字词）
        if (!to && t.kind === 'group.message') {
          const bare = stripEmoji(own)
          const near = recentBots.filter(b => k - b.k <= BOT_RECENT_TURNS && t.at - b.at <= BOT_RECENT_MS)
          const hit = bare && near.findLast(b => (terms.get(b.id) ?? []).some(x => bare.includes(x)) || overlap(b.text, bare) >= 1)
          const reply = bare && turns.slice(k + 1, k + 3).find(n => n.role === 'other' && n.sender && botName.has(String(n.sender.id))
            && n.at - t.at <= 30_000 && !n.text.startsWith('[回复 ') && overlap(ownWords(n.text), bare) >= 1)
          if (hit)
            to = botName.get(hit.id)
          else if (reply)
            to = botName.get(String(reply.sender!.id))
        }
      }
      if (to) {
        tagged = true
        out[i] = { ...t, text, sender: { ...t.sender, name: `${name}${toBotTag(to)}` } }
      }
      else if (text !== t.text) {
        out[i] = { ...t, text }
      }
    })
  }
  return { list: out, tagged }
}
