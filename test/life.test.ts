import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import type { Ctx, LogEvent, MaterialBlock, Plugin } from '../src/index.ts'
import { Mumu } from '../src/index.ts'
import life, { awakeIn } from '../plugins/official/life/index.ts'
import type { LifeNow } from '../plugins/official/life/index.ts'
import { parseChoice } from '../plugins/official/life/choose.ts'
import type { Activity, Slot } from '../plugins/official/life/rhythm.ts'
import { candidates, clockAt, draw, matchActivity, parseSetInput, slotAt } from '../plugins/official/life/rhythm.ts'
import type { LifeState } from '../plugins/official/life/state.ts'
import { LifeLog } from '../plugins/official/life/state.ts'
import type { WebRoute } from '../plugins/official/surface-web/index.ts'

// 出厂值就用清单里的：测的是装上即得的作息
const defaults = JSON.parse(readFileSync(new URL('../plugins/official/life/package.json', import.meta.url), 'utf8')).mumu.defaults as {
  activities: Activity[], rhythm: Slot[]
}
const acts = defaults.activities
const rhythm = defaults.rhythm
const hm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
const T0 = 1_800_000_000_000
const MIN = 60_000

test('life: 时段——按钟落到对的时段，早于第一个时段算昨天最后一个，left 是到下一个时段的分钟数', () => {
  assert.equal(slotAt(rhythm, hm('12:05'))?.slot.label, '午饭')
  assert.equal(slotAt(rhythm, hm('11:30'))?.slot.label, '午饭')
  assert.equal(slotAt(rhythm, hm('11:29'))?.slot.label, '起床')
  assert.equal(slotAt(rhythm, hm('02:10'))?.slot.label, '该睡了')
  assert.equal(slotAt(rhythm, hm('23:59'))?.left, 1)
  assert.equal(slotAt(rhythm, hm('12:05'))?.left, hm('13:00') - hm('12:05'))
  const late: Slot[] = [{ from: '08:00', label: '早', pick: {} }, { from: '20:00', label: '晚', pick: {} }]
  assert.equal(slotAt(late, hm('03:00'))?.slot.label, '晚')
  assert.equal(slotAt(late, hm('03:00'))?.left, hm('08:00') - hm('03:00'))
  // 时区换算：UTC 04:05 = 上海 12:05
  const c = clockAt(Date.UTC(2026, 9, 21, 4, 5), 'Asia/Shanghai')
  assert.equal(c.hm, '12:05')
  assert.equal(c.weekend, false)
  assert.equal(clockAt(Date.UTC(2026, 9, 24, 4, 5), 'Asia/Shanghai').weekend, true) // 周六
})

test('life: 抽签——同一个种子同一个结果；饭点多半是吃饭，周末早上多半接着睡', () => {
  const lunch = candidates(acts, slotAt(rhythm, hm('11:40'))!.slot, false, '犯困', {}, T0)
  assert.deepEqual(draw(42, lunch, acts), draw(42, lunch, acts))
  const eat = Array.from({ length: 400 }, (_, i) => draw(i * 7919, lunch, acts)!.activity).filter(a => a === '吃饭').length
  assert.ok(eat > 300, `饭点抽到吃饭 ${eat}/400`)
  const d = draw(7, lunch, acts)!
  const a = acts.find(x => x.name === d.activity)!
  assert.ok(d.minutes >= a.minutes![0] && d.minutes <= a.minutes![1])
  assert.ok(!a.details?.length || a.details.includes(d.detail))
  const wake = slotAt(rhythm, hm('09:40'))!.slot
  const sat = candidates(acts, wake, true, '睡觉', {}, T0)
  const keep = Array.from({ length: 300 }, (_, i) => draw(i * 104729, sat, acts)!.activity).filter(x => x === '睡觉').length
  assert.ok(keep > 200, `周末起床时段接着睡 ${keep}/300`)
  assert.ok(!candidates(acts, wake, false, '睡觉', {}, T0).some(c => c.name === '睡觉'), '工作日起床时段没有睡觉')
})

