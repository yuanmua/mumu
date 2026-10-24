/**
 * 群聊意愿的两种状态（group-policy judge.ts，2026-10-22）。像人一样：没在聊天状态的时候就少回复一点，看一眼就过去；
 * 在聊天状态就接着多聊几句，而不是机械地都按一个概率。之前为了压频率把 base 压到 0.01、问句要 ≥6 字才加分，
 * 模拟器 flood 里 24 句闲聊大脑一次没醒，真群里只有被 @ 才醒——这里守住：没在聊是「偶尔看一眼」，在聊是「多聊几句」，两者分得开。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { ConvoView } from '../plugins/official/group-policy/convo.ts'
import type { PolicyConfig } from '../plugins/official/group-policy/judge.ts'
import { judge } from '../plugins/official/group-policy/judge.ts'
import type { Entry } from '../plugins/official/group-policy/rooms.ts'
import { SELF } from '../plugins/official/group-policy/rooms.ts'
import { Topics } from '../plugins/official/group-policy/topics.ts'

const defaults = JSON.parse(readFileSync(new URL('../plugins/official/group-policy/package.json', import.meta.url), 'utf8')).mumu.defaults as PolicyConfig
const cfg: PolicyConfig = { ...defaults, timeRules: [] }
const G = 'qq:group:1'
const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }

function room(c: PolicyConfig = cfg) {
  const topics = new Topics(() => c.topic ?? {}, () => {})
  const list: Entry[] = []
  let at = 1_000_000
  return {
    other(who: string, text: string, opts: { after?: number, woke?: boolean, convo?: ConvoView } = {}) {
      at += opts.after ?? 4000
      const e: Entry = { at, who, name: who, text, convo: !!opts.convo }
      list.push(e)
      topics.onOther(G, e)
      const v = judge(c, e, list.slice(0, -1), { ...idle, topic: topics.view(G, e, at), ...(opts.convo ? { convo: opts.convo } : {}) })
      e.woke = opts.woke ?? false
      return v
    },
    self(text: string, after = 4000) {
      at += after
      const replyTo = list.findLast(x => x.who !== SELF)
      const e: Entry = { at, who: SELF, text }
      list.push(e)
      topics.onSelf(G, e, replyTo)
    },
  }
}

test('没在聊：普通一句是「偶尔看一眼」的量级——不是 0，也远低于在聊；灌水 / 复读 / @ 别人仍然很低', () => {
  const r = room()
  const plain = r.other('小林', '周末去吃那家新开的火锅')
  assert.equal(plain.state, 'idle')
  assert.ok(plain.p >= 0.05 && plain.p <= 0.2, `偶尔看一眼：${plain.p}（${plain.why.join('、')}）`)
  const filler = r.other('阿哲', '笑死')
  assert.ok(filler.p <= (cfg.shortChat ?? 0.01), `灌水 ${filler.p}`)
  const rep = r.other('糖糖', '周末去吃那家新开的火锅')
  assert.ok(rep.p <= (cfg.repeat ?? 0.01), `复读 ${rep.p}`)
  const toOther = r.other('老王', '@阿哲 你去不去')
  assert.ok(toOther.p < plain.p, `@ 别人 ${toOther.p} < 普通 ${plain.p}`)
})

test('没在聊：有人在问就往上，长短不限（原来 ≥6 字才算「认真」）；一两个字的问句仍按灌水', () => {
  const r = room()
  const plain = r.other('小林', '今天外卖到得好慢')
  const shortQ = r.other('糖糖', '有人吃过海底捞的番茄锅吗')
  assert.ok(shortQ.p > plain.p, `问句 ${shortQ.p} > 普通 ${plain.p}`)
  const tiny = r.other('老王', '哪家')
  assert.ok(tiny.p <= (cfg.shortChat ?? 0.01), `两个字的问句 ${tiny.p}`)
  const casual = r.other('阿哲', '吃了吗')
  assert.ok(casual.p > plain.p, `「吃了吗」也算有人在问（认不认真交给大脑）：${casual.p}`)
})

test('在聊：她刚说完、别人接她的话，意愿是「多聊几句」的量级，远高于没在聊；接得越多越收着；话题完了回到没在聊', () => {
  const r = room()
  r.other('小林', '周末有人去爬山吗')
  const before = r.other('阿哲', '我想去看日出').p
  r.self('爬山好啊，我也想去看日出')
  const follow = r.other('小林', '那周六早上五点出发？')
  assert.equal(follow.state, 'chatting')
  assert.ok(follow.p >= 0.3, `在聊：${follow.p}（${follow.why.join('、')}）`)
  assert.ok(follow.p > before * 3, `在聊 ${follow.p} 远高于没在聊 ${before}`)
  r.self('五点太早了吧，六点')
  const second = r.other('阿哲', '六点日出都过了，还是五点')
  assert.equal(second.state, 'chatting')
  assert.ok(second.p < follow.p, `接得越多越收着：${second.p} < ${follow.p}`)
  // 话题里的人说了收束句：话题收尾，再碰着旧话题压到 afterClose，别的话回到没在聊
  const closer = r.other('阿哲', '哈哈好')
  assert.ok(closer.p <= (cfg.topic?.afterClose ?? 0.03), `收束句 ${closer.p}`)
  const off = r.other('老王', '今晚吃啥', { after: ((cfg.topic?.cooldownSec ?? 60) + 5) * 1000 })
  assert.equal(off.state, 'idle', off.why.join('、'))
})

test('在聊：正在和她聊的人接着说——起点 followUp、按她在这段里接过几句衰减，不再是 p=1 每句必醒；旁人插话不算在聊', () => {
  // 真群甲（2026-10-22 17:50–17:58）：她回过灰灰子一句后，他的「为什么」「多押韵」每句 p=1，十二秒里大脑三次「接住梗」，八分钟开口 14 次
  const r = room()
  const follow = cfg.followUp ?? 0.5
  const decay = cfg.topic?.inTopicDecay ?? 0.75
  r.other('灰灰子', '这鱼怎么感觉没那么聪明', { woke: true })
  r.self('说鱼不聪明的那位你小心点哦')
  const first = r.other('灰灰子', '哦鲸鲸？', { convo: { name: '灰灰子', herLines: 1, nth: 1, replies: 1 } })
  assert.equal(first.state, 'chatting')
  assert.equal(first.p, follow, first.why.join('、'))
  assert.ok(first.p < 1 && first.why.some(w => w.includes('正在和她聊的 灰灰子')), first.why.join('、'))
  r.self('哦鲸鲸是什么叫法啦')
  const second = r.other('灰灰子', '这样 我管你叫哦鲸鲸 你管我叫狗修金', { convo: { name: '灰灰子', herLines: 2, nth: 1, replies: 2 } })
  assert.equal(second.p, Math.round(follow * decay * 1000) / 1000, second.why.join('、'))
  r.self('狗修金这个你试着叫一声')
  const third = r.other('灰灰子', '多押韵', { convo: { name: '灰灰子', herLines: 3, nth: 1, replies: 3 } }) // 「为什么」是问句会被问句 0.3 托住，这里用他下一句
  assert.ok(third.p < second.p && third.p < 0.35, `连着接了三句就收着：${third.p}`)
  assert.ok(first.p > (cfg.base ?? 0.08) * 3 && first.p <= 0.6, `只比没在聊高一档，不是「大都接」：${first.p}`)
  // 她说的比他回的多（她接了两句、他才回一句）：每多一句再衰减一次——对方不回，她不该一句接一句往上凑（真群乙 23:21–23:29）
  const ahead = r.other('灰灰子', '那以后就这么定了', { convo: { name: '灰灰子', herLines: 2, nth: 1, replies: 1 } })
  assert.equal(ahead.p, Math.round(follow * decay ** 2 * 1000) / 1000, ahead.why.join('、'))
  assert.ok(ahead.why.some(w => w.includes('他回了她 1 句')), ahead.why.join('、'))
  // 旁人插话不是「在聊」：按普通打分
  const by = r.other('IIIBeta2III', '先生这得花不少token')
  assert.ok(by.p < 0.2 && !by.why.some(w => w.includes('正在和她聊')), `旁人插话 ${by.p}（${by.why.join('、')}）`)
})

test('在聊：接她刚才的话得像是冲她那句来的（有共有的词或在问）；她说完后挨着的无关灌水不算在聊', () => {
  // 第一轮模拟器 boring-rocket：她应了一声「在」，之后 90 秒内每句无关灌水都成了「接她的话」，40 句灌水她开口 11 次
  const r = room()
  r.other('七七', '吃了吗')
  r.self('在')
  const off = r.other('阿哲', '上班好累')
  assert.equal(off.state, 'idle', off.why.join('、'))
  assert.ok(off.p <= (cfg.base ?? 0.08), `无关灌水回到没在聊：${off.p}`)
  r.other('小林', '你们看今晚火箭发射的直播没')
  r.self('看了，升空那下太震撼了')
  const on = r.other('阿哲', '升空那下真的，鸡皮疙瘩都起来了', { after: 8000 })
  assert.equal(on.state, 'chatting', on.why.join('、'))
  const ask = r.other('糖糖', '你在哪看的直播', { after: 8000 })
  assert.equal(ask.state, 'chatting', ask.why.join('、'))
})
