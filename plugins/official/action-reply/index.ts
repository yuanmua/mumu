/**
 * reply 动作：流式发言。
 *
 * 立场：
 * - 这里只定义「输出流可含 marker」这一机制，词汇由 expression / persona 等插件贡献。
 * - 发言者看到的是真实对话（history 原样做 user/assistant 轮次），导演的引导以
 *   「此刻心里想的」放在系统提示尾部，而不是伪装成对方说的话——v1 把「[导演指示] …」
 *   塞进 user 轮次，模型会把它当成对方在下命令，语气立刻变成客服。
 * - 对方没说话而要开口时（补充、主动找话），用一条 `[旁白]` user 轮次给模型一个说话的契机；
 *   persona 教过模型旁白不是对方说的话。
 * - 频道跟随触发它的意图。
 *
 * marker 通道：
 *   emo / act → 原样发给表现端；
 *   br       → Part{kind:'break'}，表现端据此分成多条消息（像聊天软件）；
 *   tool     → 变成一条感知交给导演并行处理，本流不中断。
 *
 * 可改点 `reply/prompt`（waterfall，载荷 ReplyPrompt）：组装提示词前，别的插件按「这次在哪个频道、对谁说」
 * 改读哪段历史（群聊的阅读窗口）、补一次性段落（记忆召回）。段落的 render 不带参数、不知道频道，
 * 所以跟频道有关的材料只能从这里进来。
 */
import type { HistoryTurn, Note, Plugin, Section } from '../../../src/index.ts'
import { MAIN_CHANNEL, PROMPT_ORDER, parseMarkers, renderNotes } from '../../../src/index.ts'
import type { ImageMessage } from '../provider-openai/index.ts'
import type { ImagesService, InlinedTurn } from '../surface-onebot/index.ts'
import type { NewlineMode } from './br.ts'
import { historyBr, normalizeBr, selfSegments } from './br.ts'
import type { ResultConfig } from './report.ts'
import { pendingResult, renderReport } from './report.ts'

interface ReplyConfig {
  historyLimit?: number
  historyPool?: number // 先多取这么多条给 reply/prompt 挑，最后只留 limit 条
  newline?: NewlineMode // 模型输出里的换行怎么算分段（见 br.ts）：all 任何换行 / double 只有空行 / none 不管
  reflexMaxChars?: number // 反射回复最多几个字：到句末标点或分段就收住，超过这么多字硬收
  reflexHint?: string // 反射回复给发言者的一段「随口应一句」；空串 = 不加
  resultKinds?: string[] // 这些感知算「动作结果」：对话里有还没汇报的，下一次带想法的发言就是汇报它
  resultWindowSec?: number // 多久以前的结果不再提
  resultMaxChars?: number // 结果原文摘录多少字
  idleHint?: string // 这个对话里没有在跑的动作时给发言者的一段「别承诺、别编进度」；空串 = 不加
}

/** 反射回复在这些字之后收住：只回一条 */
const REFLEX_STOPS = new Set(['。', '！', '？', '!', '?', '…', '~', '～', '\n'])
const REFLEX_SOFT_STOPS = new Set(['，', ',', ' ', '　'])
const REFLEX_HINT = '【此刻】对方这句很简单，随口应一句就行：只回一条，六个字以内，像「在」「咋了」「嗯？」「来了」。'
  + '别编你刚才在干嘛、在哪、经历了什么，别解释来历，别分段。'
const IDLE_HINT = '【手头】这个对话里你现在没有正在做的事：没在用电脑、没在截图、没在写程序（工作记忆、【手头的活】里没写的就是没有）。'
  + '没开始的事别说「这就去」「马上」「在弄了」「快好了」；有人问进度，就老实说没在做、还没开始或者没接这活，不许编做到哪一步了。'

/** reply/prompt 水线载荷：history 是候选池（按时间），limit 是最后留几条，extras 往里加一次性段落 */
export interface ReplyPrompt {
  actionId: string
  channel: string
  reflex: boolean
  append: boolean
  history: HistoryTurn[]
  limit: number
  extras: Section[]
}

