/**
 * 情绪状态插件。
 *
 * 立场：角色的心情不该每次回复都从零开始。它是一个随时间演化的状态：
 * 自己说出的表情标记会推动它（说了「害羞」就真的害羞一阵），对方来消息会提神，
 * 长时间没人说话会回落到基线并慢慢变困。两个维度够用：
 *   valence 愉悦度 [-1, 1]，arousal 兴奋度 [0, 1]。
 *
 * 它只听日志、只贡献材料，内核不认识它（handbook §9.4 推迟表里「情绪状态演化」的落点）：
 * - 段落（performer）：「此刻的心情」，让发言者带着情绪说话；
 * - 材料块（beat/gather）：让导演知道角色现在的状态；
 * - 日志事件 emotion.changed：舞台据此调整待机表情基线，不必每句话都靠标记。
 */
import type { LogEvent, MaterialBlock, Plugin } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'

export interface EmotionState {
  valence: number
  arousal: number
  last?: string // 最近一次表达出的情绪词
  lastAt?: number
  label: string
}

export interface EmotionService {
  state: () => EmotionState
  /** 外部推一把，如记忆插件回忆起不愉快的事 */
  nudge: (dv: number, da: number, why?: string) => void
}

interface EmotionConfig {
  decayEveryMs?: number
  baseline?: { valence: number, arousal: number }
}

/** 表情词 → (愉悦度, 兴奋度) 目标；未列出的词不影响状态 */
const WORDS: Record<string, [number, number]> = {
  开心: [0.7, 0.6],
  大笑: [0.9, 0.9],
  害羞: [0.5, 0.7],
  好奇: [0.4, 0.7],
  惊讶: [0.2, 0.9],
  难过: [-0.7, 0.3],
  委屈: [-0.6, 0.5],
  生气: [-0.5, 0.8],
  无语: [-0.2, 0.3],
  得意: [0.7, 0.7],
  思考: [0.1, 0.4],
  平静: [0.2, 0.2],
  困: [0.0, 0.1],
  心动: [0.8, 0.7],
  撒娇: [0.6, 0.6],
  脸红: [0.5, 0.7],
}

const plugin: Plugin<EmotionConfig> = {
  name: 'emotion',
  apply(ctx, cfg = {}) {
    const base = cfg.baseline ?? { valence: 0.25, arousal: 0.45 }
    const st: EmotionState = { valence: base.valence, arousal: base.arousal, label: '' }
    st.label = describe(st)

    const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
    const move = (tv: number, ta: number, weight: number, why?: string): void => {
      st.valence = clamp(st.valence + (tv - st.valence) * weight, -1, 1)
      st.arousal = clamp(st.arousal + (ta - st.arousal) * weight, 0, 1)
      if (why) {
        st.last = why
        st.lastAt = Date.now()
      }
      const label = describe(st)
      const changed = label !== st.label
      st.label = label
      if (changed)
        ctx.log.append('emotion.changed', { ...st })
    }

    const service: EmotionService = {
      state: () => ({ ...st }),
      nudge: (dv, da, why) => move(st.valence + dv, st.arousal + da, 1, why),
    }
    ctx.provide('emotion', service)

    // 自己说出口的情绪最可信；对方来消息提神；被打断略扫兴
    ctx.on<LogEvent>('log.appended', (e) => {
      if (e.type === 'utterance.part' && e.data?.part?.kind === 'marker' && e.data.part.data?.track === 'emo') {
        const word = String(e.data.part.data.value ?? '')
        const target = WORDS[word]
        if (target)
          move(target[0], target[1], 0.6, word)
        else
          st.last = word
      }
      else if (e.type === 'percept.received' && e.data?.text && e.data?.sender) {
        move(st.valence, Math.max(st.arousal, 0.5), 0.5)
      }
      else if (e.type === 'utterance.settled' && e.data?.truncated) {
        move(st.valence - 0.1, st.arousal, 0.5)
      }
    })

    // 随时间回落到基线；久无对话会变困
    const every = cfg.decayEveryMs ?? 20_000
    const timer = setInterval(() => {
      const idleMs = Date.now() - (st.lastAt ?? 0)
      const target = idleMs > 10 * 60_000 ? { valence: base.valence, arousal: 0.15 } : base
      move(target.valence, target.arousal, 0.12)
    }, every)
    timer.unref()
    ctx.effect(() => () => clearInterval(timer))

    ctx.effect(() => ctx.prompt.section({
      id: 'emotion-now',
      audience: 'performer',
      order: PROMPT_ORDER.state,
      render: () => `【此刻的心情】${st.label}${st.last ? `（刚才表达过「${st.last}」）` : ''}。让心情自然地渗进说话的语气和节奏里，但不要直接报告自己的心情。`,
    }))

    ctx.intercept<{ blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      m.blocks.push({ from: 'emotion', order: 20, text: `【角色此刻的心情】${st.label}`, data: { ...st } })
      return next()
    })
  },
}

export default plugin

/** 两个维度 → 一句中文 */
function describe(s: EmotionState): string {
  const v = s.valence
  const a = s.arousal
  if (a < 0.2)
    return v < -0.2 ? '蔫蔫的，有点低落' : '困困的，懒洋洋'
  if (v > 0.5)
    return a > 0.7 ? '兴奋，很开心' : '心情不错，轻松'
  if (v > 0.1)
    return a > 0.6 ? '来了精神，有点好奇' : '平和，愿意聊'
  if (v > -0.3)
    return a > 0.6 ? '有点紧绷' : '淡淡的，没什么波澜'
  return a > 0.6 ? '烦躁，有点生气' : '难过，提不起劲'
}
