/**
 * 大脑一拍的材料怎么摆（纯函数，单测直接测）。
 *
 * 为什么讲究摆法：每条消息都先到大脑（大脑门控），这一拍的延迟就是她开口前的等待。
 * - system：不变的规则 + 动作目录放最前，模型的前缀缓存才命中；mind 受众段落里有【现在】这种
 *   每拍都变的（带到秒），原来排在 system 第十来行，后面的规则全部缓存不上。
 * - user：此刻的状态。【最近对话】是内核给的全频道历史（群里的那几条由 group-policy 换成阅读窗口），
 *   每一拍都带全。门控上线时曾给「只因刚到的消息而开的拍」做过精简材料（只带本频道近几条、跳过几块），
 *   实测只比完整拍快 12ms，却让她在私聊里答不上「今天加的群感觉怎么样」——同日撤销（handbook §9.3），
 *   不留开关：要的是「越像人越好」，人回想近况时就是各处混在一起的。
 */
import type { BeatMaterial, HistoryTurn, WakeReason } from '../../../src/index.ts'
import { MAIN_CHANNEL, renderNotes } from '../../../src/index.ts'
import type { ImageMessage } from '../provider-openai/index.ts'
import type { InlinedTurn } from '../surface-onebot/index.ts'

export interface RenderOptions {
  interrupted?: (r: WakeReason) => boolean // 上一拍想到一半被打断、带过来的原因
}

/** 规则与动作目录在前（不变），段落在后（含每拍都变的时间） */
export function systemPrompt(rules: string, m: BeatMaterial): string {
  const catalog = `【可用动作】\n${m.catalog.map(c =>
    `- ${c.name}: ${c.description}${c.paramsHint ? `\n  参数: ${c.paramsHint}` : ''}`,
  ).join('\n')}`
  return [rules, catalog, m.sections].filter(Boolean).join('\n\n')
}

const channelTag = (channel?: string): string =>
  channel && channel !== MAIN_CHANNEL ? `[${channel}] ` : ''

/**
 * self 侧固定称谓「你」；群聊插件给她的话带了 sender.name（她在那个平台的网名）就写成「你（沐沐小号）」——
 * 真群里有人说「不要和沐沐小号聊天」，她不知道那是自己，回「那我跟她自己聊」。other 侧有名用名，无名用 kind 标注
 */
function turnLine(t: HistoryTurn): string {
  const who = t.role === 'self' ? (t.sender?.name ? `你（${t.sender.name}）` : '你') : (t.sender?.name ?? `[${t.kind}]`)
  return `${channelTag(t.channel)}${who}: ${t.text}`
}

/**
 * 内核自己发的唤醒与工作记忆只给短代码（细节在 data.code），说成人话归这里。
 * 文字照内核 1.1 之前它自己拼的原样：大脑规则里「action:reply 完成」认的就是这句，改了她看到的提示词就不是同一个了
 */
const OUTCOME: Record<string, string> = { done: '完成', stopped: '被停止', interrupted: '被中断' }

export function kernelText(text: string, data?: Record<string, unknown>): string {
  switch (data?.code) {
    case 'action-ended':
      return `动作 ${String(data.id)} ${data.outcome === 'error' ? `出错：${String(data.error)}` : OUTCOME[String(data.outcome)] ?? String(data.outcome)}`
    case 'wake-after':
      return '到了自己之前定的时间'
    case 'orphans-interrupted':
      return `上次运行时这些动作被强行中断了：${(data.ids as string[]).join('、')}`
    default:
      return text
  }
}

/** 唤醒原因的呈现，内核只给结构位 */
function reasonLine(r: WakeReason, interrupted: boolean): string {
  const who = r.sender?.name ? `${r.sender.name}：` : ''
  const half = r.partial ? '（话还没说完）' : ''
  const ago = Math.round((Date.now() - r.at) / 1000)
  const carried = interrupted ? '（上一拍想到一半被打断，还没处理）' : ''
  return `- ${channelTag(r.channel)}(${r.source}${ago > 3 ? `，${ago}s 前` : ''})${half}${carried} ${who}${kernelText(r.text, r.data)}`
}

export function renderState(m: BeatMaterial, o: RenderOptions = {}): string {
  const blocks: string[] = []
  blocks.push(`【正在运行】\n${m.running.length
    ? m.running.map(r => `- ${r.id}${channelTag(r.channel)}（${Math.round(r.runningMs / 1000)}s）: ${r.note || '启动中'}`).join('\n')
    : '无'}`)
  if (m.incoming.length) {
    blocks.push(`【对方正在说（还没说完）】\n${m.incoming.map(i =>
      `- ${channelTag(i.channel)}${i.sender?.name ?? `[${i.kind}]`}（已说 ${Math.round(i.elapsedMs / 1000)}s）：${i.text || '（还没出声）'}`,
    ).join('\n')}`)
  }
  if (m.history.length)
    blocks.push(`【最近对话】\n${m.history.map(turnLine).join('\n')}`)
  if (m.notes.length)
    blocks.push(`【工作记忆】\n${renderNotes(m.notes.map(n => ({ ...n, text: kernelText(n.text, n.data) }))).map(s => `- ${s}`).join('\n')}`)
  // 插件贡献的材料（心情、记忆……），本插件不解析内容，按顺序列出
  for (const b of m.blocks)
    blocks.push(b.text)
  blocks.push(`【本次唤醒】\n${m.reasons.map(r => reasonLine(r, !!o.interrupted?.(r))).join('\n')}`)
  return blocks.join('\n\n')
}

/**
 * 最近几张图带原图（surface-onebot 的服务 images 挑的）：【最近对话】是一整段文字，图没法逐条跟在消息后面，
 * 所以占位编了号（[图片1]），原图按编号附在这条消息末尾。同一条消息的描述还出现在【本次唤醒】等处，整段一起换成编号占位，
 * 免得描述和原图打架
 */
export function withImages(state: string, inlined: InlinedTurn[]): ImageMessage {
  const images = inlined.flatMap(t => t.images)
  if (!images.length)
    return { role: 'user', content: state }
  let content = state
  for (const s of inlined.flatMap(t => t.swaps))
    content = content.split(s.from).join(s.to)
  return { role: 'user', content: `${content}\n\n（上面的 ${images.map(i => i.label).join('、')} 是原图，按编号附在下面，照图看。）`, images }
}
