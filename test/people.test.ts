import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HistoryTurn } from '../src/index.ts'
import type { PeopleDeps } from '../plugins/official/group-policy/people.ts'
import { peopleLines, peopleSection, renderPeople } from '../plugins/official/group-policy/people.ts'
import { mergeWindow } from '../plugins/official/group-policy/reading.ts'
import type { Entry } from '../plugins/official/group-policy/rooms.ts'
import { SELF } from '../plugins/official/group-policy/rooms.ts'
import type { TemperStatus } from '../plugins/official/group-policy/temper.ts'

const G = 'qq:group:1'
const NOW = 10_000_000

const other = (at: number, who: string, text: string, channel = G): HistoryTurn =>
  ({ role: 'other', text, at, channel, kind: 'group.message', sender: { id: who, name: who } })
const self = (at: number, text: string, channel = G): HistoryTurn => ({ role: 'self', text, at, channel, kind: 'utterance' })
const entry = (t: HistoryTurn, direct = false): Entry =>
  t.role === 'self' ? { at: t.at, who: SELF, text: t.text } : { at: t.at, who: String(t.sender!.id), name: t.sender!.name, text: t.text, direct }

const calm: TemperStatus = { key: '', name: '', value: 0, level: '一般', why: [], todayAts: 0, recentAts: 0, decision: undefined, lastAt: 0 }

function deps(entries: Entry[], o: Partial<PeopleDeps> = {}): PeopleDeps {
  return {
    entries: () => entries,
    isOwner: () => false,
    isBot: () => false,
    inConvo: () => false,
    temper: () => calm,
    names: async () => ['沐沐'],
    ...o,
  }
}

test('在场的人：窗口里出现的人各一行，带身份标记、@ 次数，窗口里没带上的更早的话', async () => {
  // 阿哲 8 分钟前说要去成都，之后群里刷了一堆闲聊，窗口里只剩他最后那句
  const all: HistoryTurn[] = [
    other(NOW - 9 * 60_000, '阿哲', '@沐沐 在吗'),
    self(NOW - 8.9 * 60_000, '在呀'),
    other(NOW - 8 * 60_000, '阿哲', '我周三要去成都出差，第一次去'),
    self(NOW - 7.9 * 60_000, '成都好吃的多，记得吃火锅'),
    other(NOW - 7.5 * 60_000, '阿哲', '[表情]'),
    ...Array.from({ length: 20 }, (_, i) => other(NOW - (7 - i * 0.3) * 60_000, ['小林', '糖糖', '老王'][i % 3], `闲聊 ${i}`)),
    other(NOW - 30_000, '阿哲', '@沐沐 还记得我周三去哪吗'),
  ]
  const window = all.slice(-16)
  const entries = all.map(t => entry(t, t.text.startsWith('@沐沐')))
  const lines = await peopleLines(G, window, deps(entries, {
    isOwner: key => key === 'qq:老王',
    inConvo: (_ch, who) => who === '阿哲',
  }), { peopleWindowSec: 1800, earlier: 2 }, NOW)

  assert.equal(lines[0]?.startsWith('- 阿哲（正在和你聊）'), true, `最后说话的排第一：${lines[0]}`)
  assert.match(lines[0]!, /@ \/ 叫过你 2 次/)
  assert.match(lines[0]!, /窗口里没带上的他还说过：「我周三要去成都出差，第一次去」/)
  assert.doesNotMatch(lines[0]!, /\[表情\]/, '纯表情不算说过的事')
  assert.doesNotMatch(lines[0]!, /在吗/, '@ 她那句是打招呼，但也在窗口外——只带最近 earlier 条，成都那句更近')
  const wang = lines.find(l => l.startsWith('- 老王'))
  assert.match(wang!, /（主人）/)
  assert.match(wang!, /说了 6 句/)
  assert.match(wang!, /窗口里没带上的他还说过：「闲聊 2」/, '老王只有最早那句掉在窗口外')
  assert.doesNotMatch(wang!, /闲聊 5/, '窗口里有的不重复列')
  assert.equal(lines.length, 4, '没有网名就没有「你自己」那行')
})

