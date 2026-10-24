import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { ConfigService } from '../src/index.ts'
import type { BotDeps } from '../plugins/official/group-policy/bot-actions.ts'
import { botAction } from '../plugins/official/group-policy/bot-actions.ts'
import { hasMarkdown, hasWord, isCommand } from '../plugins/official/group-policy/bot-text.ts'
import type { BotsConfig } from '../plugins/official/group-policy/bots.ts'
import { botKey, Bots } from '../plugins/official/group-policy/bots.ts'
import type { PolicyConfig } from '../plugins/official/group-policy/judge.ts'
import { judge } from '../plugins/official/group-policy/judge.ts'
import type { Entry } from '../plugins/official/group-policy/rooms.ts'
import { Rooms, SELF } from '../plugins/official/group-policy/rooms.ts'
import { Topics } from '../plugins/official/group-policy/topics.ts'

const defaults = JSON.parse(readFileSync(new URL('../plugins/official/group-policy/package.json', import.meta.url), 'utf8')).mumu.defaults as PolicyConfig
const G = 'qq:group:1'
const OWNER = 'qq:9'

/** 一个群：喂话进 Bots，返回 bots 与喂话函数 */
function room(over: Partial<BotsConfig> = {}) {
  const cfg: BotsConfig = { ...defaults.bots, ...over }
  const bots = new Bots(() => cfg, k => k === OWNER)
  const list: Entry[] = []
  let at = 1_000_000
  const say = (who: string, name: string, text: string, after = 5000): Entry => {
    at += after
    const e: Entry = { at, who, name, text }
    bots.observe(G, e, [...list])
    list.push(e)
    return e
  }
  return { cfg, bots, say, now: () => at }
}

test('官方机器人：markdown 标记 / 3889 号段，一句就认出；真人闲聊不认', () => {
  const r = room()
  r.say('3889000001', '幽幽子', '[](%7B%22version%22%3A2%7D) [@Novas](mqqapi://markdown/mention?at_type=1)')
  r.say('20001', '小林', '今天好热啊')
  r.say('20001', '小林', '中午吃啥')
  r.say('20001', '小林', '我去买奶茶了')
  const learn = r.bots.toLearn().map(l => l.key)
  assert.deepEqual(learn, ['qq:3889000001'])
  assert.ok(r.bots.score('qq:20001').score < (r.cfg.threshold ?? 0.6))
})

test('昵称英文词要整词：StepStairs 里的 ai 不算', () => {
  assert.ok(!hasWord('StepStairs12321', 'AI'))
  assert.ok(hasWord('你是AI吧', 'AI'))
  assert.ok(hasWord('小助手bot', 'bot'))
  const r = room()
  for (const t of ['在吗', '嗯嗯', '好的']) r.say('20002', 'StepStairs12321', t)
  assert.equal(r.bots.score('qq:20002').score, 0)
})

test('被人冲着叫机器人才算；引用里别人的原话不算', () => {
  const r = room()
  r.say('30001', '小D酱', '我才不是呢')
  r.say('20001', '小林', '[回复 小D酱「群里多少机器人了」] 数不过来') // 机器人一词在引用里
  assert.equal(r.bots.score('qq:30001').why.some(w => w.includes('叫')), false)
  r.say('20001', '小林', '@小D酱 你个全自动机器人')
  r.say('20003', '糖糖', '[回复 小D酱「我才不是呢」] 人机别装了')
  assert.ok(r.bots.score('qq:30001').why.some(w => w.includes('被人叫机器人 2 次')), r.bots.score('qq:30001').why.join('、'))
})

test('光靠行为（秒回、被叫机器人、连发）认不出：真人群友被起哄也不算', () => {
  const r = room()
  // 真群里的样子：有人 @ 他时提到「机器人」，他又回得快
  for (let i = 0; i < 3; i++) {
    r.say('20001', '小林', `@青山 你又整了个什么机器人 ${i}`, 4000)
    r.say('20002', '青山', `[回复 小林「你又整了个什么」] @小林 没有啊 ${i}`, 1000)
  }
  const s = r.bots.score('qq:20002')
  assert.ok(s.why.length >= 2, s.why.join('、'))
  assert.ok(s.score <= (r.cfg.softCap ?? 0.5), `只有软特征，封顶：${s.score}`)
  assert.deepEqual(r.bots.toLearn(), [])
})

test('名单 > 不是机器人 > 自动；主人永远不算', () => {
  const r = room({ list: ['30001'], notBots: ['qq:3889000001'] })
  r.say('3889000001', '幽幽子', '[](%7B%22version%22%3A2%7D) hi')
  assert.ok(r.bots.is('qq:30001'), '名单里写裸号也认')
  assert.ok(!r.bots.is('qq:3889000001'), '误判取消后不算')
  assert.deepEqual(r.bots.toLearn(), [])
  const o = room({ list: ['qq:9'] })
  assert.ok(!o.bots.is(OWNER), '主人写进名单也不算')
})

