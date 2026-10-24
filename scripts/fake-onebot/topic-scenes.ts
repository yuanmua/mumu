/**
 * 话题吸引力（group-policy judge.ts）：话题不像是要聊的就不聊，可以一直无视，直到出现一个真实的话题。
 * boring-rocket：一长段无聊灌水（加速：两小时的量压成几分钟，每句隔 3.5 秒，不触发全群刷屏）她一句不说；
 * 中间有人聊火箭发射（她的兴趣）她才进来聊几句；之后又是灌水，她退出。
 */
import type { Scene, Step } from './scenes.ts'

const WHO = ['小林', '阿哲', '糖糖', '老王', '七七']
const BORING = [
  '6', '草', '哈哈哈', '在吗', '吃了吗', '今天好热', '上班好累', '摸鱼中', '+1', '哈哈', '下午开会', '外卖到了',
  '困死了', '又要加班', '周五了', '下雨了', '地铁好挤', // 别放奶茶、猫这类：那是她的兴趣（interests 插件），不算无聊 '我先下了', '回来了', '真的假的', '笑死', '好家伙',
  '中午吃啥', '随便', '不知道', '有道理', '确实', '1', '在', '嗯嗯',
]
const ROCKET = [
  ['小林', '你们看今晚长征五号发射的直播没'],
  ['阿哲', '看了，火箭升空那一下太震撼了'],
  ['糖糖', '火箭这次是送什么卫星上去的？'],
  ['小林', '好像是个通信卫星，后面还有一次星舰试飞'],
  ['老王', '星舰那个火箭回收能成吗？上次就差一点'],
]

const say = (who: string, text: string, after: number): Step => ({ who, text, after })
const boring = (n: number, from: number): Step[] => Array.from({ length: n }, (_, i) => say(WHO[(i + from) % WHO.length], BORING[(i + from) % BORING.length], 3500))

export const TOPIC_SCENES: Scene[] = [
  {
    id: 'boring-rocket',
    title: '一长段无聊灌水她一句不说；中间聊火箭发射她才进来聊几句，之后又不说了',
    group: 900901,
    settleMs: 240_000,
    steps: [
      { config: { timeRules: [], busyActions: [] } },
      ...boring(40, 0),
      ...ROCKET.map(([who, text]) => say(who, text, 5000)),
      { wait: 25_000 },
      ...boring(30, 7),
    ],
    check: (t) => {
      const ins = t.inbound()
      const r0 = ins.findIndex(i => i.text.includes('长征五号'))
      const r1 = r0 + ROCKET.length
      const before = t.startsBetween(0, r0)
      const during = t.startsBetween(r0, r1 + 2)
      const after = t.startsBetween(r1 + 4, 999)
      const boringP = ins.slice(0, r0).map(i => i.policy?.p ?? 0)
      const rocketP = ins.slice(r0, r1).map(i => i.policy?.p ?? 0)
      const avg = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
      return [
        t.expect(before === 0, `前面 ${r0} 句灌水她开口 ${before} 次（应为 0）`),
        t.expect(during >= 1, `聊火箭那段她进来说了 ${during} 次（≥1）`),
        t.expect(after <= 1, `后面 30 句灌水她开口 ${after} 次（≤1）`),
        // 原来要 ×5：那时正在和她聊的人直通 p=1 把火箭段的平均抬高了；并进「在聊」打分（起点 0.3～0.6、按轮衰减）后看 ×3。
        // 2026-10-23 兴趣从「抬到 0.6 × 分」改成乘法 × (1 + k × 感兴趣程度)（k 1.5，同一状态下最多 ×2.5），×3 在新设计下做不到，改看 ×2
        // （第一次跑：火箭段 0.164、灌水 0.072，×2.3）
        t.expect(avg(rocketP) > avg(boringP) * 2, `话题吸引力：火箭那段平均接话概率 ${avg(rocketP).toFixed(3)}，灌水 ${avg(boringP).toFixed(3)}（前者 > 后者 × 2）`),
        t.note(`火箭那段：${[r0, r0 + 1, r0 + 2].map(i => t.policyOf(i)).join(' / ')}`),
      ]
    },
  },
]
