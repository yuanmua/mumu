/**
 * 到点换活动时让她自己选：一次很短的模型调用（默认角色 mind.decide，绑在本地模型上，便宜）。
 * 给她时段、候选活动（带几条平时的样子）、刚才在干嘛、心情、最近做过 / 吃过什么、刚才聊了什么，
 * 她选一个并补一句具体在干嘛。输出 JSON 用 JSON.parse 读（handbook §9.2）；选的不在候选里、解析不了就退回抽签。
 */
import type { ChatMessage, ModelRequest } from '../../../src/index.ts'

export interface Option {
  name: string
  details: string[] // 平时的样子，只是参考
  liked: string[] // 其中碰到她兴趣的
}

export interface ChooseInput {
  when: string // 「周三 12:05，午饭时间（工作日）」
  now?: string // 「犯困（躺床上赖着不想动），09:40 起」
  mood?: string
  recent: string[] // 「昨天 18:02 吃饭：在吃火锅」
  chat: string[] // 最近几句对话
  options: Option[]
}

export interface Choice {
  activity: string
  detail: string
  minutes?: number
  thought: string
}

export function buildPrompt(persona: string, inp: ChooseInput): ChatMessage[] {
  const system = `${persona ? `${persona}\n\n` : ''}现在要决定你接下来干点什么。像真人一样：看看时间、心情、刚才在干嘛、最近做过 / 吃过什么，顺着自己的性子从候选里挑一件，再说具体在干嘛（可以不照着「平时的样子」，自己想一个更具体的，别和最近的重样）。
只输出一个 JSON 对象，不要代码块，不要解释：
{"activity":"候选里的一个名字","detail":"具体在干嘛，15 字以内","minutes":30,"thought":"你心里怎么想的，一句口语"}`
  const lines = [
    `现在：${inp.when}`,
    inp.now ? `你刚才在：${inp.now}` : '',
    inp.mood ? `心情：${inp.mood}` : '',
    inp.recent.length ? `最近做过：\n${inp.recent.map(s => `- ${s}`).join('\n')}` : '',
    inp.chat.length ? `刚才聊的：\n${inp.chat.map(s => `- ${s}`).join('\n')}` : '',
    `候选（后面是平时的样子）：\n${inp.options.map(o =>
      `- ${o.name}：${o.details.join(' / ') || '（随你）'}${o.liked.length ? `（你喜欢的：${o.liked.join('、')}）` : ''}`,
    ).join('\n')}`,
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.filter(Boolean).join('\n\n') },
  ]
}

export async function choose(complete: (req: ModelRequest) => Promise<string>, req: Omit<ModelRequest, 'messages'>, messages: ChatMessage[], names: string[]): Promise<Choice | undefined> {
  const first = await complete({ ...req, messages })
  const a = parseChoice(first, names)
  if (a)
    return a
  const retry = await complete({
    ...req,
    messages: [...messages, { role: 'assistant', content: first }, { role: 'user', content: `上面的输出不对：只输出一个 JSON 对象，activity 必须是这几个之一：${names.join('、')}。` }],
  })
  return parseChoice(retry, names)
}

export function parseChoice(text: string, names: string[]): Choice | undefined {
  const json = extractJson(text)
  if (!json)
    return undefined
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    const activity = typeof o.activity === 'string' ? o.activity.trim() : ''
    if (!names.includes(activity))
      return undefined
    const minutes = typeof o.minutes === 'number' && o.minutes > 0 ? Math.round(o.minutes) : undefined
    const clip = (v: unknown, n: number): string => typeof v === 'string' ? [...v.trim()].slice(0, n).join('') : ''
    return { activity, detail: clip(o.detail, 30), minutes, thought: clip(o.thought, 80) }
  }
  catch {
    return undefined // 不是合法 JSON：调用方重试或退回抽签
  }
}

/** 第一个配平的 JSON 对象，容忍外层多余文字与代码围栏（与 interests / memory / mind-default 同法） */
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
