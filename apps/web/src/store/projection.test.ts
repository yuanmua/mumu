import { describe, expect, it } from 'vitest'
import type { LogEvent } from '../protocol/types.ts'
import { createProjection, reduce, segmentsOf } from './projection.ts'

let seq = 0
const ev = (type: string, data: unknown): LogEvent => ({ seq: ++seq, at: 1000 + seq, type, data })
const live = () => {
  const s = createProjection()
  reduce(s, { type: '__live__' })
  return s
}

describe('投影规则', () => {
  it('percept.received 有 text+sender 且 main 频道 → 用户消息', () => {
    const s = live()
    reduce(s, ev('percept.received', { kind: 'message', channel: 'main', sender: { id: 'u' }, text: '你好' }))
    reduce(s, ev('percept.received', { kind: 'message', channel: 'group:1', sender: { id: 'u' }, text: '别的频道' }))
    reduce(s, ev('percept.received', { kind: 'performer.tool', channel: 'main', text: '无 sender 不算' }))
    expect(s.messages.map(m => m.text)).toEqual(['你好'])
    expect(s.messages[0].side).toBe('user')
  })

  it('平台消息：记发言人、@ 她、图片；有图时去掉正文里的占位', () => {
    const s = live()
    s.channel = 'qq:group:1'
    reduce(s, ev('percept.received', {
      kind: 'group.message',
      channel: 'qq:group:1',
      sender: { id: '20001', name: '小林' },
      text: '[表情包：黄底黑字写着哈哈哈] 笑死',
      data: { platform: 'qq', mentioned: true, avatar: '/a.png', images: [{ url: '/api/surface-onebot/media/x.png', alt: '哈哈哈', sticker: true }] },
    }))
    reduce(s, ev('percept.received', { kind: 'group.message', channel: 'qq:group:1', sender: { id: '20002', name: '阿哲' }, text: '[表情包：没给图]' }))
    expect(s.messages[0]).toMatchObject({ text: '笑死', mentioned: true, sender: { id: '20001', name: '小林', avatar: '/a.png' }, images: [{ src: '/api/surface-onebot/media/x.png', alt: '哈哈哈' }] })
    expect(s.messages[1].text).toBe('[表情包：没给图]') // 没有图就留文字描述
  })

  it('group.policy → 读空气结论挂到同发言人的上一条；surface.media 有 url 才出图、按 utt 挂', () => {
    const s = live()
    s.channel = 'qq:group:1'
    reduce(s, ev('percept.received', { kind: 'group.message', channel: 'qq:group:1', sender: { id: 'a', name: 'A' }, text: '一' }))
    reduce(s, ev('percept.received', { kind: 'group.message', channel: 'qq:group:1', sender: { id: 'b', name: 'B' }, text: '二' }))
    reduce(s, ev('group.policy', { channel: 'qq:group:1', sender: { id: 'a' }, p: 0.1, why: ['普通一句'], wake: false }))
    reduce(s, ev('group.policy', { channel: 'qq:group:2', sender: { id: 'b' }, p: 1, why: ['别的群'], wake: true }))
    expect(s.messages[0].policy).toEqual({ wake: false, p: 0.1, why: ['普通一句'] })
    expect(s.messages[1].policy).toBeUndefined()

    reduce(s, ev('utterance.started', { id: 'utt#9', action: 'reply#1', channel: 'qq:group:1' }))
    reduce(s, ev('utterance.started', { id: 'utt#10', action: 'reply#2', channel: 'qq:group:1' }))
    reduce(s, ev('surface.media', { channel: 'qq:group:1', utt: 'utt#9', kind: 'sticker' })) // 没 url：不出图
    reduce(s, ev('surface.media', { channel: 'qq:group:1', utt: 'utt#9', url: '/api/media/s.png', alt: '佩服' }))
    reduce(s, ev('surface.media', { channel: 'qq:group:1', uttId: 'utt#10', url: '/api/media/t.png' })) // 只给 uttId 也认
    reduce(s, ev('utterance.settled', { id: 'utt#9', channel: 'qq:group:1', delivered: '', truncated: false }))
    expect(s.messages.find(m => m.id === 'utt#9')).toMatchObject({ images: [{ src: '/api/media/s.png', alt: '佩服' }] }) // 只发了表情包也留着
    expect(s.messages.find(m => m.id === 'utt#10')?.images).toEqual([{ src: '/api/media/t.png', alt: undefined }])
  })

  it('surface.media 晚到：那条只有表情包的发言已当空气泡删掉，就单独补一条只有图的', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#3', action: 'reply#3', channel: 'main' }))
    reduce(s, ev('utterance.part', { id: 'utt#3', part: { kind: 'marker', data: { track: 'sticker', value: '开心' } } }))
    reduce(s, ev('utterance.settled', { id: 'utt#3', channel: 'main', delivered: '', truncated: false }))
    expect(s.messages.find(m => m.id === 'utt#3')).toBeUndefined()
    reduce(s, ev('surface.media', { channel: 'main', utt: 'utt#3', url: '/api/media/k.gif', alt: '开心' }))
    expect(s.messages.at(-1)).toMatchObject({ id: 'utt#3', side: 'character', text: '', images: [{ src: '/api/media/k.gif', alt: '开心' }] })
  })

  it('utterance.started → 新建角色消息并进入说话状态', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    expect(s.messages[0]).toMatchObject({ id: 'utt#1', side: 'character', streaming: true })
    expect(s.current).toBe('utt#1')
    expect(s.stage.speaking).toBe(true)
  })

  it('电脑上的活 → 挂在她最近一条消息下的进度小字，随 *.step 更新，*.result 收尾', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#5', action: 'reply#5', channel: 'main' }))
    reduce(s, ev('utterance.part', { id: 'utt#5', part: { kind: 'text', text: '好，这就去弄' } }))
    reduce(s, ev('action.started', { id: 'dsh#1', type: 'dsh', params: { task: '写贪吃蛇' }, channel: 'main' }))
    reduce(s, ev('action.started', { id: 'computer#9', type: 'computer', params: {}, channel: 'group:1' })) // 别的对话：不挂
    expect(s.messages[0].work).toEqual({ id: 'dsh#1', text: '叫写代码的助手开工了' })
    reduce(s, ev('dsh.step', { actionId: 'dsh#1', step: 2, say: '写了 snake.py', tool: 'write' }))
    expect(s.messages[0].work?.text).toBe('第 2 步 · 写了 snake.py')
    reduce(s, ev('percept.received', { kind: 'dsh.result', channel: 'main', text: '…', data: { actionId: 'dsh#1', ok: true, steps: 4 } }))
    expect(s.messages[0].work).toMatchObject({ done: true, ok: true, text: '做完了（4 步）' })
    expect(s.messages).toHaveLength(1) // 结果感知没有 sender，不是一条用户消息
  })

  it('utterance.part image → 记进消息的图片；只有图没有字，结算后也保留', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#9', action: 'image#1', channel: 'main' }))
    reduce(s, ev('utterance.part', { id: 'utt#9', part: { kind: 'image', data: { media: 'ab12.jpg', mime: 'image/jpeg', alt: '一张图' } } }))
    reduce(s, ev('utterance.part', { id: 'utt#9', part: { kind: 'image', data: {} } })) // 没有 media：忽略
    reduce(s, ev('utterance.settled', { id: 'utt#9', channel: 'main', delivered: '', truncated: false }))
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0].images).toEqual([{ src: '/api/media/ab12.jpg', alt: '一张图' }])
    expect(s.messages[0].streaming).toBe(false)
  })

  it('utterance.part text → 追加文本并返回 text 副作用', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    const fx = reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'text', text: '嗯' } }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'text', text: '好' } }))
    expect(s.messages[0].text).toBe('嗯好')
    expect(fx).toEqual([{ kind: 'text', uttId: 'utt#1', text: '嗯', total: 1 }])
    expect(s.messages[0].reveal).toBe(0) // live 时呈现进度由 runtime 决定
  })

  it('utterance.part marker → emo 换表情、act 做动作，并记在消息上', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'marker', data: { track: 'emo', value: '害羞' } } }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'marker', data: { track: 'act', value: '点头' } } }))
    expect(s.stage.emotion).toBe('害羞')
    expect(s.stage.action).toBe('点头')
    expect(s.messages[0].markers.map(m => m.value)).toEqual(['害羞', '点头'])
  })

  it('utterance.part break → 记下分段位置，segmentsOf 切成多条', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'text', text: '第一条。' } }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'break' } }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'text', text: '第二条。' } }))
    const m = s.messages[0]
    m.reveal = m.text.length
    expect(segmentsOf(m)).toEqual(['第一条。', '第二条。'])
    expect(segmentsOf(m, 5)).toEqual(['第一条。', '第'])
  })

  it('utterance.settled truncated → 文本回退到 delivered，舞台记打断', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'text', text: '我本来想说很多很多' } }))
    s.messages[0].reveal = 9
    const fx = reduce(s, ev('utterance.settled', { id: 'utt#1', channel: 'main', delivered: '我本来想说', truncated: true, cause: 'user-interrupt' }))
    expect(s.messages[0]).toMatchObject({ text: '我本来想说', truncated: true, cause: 'user-interrupt', streaming: false, reveal: 5 })
    expect(s.stage.speaking).toBe(false)
    expect(s.stage.interruptedAt).toBeDefined()
    expect(s.current).toBeUndefined()
    expect(fx).toEqual([{ kind: 'settled', uttId: 'utt#1', truncated: true }])
  })

  it('utterance.settled 但一个字都没说 → 删掉空气泡', () => {
    const s = live()
    reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    reduce(s, ev('utterance.settled', { id: 'utt#1', channel: 'main', delivered: '', truncated: false }))
    expect(s.messages).toEqual([])
    expect(s.current).toBeUndefined()
  })

  it('beat.opened / closed / failed → thinking', () => {
    const s = live()
    reduce(s, ev('beat.opened', { reasons: [] }))
    expect(s.thinking).toBe(true)
    reduce(s, ev('beat.closed', { intents: 0 }))
    expect(s.thinking).toBe(false)
    reduce(s, ev('beat.opened', { reasons: [] }))
    reduce(s, ev('beat.failed', { reasons: [], error: 'x' }))
    expect(s.thinking).toBe(false)
  })

  it('model.request / response / __stream__ → modelCalls', () => {
    const s = live()
    reduce(s, ev('model.request', { reqId: 'req#1', role: 'performer', provider: 'openai', model: 'm', messages: [{ role: 'system', content: 'hi' }] }))
    reduce(s, { type: '__stream__', data: { reqId: 'req#1', at: 5, chunk: { type: 'text', text: '嗯' } } })
    reduce(s, { type: '__stream__', data: { reqId: 'req#1', at: 6, chunk: { type: 'usage' } } })
    reduce(s, ev('model.response', { reqId: 'req#1', role: 'performer', model: 'm', chars: 1, aborted: false }))
    const c = s.modelCalls['req#1']
    expect(c.chunks).toEqual([{ at: 5, text: '嗯' }])
    expect(c.result?.chars).toBe(1)
    expect(s.modelOrder).toEqual(['req#1'])
  })

  it('emotion.changed → 舞台心情基线（重放阶段也记）', () => {
    const s = createProjection()
    reduce(s, ev('emotion.changed', { valence: 0.6, arousal: 0.7, label: '兴奋，很开心' }))
    expect(s.stage.mood?.label).toBe('兴奋，很开心')
  })

  it('__reset__ → 回到初始态并返回 reset 副作用', () => {
    const s = live()
    reduce(s, ev('percept.received', { kind: 'message', channel: 'main', sender: { id: 'u' }, text: '你好' }))
    const fx = reduce(s, { type: '__reset__' })
    expect(s.messages).toEqual([])
    expect(s.events).toEqual([])
    expect(fx).toEqual([{ kind: 'reset' }])
  })

  it('未知事件类型只进 events，不报错', () => {
    const s = live()
    expect(() => reduce(s, ev('memory.recalled', { what: 'ever' }))).not.toThrow()
    expect(s.events.map(e => e.type)).toEqual(['memory.recalled'])
    expect(() => reduce(s, { type: '__whatever__' } as any)).not.toThrow()
  })
})

describe('重放纪律', () => {
  it('__live__ 之前：只建状态，不返回副作用，不动舞台，文本直接全显', () => {
    const s = createProjection()
    const fx1 = reduce(s, ev('utterance.started', { id: 'utt#1', action: 'reply#1', channel: 'main' }))
    const fx2 = reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'text', text: '旧话' } }))
    reduce(s, ev('utterance.part', { id: 'utt#1', part: { kind: 'marker', data: { track: 'emo', value: '开心' } } }))
    const fx3 = reduce(s, ev('utterance.settled', { id: 'utt#1', channel: 'main', delivered: '旧话', truncated: false }))
    expect([...fx1, ...fx2, ...fx3]).toEqual([])
    expect(s.stage.speaking).toBe(false)
    expect(s.stage.emotion).toBeUndefined()
    expect(s.messages[0].reveal).toBe(2)
    reduce(s, { type: '__live__' })
    expect(s.connection).toBe('live')
  })
})
