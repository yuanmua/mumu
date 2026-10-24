/**
 * 与 docs/web-protocol.md 一一对应的类型。手写，不从内核导入——浏览器端只认协议。
 * 协议里没写的字段这里也不猜；拿不准的用 unknown。
 */
import type { WebPanel } from './admin.ts'

export interface LogEvent<T = any> {
  seq: number
  at: number
  type: string
  data: T
}

export interface Sender {
  id: string
  name?: string
}

export interface Part {
  kind: string // 'text' | 'marker' | 'break' | 其他（忽略）
  text?: string
  data?: { track?: string, value?: string, [k: string]: unknown }
}

export interface ModelStreamEvent {
  reqId: string
  at: number
  chunk: { type: string, text?: string }
}

/** SSE 上的一条：日志事件或控制信号 */
export type Incoming
  = | LogEvent
    | { type: '__live__' }
    | { type: '__reset__' }
    | { type: '__stream__', data: ModelStreamEvent }

/** 对话来源：频道名 <platform>:<kind>:<id> + 平台插件报的名字（协议 §3 /api/conversations） */
export interface Source {
  platform: string // web | qq | …
  kind: string // web | group | private
  id?: string
  name?: string
}

export interface Conversation {
  channel: string
  title: string
  firstAt: number
  lastAt: number
  count: number // 别人说过几句（减去看过时的数 = 未读）
  said?: number // 她今天在这说出去几条
  source?: Source // 旧后端没有：当网页对话
}

/** 平台感知的 data（协议 §5）；全部可选 */
export interface PerceptData {
  platform?: string
  chat?: string
  groupName?: string
  avatar?: string
  mentioned?: boolean
  images?: { url: string, alt?: string, sticker?: boolean }[]
}

/** 舞台实现与档案目录：characters 插件经 web/meta 补进来；没有时前端走 live2d 默认 */
export interface StageInfo {
  kind: string // 'live2d' | 'tachie'；不认识的按 live2d
  profile: string // 相对站点根的目录，档案在 /<profile>/profile.json
}

/** 可切换的角色包（meta.characters）：切换 = /character use <id> */
export interface CharacterInfo {
  id: string
  name: string
  stage: StageInfo
}

/** 可选的舞台皮肤（meta.skins）：切换 = /character skin <profile>，只换舞台不换人设 */
export interface SkinInfo {
  id: string
  kind: string
  profile: string
}

/** GET / POST /api/persona 的形状；rules: null = 用内置「要求」，'' = 不要 */
export interface Persona {
  name: string
  prompt: string
  style: string
  rules: string | null
  markers: Record<string, string[]>
  aliases?: Record<string, string> // 各平台网名 { 平台: 网名 }；旧后端没有
}

/** 一个模型角色的绑定（provider-openai 的字段）；没写的项由后端从 default 继承 */
export interface ModelBinding {
  provider?: string
  baseURL?: string
  model?: string
  apiKeyRef?: string
  fallback?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  responseFormat?: 'json' | 'text'
}

/** GET / POST /api/models 的响应；POST 请求体只有 roles（想要的完整 roles） */
export interface Models {
  roles: Record<string, ModelBinding>
  defaults: Record<string, ModelBinding>
  keys: string[]
  presets: (ModelBinding & { name: string })[]
}

export interface Meta {
  protocol: number
  character: { id?: string, name: string, stage?: StageInfo }
  characters?: CharacterInfo[]
  skins?: SkinInfo[]
  replay: number
  voice: { available: boolean }
  commands: { name: string, usage: string, description: string }[]
  pet?: { visible: boolean } // desktop-pet 插件补入；没装就缺省
  panels?: WebPanel[] // 插件经 web/meta 报的通用面板，形状在 admin.ts（协议 §7）
}

// 下面是前端会投影的几种 data 形状（字段来自协议文档 §5）
export interface PerceptReceived { kind: string, channel: string, sender?: Sender, text?: string, urgent?: boolean, data?: PerceptData }
export interface GroupPolicy { channel: string, sender?: Sender, p?: number, why?: string[], wake?: boolean }
/** 平台表现端真正发出一张图 / 表情包后记的日志（surface-onebot）：按 utt 挂到那条发言上 */
export interface SurfaceMedia { channel: string, utt?: string, uttId?: string, url?: string, alt?: string, kind?: string }
export interface UtteranceStarted { id: string, action: string, channel: string }
export interface UtterancePart { id: string, part: Part }
export interface UtteranceSettled { id: string, channel: string, delivered: string, truncated: boolean, cause?: string }
export interface ModelRequest { reqId: string, role: string, provider: string, model: string, messages: { role: string, content: string }[] }
export interface ModelResponse { reqId: string, role: string, model: string, chars: number, usage?: { prompt: number, completion: number }, aborted: boolean }
export interface EmotionChanged { valence: number, arousal: number, last?: string, label: string }
