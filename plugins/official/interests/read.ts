/**
 * 看一段对话，认出「在聊什么」「她投不投入」「她有没有表态」：一次模型调用（角色 interests.read，没绑就走 default）。
 * 另有模型打分的提示词（buildRatePrompt / parseRate）：没有向量模型时 semantic.ts 的退路。
 * 输出 JSON 用 JSON.parse 读（handbook §9.2：不用正则解析模型输出）；解析不了附错误重试一次，再不行这段算了。
 */
import type { ChatMessage, ModelRequest } from '../../../src/index.ts'
import type { Line, Signals } from './watch.ts'

export interface Reading {
  topic: string // 空 = 没有具体话题（寒暄、闲扯）
  desc?: string // 这个话题一句话是聊什么的（新学来的兴趣拿它算语义向量）
  keywords: string[]
  engaged: boolean
  stance: 'like' | 'dislike' | 'none'
  why: string
}

export function buildPrompt(bot: string, lines: Line[], signals: Signals, known: string[]): ChatMessage[] {
  const hints = [
    signals.turns ? `她这段开口 ${signals.turns} 次` : '',
    signals.questions ? `追问 ${signals.questions} 次` : '',
    signals.emo.length ? `说话时的表情：${signals.emo.join('、')}` : '',
  ].filter(Boolean).join('，')
  const system = `你在帮${bot}整理她自己的兴趣。下面是她刚聊完的一段（「她」是${bot}）。判断四件事：
1. topic：这段主要在聊什么具体话题，一个 2～6 字的名词（如「摄影」「火锅」「原神」「天文」）。寒暄、斗嘴、聊天气吃饭这种没有具体话题的写空串。
2. engaged：她本人对这个话题投不投入。主动接话、追问细节、说得兴致勃勃、分享自己的看法 = true；敷衍、岔开、被动应付、嫌烦 = false。只看她，不看别人。
3. stance：她自己有没有明确说喜欢 / 想试 / 迷上（like），或明确说不感兴趣 / 没意思 / 不喜欢（dislike）；没说就是 none。别人说的不算。
4. keywords：只有聊这个话题时才会出现的 3～6 个具体词（如摄影：相机、镜头、拍照、光圈）。别人聊别的也常说的词不要（图片、眼睛、可爱、喜欢、东西、今天），人名也不要。
5. desc：这个话题平时聊些什么，一句 10～25 字的话，只写话题本身、不写她的表现（如摄影：「拿相机拍照，聊镜头、光圈、构图和修图」）。没有话题写空串。
她已有的兴趣：${known.length ? known.join('、') : '（还没有）'}。如果是同一个话题，topic 就用已有的名字。
只输出一个 JSON 对象，不要代码块，不要解释：
{"topic":"","desc":"","engaged":true,"stance":"none","keywords":[],"why":"一句话"}`
  const transcript = lines.map(l => `[${l.self ? '她' : l.who}] ${l.text}`).join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${transcript}${hints ? `\n\n（${hints}）` : ''}` },
  ]
}

export async function read(complete: (req: ModelRequest) => Promise<string>, role: string, messages: ChatMessage[]): Promise<Reading | undefined> {
  const first = await complete({ role, messages })
  const a = parse(first)
  if (a)
    return a
  const retry = await complete({
    role,
    messages: [...messages, { role: 'assistant', content: first }, { role: 'user', content: '上面的输出不是合法的 JSON 对象。只输出一个合法的 JSON 对象。' }],
  })
  return parse(retry)
}

export function parse(text: string): Reading | undefined {
  const json = extractJson(text)
  if (!json)
    return undefined
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    const topic = typeof o.topic === 'string' ? o.topic.trim().slice(0, 12) : ''
    const keywords = Array.isArray(o.keywords)
      ? [...new Set(o.keywords.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x && x !== topic && [...x].length <= 10))].slice(0, 8)
      : []
    const stance = o.stance === 'like' || o.stance === 'dislike' ? o.stance : 'none'
    const desc = topic && typeof o.desc === 'string' ? o.desc.trim().slice(0, 40) : ''
    return { topic, desc, keywords, engaged: o.engaged === true, stance, why: typeof o.why === 'string' ? o.why.trim() : '' }
  }
  catch {
    return undefined // 不是合法 JSON：调用方重试或放弃
  }
}

/**
 * 模型打分（semantic.ts 的 via model 退路，角色 interests.score）：一句群消息离她哪条兴趣最近、多近。
 * 只要两个字段，输出短（绑定里把 maxTokens 压到 30 左右）；不是合法 JSON 就当不相关，不重试——读空气等不起。
 */
export function buildRatePrompt(bot: string, items: { name: string, keywords: string[] }[], text: string): ChatMessage[] {
  const list = items.map(i => i.keywords.length ? `${i.name}（${i.keywords.slice(0, 6).join('、')}）` : i.name).join('；')
  const system = `判断一句群聊消息是不是在聊${bot}感兴趣的话题。她的兴趣：${list}。
只看这句话实际在聊什么：字面带了某个词、说的却是别的事不算（「火箭队今晚比赛」是篮球，不是航天）；没带那些词、说的就是那件事算（「猎鹰九号回收了」是航天）。
只输出一个 JSON 对象，不要解释：{"topic":"最相关的兴趣名，都不相关写空串","near":0到1之间的相关程度}`
  return [{ role: 'system', content: system }, { role: 'user', content: text }]
}

export function parseRate(text: string): { topic: string, near: number } | undefined {
  const json = extractJson(text)
  if (!json)
    return undefined
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    const near = typeof o.near === 'number' ? o.near : Number(o.near)
    return { topic: typeof o.topic === 'string' ? o.topic.trim() : '', near: Number.isFinite(near) ? Math.max(0, Math.min(1, near)) : 0 }
  }
  catch {
    return undefined // 不是合法 JSON：这句当不相关
  }
}

/** 第一个配平的 JSON 对象，容忍外层多余文字与代码围栏（与 memory / mind-default 同法） */
function extractJson(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0)
    return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc)
        esc = false
      else if (c === '\\')
        esc = true
      else if (c === '"')
        inStr = false
    }
    else if (c === '"') {
      inStr = true
    }
    else if (c === '{') {
      depth++
    }
    else if (c === '}') {
      depth--
      if (!depth)
        return text.slice(start, i + 1)
    }
  }
  return undefined
}
