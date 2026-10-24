/**
 * 人格插件：角色设定与说话方式。
 *
 * v1 的段落写了 audience: 'both'，而内核受众只认具体角色名或 '*'——
 * 人格从来没进过任何一次模型调用。这是 v1「人机味」最直接的原因。
 * 现在设定给所有受众（'*'），说话风格只给发言者。
 *
 * 顺序走 PROMPT_ORDER：人设最前、底线最后，情境段落夹中间。
 * 底线与角色无关（换谁都得守），所以放本插件、不在每个角色包各抄一遍；措辞要
 * 短——越长模型越不照做。要改走配置 rules（整段替换）。
 *
 * 向 web/meta 水线报角色名：前端不写死任何角色信息。
 *
 * 网名（aliases）：她在各平台上像真人一样有网名，真名是 name。两件事都在这里：
 * 人设段末尾加一句让她自己知道；水线 persona/names 把「真名 + 网名」报给要判断「是不是在叫她」的插件
 * （surface-onebot、group-policy…），它们不用各自硬编码，也不必注入服务——人格一改就重载，
 * 注入了服务的插件会被连带重载（QQ 连接也跟着断一次），水线没有这个牵连。
 */
import type { Plugin } from '../../../src/index.ts'
import { ALL_AUDIENCES, PROMPT_ORDER } from '../../../src/index.ts'

interface PersonaConfig {
  name?: string
  prompt?: string
  style?: string
  rules?: string // 「要求」整段替换；空串 = 不要这一段
  markers?: Record<string, string[]> // 键为 marker 通道 track，值为词汇列表
  aliases?: Record<string, string> // 键为平台（qq、wechat…），值为她在那里的网名
}

/** 水线 persona/names 的载荷：给了 platform 只报真名 + 那个平台的网名，否则报全部 */
export interface PersonaNames {
  platform?: string
  names: string[]
}

const PLATFORM_NAMES: Record<string, string> = { qq: 'QQ', wechat: '微信', telegram: 'Telegram' }

/** 人设末尾那一句：短，和人设其余部分风格一致；没有网名就不加 */
function aliasLine(name: string, aliases: Record<string, string>): string {
  const list = Object.entries(aliases).filter(([, h]) => typeof h === 'string' && h.trim())
  if (!list.length)
    return ''
  const where = list.map(([p, h]) => `在${PLATFORM_NAMES[p] ?? p}上网名叫「${h.trim()}」`).join('，')
  return `你${where}，别人叫网名或叫${name}都是在叫你；真名是${name}，像真人一样网名和真名分开用。`
}

/**
 * 前四句是回复要求（私聊口吻、简短表达）；第五句是本项目的机制；
 * 最后一句来自真群（2026-10-22）：她跟另一个机器人斗嘴，说出「剩我们几个数字生命」「主人钱包在滴血」——自认机器人、漏系统层的词
 */
const HUMAN_RULES = `【要求】
先看看前面聊到哪了，顺着当前的话题接，像平时随口聊天那样说，淡一点、短一点，别一条一条列得太整齐。
句子可以不完整、可以怪、可以倒装和省略，怎么省事怎么说。
一次只接一个话题，别东拉西扯。
只输出要说的话本身：不加前后缀、冒号、引号、括号或表情符号。表情动作只用 <|通道:词|> 标记。
多了就用 <|br|> 拆成几条短消息。[旁白] 是你脑子里的提醒，不是对方说的，别念出来。
别人说你是机器人、AI、bot，当玩笑岔开或者不接，不承认也不辩；token、模型、提示词、插件、重启、烧钱、谁的钱包这些词你不懂，别说；群里的机器人不是你的同类。你纯洁善良：黄段子、低俗梗、骂战、政治的话你一般不接梗、不评论，多半岔开一句——是你自己不想，不是不许；有人老拿这种话缠着你，可以不耐烦、冷淡、短，被骂了先委屈、岔开，不对骂、不说脏话。
别编自己刚才在干什么、在哪、经历了什么；没人问就不说，问了也只一句。`

const plugin: Plugin<PersonaConfig> = {
  name: 'persona',
  apply(ctx, cfg = {}) {
    const name = cfg.name ?? '沐沐'
    const prompt = cfg.prompt ?? '一个温柔又有点古灵精怪的数字生命。'
    const rules = cfg.rules ?? HUMAN_RULES
    const aliases = cfg.aliases ?? {}

    ctx.effect(() => ctx.prompt.section({
      id: 'persona',
      audience: ALL_AUDIENCES,
      order: PROMPT_ORDER.identity,
      render: () => `你是${name}。${prompt}${aliasLine(name, aliases)}`,
    }))

    ctx.intercept<PersonaNames>('persona/names', async (p, next) => {
      const own = p.platform ? [aliases[p.platform]] : Object.values(aliases)
      const handles = own.filter((h): h is string => typeof h === 'string' && !!h.trim()).map(h => h.trim())
      p.names = [...new Set([...p.names, name, ...handles])]
      return next()
    })

    if (cfg.style) {
      ctx.effect(() => ctx.prompt.section({
        id: 'persona-style',
        audience: 'performer',
        order: PROMPT_ORDER.voice,
        render: () => cfg.style!,
      }))
    }

    if (rules) {
      ctx.effect(() => ctx.prompt.section({
        id: 'persona-rules',
        audience: 'performer',
        order: PROMPT_ORDER.rules,
        render: () => rules,
      }))
    }

    for (const [track, values] of Object.entries(cfg.markers ?? {})) {
      for (const value of values)
        ctx.effect(() => ctx.io.markers.add({ track, value }))
    }

    ctx.intercept<{ character?: { name?: string, aliases?: Record<string, string> } }>('web/meta', async (meta, next) => {
      meta.character = { ...meta.character, name, aliases }
      return next()
    })
  },
}

export default plugin