test('life: 衔接——不连着做同一件事（睡觉除外），刚吃完不再吃，吃完饭不马上洗澡，全筛光了退一步', () => {
  const night = slotAt(rhythm, hm('22:40'))!.slot
  const names = (cur: string | undefined, ended: Record<string, number> = {}): string[] =>
    candidates(acts, night, false, cur, ended, T0).map(c => c.name)
  assert.ok(!names('刷视频').includes('刷视频'))
  assert.ok(names('听歌').includes('刷视频'))
  assert.ok(!names('吃饭').includes('洗澡'), '刚吃完饭不洗澡')
  assert.ok(!names('听歌', { 吃零食: T0 - 30 * MIN }).includes('吃零食'), '半小时前刚吃过零食')
  assert.ok(names('听歌', { 吃零食: T0 - 3 * 60 * MIN }).includes('吃零食'))
  const deep = slotAt(rhythm, hm('04:00'))!.slot
  assert.deepEqual(candidates(acts, deep, false, '睡觉', {}, T0).map(c => c.name), ['睡觉'], '深夜一直睡')
  // 只有一件、还是刚做过的：退一步照样给
  const only: Slot = { from: '00:00', label: '饭', pick: { 吃饭: 1 } }
  assert.deepEqual(candidates(acts, only, false, '吃饭', { 吃饭: T0 }, T0).map(c => c.name), ['吃饭'])
})

test('life: 认说法——「在吃火锅」归吃饭，「那我去睡了」归睡觉，认不出是新事；输入框结尾的数字是分钟', () => {
  assert.equal(matchActivity(acts, '在吃火锅')?.name, '吃饭')
  assert.equal(matchActivity(acts, '那我去睡了')?.name, '睡觉')
  assert.equal(matchActivity(acts, '打游戏')?.name, '打游戏')
  assert.equal(matchActivity(acts, '拼乐高'), undefined)
  assert.deepEqual(parseSetInput('拼乐高 40'), { text: '拼乐高', minutes: 40 })
  assert.deepEqual(parseSetInput('在吃火锅，30分钟'), { text: '在吃火锅', minutes: 30 })
  assert.deepEqual(parseSetInput('在吃火锅'), { text: '在吃火锅' })
})

test('life: 她选的输出——只认候选里的活动，细节截短，坏 JSON 退回抽签', () => {
  const names = ['吃饭', '刷视频']
  assert.deepEqual(parseChoice('好的\n{"activity":"吃饭","detail":"叫了麻辣烫外卖，外面在下雨","minutes":30,"thought":"下雨不想出门"}', names), {
    activity: '吃饭', detail: '叫了麻辣烫外卖，外面在下雨', minutes: 30, thought: '下雨不想出门',
  })
  assert.equal(parseChoice('{"activity":"打游戏","detail":"x"}', names), undefined)
  assert.equal(parseChoice('吃饭吧', names), undefined)
})

test('life: 投影——日志里换过几次，重建出来的现在 / 上次做完的时刻一样；清掉就没有现在', () => {
  const ev = (seq: number, type: string, data: object, at = T0 + seq * MIN): LogEvent => ({ seq, at, type, data })
  const s1: LifeState = { activity: '吃饭', detail: '在吃火锅', from: T0, until: T0 + 40 * MIN, by: 'rhythm', seed: 1 }
  const s2: LifeState = { activity: '刷视频', detail: '', from: T0 + 30 * MIN, until: T0 + 90 * MIN, by: 'user' }
  const log = new LifeLog()
  for (const e of [ev(1, 'life.changed', s1), ev(2, 'other', {}), ev(3, 'life.changed', s2)]) log.observe(e)
  assert.equal(log.current?.activity, '刷视频')
  assert.equal(log.lastEnd(T0 + 60 * MIN)['吃饭'], T0 + 30 * MIN, '吃饭提前结束在换的那一刻')
  assert.equal(log.active(T0 + 100 * MIN), undefined, '到点了不算还在做')
  log.observe(ev(4, 'life.cleared', { by: 'user' }, T0 + 50 * MIN))
  assert.equal(log.current, undefined)
})

