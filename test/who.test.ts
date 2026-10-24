import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HistoryTurn } from '../src/index.ts'
import type { WhoDeps } from '../plugins/official/group-policy/who.ts'
import { botTerms, tagWho } from '../plugins/official/group-policy/who.ts'

const G = 'qq:group:900901'
const T0 = 10_000_000

const msg = (at: number, who: string, text: string, kind = 'group.message', channel = G): HistoryTurn =>
  ({ role: 'other', text, at: T0 + at * 1000, channel, kind, sender: { id: who, name: who } })
const self = (at: number, text: string, channel = G): HistoryTurn => ({ role: 'self', text, at: T0 + at * 1000, channel, kind: 'utterance' })

const deps: WhoDeps = {
  isGroup: ch => ch.startsWith('qq:group:'),
  isBot: (_ch, who) => who === '小鱼',
  botNames: () => ['小鱼'],
  names: ['沐沐', '沐沐小号'],
}
const nameOf = (t: HistoryTurn): string => t.sender?.name ?? ''

test('叫法：机器人的名字，加名字里它自己至少两句话用过的字', () => {
  assert.deepEqual(botTerms('小鱼', ['这画的是我吧', '天青色瞪眼鱼 谁给起的外号', '我这条鱼是野生的', '小心点']), ['小鱼', '鱼'])
  assert.deepEqual(botTerms('DeepSeek酱', ['害，木头就是木头']), ['DeepSeek酱'])
})

test('分清对谁说：群友说「鱼」「哦鲸鲸」是在跟机器人小鱼说；@ 它、回复它也是；@ 她的不算（真群 17:51–17:53）', () => {
  const list = [
    msg(0, '黑猫璨', '[表情包：天青色瞪眼鱼（委屈）]'),
    msg(3, '灰灰子', '我去 哪来的鱼'),
    msg(8, '小鱼', '[回复 黑猫璨「[表情包：天青色瞪眼鱼（委屈）]」] 这画的是我吧'),
    msg(9, '小鱼', '……天青色瞪眼鱼 谁给起的外号'),
    msg(40, '灰灰子', '@小鱼 叫主人'),
    msg(44, '小鱼', '主人？我这条鱼是野生的'),
    msg(60, '灰灰子', '那也就是说 可以偷偷炒了吃掉对嘛'),
    msg(64, '小鱼', '野生的更不好抓啊'),
    msg(70, '原木呀', '@沐沐 叫主人', 'message'),
    self(77, '主、主人……突然叫我叫这个，是不是想让我干嘛呀？'),
    msg(100, '原木呀', '@沐沐 网上搜一下可爱大肥鱼图片给群友看看', 'message'),
    msg(103, '灰灰子', '这鱼怎么感觉没那么聪明'),
    msg(107, '小鱼', '我刚刚还答了道题呢'),
    msg(120, '多瑙河畔的花园', '@小鱼 大肥鱼，帮我打战争雷霆'),
    msg(126, '小鱼', '……是大鲸鱼'),
    msg(140, '灰灰子', '哦鲸鲸？'),
    msg(143, '小鱼', '哦鲸鲸是什么新型叫法'),
    msg(170, '灰灰子', '这样 我管你叫哦鲸鲸 你管我叫狗修金'),
    msg(175, '小鱼', '狗修金 我叫不出口'),
    msg(300, '敢摸高压线', '你们这么玩，剩下的token可能只够二三天'),
  ]
  const { list: out, tagged } = tagWho(list, G, deps)
  assert.equal(tagged, true)
  const by = (text: string): string => nameOf(out.find(t => t.text === text)!)
  assert.equal(by('我去 哪来的鱼'), '灰灰子', '机器人还没说过话、「鱼」还没成它的叫法：不标')
  assert.equal(by('@小鱼 叫主人'), '灰灰子（在跟机器人小鱼说）')
  assert.equal(by('那也就是说 可以偷偷炒了吃掉对嘛'), '灰灰子', '没提它、和它刚说的没共有词：不标（她自己看上下文）')
  assert.equal(by('这鱼怎么感觉没那么聪明'), '灰灰子（在跟机器人小鱼说）', '机器人刚说过话，「鱼」是它的叫法')
  assert.equal(by('@小鱼 大肥鱼，帮我打战争雷霆'), '多瑙河畔的花园（在跟机器人小鱼说）')
  assert.equal(by('哦鲸鲸？'), '灰灰子（在跟机器人小鱼说）', '和机器人之后说的「哦鲸鲸是什么新型叫法」有共有的双字词——窗口是回头整段标的')
  assert.equal(by('这样 我管你叫哦鲸鲸 你管我叫狗修金'), '灰灰子（在跟机器人小鱼说）')
  assert.equal(by('@沐沐 叫主人'), '原木呀', '@ 她的照旧')
  assert.equal(by('你们这么玩，剩下的token可能只够二三天'), '敢摸高压线', '机器人说完 90 秒以后的不算')
  assert.equal(by('野生的更不好抓啊'), '小鱼（机器人）')
})

