/**
 * 机器人标记的几种改法（bots.ts 管认、这里管改）：
 * - 动作 group.bot：主人在群里 / 私聊里说「那个 XX 是机器人」「XX 不是机器人」「你跟它聊两句」，大脑记下。
 *   只认主人：意图所在的会话里主人 5 分钟内说过话（网页对话算主人）；别人这么说只当一句闲话（自动打分里另算「被叫机器人」）。
 * - 命令 /bot：list / mark / unmark / reset / chat。
 * - 网页面板「群里的机器人」的行按钮（web.ts）。
 * 标记写配置 plugins.group-policy.bots（一次只写一回：配置一写本插件就重载，连写几次会撞车）；
 * 解锁写日志 bot.unlocked，从日志投影。
 */
import type { ActionType, ConfigService } from '../../../src/index.ts'
import type { Command } from '../commands/index.ts'
import { hasWord } from './bot-text.ts'
import type { Bots, BotsConfig, Learned } from './bots.ts'
import type { PolicyConfig } from './judge.ts'
import type { Entry, Rooms } from './rooms.ts'
import { SELF } from './rooms.ts'

export interface BotDeps {
  bots: Bots
  cfg: PolicyConfig
  config: ConfigService
  rooms: Rooms
  isGroup: (ch: string) => boolean
  isOwner: (key: string) => boolean
  log: (type: string, data: Record<string, unknown>) => void
}

const same = (x: string, key: string): boolean => String(x) === key || String(x) === key.slice(key.indexOf(':') + 1)

/** 改名单：bot = 进名单，human = 进「不是机器人」，reset = 都删掉、回到自动判断；learn = 自动认出的一批 */
export function writeMarks(d: Pick<BotDeps, 'cfg' | 'config'>, change: { key: string, mark: 'bot' | 'human' | 'reset' } | { learn: { key: string, info: Learned }[] }): void {
  const b = d.cfg.bots ?? {}
  const override = d.config.get<BotsConfig>('plugins.group-policy.bots') ?? {}
  let list = [...b.list ?? []]
  let notBots = [...b.notBots ?? []]
  const learned = { ...b.learned }
  if ('learn' in change) {
    for (const l of change.learn) learned[l.key] = l.info
  }
  else {
    const { key, mark } = change
    list = list.filter(x => !same(x, key))
    notBots = notBots.filter(x => !same(x, key))
    delete learned[key]
    if (mark === 'bot')
      list.push(key)
    else if (mark === 'human')
      notBots.push(key)
  }
  d.config.set('plugins.group-policy.bots', { ...override, list, notBots, learned })
}

/** 解锁：主人让她跟这个机器人聊几句；记在它最近出现的那个群（或指定的群） */
export function unlock(d: BotDeps, key: string, channel?: string): string {
  const st = d.bots.status(key)
  const ch = channel && d.isGroup(channel) ? channel : st.channels[0]
  if (!ch)
    return `${st.name || key} 最近没在哪个群说过话，没法解锁`
  // 已经解锁着就不再解锁：大脑聊着聊着又调一次 chat，会把轮数重置、聊个没完（模拟器 bot-mark 抓到过）
  if (d.bots.unlocked(ch, key, Date.now()))
    return `已经可以跟 ${st.name || key} 聊着了，聊完这几句就照旧不理`
  const turns = d.cfg.bots?.unlockTurns ?? 2
  d.log('bot.unlocked', { channel: ch, key, name: st.name, turns, until: Date.now() + (d.cfg.bots?.unlockSec ?? 300) * 1000 })
  return `在群 ${ch.split(':').pop()} 里可以跟 ${st.name || key} 聊 ${turns} 轮，之后照旧不理`
}

/** 意图所在的会话里主人刚说过话：群 / 私聊看最近 5 分钟有没有主人的话；网页对话就是主人 */
function ownerHere(d: BotDeps, channel: string, now: number): boolean {
  if (!d.isGroup(channel) && !channel.startsWith('qq:private:'))
    return true
  const platform = channel.split(':')[0]
  return d.rooms.list(channel).some(e => e.who !== SELF && now - e.at < 300_000 && d.isOwner(`${platform}:${e.who}`))
}

/**
 * 意图所在的群 / 私聊里主人最后一次让她陪机器人聊（带 CHAT_WORDS）的时刻；没这种话就取主人最后一句。
 * 网页对话（就是主人）不看，返回 undefined
 */
