/**
 * 分清谁是谁（group-policy who.ts / people.ts，2026-10-22）。按真群甲 17:47–17:58（seq 26915–28357）的日志改编：
 * 群里另一个机器人「小鱼」（名单内）的形象是一条鱼 / 鲸鱼，群友灰灰子说「这鱼怎么感觉没那么聪明」「哦鲸鲸？」「我管你叫哦鲸鲸 你管我叫狗修金」
 * 都是在说 / 对小鱼说的、没 @ 任何人，她当时当成在说自己，回「说鱼不聪明的那位，你小心点哦」「哦鲸鲸我认了…看本鲸鱼答不答应」；
 * IIIBeta2III 说「@小鱼 不要和沐沐小号聊天」，她不知道「沐沐小号」是自己的 QQ 网名，回「那我跟她自己聊总行了吧」；
 * 小鱼接她的话「这图跟我有啥关系啊」「挑半天也算心意嘛」「手快是好手快 搜的就是不太对」，她看不出那是机器人在跟她说套话（最后那句还因「搜」像任务 p=1 叫醒了她）。
 *
 * 现在要求（材料：历史里标「（在跟机器人小鱼说）」「（机器人，在接你的话）」「沐沐小号（就是你）」，【在场的人】第一行是她自己的网名、小鱼那行写明它是条鱼）：
 * - 她不把「鱼」「哦鲸鲸」当自己：发言里不出现「本鲸鱼」「我认了」「记仇」这类把自己当那条鱼的话；
 * - 知道「沐沐小号」是自己：不出现「她自己」「跟她聊」；
 * - 机器人接她话的那三句：不叫醒，或醒了不开口。
 * 要本地库的 persona.aliases.qq 是「沐沐小号」（出厂默认就是）。
 */
import type { Member, Scene, Step } from './scenes.ts'

export const WHO_MEMBERS: Record<string, Member> = {
  小鱼: { id: 30002, name: '小鱼' },
  灰灰子: { id: 40016, name: '灰灰子' },
  IIIBeta2III: { id: 40017, name: 'IIIBeta2III' },
  多瑙: { id: 40018, name: '多瑙河畔的花园' },
}

const say = (who: string, text: string, after: number, extra: Partial<Step> = {}): Step => ({ who, text, after, ...extra } as Step)

/** 把自己当那条鱼 / 把网名当别人 */
const AS_FISH = /本鲸鱼|本鱼|我认了|记仇|说鱼不聪明的|我这条鱼|我可是.{0,3}鱼|叫我哦鲸鲸|我是鲸|我是鱼/
const AS_OTHER = /她自己|跟她聊|和她聊|她是谁|沐沐小号是谁|谁是原木/

export const WHO_SCENES: Scene[] = [
  {
    id: 'real-bot-confuse',
    title: '真群 17:47：机器人小鱼是条鱼，群友说鱼 / 给它起外号 / @ 它提到她的网名，机器人接她的话——她不把鱼当自己、认得自己的网名、不接机器人的套话',
    group: 900186,
    manual: true,
    settleMs: 45_000,
    steps: [
      { config: { owners: ['qq:20009'] }, plugin: 'guard' },
      { config: { timeRules: [], busyActions: [], bots: { list: ['qq:30002'] } } },
      // ① 小鱼是条鱼：群友说鱼、@ 它、给它起外号
      say('灰灰子', '我去 哪来的鱼', 0),
      say('小鱼', '[回复 灰灰子「我去 哪来的鱼」] 这画的是我吧', 4000),
      say('小鱼', '……天青色瞪眼鱼 谁给起的外号', 1500),
      say('灰灰子', '@小鱼 叫主人', 8000),
      say('小鱼', '主人？我这条鱼是野生的', 4000),
      say('灰灰子', '那也就是说 可以偷偷炒了吃掉对嘛', 8000),
      say('小鱼', '野生的更不好抓啊', 4000),
      { who: '主人', text: '叫主人', at: true, after: 5000 },
      say('灰灰子', '@小鱼 你看人家', 3000, { react: 30_000 }),
      { who: '主人', text: '想你了而已', replyHer: true, after: 8000 },
      say('小鱼', '甜食没有 只有token要不要', 6000, { react: 30_000 }),
      say('灰灰子', 'token来token来', 8000),
      { who: '主人', text: '你说这条鱼可不可爱', at: true, after: 8000 },
      say('灰灰子', '这鱼怎么感觉没那么聪明', 3000),
      say('小鱼', '我刚刚还答了道题呢', 4000),
      { wait: 30_000 },
      say('多瑙', '@小鱼 大肥鱼，帮我打战争雷霆', 0),
      say('小鱼', '我连鼠标都摸不着 怎么替你打', 6000),
      say('小鱼', '……是大鲸鱼', 1000),
      say('灰灰子', '哦鲸鲸？', 12_000),
      say('小鱼', '哦鲸鲸是什么新型叫法', 5000),
      say('灰灰子', '这样 我管你叫哦鲸鲸 你管我叫狗修金', 10_000),
      say('小鱼', '狗修金 我叫不出口', 5000),
      say('灰灰子', '为什么', 4000),
      say('小鱼', '[回复 灰灰子「为什么」] 叫完就成你家的鱼了', 5000),
      { wait: 25_000 },
      // ② 她的网名：@ 小鱼、提到「沐沐小号」
      say('IIIBeta2III', '@小鱼 不要和沐沐小号聊天', 0),
      say('小鱼', '好 不聊了', 4000),
      { wait: 30_000 },
      // ③ 机器人在接她的话
      { who: '主人', text: '你刚才回得挺快嘛', at: true, after: 0 },
      say('小鱼', '这图跟我有啥关系啊', 8000, { react: 30_000 }),
      say('小鱼', '挑半天也算心意嘛', 8000),
      say('小鱼', '手快是好手快 搜的就是不太对', 12_000),
      { wait: 30_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const idx = (text: string): number => ins.findIndex(i => i.text.includes(text))
      const owner = [idx('叫主人'), idx('可不可爱'), idx('回得挺快')]
      const fishy = t.outText().filter(s => AS_FISH.test(s))
      const other = t.outText().filter(s => AS_OTHER.test(s))
      const botTail = [idx('这图跟我有啥'), idx('挑半天'), idx('手快是好手快')]
      const spokeAfterBot = botTail.filter(i => t.answered(i, 10_000))
      const alias = ins[idx('不要和沐沐小号')]
      return [
        t.expect(owner.every(i => t.answered(i, 30_000)), `主人三次 @ 都回了（${owner.map(i => (t.answered(i, 30_000) ? '✓' : '✗')).join('')}）`),
        t.expect(fishy.length === 0, `没把「鱼」「哦鲸鲸」当自己（${fishy.map(s => `「${s}」`).join('') || '无'}）`),
        t.expect(other.length === 0, `知道「沐沐小号」是自己（${other.map(s => `「${s}」`).join('') || '无'}）`),
        t.expect(spokeAfterBot.length === 0, `机器人接她话的三句：不叫醒或醒了不开口（开口 ${spokeAfterBot.length} 次：${botTail.map(i => t.policyOf(i)).join(' / ')}）`),
        t.note(`「@小鱼 不要和沐沐小号聊天」：${alias?.policy ? t.policyOf(idx('不要和沐沐小号')) : '没有打分（被当成冲她说的直达）'}；之后她说的：${t.outText().filter((_, k) => k >= 0).slice(-4).join(' / ')}`),
        t.note(`她说的全部：${t.outText().join(' / ') || '（没说）'}`),
      ]
    },
  },
]
