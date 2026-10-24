/**
 * 工具 look：截一张屏（或取她电脑里的一张图），交给 vision.read 角色回答一个问题，换成文字观察。
 *
 * 立场：
 * - 决定下一步的 task.agent 只收文本；看画面的是另一个角色（vision.read，模型归 provider 绑定）。
 *   所以 look 的产出是一段文字，和别的工具的观察一样进工具循环——不把图塞进 agent 的上下文。
 * - 图在身体服务那边缩成 JPEG 再拿过来：每张图都会随模型请求落日志（I1），PNG 原图会把日志撑爆。
 * - 内核 ChatMessage.content 声明是 string，多模态数组靠 provider-openai 原样转发（与 surface-onebot/vision.ts 同一处断言）。
 */
import type { ChatMessage, Ctx } from '../../../src/index.ts'
import type { BodyClient } from './body.ts'

const PROMPT = '你在帮一个正在操作电脑的助手看图。先回答它的问题，再用一两句话补充画面里和问题相关的要点（窗口、按钮、文字、数字、局面）。'
  + '看不清或没有的就直说，不要编。只输出中文平文本，不超过 200 字。'

export interface LookResult {
  text: string // 交回工具循环的文字观察
  image?: { bytes: Buffer, mime: string } // 看的那张图，agent 留作这一步的截图，不必再截一次
}

export async function look(ctx: Ctx, body: BodyClient, args: Record<string, unknown>, signal: AbortSignal): Promise<LookResult> {
  const question = String(args.question ?? '').trim() || '屏幕上现在是什么情况？'
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  const img = await body.image(path || undefined, signal)
  if ('error' in img)
    return { text: `出错：${img.error}` }
  const content = [
    { type: 'text', text: `${PROMPT}\n\n${path ? `这是她电脑里的图片 ${path}。` : '这是她电脑屏幕的截图。'}问题：${question}` },
    { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.bytes.toString('base64')}` } },
  ]
  const messages = [{ role: 'user', content }] as unknown as ChatMessage[]
  const text = (await ctx.model.complete({ role: 'vision.read', messages, signal })).trim()
  return {
    text: text ? `【看到的】${text}` : '看图模型没有回答（可能它不支持图片），换 ui_tree / browser read 读文字',
    image: img,
  }
}
