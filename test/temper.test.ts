import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEvent } from '../src/index.ts'
import type { PolicyConfig } from '../plugins/official/group-policy/judge.ts'
import { ignoreAction, renderAir, Temper } from '../plugins/official/group-policy/temper.ts'
import type { Entry } from '../plugins/official/group-policy/rooms.ts'

const defaults = JSON.parse(readFileSync(new URL('../plugins/official/group-policy/package.json', import.meta.url), 'utf8')).mumu.defaults as PolicyConfig
const G = 'qq:group:1'
const G2 = 'qq:group:2'
const OWNER = 'qq:9'

function make(over: Partial<NonNullable<PolicyConfig['temper']>> = {}, bots: string[] = []) {
  const t = new Temper({
    cfg: () => ({ ...defaults.temper, ...over }),
    tabooWords: () => defaults.tabooWords ?? [],
    insultWords: () => defaults.affinity?.insultWords ?? [],
    isOwner: k => k === OWNER,
    isBot: k => bots.includes(k),
    isGroup: ch => ch.startsWith('qq:group:'),
  })
  let at = 1_000_000
  const say = (who: string, name: string, text: string, direct = true, after = 20_000, ch = G): LogEvent => {
    at += after
    const e = { seq: 0, at, type: 'percept.received', data: { channel: ch, kind: direct ? 'message' : 'group.message', sender: { id: who, name }, text } } as unknown as LogEvent
    t.observe(e)
    return e
  }
  return { t, say, now: () => at }
}

test('骚扰度按群 + 人记：反复 @、低俗话冲她说往上攒；没事按半衰期消；主人不算；别的群不受影响', () => {
  const { t, say, now } = make()
  say('7', '老王', '沐沐在吗')
  assert.equal(t.status('qq:7', now(), G).level, '一般')
  for (let i = 0; i < 5; i++) say('7', '老王', '沐沐你觉得谁的车速快，几把')
  const s = t.status('qq:7', now(), G)
  assert.ok(s.value >= 14, `连着 6 次低俗 @：骚扰度 ${s.value}`)
  assert.equal(s.level, '忍无可忍')
  assert.ok(s.why.some(w => w.includes('在这个群今天 @ / 点名你 6 次')) && s.why.some(w => w.includes('低俗')), s.why.join('，'))
  // 同一个人在别的群：干干净净
  assert.equal(t.status('qq:7', now(), G2).level, '一般')
  // 不带频道问（跨群看）：最烦的那个群
  const any = t.status('qq:7', now())
  assert.equal(any.level, '忍无可忍')
  assert.equal(any.channel, G)
  // 一天后消得差不多
  assert.equal(t.status('qq:7', now() + 86_400_000, G).level, '一般')
  // 主人怎么 @ 都不算
  for (let i = 0; i < 6; i++) say('9', '主人', '沐沐 几把 快回')
  assert.equal(t.status(OWNER, now(), G).value, 0)
  // 没冲她说的（group.message）不算骚扰
  for (let i = 0; i < 6; i++) say('8', '阿哲', '这几把天气真热', false)
  assert.equal(t.status('qq:8', now(), G).value, 0)
})

test('松紧旋钮只改形容词；材料写的是情况不是结论', () => {
  const loose = make({ sensitivity: 0.5 })
  const tight = make({ sensitivity: 2 })
  for (const m of [loose, tight]) {
    for (let i = 0; i < 3; i++) m.say('7', '老王', '沐沐你是机器人吧，承认吧')
  }
  assert.equal(loose.t.status('qq:7', loose.now(), G).level, '有点烦')
  assert.equal(tight.t.status('qq:7', tight.now(), G).level, '忍无可忍')
  const e: Entry = { at: tight.now(), who: '7', name: '老王', text: '沐沐你是机器人吧，承认吧', direct: true }
  const hints = tight.t.hintFor(G, e, tight.now())
  assert.ok(hints.some(h => h.includes('第 3 次')) && hints.some(h => h.includes('自证')) && hints.some(h => h.includes('忍无可忍')), hints.join('；'))
  assert.ok(!hints.some(h => /不接|不理/.test(h)), `材料里没有「不接 / 不理」的结论：${hints.join('；')}`)
})