// ── 装上插件：真内核，不起大脑 ──

const live: Mumu[] = []
afterEach(async () => {
  for (const m of live.splice(0))
    await m.dispose()
})

const ALLDAY: Slot[] = [{ from: '00:00', label: '全天', pick: { 吃饭: 3, 刷视频: 1 } }]

async function rig(cfg: Record<string, unknown> = {}, seed: (ctx: Ctx) => void = () => {}) {
  const mumu = Mumu.create({ cooldownMs: 0 })
  live.push(mumu)
  let ctx!: Ctx
  const fake: Plugin = {
    name: 'fake',
    apply(c) {
      ctx = c
      c.provide('commands', { register: () => () => {}, list: () => [], run: async () => false })
    },
  }
  await mumu.use(fake)
  seed(ctx)
  await mumu.use(life, { activities: acts, rhythm: ALLDAY, choose: false, tickSec: 3600, ...cfg })
  await new Promise(r => setTimeout(r, 10)) // 让装上时那一下 tick 跑完
  const route = async (method: string, path: string, body?: unknown): Promise<WebRoute['response']> => {
    const r: WebRoute = { method, path, query: {}, body }
    await ctx.bus.waterfall('web/route', r, async x => x)
    return r.response
  }
  const changes = (): LifeState[] => ctx.log.events.filter(e => e.type === 'life.changed').map(e => e.data as LifeState)
  return { ctx, route, changes }
}

test('life: 装上就按作息定一个，种子写进日志；重装从日志投影回来，不重抽', async () => {
  const a = await rig()
  assert.equal(a.changes().length, 1)
  const first = a.changes()[0]!
  assert.equal(first.by, 'rhythm')
  assert.equal(first.how, 'drew')
  assert.equal(typeof first.seed, 'number')
  assert.ok(['吃饭', '刷视频'].includes(first.activity))
  const events = [...a.ctx.log.events]
  const b = await rig({}, ctx => { for (const e of events) ctx.log.append(e.type, e.data) })
  assert.equal(b.changes().length, 1, '还在做，不重抽')
  const now = await b.route('GET', '/api/life/now')
  assert.equal((now?.body as { state: LifeState }).state.activity, first.activity)
})

test('life: 用户设的优先——作息到点不换、她自己 life.set 也不换；到点或清掉后作息接手', async () => {
  const { ctx, route, changes } = await rig()
  const r = await route('POST', '/api/life/set', { input: '在吃火锅 20' })
  assert.match(String((r?.body as { message: string }).message), /吃饭：在吃火锅/)
  const u = changes().at(-1)!
  assert.equal(u.by, 'user')
  assert.equal(u.activity, '吃饭')
  assert.equal(u.until - u.from, 20 * MIN)
  // 大脑想改：不改，工作记忆里留一句
  await ctx.actions.start('life.set', { activity: '打游戏', detail: '在打排位' })
  await new Promise(res => setTimeout(res, 10))
  assert.equal(changes().at(-1)!.by, 'user')
  assert.ok(ctx.prompt.notes(false).some(n => n.text.includes('不改')))
  // 清掉：作息马上重抽
  await route('POST', '/api/life/clear', {})
  assert.ok(ctx.log.events.some(e => e.type === 'life.cleared'))
  assert.equal(changes().at(-1)!.by, 'rhythm')
  // 没有用户设的时候，她自己可以改
  await ctx.actions.start('life.set', { activity: '打游戏', detail: '在打排位', minutes: 30 })
  await new Promise(res => setTimeout(res, 10))
  assert.equal(changes().at(-1)!.by, 'self')
  assert.equal(changes().at(-1)!.detail, '在打排位')
})

