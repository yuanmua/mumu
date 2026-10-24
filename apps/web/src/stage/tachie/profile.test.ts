import { describe, expect, it } from 'vitest'
import { describeImage, imageFiles, moodImage, parseProfile, resolveAction, resolveEmotion } from './profile.ts'

const raw = {
  base: 'base.png',
  eyesClosed: 'eyes-closed.png',
  mouthOpen: 'mouth-open.png',
  fit: { height: 1.1 },
  moods: { happy: '开心', neutral: '平静', sad: 'sad.png' },
  expressions: {
    开心: 'open.png',
    大笑: { image: 'laugh.png', gesture: 'bounce' },
    好奇: { gesture: 'tilt' },
    平静: 'base.png',
  },
  actions: { 点头: 'nod', 捂脸: { image: 'blush.png', gesture: 'flinch' } },
  interrupted: { image: 'surprised.png', gesture: 'flinch' },
}

describe('立绘档案', () => {
  it('字符串简写：带图片后缀的是图，否则是动作名；缺的可选项补默认', () => {
    const p = parseProfile(raw)
    expect(p.expressions.开心).toEqual({ image: 'open.png' })
    expect(p.actions.点头).toEqual({ gesture: 'nod' })
    expect(p.fit).toEqual({ height: 1.1, y: 0 })
    expect(p.blink).toEqual({ minSec: 2, maxSec: 6, holdMs: 120 })
  })

  it('最小档案只要 base；interrupted 默认 flinch', () => {
    const p = parseProfile({ base: 'b.png' })
    expect(p.interrupted).toEqual({ gesture: 'flinch' })
    expect(p.expressions).toEqual({})
    expect(p.eyesClosed).toBeUndefined()
  })

  it('形状不对就说清哪一项', () => {
    expect(() => parseProfile({})).toThrow('base')
    expect(() => parseProfile({ base: 'b.png', expressions: { 开心: { gesture: 'moonwalk' } } })).toThrow('expressions.开心.gesture')
    expect(() => parseProfile({ base: 'b.png', actions: ['nod'] })).toThrow('actions')
    expect(() => parseProfile(null)).toThrow('对象')
  })

  it('表情词：查得到用它的图与动作；只有动作时图不变；查不到回底图并歪头', () => {
    const p = parseProfile(raw)
    expect(resolveEmotion(p, '大笑')).toEqual({ image: 'laugh.png', gesture: 'bounce', known: true })
    expect(resolveEmotion(p, '好奇')).toEqual({ gesture: 'tilt', known: true })
    expect(resolveEmotion(p, '没有这个词')).toEqual({ image: 'base.png', gesture: 'tilt', known: false })
  })

  it('动作词：查不到小幅点头', () => {
    const p = parseProfile(raw)
    expect(resolveAction(p, '捂脸')).toEqual({ image: 'blush.png', gesture: 'flinch', known: true })
    expect(resolveAction(p, '劈叉')).toEqual({ gesture: 'nod', known: false })
  })

  it('心情基线：值是表情词就查表情，是文件名就直接用，都没有回底图', () => {
    const p = parseProfile(raw)
    expect(moodImage(p, 0.8, 0.5)).toBe('open.png')
    expect(moodImage(p, 0, 0.5)).toBe('base.png')
    expect(moodImage(p, -0.6, 0.3)).toBe('sad.png')
    expect(moodImage(p, -0.6, 0.9)).toBe('base.png') // angry 没配 → neutral
    expect(moodImage(parseProfile({ base: 'b.png' }), 0.9, 0.9)).toBe('b.png')
  })

  it('图文件清单去重、底图最前，说明文案能指出每张图归谁用', () => {
    const p = parseProfile(raw)
    const files = imageFiles(p)
    expect(files[0]).toBe('base.png')
    expect(new Set(files).size).toBe(files.length)
    expect(files).toEqual(expect.arrayContaining(['eyes-closed.png', 'mouth-open.png', 'open.png', 'laugh.png', 'blush.png', 'surprised.png', 'sad.png']))
    expect(describeImage(p, 'base.png')).toContain('底图')
    expect(describeImage(p, 'eyes-closed.png')).toContain('眨眼')
    expect(describeImage(p, 'mouth-open.png')).toContain('口型')
    expect(describeImage(p, 'blush.png')).toBe('表情：捂脸')
    expect(describeImage(p, 'laugh.png')).toBe('表情：大笑')
  })
})
