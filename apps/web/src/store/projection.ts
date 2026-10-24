/**
 * 投影：日志事件 → 界面状态。这是唯一允许改状态的地方。
 *
 * reduce() 不做任何副作用（不发网络、不动音频），只改状态并返回「该做的副作用」清单，
 * 由 app/runtime 决定在 live 之后执行。重放阶段只建状态，这条纪律靠这个结构保证。
 * 规则表见 docs/periphery.md §5.3；每条规则在 projection.test.ts 有一个用例。
 */
import { reactive } from 'vue'
import type {
  CharacterInfo,
  EmotionChanged,
  GroupPolicy,
  Incoming,
  LogEvent,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  PerceptReceived,
  SkinInfo,
  StageInfo,
  SurfaceMedia,
  UtterancePart,
  UtteranceSettled,
  UtteranceStarted,
} from '../protocol/types.ts'

export type Connection = 'connecting' | 'replaying' | 'live' | 'reconnecting' | 'offline'

export interface Marker { track: string, value: string, at: number } // at = 在 text 中的字符偏移
export interface Image { src: string, alt?: string }

export interface Message {
  id: string // 用户消息用 seq，角色消息用 utterance id
  side: 'user' | 'character'
  text: string // 全部文本（只含 Part.text；被打断后 = delivered）
  breaks: number[] // <|br|> 出现时的字符偏移，用于分成多条气泡
  markers: Marker[]
  images: Image[] // Part kind 'image'：不计入送达账，随消息一起显示
  at: number
  streaming: boolean
  truncated?: boolean
  cause?: string
  reveal: number // 已向用户呈现的字符数（字幕、回执都看它）
  // 以下只有「别人说的」消息有（side 'user'）：群里有很多人，不能都当成「你」
  sender?: { id: string, name?: string, avatar?: string }
  mentioned?: boolean // 这句 @ 了她
  policy?: { wake: boolean, p?: number, why: string[] } // group-policy 的读空气结论
  // 她这句话之后在电脑上起的活（computer / dsh）：一行实时进度小字，随 *.step 更新，结果回来标完成
  work?: { id: string, text: string, done?: boolean, ok?: boolean }
}

/** 进度小字跟的动作种类与它们每步落的日志事件 */
const WORK_TYPES = new Set(['computer', 'dsh'])
const WORK_RESULT = new Set(['computer.result', 'dsh.result'])

function findWork(s: Projection, actionId: unknown): Message | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].work?.id === actionId)
      return s.messages[i]
  }
  return undefined
}

/** 网页上的你（surface-web 的感知 sender id）；其余 sender 都是平台上的别人 */
export const WEB_USER = 'web-user'

// 平台插件把图片写成正文占位（[表情包：…]）同时在 data.images 给图；有图时占位就是重复的
const IMAGE_PLACEHOLDER = /\[(?:表情包|图片|动画表情)[：:][^\]]*\]/g

export interface StageState {
  speaking: boolean
  emotion?: string
  emotionAt?: number
  action?: string
  actionAt?: number
  interruptedAt?: number
  mood?: { valence: number, arousal: number, label: string }
}

export interface ModelCall {
  reqId: string
  role: string
  provider: string
  model: string
  messages: { role: string, content: string }[]
  startedAt: number
  chunks: { at: number, text: string }[]
  result?: { chars: number, usage?: { prompt: number, completion: number }, aborted: boolean, endedAt: number }
}

export interface Projection {
  connection: Connection
  channel: string // 当前对话（内核频道）；只投影这个频道的消息
  // 全部来自 /api/meta：stage 缺省 = live2d；id / characters / skins 缺省 = 没装 characters 插件或没 build 模型
  // ready：第一次取 meta 已有结果（成败都算）。舞台等它再挂，否则先按默认模型加载、meta 到了又换，
  // 两个 Live2D 画布同时活着会弄坏 Cubism 共享的着色器（舞台全空）。
  meta: { ready: boolean, name: string, voice: boolean, stage?: StageInfo, id?: string, characters: CharacterInfo[], skins: SkinInfo[] }
  events: LogEvent[]
  messages: Message[]
  current?: string // 正在说的 utterance id
  stage: StageState
  thinking: boolean
  modelCalls: Record<string, ModelCall>
  modelOrder: string[]
}

/** reduce 返回的副作用请求；runtime 只在 live 后执行 */
export type Effect
  = | { kind: 'text', uttId: string, text: string, total: number } // 新到文本与累计字符数
    | { kind: 'settled', uttId: string, truncated: boolean }
    | { kind: 'reset' }

export const MAX_EVENTS = 2000
export const MAX_CHUNKS = 400

export function createProjection(): Projection {
  return reactive({
    connection: 'connecting',
    channel: 'main',
    meta: { ready: false, name: '', voice: false, characters: [], skins: [] },
    events: [],
    messages: [],
    current: undefined,
    stage: { speaking: false },
    thinking: false,
    modelCalls: {},
    modelOrder: [],
  }) as Projection
}

