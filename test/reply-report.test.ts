import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Ctx, LogEvent, Plugin } from '../src/index.ts'
import { Mumu } from '../src/index.ts'
import actionReply from '../plugins/official/action-reply/index.ts'
import { pendingResult, renderReport } from '../plugins/official/action-reply/report.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

test('没在做事就别承诺、别编进度：这个对话没有在跑的动作时，发言者提示词里有【手头】；动作在跑（别的对话的不算）就没有', async () => {
  const mumu = Mumu.create({ cooldownMs: 0 })
  try {
    let ctx!: Ctx
    const systems: string[] = []
    const fake: Plugin = {
      name: 'fake',
      apply(c) {
        ctx = c
        c.effect(() => c.model.registerProvider({
          name: 'fake',
          async* stream({ messages }) {
            systems.push(String(messages[0].content))
            yield { type: 'text', text: '嗯' }
          },
        }))
        c.effect(() => c.model.bind('default', { provider: 'fake', model: 'x' }))
        c.effect(() => c.actions.register({ name: 'screenshot', description: '截图', run: () => sleep(300) }))
      },
    }
    await mumu.use(fake)
    await mumu.use(actionReply)
    ctx.actions.start('reply', { reflex: true }, 'qq:group:1')
    await sleep(50)
    assert.match(systems[0], /【手头】这个对话里你现在没有正在做的事/)
    ctx.actions.start('screenshot', {}, 'qq:group:1')
    ctx.actions.start('reply', { guidance: '这就去截' }, 'qq:group:1')
    await sleep(50)
    assert.ok(!systems[1].includes('【手头】'))
    ctx.actions.start('reply', { guidance: '随便聊' }, 'qq:group:2')
    await sleep(50)
    assert.match(systems[2], /【手头】/)
  }
  finally {
    await mumu.dispose()
  }
})

let seq = 0
const ev = (at: number, type: string, data: Record<string, unknown>): LogEvent => ({ seq: ++seq, at, type, data })
const cfg = { kinds: ['computer.result', 'dsh.result'], windowMs: 600_000, maxChars: 40 }
const CH = 'qq:group:1'
const result = (at: number, ok = true, channel = CH): LogEvent =>
  ev(at, 'percept.received', { kind: 'dsh.result', channel, text: 'DSH 工程活「写水杯程序」做完了', data: { task: '写一个 Python 程序算水杯题', ok, result: '已完成。\n\n## 结果\n\nn=8, k=3 最坏要问 5 次，信息论下界 3。' } })
const reply = (at: number, id: string, params: Record<string, unknown> = {}, channel = CH): LogEvent =>
  ev(at, 'action.started', { id, type: 'reply', params, channel })

test('汇报：本对话有还没汇报的结果 → 这次发言就是汇报；带想法的 reply 说过之后就不算', () => {
  const events = [result(1000), reply(2000, 'reply#2')]
  assert.equal(pendingResult(events, CH, 'reply#2', 3000, cfg), events[0]) // 自己这条不算「已经说过」
  assert.equal(pendingResult([...events, reply(4000, 'reply#3')], CH, 'reply#3', 5000, cfg), undefined) // reply#2 已经开口汇报过
})

test('汇报：快回不算汇报过；别的对话的结果、太久以前的结果不提', () => {
  const events = [result(1000), reply(2000, 'reply#2', { reflex: true, quick: true })]
  assert.equal(pendingResult([...events, reply(3000, 'reply#3')], CH, 'reply#3', 4000, cfg), events[0])
  assert.equal(pendingResult([result(1000, true, 'qq:group:2'), reply(2000, 'reply#2')], CH, 'reply#2', 3000, cfg), undefined)
  assert.equal(pendingResult([result(1000), reply(700_000, 'reply#2')], CH, 'reply#2', 700_000, cfg), undefined)
})

test('汇报段：说清是汇报、别接闲话，带压成一行的结果摘录；没做成就说没做成', () => {
  const s = renderReport(result(1000), cfg.maxChars)
  assert.match(s, /^【这次开口是汇报】你刚做完一件事（「写一个 Python 程序算水杯题…」）/)
  assert.match(s, /别去接群里最新的闲话/)
  assert.ok(s.endsWith('\n结果原文摘录（挑要紧的说，别念代码和路径）：已完成。 ## 结果 n=8, k=3 最坏要问 5 次，信息论下界 3。'))
  assert.match(renderReport(result(1000, false), cfg.maxChars), /你刚没做成一件事/)
})
