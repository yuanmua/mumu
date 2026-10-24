/**
 * 模型档案：把内核的表情/动作**词汇**映射到某一个 Live2D 模型的**资源**。
 * 词汇归插件，映射归模型；两边互不认识，所以换模型只需换一份 profile.json。
 *
 * 三种演法可以叠加：expression（模型自带表情文件）、pose（参数偏移，任何模型通用）、
 * gesture（程序化动作，任何模型通用）、motion（模型自带动作文件）。
 */
export interface EmotionDef {
  expression?: string
  pose?: Record<string, number>
  gesture?: string
}

export interface ActionDef extends EmotionDef {
  motion?: string
  index?: number
}

export interface Profile {
  model: string // 相对模型目录的 model3.json
  fit?: { height?: number, y?: number } // 模型高度 = 视口高 × height；顶部偏移 = 视口高 × y
  idle?: string
  mouth?: { param?: string, max?: number }
  moods?: { happy?: string, sad?: string, angry?: string, neutral?: string }
  emotions?: Record<string, EmotionDef>
  actions?: Record<string, ActionDef>
  interrupted?: EmotionDef
}

export const DEFAULT_MODEL = 'hiyori'
const MODELS_ROOT = 'live2d/models'

/**
 * 模型目录（相对站点根，不带首尾斜杠）。优先级：?model=<id> > 角色包给的目录 > localStorage > 默认。
 * 查询串放最前是给调试用的；角色包在 localStorage 之前，否则切了角色舞台还停在旧模型上。
 */
export function modelDir(preferred?: string): string {
  const q = new URLSearchParams(location.search).get('model')
  if (q)
    return `${MODELS_ROOT}/${q}`
  if (preferred)
    return preferred.replace(/^\/+|\/+$/g, '')
  try {
    const saved = localStorage.getItem('mumu.model')
    if (saved)
      return `${MODELS_ROOT}/${saved}`
  }
  catch {
    // 隐私模式等读不到：用默认
  }
  return `${MODELS_ROOT}/${DEFAULT_MODEL}`
}

export async function loadProfile(dir: string): Promise<Profile> {
  const res = await fetch(`/${dir}/profile.json`, { cache: 'no-cache' })
  if (!res.ok)
    throw new Error(`没有找到模型档案 /${dir}/profile.json`)
  return await res.json()
}