export function resetProjection(s: Projection): void {
  s.events = []
  s.messages = []
  s.current = undefined
  s.stage = { speaking: false, mood: s.stage.mood }
  s.thinking = false
  s.modelCalls = {}
  s.modelOrder = []
}

function findMessage(s: Projection, uttId: string): Message | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].id === uttId)
      return s.messages[i]
  }
  return undefined
}

export function reduce(s: Projection, e: Incoming): Effect[] {
  const live = s.connection === 'live'

  if (e.type === '__live__') {
    s.connection = 'live'
    return []
  }
  if (e.type === '__reset__') {
    resetProjection(s)
    return [{ kind: 'reset' }]
  }
  if (e.type === '__stream__') {
    const ev = (e as { data: ModelStreamEvent }).data
    const call = s.modelCalls[ev.reqId]
    if (call && ev.chunk.type === 'text' && ev.chunk.text) {
      call.chunks.push({ at: ev.at, text: ev.chunk.text })
      if (call.chunks.length > MAX_CHUNKS)
        call.chunks.splice(0, call.chunks.length - MAX_CHUNKS)
    }
    return []
  }
  if (typeof (e as { type: string }).type !== 'string' || (e as { type: string }).type.startsWith('__'))
    return [] // 不认识的控制信号

  const ev = e as LogEvent
  s.events.push(ev)
  if (s.events.length > MAX_EVENTS)
    s.events.splice(0, s.events.length - MAX_EVENTS)

  switch (ev.type) {
    case 'percept.received': {
      const d = ev.data as PerceptReceived
      if (WORK_RESULT.has(d.kind)) {
        const r = (d.data ?? {}) as unknown as { actionId?: string, ok?: boolean, steps?: number }
        const m = findWork(s, r.actionId)
        if (m?.work)
          m.work = { ...m.work, done: true, ok: r.ok === true, text: `${r.ok ? '做完了' : '没做成'}（${r.steps ?? '?'} 步）` }
        return []
      }
      if (d.text && d.sender && (d.channel ?? 'main') === s.channel) {
        const images = (d.data?.images ?? []).filter(i => typeof i?.url === 'string').map(i => ({ src: i.url, alt: i.alt }))
        const text = images.length ? d.text.replace(IMAGE_PLACEHOLDER, '').trim() : d.text
        s.messages.push({
          id: `p${ev.seq}`,
          side: 'user',
          text,
          breaks: [],
          markers: [],
          images,
          at: ev.at,
          streaming: false,
          reveal: text.length,
          sender: { id: d.sender.id, name: d.sender.name, avatar: d.data?.avatar },
          mentioned: d.data?.mentioned === true,
        })
      }
      return []
    }
    case 'group.policy': {
      // 读空气的结论挂到同频道、同发言人的上一条消息上（它紧跟在那条感知后面落日志）
      const d = ev.data as GroupPolicy
      if (d.channel !== s.channel)
        return []
      const m = [...s.messages].reverse().find(x => x.side === 'user' && (!d.sender?.id || x.sender?.id === d.sender.id))
      if (m && !m.policy)
        m.policy = { wake: d.wake === true, p: typeof d.p === 'number' ? d.p : undefined, why: Array.isArray(d.why) ? d.why.map(String) : [] }
      return []
    }
    case 'surface.media': {
      // 平台表现端真正发出去的图 / 表情包（发言片段早已落日志，只能事后另记一条）：按 utt 挂到那条发言，没给 utt = 该频道她最近一条。
      // 给了 utt 却找不到：那条只有表情包没有字，结算时当空气泡删了（表情包是找完才到的）——单独补一条只有图的消息
      const d = ev.data as SurfaceMedia
      if (d.channel !== s.channel || typeof d.url !== 'string')
        return []
      const utt = d.utt ?? d.uttId
      const m = utt ? findMessage(s, utt) : [...s.messages].reverse().find(x => x.side === 'character')
      if (m && !m.images.some(i => i.src === d.url))
        m.images.push({ src: d.url, alt: d.alt })
      else if (!m && utt)
        s.messages.push({ id: utt, side: 'character', text: '', breaks: [], markers: [], images: [{ src: d.url, alt: d.alt }], at: ev.at, streaming: false, reveal: 0 })
      return []
    }
    case 'action.started': {
      // 电脑上的活挂到同频道她最近一条消息下（多半是「这就去弄」那句）；那个对话里她还没说过话就不挂
      const d = ev.data as { id: string, type: string, channel?: string }
      if (!WORK_TYPES.has(d.type) || (d.channel ?? 'main') !== s.channel)
        return []
      const m = [...s.messages].reverse().find(x => x.side === 'character')
      if (m)
        m.work = { id: d.id, text: d.type === 'dsh' ? '叫写代码的助手开工了' : '开始在电脑上弄了' }
      return []
    }
    case 'action.ended': {
      // 被停掉的不会有 *.result：在这里收尾；正常结束的等 *.result 带上成败与步数
      const d = ev.data as { id: string, outcome?: string }
      const m = findWork(s, d.id)
      if (m?.work && !m.work.done && d.outcome !== 'done')
        m.work = { ...m.work, done: true, ok: false, text: d.outcome === 'stopped' ? '被叫停了' : '出错停下了' }
      return []
    }
    case 'computer.step':
    case 'dsh.step': {
      const d = ev.data as { actionId?: string, step?: number, say?: string, tool?: string, done?: boolean }
      const m = findWork(s, d.actionId)
      if (m?.work && !m.work.done && !d.done)
        m.work = { ...m.work, text: `第 ${d.step ?? '?'} 步 · ${d.say || d.tool || '…'}` }
      return []
    }
    case 'utterance.started': {
      const d = ev.data as UtteranceStarted
      if ((d.channel ?? 'main') !== s.channel)
        return []
      s.messages.push({
        id: d.id,
        side: 'character',
        text: '',
        breaks: [],
        markers: [],
        images: [],
        at: ev.at,
        streaming: true,
        reveal: 0,
      })
      s.current = d.id
      if (live)
        s.stage.speaking = true
      return []
    }
    case 'utterance.part': {
      const d = ev.data as UtterancePart
      const m = findMessage(s, d.id)
      if (!m || !m.streaming)
        return []
      const p = d.part
      if (p.kind === 'text' && p.text) {
        m.text += p.text
        if (!live)
          m.reveal = m.text.length // 重放：直接全显
        return live ? [{ kind: 'text', uttId: d.id, text: p.text, total: m.text.length }] : []
      }
      if (p.kind === 'marker' && p.data?.track) {
        const value = String(p.data.value ?? '')
        m.markers.push({ track: p.data.track, value, at: m.text.length })
        if (live) {
          if (p.data.track === 'emo') {
            s.stage.emotion = value
            s.stage.emotionAt = ev.at
          }
          else if (p.data.track === 'act') {
            s.stage.action = value
            s.stage.actionAt = ev.at
          }
        }
        return []
      }
      if (p.kind === 'image' && typeof p.data?.media === 'string') {
        m.images.push({ src: `/api/media/${encodeURIComponent(p.data.media)}`, alt: typeof p.data.alt === 'string' ? p.data.alt : undefined })
        return []
      }
      if (p.kind === 'break') {
        if (m.text.length && m.breaks[m.breaks.length - 1] !== m.text.length)
          m.breaks.push(m.text.length)
        return []
      }
      return [] // 不认识的 Part.kind：忽略，即能力降级
    }
    case 'utterance.settled': {
      const d = ev.data as UtteranceSettled
      const m = findMessage(s, d.id)
      if (m && !d.delivered && !m.images.length) {
        // 一个字都没说出去（刚开口就被打断）：不留空气泡；只发了图的消息本来就没有字，要留
        s.messages.splice(s.messages.indexOf(m), 1)
      }
      else if (m) {
        m.streaming = false
        if (d.truncated) {
          m.text = d.delivered
          m.truncated = true
          m.cause = d.cause
          m.breaks = m.breaks.filter(b => b < m.text.length)
          m.markers = m.markers.filter(k => k.at <= m.text.length)
        }
        m.reveal = Math.min(Math.max(m.reveal, live ? m.reveal : m.text.length), m.text.length)
        if (!live)
          m.reveal = m.text.length
      }
      if (s.current === d.id)
        s.current = undefined
      if (live) {
        s.stage.speaking = false
        if (d.truncated)
          s.stage.interruptedAt = ev.at
      }
      return live ? [{ kind: 'settled', uttId: d.id, truncated: d.truncated }] : []
    }
    case 'beat.opened':
      s.thinking = true
      return []
    case 'beat.closed':
    case 'beat.failed':
      s.thinking = false
      return []
    case 'emotion.changed': {
      const d = ev.data as EmotionChanged
      s.stage.mood = { valence: d.valence, arousal: d.arousal, label: d.label }
      return []
    }
    case 'model.request': {
      const d = ev.data as ModelRequest
      s.modelCalls[d.reqId] = {
        reqId: d.reqId,
        role: d.role,
        provider: d.provider,
        model: d.model,
        messages: d.messages ?? [],
        startedAt: ev.at,
        chunks: [],
      }
      s.modelOrder.push(d.reqId)
      if (s.modelOrder.length > 200) {
        const drop = s.modelOrder.splice(0, s.modelOrder.length - 200)
        for (const id of drop) delete s.modelCalls[id]
      }
      return []
    }
    case 'model.response': {
      const d = ev.data as ModelResponse
      const call = s.modelCalls[d.reqId]
      if (call)
        call.result = { chars: d.chars, usage: d.usage, aborted: d.aborted, endedAt: ev.at }
      return []
    }
    default:
      return [] // 其他事件只进 events
  }
}

/** 按 break 切成多条气泡；只取已呈现（reveal）的部分 */
export function segmentsOf(m: Message, upTo = m.reveal): string[] {
  const text = m.text.slice(0, upTo)
  const out: string[] = []
  let last = 0
  for (const b of m.breaks) {
    if (b >= text.length)
      break
    out.push(text.slice(last, b))
    last = b
  }
  out.push(text.slice(last))
  return out.map(x => x.trim()).filter((x, i, arr) => x.length || i === arr.length - 1)
}
