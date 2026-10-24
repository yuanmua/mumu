import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { BeatMaterial, Ctx, HistoryTurn, LogEvent, Plugin, Section, WakeReason } from '../src/index.ts'
import { Mumu } from '../src/index.ts'
import type { ReplyPrompt } from '../plugins/official/action-reply/index.ts'
import mindDefault from '../plugins/official/mind-default/index.ts'
import { kernelText, renderState, systemPrompt } from '../plugins/official/mind-default/material.ts'
import reflex from '../plugins/official/reflex/index.ts'
import { classify, spineCandidate, stickerPattern } from '../plugins/official/reflex/route.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const rc = { lightMaxChars: 4, sticker: stickerPattern('[表情包'), lightCooldownMs: 10_000, lightReplyChance: 0.85, actionWords: ['截图', '搜', '发群里'] }

test('分流：要她做事的话不轻，短也不行', () => {
  assert.deepEqual(classify('截图', rc), { light: false, why: '要她做事' })
  assert.deepEqual(classify('截图桌面发群里', rc), { light: false, why: '要她做事' })
  assert.deepEqual(classify('[表情包] 搜张猫图', rc), { light: false, why: '要她做事' })
  assert.deepEqual(classify('截图呢？', rc), { light: false, why: '要她做事' })
  assert.equal(classify('好', rc).light, true)
})

test('分流：纯表情包、很短又没问号的算轻，问句、长句不算', () => {
  assert.deepEqual(classify('[表情包]', rc), { light: true, why: '表情包' })
  assert.deepEqual(classify('[表情包：猫猫叹气] [表情包]', rc), { light: true, why: '表情包' })
  assert.deepEqual(classify('对的', rc), { light: true, why: '短句' })
  assert.deepEqual(classify('哈哈哈哈', rc), { light: true, why: '短句' })
  assert.deepEqual(classify('是主人吗？', rc), { light: false, why: '问句' })
  assert.deepEqual(classify('在吗?', rc), { light: false, why: '问句' })
  assert.deepEqual(classify('明天我拉你进更多群', rc), { light: false, why: '长句' })
  assert.deepEqual(classify('[表情包] 你看这个好不好笑', rc), { light: false, why: '长句' }) // 表情包带话，看话
  assert.equal(classify('嗯嗯', { ...rc, lightMaxChars: 0 }).light, false) // 0 = 只有纯表情包算轻
  assert.deepEqual(classify('@沐沐 在吗', rc), { light: true, why: '短句' }) // @ 片段不算字数
  assert.deepEqual(classify('@沐沐小号', rc), { light: true, why: '只叫了一声' })
})

test('兜底白名单：全轻才进；有重的、连发、主人说的不进；刚说过话或没掷中也不进', () => {
  const base = { heavy: false, burst: false, owner: false, count: 1, why: ['短句'], sinceReplyMs: 60_000, roll: 0.1 }
  assert.equal(spineCandidate(base, rc).spine, true)
  assert.deepEqual(spineCandidate({ ...base, heavy: true, why: ['问句'] }, rc), { spine: false, why: ['问句'] })
  assert.deepEqual(spineCandidate({ ...base, burst: true, count: 3 }, rc), { spine: false, why: ['短句', '连发 3 条'] })
  assert.deepEqual(spineCandidate({ ...base, owner: true }, rc), { spine: false, why: ['短句', '主人说的'] })
  assert.deepEqual(spineCandidate({ ...base, sinceReplyMs: 3000 }, rc).why, ['短句', '她刚说过话'])
  assert.deepEqual(spineCandidate({ ...base, roll: 0.9 }, rc).why, ['短句', '没掷中接话概率'])
  assert.equal(spineCandidate({ ...base, roll: 0.9 }, { ...rc, lightReplyChance: 1 }).spine, true)
})

const reason = (text: string, channel: string, external = true, sender = true): WakeReason =>
  ({ source: 'message', text, channel, external, sender: sender ? { id: 'u1', name: '小明' } : undefined, at: Date.now() })
const material = (over: Partial<BeatMaterial>): BeatMaterial => ({
  reasons: [], catalog: [], running: [], incoming: [], history: [], notes: [], sections: '', blocks: [], ...over,
})

test('大脑材料：规则和动作目录在 system 最前（缓存得上），每拍都变的段落在后', () => {
  const m = material({ sections: '【现在】11:27', catalog: [{ name: 'reply', description: '说话', running: 1 }] })
  const s = systemPrompt('【你是谁】规则', m)
  assert.ok(s.startsWith('【你是谁】规则\n\n【可用动作】\n- reply: 说话'))
  assert.ok(s.endsWith('【现在】11:27'))
  assert.ok(!s.includes('运行中')) // 运行中几个会变，放在状态里的【正在运行】
})

test('大脑材料：内核的短代码说成人话，文字和内核 1.1 之前它自己拼的一样', () => {
  const ended = (outcome: string, error?: string): WakeReason => ({ source: 'action:reply', text: `reply#3 ${outcome}`, data: { code: 'action-ended', id: 'reply#3', action: 'reply', outcome, ...(error ? { error } : {}) }, external: false, at: Date.now() })
  assert.equal(kernelText(ended('done').text, ended('done').data), '动作 reply#3 完成')
  assert.equal(kernelText(ended('stopped').text, ended('stopped').data), '动作 reply#3 被停止')
  assert.equal(kernelText(ended('error', 'boom').text, ended('error', 'boom').data), '动作 reply#3 出错：boom')
  assert.equal(kernelText('wake-after', { code: 'wake-after', afterMs: 1000 }), '到了自己之前定的时间')
  assert.equal(kernelText('别的', undefined), '别的')
  const s = renderState(material({
    reasons: [ended('done')],
    running: [{ id: 'search#5', note: '', runningMs: 1000 }],
    notes: [{ source: 'kernel', text: 'interrupted: reply#1, utt#2', data: { code: 'orphans-interrupted', ids: ['reply#1', 'utt#2'] }, elapsedMs: 0 }],
  }))
  assert.match(s, /\(action:reply\) 动作 reply#3 完成/)
  assert.match(s, /- search#5（1s）: 启动中/)
  assert.match(s, /上次运行时这些动作被强行中断了：reply#1、utt#2/)
})

test('大脑材料：每一拍都带全频道的最近对话和所有材料块（精简拍已撤销），被打断带过来的原因有标记', () => {
  const turn = (channel: string, text: string): HistoryTurn => ({ role: 'other', kind: 'message', text, channel, at: Date.now() })
  const m = material({
    reasons: [reason('在吗', 'c:a')],
    history: [turn('c:b', '别处1'), turn('qq:group:1', '群里1'), turn('c:a', 'a1'), turn('c:a', 'a2'), turn('c:b', '别处2'), turn('c:a', 'a3')],
    blocks: [{ from: 'interests', order: 40, text: '【兴趣】' }, { from: 'guard', order: 10, text: '【要你做事的】' }],
  })
  const s = renderState(m)
  // 真 QQ：主人私聊问「今天加的群感觉怎么样」，精简拍的材料里一条群里的事都没有，她答「还没进去看过」
  for (const x of ['别处1', '[qq:group:1] ', '群里1', 'a1', 'a2', 'a3', '别处2', '【兴趣】', '【要你做事的】'])
    assert.ok(s.includes(x), `带上「${x}」`)
  assert.doesNotMatch(s, /上一拍想到一半被打断/)
  const marked = renderState(m, { interrupted: () => true })
  assert.match(marked, /上一拍想到一半被打断，还没处理/)
})

// 断言失败也要收掉内核，否则残留的计时器让测试进程挂住
const live: Mumu[] = []
afterEach(async () => {
  for (const m of live.splice(0))
    await m.dispose()
})

/**
 * 真内核 + reflex（脊椎）+ mind-default（大脑），模型是假的：大脑的回答由 decide() 给，发言者不用（reply 动作也是假的，跑 replyMs 就完）。
 * 计时都调小，测的是「谁在什么时候被叫起来、谁开口」。owners 给了就装一个假配置服务（guard 的主人名单）。
 */
async function rig(opts: { decide?: (prompt: string) => string, decideMs?: number, replyMs?: number, reflexCfg?: Record<string, unknown>, owners?: string[] } = {}) {
  const mumu = Mumu.create({ cooldownMs: 0 })
  live.push(mumu)
  let ctx!: Ctx
  const replies: { params: Record<string, unknown>, channel?: string }[] = []
  const shots: (string | undefined)[] = []
  const fake: Plugin = {
    name: 'fake',
    apply(c) {
      ctx = c
      c.effect(() => c.model.registerProvider({
        name: 'fake',
        async* stream({ messages }) {
          // 只给大脑看材料（最后一条 user）
          if (opts.decideMs)
            await sleep(opts.decideMs)
          yield { type: 'text', text: opts.decide?.(messages[messages.length - 1].content) ?? '{"note":"","intents":[]}' }
        },
      }))
      c.effect(() => c.model.bind('default', { provider: 'fake', model: 'x' }))
      c.effect(() => c.actions.register({
        name: 'reply',
        description: '说话',
        run: async (a) => {
          replies.push({ params: a.params, channel: a.channel })
          await sleep(opts.replyMs ?? 20)
        },
      }))
      c.effect(() => c.actions.register({ name: 'screenshot', description: '截图', run: async (a) => { shots.push(a.channel) } }))
      if (opts.owners)
        c.provide('config', { get: (path: string) => path === 'plugins.guard.owners' ? opts.owners : undefined, set: () => {}, onChange: () => () => {} })
    },
  }
  await mumu.use(fake)
  await mumu.use(mindDefault)
  await mumu.use(reflex, { delayMs: 30, thinkDelayMs: 60, burstGapMs: 150, burstDelayMs: 120, lightCooldownMs: 0, lightReplyChance: 1, fallbackMs: 100, actionWords: ['截图', '搜'], ...opts.reflexCfg })
  const say = (text: string, channel = 'c:t', who = 'u1'): Promise<void> =>
    ctx.io.percept({ kind: 'message', channel, sender: { id: who, name: '小明' }, text, urgent: true })
  const events = (type: string): LogEvent[] => ctx.log.events.filter(e => e.type === type)
  const decides = (): LogEvent[] => events('model.request').filter(e => e.data.role === 'mind.decide')
  return { mumu, ctx, replies, shots, say, events, decides }
}

const QUICK = '{"note":"应一声","quick":true}' // 只放行快回时模型常不写 intents：当空，不重试

test('轻消息：脊椎不抢先开口，合流后叫醒大脑；大脑写 quick → 一条简短 reply（performer.reflex）', async () => {
  const r = await rig({ decide: () => QUICK })
  await r.say('在吗')
  await sleep(15)
  assert.equal(r.decides().length, 0) // 合流中，大脑的即时唤醒被压住了
  await sleep(60)
  assert.equal(r.events('reflex.started').length, 0)
  assert.deepEqual(r.replies.map(x => [x.params, x.channel]), [[{ reflex: true, quick: true, note: '应一声' }, 'c:t']])
  assert.deepEqual(r.events('reflex.route').map(e => [e.data.path, e.data.spine]), [['think', true]])
  assert.match(String(r.decides()[0].data.messages[1].content), /很简单，想应一声就 quick:true/)
  assert.ok(!r.decides().some(d => JSON.stringify(d.data.messages).includes('无法解析'))) // 没写 intents 不算失败、不重试
})

test('大脑想太久：白名单里的招呼由脊椎兜底先应一声；大脑那拍晚到的 reply 被硬闸拦下', async () => {
  const r = await rig({ decideMs: 200, decide: () => '{"intents":[{"do":"start","action":"reply","channel":"c:t","params":{"brief":true}}]}' })
  await r.say('在吗')
  await sleep(160) // 合流 30 + 兜底 100
  assert.deepEqual(r.replies.map(x => x.params), [{ reflex: true }])
  assert.deepEqual(r.events('reflex.route').map(e => e.data.path), ['think', 'fallback'])
  await sleep(150)
  assert.equal(r.replies.length, 1)
  assert.deepEqual(r.events('intent.blocked').map(e => e.data.why), ['spine-answered'])
})

test('大脑及时决定不回：不兜底', async () => {
  const r = await rig()
  await r.say('嗯')
  await sleep(250)
  assert.equal(r.replies.length, 0)
  assert.equal(r.events('reflex.started').length, 0)
})

test('问句、要她做事的话：大脑再慢也不兜底，只等大脑', async () => {
  const r = await rig({ decideMs: 250 })
  await r.say('所以知道我是谁吗？')
  await r.say('帮我截图', 'c:u')
  await sleep(400)
  assert.equal(r.events('reflex.started').length, 0)
  assert.deepEqual(r.events('reflex.route').map(e => [e.data.path, e.data.why, e.data.spine]), [['think', ['问句'], false], ['think', ['要她做事'], false]])
})

test('主人说的：短招呼也不兜底（等大脑）；群友的照常兜底', async () => {
  const r = await rig({ decideMs: 250, owners: ['qq:42'] })
  await r.say('在吗', 'qq:group:1', '42')
  await r.say('在吗', 'qq:group:2', '7')
  await sleep(200)
  assert.deepEqual(r.events('reflex.route').filter(e => e.data.path === 'think').map(e => [e.data.channel, e.data.why]), [['qq:group:1', ['短句', '主人说的']], ['qq:group:2', ['短句']]])
  assert.deepEqual(r.events('reflex.started').map(e => e.data.channel), ['qq:group:2'])
})

test('问句：等 thinkDelay 后交给大脑，大脑起的 reply 不被拦', async () => {
  const r = await rig({
    decide: p => p.includes('还没人回')
      ? '{"note":"认真回他","intents":[{"do":"start","action":"reply","params":{"guidance":"想想他是不是在逗我"}}]}'
      : '{"note":"","intents":[]}',
  })
  await r.say('所以知道我是谁吗？')
  await sleep(40)
  assert.equal(r.decides().length, 0) // 还在等对方是不是要接着说
  await sleep(100)
  assert.deepEqual(r.replies.map(x => x.params), [{ guidance: '想想他是不是在逗我' }])
  assert.equal(r.events('intent.blocked').length, 0)
})

test('连发三条：合流成一次，大脑只想一拍，唤醒原因里三句都在', async () => {
  // 第一句是要想的（thinkDelay 60ms），合流还没结束对方又来两句：窗口一路推后，三句并成一次
  const r = await rig()
  await r.say('我跟你说个事')
  await sleep(40)
  await r.say('诶')
  await sleep(40)
  await r.say('[表情包]')
  await sleep(80)
  assert.equal(r.events('reflex.route').length, 0) // 连发窗口 120ms 从第三条重新算
  await sleep(150)
  const routes = r.events('reflex.route')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].data.count, 3)
  assert.equal(routes[0].data.spine, false)
  assert.deepEqual(routes[0].data.why, ['长句', '短句', '表情包', '连发 3 条'])
  const opened = r.events('beat.opened')
  assert.equal(opened.length, 1)
  assert.equal(opened[0].data.reasons[0].text, '我跟你说个事 / 诶 / [表情包]')
})

test('隔得近的单条也算连发：不进兜底白名单', async () => {
  const r = await rig({ decide: () => QUICK })
  await r.say('好')
  await sleep(100)
  await r.say('哈哈') // 和上一句隔 100ms < burstGapMs
  await sleep(200)
  assert.deepEqual(r.events('reflex.route').map(e => e.data.spine), [true, false])
  assert.ok(r.events('reflex.route')[1].data.why.includes('连发 1 条'))
})

test('硬闸：合流中大脑（被别的事叫醒）起的 reply 拦下（merge-pending）', async () => {
  const r = await rig({
    decide: p => p.includes('到点了') || p.includes('还没人回')
      ? '{"intents":[{"do":"start","action":"reply","channel":"c:t","params":{}}]}'
      : '{"intents":[]}',
  })
  await r.say('你觉得我该不该换工作') // thinkDelay 60ms
  r.ctx.mind.wake({ source: 'timer', text: '到点了', external: true })
  await sleep(30)
  assert.deepEqual(r.events('intent.blocked').map(e => e.data.why), ['merge-pending'])
  assert.equal(r.replies.length, 0)
  await sleep(100)
  assert.equal(r.replies.length, 1) // 合流结束后大脑再想，这次放行
})

test('已有 reply 在跑：大脑再 append 同一件事被拦下（reply-running），规则里写着脊椎不抢先、补充要说新东西', async () => {
  let n = 0
  const r = await rig({
    replyMs: 150,
    decide: () => n++ ? '{"intents":[{"do":"start","action":"reply","params":{"append":true,"guidance":"再说一遍好"}}]}' : QUICK,
  })
  await r.say('好')
  await sleep(60)
  r.ctx.mind.wake({ source: 'timer', text: '到点了', external: true })
  await sleep(40)
  assert.deepEqual(r.replies.map(x => x.params), [{ reflex: true, quick: true, note: '应一声' }])
  assert.deepEqual(r.events('intent.blocked').map(e => e.data.why), ['reply-running'])
  const system = String(r.decides()[0].data.messages[0].content)
  assert.ok(system.startsWith('【你是谁】'))
  assert.ok(system.includes('脊椎不会抢在你前面开口'))
  assert.ok(system.includes('和刚才说的是一回事就别补'))
})

test('reply 说完了大脑才想好：它取材料时 reply 还在跑，这拍起的 reply 拦下（stale-running），不再说一遍', async () => {
  let quick = true
  const r = await rig({
    replyMs: 40,
    decideMs: 120,
    decide: (p) => {
      if (p.includes('- reply#'))
        return '{"intents":[{"do":"start","action":"reply","params":{"guidance":"再道一遍晚安"}}]}'
      const q = quick
      quick = false
      return q ? QUICK : '{"intents":[]}'
    },
    reflexCfg: { fallbackMs: 0 },
  })
  await r.say('晚安')
  await sleep(160) // 合流 30 + 大脑 120 → quick 开口，说 40ms
  r.ctx.mind.wake({ source: 'timer', text: '到点了', external: true })
  await sleep(250)
  assert.deepEqual(r.replies.map(x => x.params), [{ reflex: true, quick: true, note: '应一声' }])
  assert.deepEqual(r.events('intent.blocked').map(e => e.data.why), ['stale-running'])
})

test('她在群里说话时大脑想去私聊开口：拦下（busy-elsewhere）；说完那拍材料里提醒「刚才想在这说的还没说」，大脑再起才放行', async () => {
  // 模拟器 phone 场景：群里回糖糖的同时，私聊「在的在的，问吧」也开了口——跨频道原来只靠大脑自觉
  let n = 0
  const prompts: string[] = []
  const r = await rig({
    replyMs: 200,
    decide: (p) => {
      prompts.push(p)
      switch (n++) {
        case 0: return '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"guidance":"回群"}}]}'
        case 1: return '{"intents":[{"do":"start","action":"reply","channel":"c:p","params":{"guidance":"回私聊"}}]}'
        case 2: return '{"intents":[{"do":"start","action":"reply","channel":"c:p","params":{"guidance":"补上"}}]}'
        default: return '{"intents":[]}'
      }
    },
  })
  await r.say('沐沐在吗', 'qq:group:1') // 群里即时开拍 → 回群，说 200ms
  await sleep(20)
  await r.say('我有事问你', 'c:p') // 私聊合流 60ms → 第二拍想回私聊
  await sleep(120)
  assert.deepEqual(r.replies.map(x => [x.params, x.channel]), [[{ guidance: '回群' }, 'qq:group:1']])
  assert.deepEqual(r.events('intent.blocked').map(e => [e.data.why, e.data.channel, e.data.busy]), [['busy-elsewhere', 'c:p', 'qq:group:1']])
  assert.match(prompts[1], /你正在 qq:group:1 说话：这拍别在别的频道 start reply/)
  await sleep(250) // 群里说完 → reply 结束那拍带着提醒，大脑再起私聊
  assert.deepEqual(r.replies.map(x => [x.params, x.channel]), [[{ guidance: '回群' }, 'qq:group:1'], [{ guidance: '补上' }, 'c:p']])
  assert.match(prompts[2], /频道 c:p 你想在这说的话还没说（当时的念头「回私聊」）：上一拍被拦下了，因为你正在 qq:group:1 说话；现在说完了/)
  assert.doesNotMatch(prompts[3] ?? '', /你想在这说的话还没说/) // 提醒一次就够
  // 两条没有同时在说：群里那条结束之后私聊才开口
  const started = r.events('action.started').filter(e => String(e.data.id).startsWith('reply#'))
  const ended = r.events('action.ended').filter(e => String(e.data.id).startsWith('reply#'))
  assert.ok(ended[0].at <= started[1].at, '私聊在群里说完之后才开口')
  assert.equal(r.events('intent.blocked').length, 1)
})

test('她在别处说话时：脊椎也不替招呼兜底，材料里只提醒「还没人回」，等她说完', async () => {
  const prompts: string[] = []
  const r = await rig({ replyMs: 250, decideMs: 150, decide: (p) => { prompts.push(p); return '{"intents":[]}' } })
  r.ctx.actions.start('reply', {}, 'qq:group:1') // 她正在群里说
  await r.say('在吗', 'c:t') // 白名单招呼：合流 30 + 兜底 100
  await sleep(200)
  assert.equal(r.events('reflex.started').length, 0)
  assert.equal(r.replies.length, 1)
  await sleep(300) // 群里说完那拍
  assert.equal(r.events('reflex.started').length, 0) // 兜底只排一次，过了就只等大脑
  assert.ok(prompts.at(-1)?.includes('频道 c:t 对方刚发的 1 条还没人回'), '说完那拍大脑看得到私聊还没人回')
})

test('群里 @ 她让她做事：脊椎不应付，大脑即时被叫醒、材料里提示「像是要你动手做事」，同一拍起 reply + 动作', async () => {
  const r = await rig({
    decide: p => p.includes('像是要你动手做事')
      ? '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"guidance":"这就去截"}},{"do":"start","action":"screenshot","channel":"qq:group:1","params":{}}]}'
      : '{"intents":[]}',
  })
  await r.say('截图桌面发群里', 'qq:group:1')
  await sleep(80)
  assert.equal(r.events('reflex.started').length, 0)
  assert.deepEqual(r.events('reflex.route').map(e => [e.data.path, e.data.why]), [['think', ['要她做事']]])
  assert.deepEqual(r.replies.map(x => [x.params, x.channel]), [[{ guidance: '这就去截' }, 'qq:group:1']])
  assert.deepEqual(r.shots, ['qq:group:1'])
})

test('主人 @ 她、怎么措辞都行：材料里写着「是主人说的」，大脑同拍应一声 + 起动作', async () => {
  const r = await rig({
    owners: ['qq:42'],
    decide: p => p.includes('是主人说的')
      ? '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"guidance":"好我去算"}},{"do":"start","action":"screenshot","channel":"qq:group:1","params":{}}]}'
      : '{"intents":[]}',
  })
  await r.say('设 f(x) 满足……用电脑试试看', 'qq:group:1', '42')
  await sleep(80)
  assert.equal(r.events('reflex.started').length, 0)
  assert.deepEqual(r.replies.map(x => x.params), [{ guidance: '好我去算' }])
  assert.deepEqual(r.shots, ['qq:group:1'])
})

test('quick 落到最近有人说话的那个对话；同一对话里大脑已 start reply 就以那条为准', async () => {
  let n = 0
  const r = await rig({ decide: () => n++ ? QUICK : '{"quick":true,"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"guidance":"认真说"}}]}' })
  await r.say('沐沐', 'qq:group:1')
  await sleep(80) // 第二拍是 reply 结束，没人说话：大脑写了 quick 也不应声
  assert.deepEqual(r.replies.map(x => [x.params, x.channel]), [[{ guidance: '认真说' }, 'qq:group:1']])
  await r.say('在吗', 'qq:group:2')
  await sleep(60)
  assert.deepEqual(r.replies[1], { params: { reflex: true, quick: true, note: '应一声' }, channel: 'qq:group:2' })
})

test('动作被 guard 拦下：同拍的 reply 排到后面派发，念头里补「没在做，别说这就去、别说电脑坏了」', async () => {
  const r = await rig({
    decide: p => p.includes('像是要你动手做事')
      ? '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"guidance":"这就去截"}},{"do":"start","action":"screenshot","channel":"qq:group:1","params":{}}]}'
      : '{"intents":[]}',
  })
  // 假 guard：拦 screenshot 并像真 guard 一样记 guard.blocked
  await r.mumu.use({
    name: 'fake-guard',
    apply(c) {
      c.intercept<{ intent: { do: string, action?: string, channel?: string }, allow: boolean }>('intent/pre-dispatch', async (p, next) => {
        if (p.intent.action === 'screenshot') {
          p.allow = false
          c.log.append('guard.blocked', { intent: p.intent, action: 'screenshot', who: '阿哲', why: '不是主人' })
        }
        return next()
      })
    },
  })
  await r.say('截图桌面发群里', 'qq:group:1')
  await sleep(80)
  assert.deepEqual(r.shots, [])
  assert.equal(r.replies.length, 1)
  assert.match(String(r.replies[0].params.guidance), /^这就去截。但 screenshot 刚被拦下了（不是主人），没有在做/)
  assert.match(String(r.replies[0].params.guidance), /别说电脑碰不到、碰不了、坏了/)
})

test('大脑明确写了 quick 就以大脑为准，不按字数降级；只有对方那句像要她做事才降成正常回复', async () => {
  const r = await rig({ decide: () => QUICK })
  // 全量探针 s1：「你好呀，在干嘛呢」8 个字，原来按「不轻」被降级，念头里多出「对方说的是正事」
  for (const [text, ch] of [['你好呀，在干嘛呢', 'qq:group:1'], ['感觉还得调试一下', 'qq:group:2'], ['@沐沐 在吗', 'qq:group:3']]) {
    await r.say(text, ch) // 逐句来：同时到会并成一拍，一次决策只放行一条快回
    await sleep(60)
  }
  await r.ctx.io.percept({ kind: 'qq.poke', channel: 'qq:group:4', sender: { id: 'u1', name: '小明' }, text: '[戳了戳你]', urgent: true })
  await sleep(60)
  assert.deepEqual(r.replies.map(x => [x.channel, x.params.quick]).sort(), [['qq:group:1', true], ['qq:group:2', true], ['qq:group:3', true], ['qq:group:4', true]])
  assert.equal(r.events('reflex.quick-demoted').length, 0)
  // 「截图看看桌面」被一个「好」打发、动作没起（真群 #9158）：这种还是降
  await r.say('@沐沐 截图看看桌面', 'qq:group:5')
  await sleep(60)
  assert.deepEqual(r.replies.find(x => x.channel === 'qq:group:5')?.params, { guidance: '应一声。对方是要你做事，不是打招呼：接住他的意思，正常说一句完整的话，别只回几个字' })
  assert.equal(r.events('reflex.quick-demoted').length, 1)
})

test('结果回来时她正说着别的：汇报被 reply-running 拦下后记着，说完那拍提醒大脑补上（全量测试 Q-8）', async () => {
  let first = true
  const r = await rig({
    replyMs: 150,
    decide: (p) => {
      const now = p.slice(p.lastIndexOf('【本次唤醒】'))
      if (p.includes('你刚想汇报'))
        return '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"append":true,"guidance":"告诉他没算成"}}]}'
      if (now.includes('computer.result'))
        return '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"append":true,"guidance":"汇报结果"}}]}'
      if (first) {
        first = false
        return '{"intents":[{"do":"start","action":"reply","channel":"qq:group:1","params":{"guidance":"先聊两句别的"}}]}'
      }
      return '{"intents":[]}'
    },
  })
  await r.say('沐沐你在干嘛', 'qq:group:1')
  await sleep(40) // 她正说着「别的」，结果这时回来
  await r.ctx.io.percept({ kind: 'computer.result', channel: 'qq:group:1', text: '电脑上的事「算 2 的 100 次方」没做成', data: { task: '算 2 的 100 次方', ok: false }, urgent: false })
  await sleep(60)
  assert.deepEqual(r.events('intent.blocked').map(e => e.data.why), ['reply-running'])
  await sleep(250) // 那句说完 → 一拍，材料里有提醒 → 补上汇报
  const prompts = r.decides().map(d => String(d.data.messages[1].content))
  assert.ok(prompts.some(p => p.includes('你刚想汇报「算 2 的 100 次方」的结果还没说（当时的念头「汇报结果」）')))
  assert.deepEqual(r.replies.map(x => x.params.guidance), ['先聊两句别的', '告诉他没算成'])
  // 只提醒一次：补上之后不再出现
  await r.ctx.mind.wake({ source: 'timer', text: '到点了', external: true })
  await sleep(250)
  assert.equal(r.replies.length, 2)
})

test('私聊里让她做事：交给大脑，不兜底', async () => {
  const r = await rig()
  await r.say('帮我搜一下')
  await sleep(250)
  assert.equal(r.events('reflex.started').length, 0)
  assert.deepEqual(r.events('reflex.route').map(e => [e.data.path, e.data.why]), [['think', ['要她做事']]])
})

test('新输入作废的那拍留下全部原因，下一拍标着「想到一半被打断」', async () => {
  const r = await rig({ decideMs: 60 })
  await r.say('沐沐帮我截图', 'qq:group:1') // 群里不合流：大脑即时开拍
  await sleep(20)
  await r.say('快点', 'qq:group:1') // 想到一半来了新的
  await sleep(200)
  const decisions = r.events('mind.decision')
  assert.equal(decisions[0].data.aborted, true)
  const next = decisions.find(d => !d.data.aborted)!
  assert.deepEqual(next.data.reasons.map((x: { text: string, carried?: boolean }) => [x.text, !!x.carried]), [['沐沐帮我截图', true], ['快点', false]])
  const prompt = String(r.decides()[1].data.messages[1].content)
  assert.match(prompt, /上一拍想到一半被打断，还没处理） 小明：沐沐帮我截图/)
})

test('群频道不合流：问句也即时叫醒大脑，脊椎不开口', async () => {
  const r = await rig({ replyMs: 50 })
  await r.say('沐沐你觉得呢？', 'qq:group:1')
  await sleep(5)
  assert.ok(r.events('beat.opened').length >= 1) // 没压唤醒
  await sleep(150)
  assert.equal(r.replies.length, 0)
  assert.deepEqual(r.events('reflex.route').map(e => [e.data.path, e.data.why]), [['think', ['问句']]])
})

test('连发提醒：发言者的历史末尾对方连着两条以上，加一段「一起回」', async () => {
  const r = await rig()
  const turn = (role: 'self' | 'other', text: string): HistoryTurn => ({ role, kind: 'message', text, channel: 'c:t', at: Date.now() })
  const run = async (history: HistoryTurn[], channel = 'c:t'): Promise<Section[]> => (await r.ctx.bus.waterfall<ReplyPrompt, ReplyPrompt>('reply/prompt', {
    actionId: 'reply#1', channel, reflex: false, append: false, history, limit: 14, extras: [],
  }, p => p)).extras
  assert.equal((await run([turn('self', '嗯'), turn('other', '诶')])).length, 0)
  const extras = await run([turn('self', '嗯'), turn('other', '诶'), turn('other', '跟你说'), turn('other', '我面试了')])
  assert.equal(extras.length, 1)
  assert.match(String(extras[0].render()), /连着发了 3 条/)
  assert.equal((await run([turn('other', '诶'), turn('other', '在吗')], 'qq:group:1')).length, 0)
})