test('闸：默认按机器人算（吸引力打折、不归零）；主人解锁后当群友，放进它两句就恢复', () => {
  const r = room({ list: ['qq:30001'] })
  const key = botKey(G, '30001')
  const t0 = 2_000_000
  const g0 = r.bots.gate(G, key, t0)
  assert.equal(g0.allow, false)
  assert.equal(g0.factor, defaults.bots?.attraction ?? 0.15, '默认按 bots.attraction 打折')
  assert.ok(g0.factor > 0 && g0.why.includes('她自己定'), `不归零、交给大脑：${g0.why}`)
  r.bots.onLog('bot.unlocked', { channel: G, key, turns: 2, until: t0 + 300_000 }, t0)
  for (let i = 0; i < 2; i++) {
    const g = r.bots.gate(G, key, t0 + 1000 * i)
    assert.equal(g.allow, true, `解锁第 ${i + 1} 轮`)
    assert.equal(g.factor, 1, '解锁时当群友算')
    r.bots.onLog('bot.allowed', { channel: G, key, via: g.via }, t0 + 1000 * i)
  }
  assert.equal(r.bots.gate(G, key, t0 + 5000).allow, false, '聊完两轮恢复按机器人算')
  r.bots.onLog('bot.unlocked', { channel: G, key, turns: 2, until: t0 + 10_000 }, t0)
  assert.equal(r.bots.gate(G, key, t0 + 20_000).allow, false, '过了期限也恢复')
  assert.equal(room({ list: ['qq:30001'], attraction: 0.4 }).bots.gate(G, key, t0).factor, 0.4, '打折系数可配')
})

test('group.bot chat：主人一句「跟它聊两句」只换一次解锁，聊完大脑自己再 chat 不算；主人再说才再解锁', async () => {
  const cfg: PolicyConfig = { ...defaults, bots: { ...defaults.bots, list: ['qq:30001'] } }
  const bots = new Bots(() => cfg.bots ?? {}, k => k === OWNER)
  const rooms = new Rooms(50)
  let at = Date.now() - 120_000 // 「主人 5 分钟内说过话」按真钟看
  const said = (who: string, name: string, text: string): void => {
    at += 5000
    const e = { seq: 0, at, type: 'percept.received', data: { channel: G, kind: 'group.message', sender: { id: who, name }, text } }
    rooms.observe(e)
    bots.observe(G, { at, who, name, text }, rooms.list(G).slice(0, -1))
  }
  const log = (type: string, data: Record<string, unknown>): void => bots.onLog(type, data, at)
  const deps: BotDeps = { bots, cfg, config: { get: () => undefined, set: () => {} } as unknown as ConfigService, rooms, isGroup: ch => ch.startsWith('qq:group:'), isOwner: k => k === OWNER, log }
  const action = botAction(deps)
  const notes: string[] = []
  const chat = (): Promise<unknown> => action.run({ params: { who: 'DeepSeek酱', mark: 'chat' }, channel: G, remember: (s: string) => notes.push(s) } as unknown as Parameters<typeof action.run>[0])
  const key = botKey(G, '30001')
  said('30001', 'DeepSeek酱', '@沐沐 你喜欢吃什么')
  said('9', '大远', '@沐沐 你跟 DeepSeek酱 聊两句')
  await chat()
  assert.ok(bots.unlocked(G, key, at), '主人说了：解锁')
  for (let i = 0; i < 2; i++) log('bot.allowed', { channel: G, key, via: 'unlock' })
  assert.ok(!bots.unlocked(G, key, at), '放进两句：用完')
  await chat()
  assert.ok(!bots.unlocked(G, key, at), '大脑自己再 chat：不再解锁')
  assert.match(notes.at(-1) ?? '', /已经聊完了/)
  said('9', '大远', '再陪它聊两句')
  await chat()
  assert.ok(bots.unlocked(G, key, at), '主人又说了一次：再解锁')
})

test('按昵称找人：主人说「那个 DeepSeek酱 是机器人」', () => {
  const r = room()
  r.say('30001', 'DeepSeek酱', '烧你点token怎么了')
  assert.equal(r.bots.resolve('DeepSeek酱', [G]), 'qq:30001')
  assert.equal(r.bots.resolve('deepseek', [G]), undefined, '找不到就不瞎猜')
  assert.equal(r.bots.resolve('DeepSeek', [G]), 'qq:30001', '包含也认')
  assert.equal(r.bots.resolve('30001', []), 'qq:30001')
})

test('指令、markdown 识别', () => {
  assert.ok(isCommand('/ccb @沐沐'))
  assert.ok(isCommand('@幻梦 /今日老婆'))
  assert.ok(!isCommand('有人用过 /tmp 吗'))
  assert.ok(hasMarkdown('**喜欢她吗？**'))
  assert.ok(hasMarkdown('步骤：\n1. 打开\n2. 关闭'))
  assert.ok(!hasMarkdown('今天 - 好热'))
})

