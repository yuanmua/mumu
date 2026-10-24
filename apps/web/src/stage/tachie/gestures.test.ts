import { describe, expect, it } from 'vitest'
import { addOffset, breath, idleSway, nextBlinkDelay, speakingMotion, TACHIE_GESTURES, toTransform } from './gestures.ts'
import { GESTURES } from '../live2d/gestures.ts'

describe('立绘手势', () => {
  it('与 Live2D 同名手势时长一致，两种舞台共用一份词映射', () => {
    for (const [name, g] of Object.entries(GESTURES))
      expect(TACHIE_GESTURES[name]?.duration, name).toBe(g.duration)
  })

  it('每个手势起点与终点都回到零：叠在待机上不会留残余偏移', () => {
    for (const [name, g] of Object.entries(TACHIE_GESTURES)) {
      for (const p of [0, 1]) {
        const o = g.at(p)
        for (const v of Object.values(o))
          expect(Math.abs(v ?? 0), `${name}@${p}`).toBeLessThan(1e-6) // sin(π) 不是精确的 0
      }
    }
  })

  it('每个手势中段有动静，且幅度在整图可接受范围内', () => {
    for (const [name, g] of Object.entries(TACHIE_GESTURES)) {
      let moved = 0
      for (let i = 1; i < 20; i++) {
        const o = g.at(i / 20)
        moved += Math.abs(o.x ?? 0) + Math.abs(o.y ?? 0) + Math.abs(o.rot ?? 0) + Math.abs(o.scale ?? 0)
        expect(Math.abs(o.x ?? 0), name).toBeLessThanOrEqual(3)
        expect(Math.abs(o.y ?? 0), name).toBeLessThanOrEqual(3)
        expect(Math.abs(o.rot ?? 0), name).toBeLessThanOrEqual(6)
        expect(Math.abs(o.scale ?? 0), name).toBeLessThanOrEqual(0.05)
      }
      expect(moved, name).toBeGreaterThan(0)
    }
  })

  it('呼吸与待机摆动幅度很小，且 t=0 时呼吸为零', () => {
    expect(breath(0).scale).toBe(0)
    expect(Math.abs(breath(0).y ?? 0)).toBe(0)
    for (let t = 0; t < 30; t += 0.37) {
      expect(Math.abs(breath(t).scale ?? 0)).toBeLessThanOrEqual(0.02)
      expect(Math.abs(breath(t).y ?? 0)).toBeLessThanOrEqual(2)
      expect(Math.abs(idleSway(t).rot ?? 0)).toBeLessThanOrEqual(1)
    }
  })

  it('没有口型图时点头幅度跟着口型值走；有口型图时不点', () => {
    const closed = speakingMotion(0, 1, true)
    const open = speakingMotion(0, 1, false)
    expect((closed.y ?? 0) - (open.y ?? 0)).toBeCloseTo(0.7)
  })

  it('眨眼间隔落在区间内，区间颠倒也不崩', () => {
    expect(nextBlinkDelay(2, 6, () => 0)).toBe(2)
    expect(nextBlinkDelay(2, 6, () => 1)).toBe(6)
    expect(nextBlinkDelay(2, 6, () => 0.5)).toBe(4)
    expect(nextBlinkDelay(6, 2, () => 0.5)).toBe(4)
  })

  it('偏移相加与 transform 换算', () => {
    expect(addOffset({ x: 1, rot: 2 }, { x: 1, y: -1, scale: 0.01 })).toEqual({ x: 2, y: -1, rot: 2, scale: 0.01 })
    expect(toTransform({ x: 1, y: -2, rot: 3, scale: 0.01 }, 1000)).toBe('translate(10.00px, -20.00px) rotate(3.000deg) scale(1.0100)')
    expect(toTransform({}, 500)).toBe('translate(0.00px, 0.00px) rotate(0.000deg) scale(1.0000)')
  })
})