const plugin: Plugin<ReplyConfig> = {
  name: 'action-reply',
  apply(ctx, cfg = {}) {
    const historyLimit = cfg.historyLimit ?? 30
    const historyPool = Math.max(cfg.historyPool ?? 200, historyLimit)
    const newline = cfg.newline ?? 'all'
    const results: ResultConfig = {
      kinds: cfg.resultKinds ?? ['computer.result', 'dsh.result', 'extend.result', 'search.result'],
      windowMs: (cfg.resultWindowSec ?? 600) * 1000,
      maxChars: cfg.resultMaxChars ?? 300,
    }

    /** 工作记忆条目的来源若是动作实例（reply#3、computer#1），它在哪个频道跑；不是动作（kernel、guard）的算全局 */
    const sameChannel = (source: string, channel: string): boolean => {
      if (!source.includes('#'))
        return true
      const running = ctx.actions.snapshot().find(r => r.id === source)
      if (running)
        return (running.channel ?? MAIN_CHANNEL) === channel
      const ev = ctx.log.events.findLast(e => e.type === 'action.started' && e.data?.id === source)
      return !ev || (ev.data.channel ?? MAIN_CHANNEL) === channel
    }

    /** 没有收图的表现端（没装 surface-onebot）就没有原图，全用文字 */
    const inlineImages = (history: HistoryTurn[]): Map<number, InlinedTurn> => {
      try {
        return ctx.use<ImagesService>('images').inline(history)
      }
      catch {
        return new Map() // 服务不在：图只剩文字描述，照常说话
      }
    }

    ctx.effect(() => ctx.actions.register({
      name: 'reply',
      description: '开口说一段话（流式）。只想应一声就用决策里的 quick（脊椎秒回一条短的），不用 start 这个；已有 reply 在跑就不要重复启动。',
      paramsHint: '{"guidance":"你心里想说的方向/要点（第一人称，可省）","append":true 表示补充刚才的发言,"tier":"deep" 表示认真答（换更强的模型，配合 append 用）,"brief":true 表示对方只是简单招呼（在吗、嗯？），只回一条六个字以内的}',
      reloadPolicy: 'abort',
      run: async (a) => {
        const guidance = String(a.params.guidance ?? '').trim()
        const append = Boolean(a.params.append)
        const reflex = Boolean(a.params.reflex)
        // 简短模式：反射回复一律简短；导演回简单招呼时也带 brief（群里的 @ 常由群聊策略交给导演，不走反射）
        const brief = reflex || Boolean(a.params.brief)
        // 认真答：换 performer.deep 角色（绑定在 provider 配置里，通常是更强 / 更贵的模型）。
        // 反射已经用普通模型先开了口，所以导演多半以 append 的形式追加一段认真的回答。
        const deep = a.params.tier === 'deep'
        // 反射单独一个角色：它要的是首字快（适合绑本地），导演发起的回复可以绑更好的模型
        const role = deep ? 'performer.deep' : reflex ? 'performer.reflex' : 'performer'
        a.note(deep ? '正在认真答' : reflex ? '正在回应' : append ? '正在补充刚才的话' : '正在开口')

        const utt = a.utter()
        // 只读不消耗，消耗由 beat 负责。工作记忆是全局的，但来源是某个动作实例的条目（「刚说完：…」「电脑上的事做完了」）
        // 只属于它跑的那个会话：别的会话的放进来，她会在这里复读那边的话（多会话实测：网页 A 的话被她在网页 B 里原样说了一遍）
        const notes = renderNotes(ctx.prompt.notes(false).filter(n => sameChannel(n.source, utt.channel)).map(kernelNote))
        const pool = ctx.log.history({ channel: utt.channel, limit: historyPool })

        // 本次才有的两段（工作记忆、导演引导）作为一次性段落交给组装，走同一套 PROMPT_ORDER，
        // 而不是拼在整段尾部——否则它们会排到「底线」之后，顺序就不统一了
        const extras: Section[] = []
        if (notes.length) {
          extras.push({
            id: 'reply-notes',
            audience: 'performer',
            order: PROMPT_ORDER.memory,
            render: () => `【刚才发生的事】\n${notes.map(s => `- ${s}`).join('\n')}`,
          })
        }
        if (guidance) {
          extras.push({
            id: 'reply-guidance',
            audience: 'performer',
            order: PROMPT_ORDER.thought,
            render: () => `【此刻你心里想的】${guidance}`,
          })
        }
        // 反射只接「不用想」的话（reflex 分流），真人就回「在」「咋了」。不说的话她会回一串，
        // 还给自己编个来历（实测「在吗」→「在呢在呢刚被叫去做题了，脑子还热着」，群友一问导演又解释一遍）
        const reflexHint = cfg.reflexHint ?? REFLEX_HINT
        if (brief && reflexHint) {
          extras.push({ id: 'reply-reflex', audience: 'performer', order: PROMPT_ORDER.thought, render: () => reflexHint })
        }
        // 本对话有还没汇报的动作结果：这次开口就是汇报它（report.ts）。排在时间之后、【要求】之前——
        // 夹在中间的「心里想的」压不过结尾「把握当前话题」和历史最后一条闲话（真群实测）
        const result = brief ? undefined : pendingResult(ctx.log.events, utt.channel, a.id, Date.now(), results)
        if (result)
          extras.push({ id: 'reply-report', audience: 'performer', order: PROMPT_ORDER.time + 10, render: () => renderReport(result, results.maxChars) })
        // 这个对话里没有在跑的动作：没开始的事不许嘴上承诺、不许编进度（快回也算）。真群：「截图看看桌面」反射答「好，我这就去弄」
        // 却什么都没起；被问「实时汇报项目进度」时什么都没在跑，她编「刚建了个文件夹」，被当场拆台。
        // 大脑「应一声 + 起动作」时 reply 排在动作后派发，那时动作已在跑，这段不出现，照常可以说「这就去」
        const idleHint = cfg.idleHint ?? IDLE_HINT
        const busy = ctx.actions.snapshot().some(r => !r.id.startsWith('reply#') && (r.channel ?? MAIN_CHANNEL) === utt.channel)
        if (idleHint && !busy)
          extras.push({ id: 'reply-idle', audience: 'performer', order: PROMPT_ORDER.time + 5, render: () => idleHint })
        // 别的插件按频道改读哪段历史、补段落；没人拦就是最近 limit 条
        const prompt = await ctx.bus.waterfall<ReplyPrompt, ReplyPrompt>('reply/prompt', {
          actionId: a.id,
          channel: utt.channel,
          reflex,
          append,
          history: pool,
          limit: historyLimit,
          extras,
        }, p => p)
        const history = prompt.history.slice(-prompt.limit)
        const system = await ctx.prompt.assemble('performer', prompt.extras)
        // 她分段说出去的话在 delivered 里粘在一起，从日志找回分段位置（见 br.ts）
        const segments = selfSegments(ctx.log.events, history[0]?.at ?? Date.now())
        // 最近几张图以原图跟着那条消息（选图归收图的表现端：服务 images）；快回只求快，不带
        const inlined = reflex ? new Map<number, InlinedTurn>() : inlineImages(history)

        const messages: ImageMessage[] = [
          { role: 'system', content: system },
          ...history.map((t, i) => toMessage(t, newline, segments, inlined.get(i))),
        ]
        // 模型需要一个 user 轮次才会开口；历史以对方结尾时本来不用加——
        // 但大脑写了接谁、接哪句时，念头放在最后一轮才压得过历史末尾那条（全量测试 2026-10-22：guidance「接小林那句吃辣」她说出
        // 「小D酱能不能歇会」、guidance「不理那两个，接小圆圆的暴风雪」她说出「两个人都刷一样的，不腻吗」；
        // 系统提示里再加一段【这次开口】也没用，模型记得最牢的是最后一轮）
        const last = history[history.length - 1]
        const narration: string[] = []
        if (append)
          narration.push('接着你上一句补充一点，衔接着说，别重复已经说过的。')
        else if (!last || last.role === 'self')
          narration.push('对方这会儿没说话。你想到什么就说什么，一两句就好。')
        if (guidance && !brief)
          narration.push(`你此刻心里想的：${guidance}——接谁、接哪句以这个为准，聊天记录最后几条里别人的话不一定是在等你回。`)
        if (narration.length)
          messages.push({ role: 'user', content: `[旁白] ${narration.join(' ')}` })

        try {
          // 模型常把 <|br|> 写成 HTML 的 <br> 或换行：进 parseMarkers 之前归一化（见 br.ts）
          const textStream = normalizeBr(onlyText(ctx.model.stream({ role, messages, signal: utt.signal })), newline)
          let spoke = false // 上次分段之后说过字没有：连着的 <|br|> 只分一次，开头的不分（否则表现端发出空消息）
          // 反射回复只回一条：说出字之后遇到句末标点就收住，分段（<|br|>）也当收尾，超过上限硬收。
          // 提示词里也说了，但模型常照旧回一串；机械收住才稳（不用正则解析，逐字看）。
          // 收住后不再出字、不再分段，但后面的表情 / 表情包标记照发（「好嘞！<|sticker:得意|>」的图不能丢）
          const cap = brief ? Math.max(1, cfg.reflexMaxChars ?? 8) : Infinity
          let said = 0
          let closed = false
          for await (const chunk of parseMarkers(textStream)) {
            if (utt.signal.aborted)
              break
            if (chunk.type === 'text') {
              if (brief) {
                if (closed)
                  continue
                const clip = clipReflex(chunk.text, said, cap)
                said = clip.said
                closed = clip.done
                spoke ||= clip.text.trim() !== ''
                if (clip.text)
                  await utt.write(clip.text)
                continue
              }
              spoke ||= chunk.text.trim() !== ''
              await utt.write(chunk.text)
            }
            else if (chunk.type === 'marker') {
              if (chunk.track === 'tool') {
                // 发言中的工具意图交给导演并行处理。无 sender 故不进历史；非 urgent 故不打断自身。
                void ctx.io.percept({
                  kind: 'performer.tool',
                  channel: utt.channel,
                  text: `发言中想用工具: ${chunk.body}`,
                  data: { body: chunk.body },
                })
              }
              else if (chunk.track === 'br') {
                if (brief && spoke) {
                  closed = true // 反射只回一条
                  continue
                }
                if (spoke)
                  await utt.emit({ kind: 'break' })
                spoke = false
              }
              else {
                await utt.emit({ kind: 'marker', data: { track: chunk.track, value: chunk.body } })
              }
            }
          }
        }
        finally {
          const r = await utt.end()
          if (r.truncated) {
            // 对方打断通常是想说别的：先听对方的，不要把没说完的内容接着讲
            a.remember(
              `你上一句说到一半被对方打断了（原因: ${r.cause}）。对方实际听到的只有：「${r.delivered}」。`
              + `没说出去的那部分（「${r.generated.slice(r.delivered.length).slice(0, 60)}…」）就当没说过，`
              + `别接着讲、别重复、别抱怨；先回应对方现在说的话，除非对方明确让你继续。`,
            )
          }
          else if (r.delivered) {
            a.remember(`刚说完：「${r.delivered.slice(0, 80)}」。别急着再说话，除非确有必要补充。`)
          }
          else {
            a.remember('刚才想说话但一个字都没说出去。')
          }
        }
      },
    }))
  },
}

