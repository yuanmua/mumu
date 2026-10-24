import { describe, expect, it } from 'vitest'
import { Typewriter } from './typewriter.ts'

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('打字机', () => {
  it('按每字间隔逐字呈现，不超前于到达的文本', () => {
    const c = clock()
    const tw = new Typewriter({ charMs: 10, now: c.now })
    tw.feed('你好')
    expect(tw.tick()).toBe(1) // 第一个字立刻出
    c.advance(10)
    expect(tw.tick()).toBe(1)
    c.advance(100)
    expect(tw.tick()).toBe(0) // 没有更多文本
    expect(tw.done).toBe(true)
    tw.feed('你好呀')
    expect(tw.tick()).toBe(1)
    expect(tw.revealed).toBe(3)
  })

  it('句末与换行有额外停顿', () => {
    const c = clock()
    const tw = new Typewriter({ charMs: 10, pauseMs: 100, breakMs: 200, now: c.now })
    tw.feed('嗯。\n好')
    expect(tw.tick()).toBe(1) // 嗯
    c.advance(10)
    expect(tw.tick()).toBe(1) // 。 → 之后停 100
    c.advance(50)
    expect(tw.tick()).toBe(0)
    c.advance(50)
    expect(tw.tick()).toBe(1) // \n → 之后停 200
    c.advance(150)
    expect(tw.tick()).toBe(0)
    c.advance(50)
    expect(tw.tick()).toBe(1) // 好
  })

  it('定时器被节流时按时间表追赶：隔 1 秒一次 tick 也能补上这 1 秒的字', () => {
    const c = clock()
    const tw = new Typewriter({ charMs: 10, pauseMs: 10, breakMs: 10, now: c.now })
    tw.feed('一二三四五六七八九十')
    expect(tw.tick()).toBe(1)
    c.advance(1000)
    expect(tw.tick()).toBe(9) // 1 秒够出 100 个字，剩下 9 个全补上
  })

  it('flush 立刻全显', () => {
    const tw = new Typewriter({ now: () => 0 })
    tw.feed('一二三四')
    expect(tw.flush()).toBe(4)
    expect(tw.done).toBe(true)
  })
})
