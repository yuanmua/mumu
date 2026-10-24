/**
 * 上下文够长 + 群里的人带上下文（group-policy reading.ts / people.ts、memory 召回范围，2026-10-22）：
 * 上下文要足够长，群里的人物也要带上下文。
 * - context-recall：阿哲和她聊着说了句自己的事（没 @），之后群里慢慢刷了二十来句闲聊、小林 @ 她两次她都答了；
 *   阿哲再 @ 问「还记得我周三去哪吗」——改前发言者只读最近 16 条 + 她最后 2 次开口的上下文，成都那句早被挤出去，
 *   她答不上；现在窗口读 30 条，且【在场的人】里写着阿哲「窗口里没带上的他还说过：『我周三要去成都出差…』」。
 */
import type { Scene, Step } from './scenes.ts'

const say = (who: string, text: string, after: number, extra: Partial<Step> = {}): Step => ({ who, text, after, ...extra } as Step)

// 二十句闲聊，三个人轮流，每句隔 8～10 秒（一分钟不到 6 句，不算「热闹」，走 recent 条数）
const CHATTER: [string, string][] = [
  ['糖糖', '今天地铁好挤'], ['老王', '早高峰都这样'], ['七七', '我骑车来的，风大'], ['糖糖', '中午吃啥'], ['老王', '楼下新开了家面馆'],
  ['七七', '面馆贵不贵'], ['糖糖', '二十多一碗吧'], ['老王', '还行'], ['七七', '下午又要开会'], ['糖糖', '开会开会，烦'],
  ['老王', '周五交周报'], ['七七', '我周报还没写'], ['糖糖', '摸鱼写呗'], ['老王', '哈哈'], ['七七', '晚上有人打游戏吗'],
  ['糖糖', '我要加班'], ['老王', '可以，几点'], ['七七', '九点吧'], ['糖糖', '你们玩，我看着'], ['老王', '行'],
]

export const CONTEXT_SCENES: Scene[] = [
  {
    id: 'context-recall',
    title: '阿哲聊着时说了句要去成都（没 @），刷了二十句闲聊、她另答了两次 @ 之后，阿哲再问「还记得我去哪吗」她答得上',
    group: 900180,
    manual: true,
    settleMs: 40_000,
    steps: [
      { config: { timeRules: [], busyActions: [] } },
      { who: '阿哲', text: '在吗', at: true, after: 0 },
      say('阿哲', '我下周三要去成都出差，第一次去，有点紧张', 3000, { react: 40_000 }), // 正在和她聊：不 @ 也叫醒
      say('阿哲', '就待两天', 3000, { react: 40_000 }),
      ...CHATTER.map(([who, text], i) => say(who, text, i % 2 ? 8000 : 10_000)),
      { who: '小林', text: '你中午吃了没', at: true, after: 8000 }, // 她另外开口两次：改前「她最后 2 次开口的上下文」就全是小林的
      { who: '小林', text: '那你一般几点吃', at: true, after: 3000, react: 40_000 },
      { who: '阿哲', text: '你还记得我下周三要去哪出差吗', at: true, after: 8000, react: 40_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const ask = ins.findIndex(i => i.text.includes('去哪出差'))
      const trip = ins.findIndex(i => i.text.includes('成都出差'))
      return [
        t.expect(t.answered(0, 30_000), '第一句 @ 答了'),
        t.expect(t.answered(trip, 45_000), '聊着时说的「去成都出差」没 @ 也接了'),
        t.expect(t.answered(ask, 45_000), '最后那句 @ 答了'),
        t.expect(t.saidAfter(ask, /成都/), `答出了「成都」（她说的：${t.outText().slice(-2).join(' / ') || '（没回）'}）`),
        t.note(`闲聊 ${CHATTER.length} 句 + 小林两次 @，成都那句离最后一问隔了 ${ask - trip} 条`),
      ]
    },
  },
]
