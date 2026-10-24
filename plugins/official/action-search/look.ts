/**
 * 发图前看一眼：搜来的图交看图模型（vision.read）一句话说图里是什么、能不能发到群里。
 *
 * 输出 JSON，用 JSON.parse 读，不用正则抠（handbook §9.2）。看不了（模型挂了、超时、没按 JSON 回）返回 undefined：
 * 调用方标「没看过」照常列出——找图是对方要的，宁可让大脑知道「没看过」再自己定，也不整次作废。
 * 多模态数组的类型断言同 stickers/review.ts：内核 ChatMessage.content 声明是 string，provider 原样转发。
 */
import type { ChatMessage, ModelRequest } from '../../../src/index.ts'
import type { Look } from './search.ts'

export const LOOK_RULES = ['色情、擦边、裸露', '血腥、恐怖、惊悚', '带二维码、广告、联系方式', '政治人物或敏感时事', '普通人的私人照片']

export function lookPrompt(query: string, rules: string[] = LOOK_RULES): string {
  return `这是按「${query}」从网上搜到的一张图，准备发到聊天群里。看图后只输出一个 JSON 对象，不要解释：
{"desc":"…","fit":true,"ok":true,"why":""}
- desc：一句话（不超过 25 字）说图里是什么，有字就带上字。
- fit：图和「${query}」对不对得上（搜的东西在图里）。
- ok：沾上下面任何一条就是 false，拿不准也算沾上：
${rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}
- why：ok 为 false 时一句话说原因。`
}

export function parseLook(text: string): Look | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (typeof j.ok !== 'boolean')
      return undefined
    return {
      ok: j.ok,
      desc: typeof j.desc === 'string' && j.desc.trim() ? j.desc.trim().slice(0, 60) : undefined,
      ...(typeof j.fit === 'boolean' ? { fit: j.fit } : {}),
      why: typeof j.why === 'string' ? j.why : undefined,
    }
  }
  catch {
    return undefined // 不是合法 JSON：按「没看过」处理，见文件头
  }
}

export async function look(
  complete: (req: ModelRequest) => Promise<string>,
  query: string,
  bytes: Buffer,
  mime: string,
  signal: AbortSignal,
  rules?: string[],
): Promise<Look | undefined> {
  const content = [
    { type: 'text', text: lookPrompt(query, rules) },
    { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } },
  ]
  const messages = [{ role: 'user', content }] as unknown as ChatMessage[]
  try {
    return parseLook(await complete({ role: 'vision.read', messages, signal }))
  }
  catch (e) {
    console.warn('[action-search] 看图失败:', e instanceof Error ? e.message : e)
    return undefined
  }
}
