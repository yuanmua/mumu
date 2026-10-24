/**
 * 群里在说话的人：对话窗口里出现的每个人是谁、最近在这个群里干嘛。
 *
 * 阅读窗口只带几十条话，光看几句认不出一个人：他是主人还是机器人、是不是正和她聊着、她对他烦不烦、
 * 窗口外他前面还说了什么。真群里常见的接不上：阿哲说了句自己的事，群里刷了二十句闲聊，他再问「还记得我刚说啥吗」，
 * 窗口里只剩他最后那句。长期的「他是谁」归 memory 插件的印象；这里只给当下的情况，全部从 rooms 的投影现算，不另存。
 * 大脑与发言者各一份（同一组行，标题不同）。
 *
 * 第一行是她自己（2026-10-22 真群：她不知道「沐沐小号」是自己的网名）；机器人那行写明它刚在说什么、群友怎么冲它说的、
 * 它的叫法（名字 + 名字里它自称的字，who.ts botTerms）——群友说的「鱼」是在说它，不是她。
 */
import type { HistoryTurn, Section } from '../../../src/index.ts'
import { formatElapsed, PROMPT_ORDER } from '../../../src/index.ts'
import type { ReadingConfig } from './judge.ts'
import { stripEmoji } from './judge.ts'
import type { Entry } from './rooms.ts'
import { SELF } from './rooms.ts'
import type { TemperStatus } from './temper.ts'
import { botTerms, ownWords } from './who.ts'

export interface PeopleDeps {
  entries: (ch: string) => Entry[] // 这个群最近的话（rooms）
  isOwner: (key: string) => boolean // key = 平台:号
  isBot: (ch: string, who: string) => boolean
  inConvo: (ch: string, who: string) => boolean // 此刻正和这人聊着（convo.ts）
  temper: (key: string, ch: string) => TemperStatus // 她对这人烦不烦、在这个群是不是正不理他（temper.ts，按群 + 人）
  names: () => Promise<string[]> // 她的名字：第一个真名，后面是各平台网名（persona/names）
}

export interface GroupWindow { channel: string, window: HistoryTurn[] }

/** 一个群里、窗口中出现的人，每人一行；她自己第一行（有网名时），之后最后说话的排前面 */
export async function peopleLines(ch: string, window: HistoryTurn[], d: PeopleDeps, cfg: ReadingConfig, now: number): Promise<string[]> {
  const platform = ch.split(':')[0]
  const windowMs = (cfg.peopleWindowSec ?? 1800) * 1000
  const seen = new Map<string, { name: string, last: number, ats: Set<number> }>()
  for (const t of window) {
    if (t.role !== 'other' || !t.sender)
      continue
    const id = String(t.sender.id)
    const s = seen.get(id) ?? { name: t.sender.name ?? id, last: 0, ats: new Set<number>() }
    s.last = Math.max(s.last, t.at)
    s.ats.add(t.at)
    seen.set(id, s)
  }
  if (!seen.size)
    return []
  const all = d.entries(ch)
  const lines = [...seen.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, cfg.people ?? 10)
    .map(([id, s]) => {
      const mine = all.filter(e => e.who === id && now - e.at < windowMs)
      // 名字取 rooms 里的原名：窗口里的可能已经被打上「（机器人）」之类的标记
      const name = mine[mine.length - 1]?.name ?? s.name
      const key = `${platform}:${id}`
      const tags: string[] = []
      if (d.isOwner(key))
        tags.push('主人')
      const bot = d.isBot(ch, id)
      if (bot)
        tags.push('机器人')
      if (d.inConvo(ch, id))
        tags.push('正在和你聊')
      const st = d.temper(key, ch)
      if (st.decision)
        tags.push('你正在不理他')
      else if (st.level !== '一般')
        tags.push(`你对他${st.level}`)
      const parts: string[] = [`最近 ${Math.round(windowMs / 60_000)} 分钟说了 ${mine.length} 句`]
      const direct = mine.filter(e => e.direct)
      const lastDirect = direct[direct.length - 1]
      if (lastDirect)
        parts.push(`@ / 叫过你 ${direct.length} 次（最近一次 ${ago(now - lastDirect.at)}）`)
      // 窗口里没带上的、比他窗口里最后一句更早的话：几分钟前他说过的事，接他的话时得知道
      const earlier = mine.filter(e => !s.ats.has(e.at) && e.at < s.last && meaningful(e.text)).slice(-(cfg.earlier ?? 2))
      if (earlier.length)
        parts.push(`窗口里没带上的他还说过：${earlier.map(e => `「${clip(e.text, 40)}」（${ago(now - e.at)}）`).join('')}`)
      if (bot)
        parts.push(...botParts(name, mine, all.filter(e => now - e.at < windowMs)))
      return `- ${name}${tags.length ? `（${tags.join('，')}）` : ''}：${parts.join('；')}`
    })
  const aliases = (await d.names()).slice(1).filter(Boolean)
  if (aliases.length)
    lines.unshift(`- 你自己：网名叫「${aliases.join('」「')}」，群友写这个名字（@ 或者直接提到）就是在说你，不是别人`)
  return lines
}

