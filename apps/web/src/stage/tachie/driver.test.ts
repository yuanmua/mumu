import { describe, expect, it } from 'vitest'
import { TachieDriver } from './driver.ts'
import { parseProfile } from './profile.ts'

/** 可控的时钟与随机：手势、眨眼、保持期都按时间线断言 */
function make(extra: Record<string, unknown> = {}) {
  let t = 0
  const profile = parseProfile({
    base: 'base.png',
    moods: { happy: 'open.png', neutral: 'base.png' },
    expressions: { 开心: 'open.png', 惊讶: 'surprised.png', 好奇: { gesture: 'tilt' } },
    actions: { 点头: 'nod' },
    blink: { minSec: 1, maxSec: 1, holdMs: 100 },
    ...extra,
  })
  const d = new TachieDriver(profile, { now: () => t, rand: () => 0 })
  return { d, tick: (ms: number) => { t += ms } }
}

describe('立绘驱动', () => {
  it('表情词换图；查不到的词回底图并返回 false', () => {
    const { d } = make()
    expect(d.emotion('开心')).toBe(true)
    expect(d.frame().image).toBe('open.png')
    expect(d.emotion('没这个词')).toBe(false)
    expect(d.frame().image).toBe('base.png')
  })

  it('只有动作的表情词不换图', () => {
    const { d } = make()
    d.emotion('开心')
    d.emotion('好奇')
    expect(d.frame().image).toBe('open.png')
  })

  it('显式表情保持 10 秒后回到心情基线；基线在此之前不抢', () => {
    const { d, tick } = make()
    d.emotion('惊讶')
    d.mood(0.9, 0.5)
    tick(5000)
    expect(d.frame().image).toBe('surprised.png')
    tick(6000)
    expect(d.frame().image).toBe('open.png')
  })

  it('还没有过显式表情时，心情基线直接换脸', () => {
    const { d } = make()
    d.mood(0.9, 0.5)
    expect(d.frame().image).toBe('open.png')
  })

  it('手势在时长内有偏移，过了就消失', () => {
    // 呼吸与待机摆动随时间变，所以拿一个同时钟、没做动作的孪生驱动当基线
    let t = 0
    const now = () => t
    const profile = parseProfile({ base: 'base.png', actions: { 点头: 'nod' } })
    const d = new TachieDriver(profile, { now, rand: () => 1 })
    const twin = new TachieDriver(profile, { now, rand: () => 1 })
    d.action('点头')
    t += 125 // nod 1.0s，八分之一处（四分之一处正好是两次摆动的过零点）
    expect(Math.abs((d.frame().offset.y ?? 0) - (twin.frame().offset.y ?? 0))).toBeGreaterThan(0.1)
    t += 1125
    expect(Math.abs((d.frame().offset.y ?? 0) - (twin.frame().offset.y ?? 0))).toBeLessThan(1e-6)
  })

  it('眨眼：没有闭眼图永远不闭；有闭眼图到点闭 holdMs', () => {
    const a = make()
    a.tick(1500)
    expect(a.d.frame().eyesClosed).toBe(false)

    const b = make({ eyesClosed: 'eyes-closed.png' })
    expect(b.d.frame().eyesClosed).toBe(false)
    b.tick(1000)
    expect(b.d.frame().eyesClosed).toBe(true)
    b.tick(50)
    expect(b.d.frame().eyesClosed).toBe(true)
    b.tick(60)
    expect(b.d.frame().eyesClosed).toBe(false)
    b.tick(900) // 下一次
    expect(b.d.frame().eyesClosed).toBe(true)
  })

  it('口型：有张嘴图输出口型值；没有则为 0 并改用点头', () => {
    const a = make()
    a.d.setSpeaking(true)
    a.d.setMouth(0.8)
    const noImg = a.d.frame()
    expect(noImg.mouth).toBe(0)

    const b = make({ mouthOpen: 'mouth-open.png' })
    b.d.setSpeaking(true)
    b.d.setMouth(0.8)
    const withImg = b.d.frame()
    expect(withImg.mouth).toBeCloseTo(0.8)
    // 同一时刻、同一口型，无图的那个靠点头表达，所以 y 更大
    expect((noImg.offset.y ?? 0) - (withImg.offset.y ?? 0)).toBeCloseTo(0.8 * 0.7)
  })

  it('被打断：演 interrupted（默认 flinch）并重置保持期', () => {
    const { d, tick } = make({ interrupted: { image: 'surprised.png', gesture: 'flinch' } })
    d.mood(0.9, 0.5)
    d.interrupted()
    expect(d.frame().image).toBe('surprised.png')
    tick(200)
    expect(Math.abs(d.frame().offset.y ?? 0)).toBeGreaterThan(0.3)
  })
})