export default plugin

/** 内核的孤儿提示只给短代码（data.code），说成人话归消费方；文字照内核 1.1 之前它自己拼的原样 */
function kernelNote(n: Note): Note {
  return n.data?.code === 'orphans-interrupted'
    ? { ...n, text: `上次运行时这些动作被强行中断了：${(n.data.ids as string[]).join('、')}` }
    : n
}

/** 历史转模型消息：self 为 assistant，other 为 user，有名则前缀名字；这一轮带原图时，文字用换过占位的、图挂在 images 上 */
function toMessage(t: HistoryTurn, newline: NewlineMode, segments: Map<string, string>, inlined?: InlinedTurn): ImageMessage {
  // 她以前分段说出去的话（分段位置、换行、或归一化之前留下的字面 <br>）写成 <|br|>：示范正确写法，别让她学成换行或粘成一长串
  const text = t.role === 'self' ? historyBr(segments.get(`${t.channel}|${t.at}`) ?? t.text, newline) : inlined?.text ?? t.text
  const content = t.role === 'other' && t.sender?.name ? `${t.sender.name}：${text}` : text
  return { role: t.role === 'self' ? 'assistant' : 'user', content, ...(inlined?.images.length ? { images: inlined.images } : {}) }
}

/**
 * 反射回复逐字收。said = 之前已说出的字数（只数非空白、非标点的字）。
 * 说出过字之后遇到句末标点：带上它收住（换行不带）；够 cap 字硬收。开头的标点、空白不算说出字，免得「…在」被截成「…」。
 */
export function clipReflex(text: string, said: number, cap: number): { text: string, said: number, done: boolean } {
  let out = ''
  for (const ch of text) {
    if (said >= cap)
      return { text: out, said, done: true }
    if (REFLEX_STOPS.has(ch) && said > 0)
      return { text: ch === '\n' ? out : out + ch, said, done: true }
    // 说够三个字后的逗号、空格也收（不带它）：「在呢在呢 刚被叫去做题了」到这里就该停了；「在，咋了」不受影响
    if (REFLEX_SOFT_STOPS.has(ch) && said >= 3)
      return { text: out, said, done: true }
    out += ch
    if (ch.trim() && !REFLEX_STOPS.has(ch) && !REFLEX_SOFT_STOPS.has(ch))
      said++
  }
  return { text: out, said, done: said >= cap }
}

async function* onlyText(source: AsyncIterable<{ type: string, text?: string }>): AsyncGenerator<string> {
  for await (const c of source) {
    if (c.type === 'text' && c.text)
      yield c.text
  }
}