/** 机器人那行多说的：它刚在说什么、群友怎么冲它说、它的叫法 */
function botParts(name: string, mine: Entry[], all: Entry[]): string[] {
  const own = mine.map(e => stripEmoji(ownWords(e.text))).filter(t => t.length >= 2)
  const parts: string[] = []
  if (own.length)
    parts.push(`它刚说：${own.slice(-3).map(t => `「${clip(t, 30)}」`).join('')}`)
  const toIt = all.filter(e => e.who !== SELF && !mine.includes(e) && (e.text.includes(`@${name}`) || e.text.startsWith(`[回复 ${name}「`)))
    .map(e => stripEmoji(ownWords(e.text))).filter(t => t.length >= 2)
  if (toIt.length)
    parts.push(`群友冲它说过：${toIt.slice(-2).map(t => `「${clip(t, 30)}」`).join('')}`)
  const terms = botTerms(name, own).slice(1)
  parts.push(`群友说的${terms.length ? `「${terms.join('」「')}」、` : ''}它的外号、它自称的东西，多半是在说它，不是你`)
  return parts
}

/** 给大脑：每个在唤醒原因里的群一组 */
export async function renderPeople(groups: GroupWindow[], d: PeopleDeps, cfg: ReadingConfig, now: number): Promise<string> {
  const blocks: string[] = []
  for (const { channel, window } of groups) {
    const lines = await peopleLines(channel, window, d, cfg, now)
    if (lines.length)
      blocks.push(`群 ${channel.split(':').pop()}：\n${lines.join('\n')}`)
  }
  if (!blocks.length)
    return ''
  return `【群里在说话的人】（对话里出现的这几个人分别是谁、最近在群里干嘛；「窗口里没带上的」是对话里没显示出来的更早的话，接他的话时记得）\n${blocks.join('\n')}`
}

/** 给发言者：这次要说话的群里在场的人 */
export async function peopleSection(channel: string, window: HistoryTurn[], d: PeopleDeps, cfg: ReadingConfig, now: number): Promise<Section | undefined> {
  const lines = await peopleLines(channel, window, d, cfg, now)
  if (!lines.length)
    return undefined
  const text = `【在场的人】（对话里这几个人分别是谁、最近在干嘛；「窗口里没带上的」是上面对话里没显示的更早的话，接谁的话就记得他说过什么）\n${lines.join('\n')}`
  return { id: 'group-people', audience: 'performer', order: PROMPT_ORDER.memory + 1, render: () => text }
}

/** 纯表情 / 图片 / 一两个字的不算「说过的事」 */
function meaningful(text: string): boolean {
  return text.replace(/\[[^\]]*\]/g, '').replace(/^(?:\s*@\S+)+/, '').trim().length >= 3
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function ago(ms: number): string {
  return ms < 10_000 ? '刚刚' : `${formatElapsed(ms)}前`
}
