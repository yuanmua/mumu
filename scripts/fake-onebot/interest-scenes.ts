/**
 * 她自己的兴趣表（plugins/official/interests）：投入地聊了几次的新话题会自己进表，之后再聊到它打分明显高。
 *
 * - interest-learn（点名才跑：会写兴趣表）：七七私聊她分三次聊摄影，每次之间等她「聊完一段」（settleSec 临时调到 20 秒），
 *   然后看表里有没有「摄影」、再给「摄影的话」和「无关的话」各打一次分。settleSec 临时调到 15 秒，每轮之后等 60 秒。
 *   私聊频道是固定的（qq:private:七七的号），兴趣表也不清——重跑时「摄影」可能已经在表里，核对只看结果。
 */
import type { Scene, Step } from './scenes.ts'

/**
 * interest-sem：兴趣分是语义相近度，不是关键词包含，也不靠代码做字面匹配（2026-10-23）。
 * 三句不带「火箭」「航天」任何关键词、明明在聊航天的话，要比三句字面带「火箭」、说的却是篮球 / 房价 / 升职的话分高；
 * 同样六句也发进群里，看读空气那边乘上去的系数（why 里的「×1.x」）。不写兴趣表。
 */
const SEM_POS = ['猎鹰九号那个回收你们看了吗', '马斯克那个大筷子又把一级夹住了', '昨晚天宫过境了，好亮的一颗星划过去']
// 别用「火箭少女的新歌」：那是在聊音乐，本来就是她的兴趣（第一次跑就被认成音乐 1.00，认得对）
const SEM_NEG = ['火箭队今晚比赛谁去看', '这房价涨得跟坐火箭似的', '他升职快得跟坐了火箭一样']

const to = 'private' as const
const say = (text: string, after = 6000): Step => ({ who: '七七', text, to, after })

/** 三次，一次一个角度；每次她说完、安静过 settleSec 才算一段 */
const ROUNDS: string[][] = [
  ['沐沐，我最近迷上摄影了！周末去江边拍了日落', '光线超好，就是我不太会构图', '你觉得拍日落是把太阳放中间好还是放边上好'],
  ['我今天又去买了个二手镜头，50mm 定焦的', '拍人像背景虚化超好看，光圈开到 1.8', '你拍过照片吗，喜欢拍什么'],
  ['昨晚去拍夜景了，用三脚架长曝光拍车轨', '快门开了 15 秒，车灯拉成一条条的线', '就是 ISO 调不好老是有噪点，好难啊'],
]

export const INTEREST_SCENES: Scene[] = [
  {
    id: 'interest-learn',
    title: '兴趣·分三次投入地聊摄影 → 兴趣表自己长出「摄影」，打分高于无关话题',
    group: 900300,
    manual: true,
    settleMs: 60_000,
    steps: [
      // 她回得慢（打字节奏），最后一句之后要留够「她说完 + 安静 settleSec + 一次定时检查」，不然两轮会并成一段
      { config: { settleSec: 15 }, plugin: 'interests' },
      ...ROUNDS.flatMap((round): Step[] => [...round.map((t, i) => say(t, i ? 9000 : 1000)), { wait: 60_000 }]),
      { command: '/interests flush' },
      { command: '/interests' },
      { command: '/interests score 我新买了个镜头准备去拍夜景' },
      { command: '/interests score 今天地铁好挤，中午吃了碗面' },
    ],
    check: (t) => {
      const [, table = '', photo = '', plain = ''] = t.commandOut
      const scoreOf = (s: string): number => Number(s.trim().split(/\s+/)[0]) || 0
      const row = table.split('；').find(l => l.trim().startsWith('摄影')) ?? ''
      return [
        t.expect(t.outs.length >= 6, `她在私聊里接了话（${t.outs.length} 条）`),
        t.expect(!!row && !row.includes('候选'), `兴趣表里有「摄影」且已进表：${row.trim() || '（没有）'}`),
        t.expect(scoreOf(photo) >= 0.3 && scoreOf(photo) > scoreOf(plain) + 0.2, `摄影的话 ${scoreOf(photo)} 明显高于无关的话 ${scoreOf(plain)}`),
      ]
    },
  },
  {
    id: 'interest-sem',
    title: '兴趣·语义：没有关键词的航天话比字面带「火箭」的无关话分高',
    group: 900310,
    settleMs: 60_000,
    steps: [
      { config: { timeRules: [], busyActions: [] } },
      // 先打分（同一句第一次可能要等模型加载：先各打一遍预热，第二遍才记）
      ...[...SEM_POS, ...SEM_NEG].map((s): Step => ({ command: `/interests score ${s}` })),
      ...[...SEM_POS, ...SEM_NEG].map((s): Step => ({ command: `/interests score ${s}` })),
      // 再发进群里：无关的先发（她多半不接，不会把后面的变成「在聊」），隔开发
      ...[...SEM_NEG, ...SEM_POS].map((s, i): Step => ({ who: ['小林', '阿哲', '糖糖'][i % 3], text: s, after: 8000 })),
    ],
    check: (t) => {
      const outs = t.commandOut.slice(SEM_POS.length + SEM_NEG.length)
      const scoreOf = (s = ''): number => Number(s.trim().split(/\s+/)[0]) || 0
      const msOf = (s = ''): number => Number(/（(\d+) 毫秒）/.exec(s)?.[1] ?? Number.NaN)
      const pos = outs.slice(0, SEM_POS.length).map(scoreOf)
      const neg = outs.slice(SEM_POS.length).map(scoreOf)
      const avg = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
      const firstMs = t.commandOut.slice(0, SEM_POS.length + SEM_NEG.length).map(msOf).filter(Number.isFinite)
      const ms = outs.map(msOf).filter(Number.isFinite)
      const ins = t.inbound()
      const factor = (i: number): string => /×([\d.]+)/.exec(t.policyReasons(i).find(w => w.includes('感兴趣')) ?? '')?.[1] ?? '1'
      return [
        t.expect(avg(pos) > avg(neg) + 0.1, `没有关键词的航天话平均 ${avg(pos).toFixed(2)}（${pos.join(' / ')}）> 字面带「火箭」的无关话 ${avg(neg).toFixed(2)}（${neg.join(' / ')}）+ 0.1`),
        t.expect(Math.min(...pos) > 0, `三句航天话都认得出（最低 ${Math.min(...pos)}）`),
        t.note(`打分耗时：第一遍（新句子要算向量）${firstMs.join(' / ')} 毫秒；第二遍（缓存）${ms.join(' / ')} 毫秒`),
        t.note(`读空气乘上去的系数：无关 ${SEM_NEG.map((_, i) => factor(i)).join(' / ')}；航天 ${SEM_POS.map((_, i) => factor(SEM_NEG.length + i)).join(' / ')}`),
        t.note(ins.map((_, i) => `${i + 1}. ${t.policyOf(i)}`).join('\n  ')),
      ]
    },
  },
]