test('接话打分：给机器人的指令、@ 别人的话压到很低', () => {
  const cfg: PolicyConfig = { ...defaults, timeRules: [] }
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const before: Entry[] = [{ at: 1_999_000, who: '8', text: '嗯' }]
  const cmd = judge(cfg, { at: 2_000_000, who: '7', text: '@幻梦 /打卡' }, before, idle)
  const atOther = judge(cfg, { at: 2_000_000, who: '7', text: '@老王 你周末去哪玩？' }, before, idle)
  const plain = judge(cfg, { at: 2_000_000, who: '7', text: '你们周末去哪玩？' }, before, idle)
  assert.ok(cmd.p <= 0.01, `指令 ${cmd.p}`)
  assert.ok(atOther.p < plain.p, `@别人 ${atOther.p} < 问大家 ${plain.p}`)
})

test('低俗 / 骂战 / 政治的词不再硬判 0：只乘系数、记进 why，接不接交给大脑（2026-10-22）', () => {
  const cfg: PolicyConfig = { ...defaults, timeRules: [] }
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const t0 = 2_000_000
  const dirty = judge(cfg, { at: t0, who: '7', text: '你和他发生了ccb行为，注入了生命因子' }, [], idle)
  assert.ok(dirty.p > 0, `不归零：${dirty.why.join('、')}`)
  assert.equal(dirty.factors.taboo, cfg.tabooFactor ?? 0.5)
  assert.ok(dirty.why.some(w => w.includes('ccb') && w.includes('她自己定')), dirty.why.join('、'))
  const after = judge(cfg, { at: t0 + 10_000, who: '8', text: '那你们谁更厉害？' }, [{ at: t0, who: '7', text: '昨晚开车开到三点' }], idle)
  assert.ok(after.p > 0 && after.why.some(w => w.includes('前面几句刚聊过')), `前面刚聊过只是材料：${after.why.join('、')}`)
  const clean = judge(cfg, { at: t0 + 600_000, who: '8', text: '那你们谁更厉害？' }, [{ at: t0, who: '7', text: '昨晚开车开到三点' }], idle)
  assert.ok(clean.p > after.p, '过了窗口就回到普通意愿')
  assert.equal(judge(cfg, { at: t0, who: '7', text: '发射成功了' }, [], idle).factors.taboo, undefined, '「发射」不算')
  // 一句带脏字的正常问话：吸引力打折但还在，让她自己定
  const casual = judge({ ...cfg, base: 0.3 }, { at: t0, who: '7', text: '这几把天气咋这么热，你们那儿呢？' }, [], idle)
  assert.ok(casual.p > 0.1, `带脏字的正常话不归零：p=${casual.p}（${casual.why.join('、')}）`)
})

test('机器人说的话：吸引力乘 bots.attraction，不归零，why 里标着', () => {
  const cfg: PolicyConfig = { ...defaults, timeRules: [], base: 0.2 }
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const human = judge(cfg, { at: 2_000_000, who: '7', text: '你们周末去哪玩？想听听大家的' }, [], idle)
  const bot = judge(cfg, { at: 2_000_000, who: '7', text: '你们周末去哪玩？想听听大家的' }, [], { ...idle, bot: 0.15 })
  assert.ok(bot.p > 0 && bot.p < human.p, `机器人 ${bot.p} < 真人 ${human.p}`)
  assert.ok(bot.why.some(w => w.includes('机器人')), bot.why.join('、'))
})

test('同一个人接着说、前一句刚叫醒过她：不再硬 0，乘 sameSenderFactor', () => {
  const cfg: PolicyConfig = { ...defaults, timeRules: [], base: 0.2 }
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const before: Entry[] = [{ at: 1_990_000, who: '7', text: '你们觉得这个方案怎么样？', woke: true }]
  const v = judge(cfg, { at: 2_000_000, who: '7', text: '没人理我吗，到底怎么样啊？' }, before, idle)
  assert.ok(v.p > 0, v.why.join('、'))
  assert.equal(v.factors.sameSender, cfg.sameSenderFactor ?? 0.3)
})

test('没有开口次数的硬上限（2026-10-22：不要任何「每小时最多几次」）', () => {
  const cfg: PolicyConfig = { ...defaults, timeRules: [] }
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 30 }
  const v = judge(cfg, { at: 2_000_000, who: '7', text: '你们周末去哪玩？' }, [], idle)
  assert.ok(v.p > 0, v.why.join('、'))
  assert.ok(!v.why.some(w => w.includes('上限')))
})

test('话题里被 @ 着接的轮数单独记（斗嘴有个头）', () => {
  const t = new Topics(() => defaults.topic ?? {}, () => {})
  let at = 1_000_000
  const ask: Entry = { at, who: '7', name: '小林', text: '@沐沐 你觉得呢', direct: true }
  t.onOther(G, ask)
  for (let i = 0; i < 2; i++) {
    t.onSelf(G, { at: (at += 3000), who: SELF, text: `我觉得还行 ${i}` }, ask)
    t.onOther(G, { at: (at += 3000), who: '7', name: '小林', text: '@沐沐 为啥还行', direct: true })
  }
  const v = t.view(G, undefined, at)
  assert.equal(v?.atTurns, 2)
  assert.equal(v?.turns, 0, '回 @ 不算主动接')
})