test('life: 她自己选——模型选的在候选里就用，带上她心里那句；乱选退回抽签', async () => {
  let answer = '{"activity":"吃饭","detail":"叫了麻辣烫外卖","minutes":30,"thought":"下雨不想出门，叫个麻辣烫吧"}'
  const asked: string[] = []
  const { ctx, route, changes } = await rig({ choose: true, rhythm: [{ from: '00:00', label: '全天', pick: { 吃饭: 1, 刷视频: 1, 听歌: 1, 打游戏: 1 } }] }, (c) => {
    c.model.complete = async (req) => {
      asked.push(req.messages.map(m => m.content).join('\n'))
      return answer
    }
  })
  const s = changes().at(-1)!
  assert.equal(s.how, 'chose')
  assert.equal(s.activity, '吃饭')
  assert.equal(s.detail, '叫了麻辣烫外卖')
  assert.equal(s.thought, '下雨不想出门，叫个麻辣烫吧')
  assert.equal(s.until - s.from, 30 * MIN)
  assert.match(asked[0]!, /候选/)
  // 假装是 12:05 再换一个：刚吃完，候选里没有吃饭
  answer = '{"activity":"刷视频","detail":"刷到一只猫"}'
  await route('POST', '/api/life/next', { at: '12:05' })
  assert.match(asked[1]!, /12:05/)
  assert.doesNotMatch(asked[1]!, /- 吃饭：/)
  assert.equal(changes().at(-1)!.activity, '刷视频')
  answer = '{"activity":"去月球"}'
  await route('POST', '/api/life/next', {})
  assert.equal(changes().at(-1)!.how, 'drew')
  assert.ok(ctx.log.events.some(e => e.type === 'life.failed'))
})

test('life: 进提示词——发言者段落和大脑材料都有「在干嘛」；life/now 报忙不忙', async () => {
  const { ctx, route } = await rig()
  await route('POST', '/api/life/set', { input: '在打排位' })
  const performer = await ctx.prompt.assemble('performer')
  assert.match(performer, /【你此刻在干嘛】打游戏：在打排位/)
  const m = { reasons: [], blocks: [] as MaterialBlock[] }
  await ctx.bus.waterfall('beat/gather', m, async x => x)
  assert.match(m.blocks.find(b => b.from === 'life')!.text, /【你在干嘛】打游戏：在打排位/)
  const now = await ctx.bus.waterfall<LifeNow, LifeNow>('life/now', { busy: 1, asleep: false }, async p => p)
  assert.equal(now.activity, '打游戏')
  assert.equal(now.busy, 0.6)
  assert.equal(now.asleep, false)
})

test('life: 睡着时她自己想找话拦下；有人私聊 / @ 她、或她已经醒着在这聊就照常回；群里没 @ 她的闲聊不算', async () => {
  const { ctx, route } = await rig()
  await route('POST', '/api/life/set', { input: '睡觉' })
  const say = async (channel: string): Promise<boolean> => {
    const p = { intent: { do: 'start', action: 'reply', channel, params: {} }, allow: true }
    await ctx.bus.waterfall('intent/pre-dispatch', p, async x => x)
    return p.allow
  }
  const G = 'qq:group:1'
  assert.equal(await say('main'), false, 'timer 到了想找话：拦')
  assert.ok(ctx.log.events.some(e => e.type === 'life.quiet'))
  ctx.log.append('percept.received', { kind: 'group.message', channel: G, sender: { id: '1', name: '阿哲' }, text: '有人吗' })
  assert.equal(await say(G), false, '群里闲聊没 @ 她')
  ctx.log.append('percept.received', { kind: 'message', channel: G, sender: { id: '1', name: '阿哲' }, text: '@沐沐 醒醒' })
  assert.equal(await say(G), true, '@ 她了，像手机响了')
  ctx.log.append('percept.received', { kind: 'message', channel: 'main', sender: { id: 'web-user' }, text: '在干嘛' })
  assert.equal(await say('main'), true)
  assert.equal(awakeIn([{ seq: 1, at: T0, type: 'utterance.started', data: { channel: 'x' } }], 'x', T0 - 1), true, '她已经在这开过口')
  const now = await ctx.bus.waterfall<LifeNow, LifeNow>('life/now', { busy: 1, asleep: false }, async p => p)
  assert.equal(now.asleep, true)
  assert.equal(now.busy, 0.5)
})
