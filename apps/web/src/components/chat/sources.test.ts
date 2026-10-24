import { describe, expect, it } from 'vitest'
import type { Conversation } from '../../protocol/types.ts'
import { badge, hue, isPlatform, matches, sourceOf, unread } from './sources.ts'

const conv = (channel: string, source?: Conversation['source'], count = 3): Conversation => ({ channel, title: channel, firstAt: 0, lastAt: 0, count, source })

describe('对话来源', () => {
  it('图标与标签：网页 / QQ 群 / QQ 私聊 / 不认识的平台', () => {
    expect(badge({ platform: 'web', kind: 'web' })).toEqual({ icon: '🌐', label: '网页' })
    expect(badge({ platform: 'qq', kind: 'group' })).toEqual({ icon: '👥', label: 'QQ 群' })
    expect(badge({ platform: 'qq', kind: 'private' })).toEqual({ icon: '💬', label: 'QQ 私聊' })
    expect(badge({ platform: 'matrix', kind: 'group' }).label).toBe('matrix 群')
  })

  it('旧后端没有 source：当网页对话；平台会话才翻转左右', () => {
    expect(sourceOf(conv('main'))).toEqual({ platform: 'web', kind: 'web' })
    expect(sourceOf(undefined).kind).toBe('web')
    expect(isPlatform({ platform: 'qq', kind: 'group' })).toBe(true)
    expect(isPlatform({ platform: 'web', kind: 'web' })).toBe(false)
  })

  it('按来源筛选', () => {
    const g = conv('qq:group:1', { platform: 'qq', kind: 'group' })
    const p = conv('qq:private:2', { platform: 'qq', kind: 'private' })
    const w = conv('main')
    expect([g, p, w].filter(c => matches(c, 'group'))).toEqual([g])
    expect([g, p, w].filter(c => matches(c, 'web'))).toEqual([w])
    expect([g, p, w].filter(c => matches(c, 'all'))).toHaveLength(3)
  })

  it('未读 = 句数 − 看过时的句数；正在看的不算', () => {
    const g = conv('qq:group:1', { platform: 'qq', kind: 'group' }, 10)
    expect(unread(g, {}, 'main')).toBe(10)
    expect(unread(g, { 'qq:group:1': 7 }, 'main')).toBe(3)
    expect(unread(g, { 'qq:group:1': 12 }, 'main')).toBe(0)
    expect(unread(g, {}, 'qq:group:1')).toBe(0)
  })

  it('占位头像底色稳定', () => {
    expect(hue('20001')).toBe(hue('20001'))
    expect(hue('20001')).toBeGreaterThanOrEqual(0)
    expect(hue('20001')).toBeLessThan(360)
    // 连号也要分得开
    const d = Math.abs(hue('20004') - hue('20005'))
    expect(Math.min(d, 360 - d)).toBeGreaterThan(30)
  })
})
