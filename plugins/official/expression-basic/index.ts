/**
 * 表情插件：动作提供 marker 机制，本插件提供词汇与教学。
 *
 * v1 的词只有十个且没有提示，模型要么不用、要么只在开头放一个「开心」。
 * 现在每个词带「什么时候用」，教学段落讲清放置位置（情绪变化那一刻、紧贴那句话），
 * 并把词汇表按通道列出；其他插件（persona、将来的 memory）贡献的词自动纳入，
 * 同名词去重，提示取最先注册的。
 *
 * 词怎么演（映射到 Live2D 表情文件 / 参数 / 动作）不归本插件管——那是表现端模型档案的事。
 */
import type { MarkerDef, Plugin } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'

const BASE: MarkerDef[] = [
  { track: 'emo', value: '开心', hint: '被逗乐、聊到喜欢的东西' },
  { track: 'emo', value: '大笑', hint: '真的很好笑' },
  { track: 'emo', value: '害羞', hint: '被夸、被调侃、说到自己' },
  { track: 'emo', value: '好奇', hint: '对方抛出新东西' },
  { track: 'emo', value: '惊讶', hint: '没想到' },
  { track: 'emo', value: '难过', hint: '听到不好的事、被冷落' },
  { track: 'emo', value: '委屈', hint: '被误会、被凶' },
  { track: 'emo', value: '生气', hint: '假装生气也算' },
  { track: 'emo', value: '无语', hint: '对方说了句废话或冷笑话' },
  { track: 'emo', value: '得意', hint: '猜对了、被认可' },
  { track: 'emo', value: '思考', hint: '认真想一个问题的时候' },
  { track: 'emo', value: '平静', hint: '情绪回落、认真说话' },
  { track: 'emo', value: '困', hint: '深夜、无聊' },
  { track: 'emo', value: '心动', hint: '被温柔到' },
  { track: 'emo', value: '撒娇', hint: '想要点什么、耍赖' },
  { track: 'act', value: '点头', hint: '同意、嗯嗯' },
  { track: 'act', value: '摇头', hint: '不是、不要' },
  { track: 'act', value: '歪头', hint: '疑惑、装可爱' },
  { track: 'act', value: '挥手', hint: '打招呼、再见' },
  { track: 'act', value: '鼓掌', hint: '夸对方' },
  { track: 'act', value: '想了想', hint: '停顿一下再说' },
  { track: 'act', value: '叹气', hint: '无奈' },
  { track: 'act', value: '耸肩', hint: '不知道、随便' },
  { track: 'act', value: '捂脸', hint: '尴尬、害羞到不行' },
  { track: 'act', value: '跳一下', hint: '兴奋' },
]

interface ExpressionConfig {
  perReply?: string // 教学里「一条回复几个」的措辞
}

const plugin: Plugin<ExpressionConfig> = {
  name: 'expression-basic',
  apply(ctx, cfg = {}) {
    for (const def of BASE)
      ctx.effect(() => ctx.io.markers.add(def))

    ctx.effect(() => ctx.prompt.section({
      id: 'expression-teaching',
      audience: 'performer',
      order: PROMPT_ORDER.teaching,
      render: () => {
        const tracks = ctx.io.markerTracks()
        if (!tracks.size)
          return ''
        const lines: string[] = []
        for (const [track, defs] of tracks) {
          const seen = new Map<string, string | undefined>()
          for (const d of defs) {
            if (!seen.has(d.value))
              seen.set(d.value, d.hint)
          }
          const words = [...seen].map(([v, h]) => h ? `${v}（${h}）` : v).join('、')
          lines.push(`- ${track}：${words}`)
        }
        return [
          '【表情与动作】',
          '你有身体。说话时在情绪变化的那一刻、紧贴那句话前面放标记，格式 <|通道:词|>，如「<|emo:害羞|>才、才不是呢」。',
          `一条回复放 ${cfg.perReply ?? '1～3'} 个，不要每句都放，也不要只在开头放一个。只用下面列出的词：`,
          ...lines,
          '长一点的回复用 <|br|> 拆成几条短消息发（像聊天软件那样），一条消息一两句话。就写 <|br|> 这六个字符，不是 HTML 的 <br>。',
        ].join('\n')
      },
    }))
  },
}

export default plugin
