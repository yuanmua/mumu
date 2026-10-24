/**
 * 会话数据类型。内核不定义会话形态：群聊、弹幕、视觉、文件都只是感知的 kind。
 * 内核只认三个结构位：channel（并行上下文）、sender（来源身份）、text（自然语言摘要）。
 */

// T 缺省 any：现有插件直接读 e.data.<字段>；插件重做时改成 unknown 收紧（handbook §9.3）
export interface LogEvent<T = any> {
  seq: number
  at: number
  type: string
  data: T
}

/** 来源身份；群成员、弹幕观众、设备共用 */
export interface Sender {
  id: string
  name?: string
}

/**
 * 对话历史的一条投影。结构规则：感知有 text 且有 sender ⇒ other 侧；
 * 实际送达的发言（utterance.settled 的 delivered）⇒ self 侧。渲染由消费方决定。
 */
export interface HistoryTurn {
  role: 'self' | 'other'
  text: string
  at: number
  channel: string
  kind: string // 来源感知的 kind；self 侧固定为 'utterance'
  sender?: Sender
}

/** 未指定频道时的缺省频道 id */
export const MAIN_CHANNEL = 'main'

/**
 * 反馈：某次行为后来是好是坏、谁评价的。写成日志事件 `feedback`（FEEDBACK_EVENT），
 * 主人纠正、对方反应、bench 打分都用这一个形状，各家采的数据才能汇到一起。
 * 内核只定形状，不产生也不消费它。
 */
export interface Feedback {
  target: { seq?: number, id?: string } // 评的是哪条事件（seq），或哪个动作 / 发声 / 模型请求（id）；至少给一个
  score: number // -1（坏）～ 1（好）
  by: { kind: string, id?: string } // 谁评的：kind 由插件约定（如人、bench、规则），id 是其身份
  reason?: string
  data?: Record<string, unknown>
}

export const FEEDBACK_EVENT = 'feedback'
