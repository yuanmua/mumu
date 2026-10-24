/** 本插件的配置形状；默认值在 package.json 的 mumu.defaults，网页表单的说明在 mumu.ui */
import type { InlineConfig } from './inline.ts'
import type { NoticeConfig } from './notices.ts'
import type { SplitConfig } from './outbox.ts'
import type { QueryConfig } from './queries.ts'
import type { ThrottleConfig } from './throttle.ts'
import type { VisionConfig } from './vision.ts'

export interface OneBotConfig {
  url?: string
  token?: string // 直接填 token（网页设置里是密码框）；空着就按 tokenRef 去密钥库取
  tokenRef?: string
  reconnectMs?: number
  callTimeoutMs?: number
  names?: string[]
  privateUrgent?: boolean
  inputStatus?: boolean // 私聊等待期间显示「对方正在输入…」
  voiceToText?: boolean // 收到语音时让 NapCat 转文字
  keepMessages?: number // 每个频道记住最近几条（引用、撤回原文、@ 人）
  inline?: boolean // 教发言者用 <|quote|> / <|at:名字|>
  actions?: boolean // 注册 qq.send / qq.manage / qq.query / qq.call
  saveMedia?: boolean // 收到的图 / 她发的表情包存进 mediaDir，网页才看得见
  maxMediaBytes?: number
  mediaDir?: string // 别的动作产出的图片放在哪（Part kind 'image' 的 data.media 是这里的文件名）
  throttle?: ThrottleConfig
  split?: SplitConfig
  notices?: NoticeConfig
  query?: QueryConfig
  vision?: VisionConfig
  images?: { inline?: InlineConfig } // 最近几张图以原图进发言者 / 大脑的上下文（inline.ts）
  stickers?: boolean // 表情包收发交给 stickers 插件（服务 stickers）；没装它就只看不收、不发
}