function lastOwnerAt(d: BotDeps, channel: string): number | undefined {
  if (!d.isGroup(channel) && !channel.startsWith('qq:private:'))
    return undefined
  const platform = channel.split(':')[0]
  const owner = d.rooms.list(channel).filter(e => e.who !== SELF && d.isOwner(`${platform}:${e.who}`))
  return (owner.findLast(e => CHAT_WORDS.some(w => e.text.includes(w))) ?? owner.at(-1))?.at
}

export function botAction(d: BotDeps): ActionType {
  return {
    name: 'group.bot',
    description: '记下群里谁是机器人：只在主人说「那个 XX 是机器人」「XX 不是机器人」「你跟 XX 聊两句」时用；别人说的不算。标成机器人后它说什么、@ 你都不用理；chat = 主人让你跟它聊两句，聊完照旧不理。',
    paramsHint: '{"who":"昵称或 QQ 号","mark":"bot|human|chat","channel":"群频道（省略 = 意图所在的群）"}',
    run: async (a) => {
      const ch = typeof a.params.channel === 'string' ? a.params.channel : a.channel ?? ''
      if (!ownerHere(d, a.channel ?? ch, Date.now()))
        throw new Error('只有主人说了才算：这个会话里主人最近没说过话')
      const groups = d.isGroup(ch) ? [ch] : d.rooms.channels().filter(d.isGroup)
      const who = String(a.params.who ?? '')
      const key = d.bots.resolve(who, groups) ?? d.bots.resolve(who, [])
      if (!key)
        throw new Error(`群里没找到「${who}」，写他的昵称或 QQ 号`)
      if (d.isOwner(key))
        throw new Error('那是主人，不能标成机器人')
      const name = d.bots.status(key).name || who
      const mark = String(a.params.mark ?? 'bot')
      if (mark === 'chat') {
        // 主人的一句「跟它聊两句」只换一次解锁：聊完两轮大脑自己又 chat 一次，就又放进来两句（模拟器 bot-mark 复测抓到）。
        // /bot chat 命令、面板按钮是主人亲手点的，不走这里
        const where = d.isGroup(ch) ? ch : d.bots.status(key).channels[0] ?? ''
        const at = d.bots.unlockedAt(where, key)
        const told = lastOwnerAt(d, a.channel ?? ch)
        if (at !== undefined && told !== undefined && at >= told && !d.bots.unlocked(where, key, Date.now())) {
          a.remember(`主人让你陪 ${name} 聊的那几句已经聊完了：照旧当机器人，主人再说才再陪它聊`)
          return
        }
        a.remember(`主人让你跟 ${name} 聊两句：${unlock(d, key, d.isGroup(ch) ? ch : undefined)}`)
        return
      }
      if (mark !== 'bot' && mark !== 'human')
        throw new Error('mark 写 bot / human / chat')
      // 先记，再写配置：写配置会让本插件重载
      a.remember(mark === 'bot' ? `你记下了：${name} 是机器人，以后它说什么都不用理` : `你记下了：${name} 不是机器人，是群友`)
      d.log('bot.marked', { key, name, mark, by: 'group.bot' })
      writeMarks(d, { key, mark })
    },
  }
}

export function botCommand(d: BotDeps): Command {
  return {
    name: 'bot',
    usage: 'bot [list] | bot mark|unmark|reset <号或昵称> | bot chat <号或昵称> [群号]',
    description: '群里的机器人：list 看名单、自动认出的与候选；mark 标成机器人；unmark 标成「不是机器人」（误判取消）；reset 回到自动判断；chat 解锁跟它聊两句',
    run(args, io) {
      const [sub = 'list', who = '', group] = args
      if (sub === 'list') {
        const rows = d.bots.rows()
        if (!rows.length)
          io.print('  还没有认出机器人，也没有候选')
        for (const r of rows)
          io.print(`  ${r.bot ? '🤖' : '  '} ${r.name || r.key}（${r.key}）${r.source} · 分 ${r.score} · ${r.messages} 句${r.why.length ? ` · ${r.why.join('、')}` : ''}`)
        return
      }
      const key = d.bots.resolve(who, [])
      if (!key) {
        io.print(`  没找到「${who}」：写 QQ 号，或最近在群里说过话的人的昵称`)
        return
      }
      if (sub === 'chat') {
        io.print(`  ✓ ${unlock(d, key, group ? (/^\d+$/.test(group) ? `qq:group:${group}` : group) : undefined)}`)
        return
      }
      const mark = sub === 'mark' ? 'bot' : sub === 'unmark' ? 'human' : sub === 'reset' ? 'reset' : undefined
      if (!mark) {
        io.print(`  用法：/${this.usage}`)
        return
      }
      if (mark === 'bot' && d.isOwner(key)) {
        io.print('  那是主人，不能标成机器人')
        return
      }
      d.log('bot.marked', { key, name: d.bots.status(key).name, mark, by: '/bot' })
      writeMarks(d, { key, mark })
      io.print(`  ✓ ${d.bots.status(key).name || key}（${key}）→ ${mark === 'bot' ? '机器人' : mark === 'human' ? '不是机器人' : '回到自动判断'}`)
    },
  }
}