test('不理按群、拉黑跨群：都由大脑的动作决定、从日志投影、到期自动恢复；主人不能不理；原谅即刻生效', async () => {
  const { t, say, now } = make()
  say('7', '老王', '沐沐 几把')
  const logs: { type: string, data: Record<string, unknown> }[] = []
  const action = ignoreAction({
    temper: t,
    cfg: () => defaults.temper ?? {},
    isOwner: k => k === OWNER,
    isGroup: ch => ch.startsWith('qq:group:'),
    resolve: who => who === '老王' ? 'qq:7' : who === '大远' ? OWNER : undefined,
    nameOf: k => k === 'qq:7' ? '老王' : '大远',
    log: (type, data) => {
      logs.push({ type, data })
      t.observe({ seq: 0, at: Date.now(), type, data } as unknown as LogEvent)
    },
  })
  const remembered: string[] = []
  const run = (params: Record<string, unknown>, channel = G) => action.run({ id: 'group.ignore#1', params, channel, remember: (s: string) => remembered.push(s) } as never)
  await assert.rejects(run({ who: '大远', mode: 'ignore', why: '烦' }), /主人/)
  await assert.rejects(run({ who: '路人甲', mode: 'ignore' }), /没找到/)
  await run({ who: '老王', mode: 'ignore', minutes: 10_000, why: '老拿黄段子 @ 我' })
  const dec = t.ignoring('qq:7', Date.now(), G)
  assert.ok(dec && dec.mode === 'ignore' && dec.channel === G && dec.why.includes('黄段子'), '决定进了投影、带着群')
  assert.equal(t.ignoring('qq:7', Date.now(), G2), undefined, '只在那个群不理：别的群照常')
  assert.ok(t.ignoring('qq:7', Date.now()), '不带频道问（表现端）：他在某个群被不理 = 真')
  const minutes = Number(logs[0].data.minutes)
  assert.equal(minutes, defaults.temper?.ignoreMaxMinutes ?? 240, '时长夹在上限内')
  assert.ok(remembered[0].includes('不理 老王') && remembered[0].includes('别的群'))
  // 期间他的话在【读空气】里标着「你在群 1 不理」
  const air = renderAir(t, { channels: () => [G], list: () => [{ at: now(), who: '7', name: '老王', text: '沐沐 几把', direct: true }] }, ch => ch.startsWith('qq:group:'), now())
  assert.ok(air.includes('你在群 1 不理 老王') && air.includes('forgive'), air)
  // 到期自动恢复（查过期的那一下就把决定清掉了，所以放在最后看）
  assert.equal(t.ignoring('qq:7', Date.now() + minutes * 60_000 + 1, G), undefined, '到期自动恢复')
  await run({ who: '老王', mode: 'ignore', minutes: 5, why: '又来了' })
  await assert.rejects(run({ who: '老王', mode: 'forgive' }, G2), /本来就没/)
  await run({ who: '老王', mode: 'forgive', why: '算了' })
  assert.equal(t.ignoring('qq:7', Date.now(), G), undefined, '原谅即刻生效')
  // 拉黑：对人、跨群；默认按小时算，夹在 blockMaxHours
  await run({ who: '老王', mode: 'block', why: '骂人' })
  const b = logs.at(-1)!
  assert.equal(b.data.mode, 'block')
  assert.equal(Number(b.data.minutes), (defaults.temper?.blockHours ?? 24) * 60)
  assert.equal(t.ignoring('qq:7', Date.now(), G2)?.mode, 'block', '拉黑了在别的群也不理')
  const air2 = renderAir(t, { channels: () => [G2], list: () => [] }, ch => ch.startsWith('qq:group:'), now())
  assert.ok(air2.includes('你拉黑了 老王'), air2)
  await run({ who: '老王', mode: 'forgive', why: '算了' }, G2)
  assert.equal(t.ignoring('qq:7', Date.now()), undefined, '原谅连拉黑一起解')
})

test('岔开过的低俗话题再被追问：升档「岔开过还追着问」，材料写明已经岔开过（同群别人追也算）', () => {
  const { t, say, now } = make()
  say('7', 'Tan', '沐沐 惨在哪，55ml的ccb')
  // 她开了口（岔开）
  t.observe({ seq: 0, at: now() + 5000, type: 'utterance.settled', data: { channel: G, delivered: '别问我这个' } } as unknown as LogEvent)
  const e: Entry = { at: now() + 30_000, who: '8', name: 'Wei', text: '沐沐 55ml一次算什么水平 ccb', direct: true }
  const hints = t.hintFor(G, e, now() + 30_000)
  assert.ok(hints.some(h => h.includes('已经岔开过这个低俗话题') && h.includes('他还追着问')), hints.join('；'))
  say('8', 'Wei', '沐沐 55ml一次算什么水平 ccb', true, 30_000)
  const s = t.status('qq:8', now(), G)
  assert.ok(s.why.some(w => w.includes('你岔开过了还追着问 1 次')), s.why.join('，'))
  assert.ok(s.value > t.status('qq:7', now(), G).value, '追问的人比第一个说的人更烦')
  // 别的群没岔开过：不算
  const e2: Entry = { at: now(), who: '8', name: 'Wei', text: '沐沐 55ml ccb', direct: true }
  assert.ok(!t.hintFor(G2, e2, now()).some(h => h.includes('岔开过')))
})

test('机器人 @ 她算得轻；没冲她说的话只给材料不记骚扰', () => {
  const { t, say, now } = make({}, ['qq:30001'])
  for (let i = 0; i < 6; i++) say('30001', 'DeepSeek酱', '沐沐理理我')
  const s = t.status('qq:30001', now(), G)
  assert.ok(s.value < 14, `机器人 6 次 @：${s.value}`)
  const e: Entry = { at: now(), who: '30001', name: 'DeepSeek酱', text: '沐沐理理我', direct: true }
  assert.ok(t.hintFor(G, e, now()).some(h => h.includes('机器人')))
})