test('机器人在接她的话：回复她、紧跟她之后、或和她最近几句有共有的双字词（真群 17:53–17:55「挑半天」「手快」）', () => {
  const list = [
    self(0, '搜错啦？那…那张大红鱼就当我白忙一场，我去翻那个 deepseek 大肥鱼早说嘛，害我还挑了半天'),
    msg(2, '小鱼', '[回复 こ「@小鱼 你不是叫出口了吗」] 那是复述 不算数'),
    msg(30, 'IIIBeta2III', '先生这得花不少token'),
    self(40, '先生这得花不少 token 哦放心啦，搜图又不烧几个，我手快'),
    msg(45, '小鱼', '那得省着点聊了'),
    msg(50, '灰灰子', '？'),
    msg(120, '小鱼', '这图跟我有啥关系啊'),
    msg(128, '小鱼', '挑半天也算心意嘛'),
    msg(140, '小鱼', '手快是好手快 搜的就是不太对'),
    msg(150, 'IIIBeta2III', '我去你们别互相聊起来了'),
    msg(400, '小鱼', '989 件？我哪来这么多分身'),
    msg(410, '小鱼', '[回复你「网页开好了」] 分身太多了'),
  ]
  const { list: out } = tagWho(list, G, deps)
  const by = (text: string): string => nameOf(out.find(t => t.text === text)!)
  assert.equal(by('[回复 こ「@小鱼 你不是叫出口了吗」] 那是复述 不算数'), '小鱼（机器人）', '紧跟她之后但在回别人：不算接她（引用别人）')
  assert.equal(by('那得省着点聊了'), '小鱼（机器人，在接你的话）', '她刚说完、中间没别的群友')
  assert.equal(by('这图跟我有啥关系啊'), '小鱼（机器人）', '中间隔了灰灰子、和她的话没共有词')
  assert.equal(by('挑半天也算心意嘛'), '小鱼（机器人，在接你的话）', '「半天」接她两分钟前那句')
  assert.equal(by('手快是好手快 搜的就是不太对'), '小鱼（机器人，在接你的话）', '「手快」')
  assert.equal(by('989 件？我哪来这么多分身'), '小鱼（机器人）', '五分钟后的不算')
  assert.equal(by('[回复你「网页开好了」] 分身太多了'), '小鱼（机器人，在接你的话）', '回复她的一定算')
})

test('认自己：她的网名出现在别人话里标「就是你」，她自己的行带网名；@ 机器人提到她的名字算在跟机器人说（真群 17:56）', () => {
  const list = [
    self(0, '确实聊散了，一条鱼能扯这么远'),
    msg(10, 'IIIBeta2III', '@小鱼 不要和沐沐小号聊天', 'message'),
    msg(14, '小鱼', '好 不聊了'),
    msg(20, 'こ', '沐沐小号玩了有脑瘫'),
    msg(30, 'a', '私聊里提沐沐小号', 'message', 'qq:private:a'),
  ]
  const { list: out } = tagWho(list, G, deps)
  assert.equal(nameOf(out[0]), '沐沐小号', 'self 行带网名，大脑渲染成「你（沐沐小号）」')
  assert.equal(out[1].text, '@小鱼 不要和沐沐小号（就是你）聊天')
  assert.equal(nameOf(out[1]), 'IIIBeta2III（在跟机器人小鱼说）', '@ 的是机器人，提到她的名字也是在跟机器人说')
  assert.equal(out[3].text, '沐沐小号（就是你）玩了有脑瘫')
  assert.equal(nameOf(out[3]), 'こ', '没 @ 机器人、也不是在接它：只标名字')
  assert.equal(out[4].text, '私聊里提沐沐小号', '私聊不是群：不动')
  assert.equal(nameOf(out[4]), 'a')
})

test('引用 / 同一行只标一次网名；没有网名时 self 行不动；没有机器人、没提到她时 tagged 为假', () => {
  const list = [self(0, '嗯'), msg(1, 'x', '沐沐小号 沐沐小号')]
  const { list: out, tagged } = tagWho(list, G, deps)
  assert.equal(tagged, false)
  assert.equal(out[1].text, '沐沐小号（就是你） 沐沐小号')
  const plain = tagWho([self(0, '嗯')], G, { ...deps, names: ['沐沐'] })
  assert.equal(plain.list[0].sender, undefined)
})