test('在场的人：机器人、她正不理的人、让她烦的人都标出来；给大脑按群分组，给发言者是一段', async () => {
  const window = [other(NOW - 20_000, '机器君', '签到成功'), other(NOW - 10_000, '阿哲', '哈哈'), other(NOW - 5_000, '老王', '滚')]
  const entries = window.map(t => entry(t))
  const d = deps(entries, {
    isBot: (_ch, who) => who === '机器君',
    temper: key => key === 'qq:老王'
      ? { ...calm, level: '很烦', decision: { key, name: '老王', mode: 'ignore', until: NOW + 60_000, why: '老骂人', at: NOW } }
      : key === 'qq:阿哲' ? { ...calm, level: '有点烦' } : calm,
  })
  const block = await renderPeople([{ channel: G, window }], d, {}, NOW)
  assert.match(block, /^【群里在说话的人】/)
  assert.match(block, /群 1：/)
  assert.match(block, /- 机器君（机器人）/)
  assert.match(block, /- 阿哲（你对他有点烦）/)
  assert.match(block, /- 老王（你正在不理他）/)

  const s = await peopleSection(G, window, d, {}, NOW)
  assert.equal(s?.id, 'group-people')
  assert.match(await s!.render(), /^【在场的人】/)
  assert.equal(await renderPeople([{ channel: G, window: [self(NOW, '只有我')] }], d, {}, NOW), '', '窗口里没有别人就没有这块')
  assert.equal(await peopleSection(G, [], d, {}, NOW), undefined)
})

test('在场的人：第一行是她自己的网名；机器人那行写它刚说什么、群友怎么冲它说、它的叫法（真群甲「小鱼」是条鱼）', async () => {
  const all: HistoryTurn[] = [
    other(NOW - 90_000, '灰灰子', '我去 哪来的鱼'),
    other(NOW - 85_000, '小鱼', '[回复 黑猫璨「[表情包：天青色瞪眼鱼]」] 这画的是我吧'),
    other(NOW - 84_000, '小鱼', '……天青色瞪眼鱼 谁给起的外号'),
    other(NOW - 70_000, '灰灰子', '@小鱼 叫主人'),
    other(NOW - 66_000, '小鱼', '主人？我这条鱼是野生的'),
    other(NOW - 50_000, '多瑙河畔的花园', '@小鱼 大肥鱼，帮我打战争雷霆'),
    other(NOW - 45_000, '小鱼', '我连鼠标都摸不着 怎么替你打'),
    other(NOW - 44_000, '小鱼', '[表情包：鲸鱼]'),
    other(NOW - 30_000, '灰灰子', '这鱼怎么感觉没那么聪明'),
  ]
  const d = deps(all.map(t => entry(t)), { isBot: (_ch, who) => who === '小鱼', names: async () => ['沐沐', '沐沐小号'] })
  const lines = await peopleLines(G, all, d, {}, NOW)
  assert.equal(lines[0], '- 你自己：网名叫「沐沐小号」，群友写这个名字（@ 或者直接提到）就是在说你，不是别人')
  const fish = lines.find(l => l.startsWith('- 小鱼（机器人）'))!
  assert.match(fish, /它刚说：「……天青色瞪眼鱼 谁给起的外号」「主人？我这条鱼是野生的」「我连鼠标都摸不着 怎么替你打」/, `最近三句、去掉引用与纯表情：${fish}`)
  assert.match(fish, /群友冲它说过：「叫主人」「大肥鱼，帮我打战争雷霆」/, `@ 它的话去掉 @：${fish}`)
  assert.match(fish, /群友说的「鱼」、它的外号、它自称的东西，多半是在说它，不是你/, `叫法从它名字里它自己也用的字来：${fish}`)
})

test('合并窗口：只换掉那个群的历史，别的频道照旧，按时间排回去', () => {
  const history = [other(1, 'a', '私聊 1', 'qq:private:a'), other(2, '小林', '群 旧'), self(3, '群 她', G), other(4, 'a', '私聊 2', 'qq:private:a')]
  const window = [other(0, '阿哲', '更早的群消息'), other(2, '小林', '群 旧'), self(3, '群 她', G), other(5, '糖糖', '群 新')]
  const merged = mergeWindow(history, G, window)
  assert.deepEqual(merged.map(t => t.text), ['更早的群消息', '私聊 1', '群 旧', '群 她', '私聊 2', '群 新'])
})