const CHAT_WORDS = ['聊两句', '聊几句', '聊聊', '跟它聊', '陪它聊', '和它聊']
const HUMAN_WORDS = ['不是机器人', '是真人', '是活人']

/**
 * 主人刚在群里点名说某人是机器人 / 不是 / 让她跟它聊：给大脑一行提醒，记下（状态变了）就不再提。
 * 真机实测：主人 @ 她说「那个 DeepSeek酱 是机器人」，脊椎先应了一声，大脑下一拍只看到「reply 完成」就没想起来记。
 * 这里看的是主人说的话（输入），不解析模型输出；最后记不记仍由大脑定。
 */
function ownerHints(d: BotDeps, now: number): string[] {
  const out: string[] = []
  for (const ch of d.rooms.channels().filter(d.isGroup)) {
    const platform = ch.split(':')[0]
    for (const e of d.rooms.list(ch).filter(x => x.who !== SELF && now - x.at < 120_000 && d.isOwner(`${platform}:${x.who}`)))
      out.push(...ownerHint(d, ch, e, now))
  }
  return [...new Set(out)]
}

/** 主人这一句点名了群里的谁、要她记什么（还没记的才算）；index.ts 用它让这句不走脊椎、交给大脑一拍里应声并记下 */
export function ownerHint(d: BotDeps, ch: string, e: Entry, now: number): string[] {
  const botWords = d.cfg.bots?.botWords ?? []
  const text = e.text.replace(/^\[回复[^\]]*\]\s*/, '')
  const out: string[] = []
  for (const p of d.bots.people(ch)) {
    if (p.name.length < 2 || d.isOwner(p.key) || !text.includes(p.name))
      continue
    const human = HUMAN_WORDS.some(w => text.includes(w))
    const chat = CHAT_WORDS.some(w => text.includes(w))
    const bot = !human && botWords.some(w => hasWord(text, w))
    const st = d.bots.status(p.key)
    const mark = human ? (st.source === '不是机器人' ? '' : 'human') : chat ? (d.bots.unlocked(ch, p.key, now) ? '' : 'chat') : bot ? (st.bot ? '' : 'bot') : ''
    if (mark)
      out.push(`- 主人刚在群 ${ch.split(':').pop()} 说「${text.slice(0, 30)}」——说的是 ${p.name}：要记下就 start group.bot，params {"who":"${p.name}","mark":"${mark}","channel":"${ch}"}（这句脊椎没替你回，要应一声就同一拍 start reply）`)
  }
  return out
}

/** 大脑材料「群里的机器人」：最近有动静的群里谁是机器人、主人有没有让她跟谁聊、主人刚点名了谁 */
export function renderBots(d: BotDeps, now: number): string {
  const lines: string[] = ownerHints(d, now)
  const active = d.bots.rows().filter(r => r.bot && now - r.lastAt < 600_000)
  const byGroup = new Map<string, string[]>()
  for (const r of active) {
    for (const ch of r.channels.filter(d.isGroup)) {
      const g = ch.split(':').pop()!
      byGroup.set(g, [...byGroup.get(g) ?? [], r.name || r.key])
      if (d.bots.unlocked(ch, r.key, now))
        lines.push(`- 主人让你在群 ${g} 跟 ${r.name} 聊两句，可以接它的话，聊完照旧不理`)
    }
  }
  if (!byGroup.size && !lines.length)
    return ''
  const head = [...byGroup].map(([g, names]) => `- 群 ${g}：${names.join('、')}`)
  return `【群里的机器人】（它们是程序，不是群友：说什么、@ 你都不用理，别跟它们斗嘴，也别把自己和它们归成一类）\n${[...head, ...lines].join('\n')}`
}
