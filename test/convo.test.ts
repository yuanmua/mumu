import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { HistoryTurn } from '../src/index.ts'
import { toOther } from '../plugins/official/group-policy/bot-text.ts'
import type { Convo } from '../plugins/official/group-policy/convo.ts'
import { asks, convoSection, Convos, renderConvos } from '../plugins/official/group-policy/convo.ts'
import type { PolicyConfig } from '../plugins/official/group-policy/judge.ts'
import { judge } from '../plugins/official/group-policy/judge.ts'
import { readingWindow } from '../plugins/official/group-policy/reading.ts'
import type { Entry } from '../plugins/official/group-policy/rooms.ts'
import { SELF } from '../plugins/official/group-policy/rooms.ts'
import { Topics } from '../plugins/official/group-policy/topics.ts'

// 出厂默认值；时段系数去掉，免得跑测试的钟点影响概率
const defaults = JSON.parse(readFileSync(new URL('../plugins/official/group-policy/package.json', import.meta.url), 'utf8')).mumu.defaults as PolicyConfig
const cfg: PolicyConfig = { ...defaults, timeRules: [] }
const G = 'qq:group:1'

/** 一个群：别人的话走 onOther（回填 convo），她的话按 index.ts 的算法认「在回谁」 */
function room(c: PolicyConfig = cfg) {
  const events: { type: string, why?: string, who: string }[] = []
  const convos = new Convos(() => c.convo ?? {}, () => c.topic ?? {}, (type, x: Convo) => events.push({ type, why: x.why, who: x.who }))
  const list: Entry[] = []
  let at = 1_000_000
  let speaking = false // speak() 到 self() 之间她正在说：这期间到的句子谁都没看到（index.ts 按正在跑的 reply 判）
  return {
    events,
    convos,
    list,
    now: () => at,
    other(who: string, text: string, opts: { direct?: boolean, woke?: boolean, after?: number } = {}): Entry {
      at += opts.after ?? 5000
      const e: Entry = { at, who, name: who, text, direct: opts.direct, woke: opts.woke }
      list.push(e)
      convos.onOther(G, e, speaking)
      return e
    },
    /** 她开口了（utterance.started，index.ts 调 onSpeak）：要模拟「她说话时对方又说」就先 speak、再 other、最后 self 带同一个 startedAt */
    speak(): number {
      at += 1000
      speaking = true
      convos.onSpeak(G, at)
      return at
    },
    /**
     * 她说一句；startedAt = 她开口的时刻（缺省 = 说完那刻）。她在回谁（index.ts replyTargets）：叫醒那拍大脑的原因里说话的人——
     * 这里用「上次开口后冲她说的 / 对话中的 / 叫醒过大脑的」代替，不再有「都没有就算她开口前别人那句」的兜底
     */
    self(text: string, opts: { after?: number, startedAt?: number } = {}) {
      at += opts.after ?? 5000
      const e: Entry = { at, who: SELF, text }
      const since = list.slice(list.findLastIndex(x => x.who === SELF) + 1)
      const to = since.filter(x => x.direct || x.convo || x.woke)
      list.push(e)
      if (opts.startedAt === undefined)
        convos.onSpeak(G, at) // 没单独 speak 过：开口即说完
      speaking = false
      convos.onSelf(G, e, to, opts.startedAt ?? at)
    },
  }
}

test('正在对话：@ 她问了一句、她答了，对方不 @ 接着问的两句都算在跟她说', () => {
  const r = room()
  const ask = r.other('原木', '@沐沐 火箭回收是怎么做到的', { direct: true })
  assert.ok(!ask.convo, '第一次 @ 之前没在聊')
  r.self('靠栅格舵和发动机反推，一点点减速落到船上')
  const f1 = r.other('原木', '那落到船上不会翻吗')
  r.self('有腿撑着，还有锁住的装置')
  const f2 = r.other('原木', '成本能降多少')
  assert.ok(f1.convo && f2.convo, '两句追问都标成在跟她说')
  assert.ok(r.convos.isIn(G, '原木', r.now()))
  // 接着 @ 也算接着聊（不是「刚 @ 过又 @」）
  const again = r.other('原木', '@沐沐 你咋知道这么多', { direct: true })
  assert.ok(again.convo)
})

test('正在对话：她插话回了某人（那句叫醒了大脑），也算和那人聊上了；路人的话不算，她开口前后恰好说话的人也不算', () => {
  const r = room()
  r.other('小林', '你们看今晚长征五号发射没', { woke: true })
  r.other('阿哲', '我没给他上太多功能') // 真群 17:53：她回灰灰子时 IIIBeta2III 恰好在她开口前说了句无关的，原来就成了「正在和她聊」
  r.self('看了！升空那一下好震撼')
  const lin = r.other('小林', '对吧，我还录屏了')
  const wang = r.other('老王', '今天好热啊')
  const zhe = r.other('阿哲', '先生这得花不少token')
  assert.ok(lin.convo, '她回过的人接着说，算在跟她说')
  assert.ok(!wang.convo, '路人不算')
  assert.ok(!zhe.convo && !r.convos.isIn(G, '阿哲', r.now()), '她开口前恰好说话的人不算在聊')
})

test('正在对话：对方连续两句在跟别人说（@ / 回复别人）就结束；收束句也结束', () => {
  const r = room()
  r.other('原木', '@沐沐 在吗', { direct: true })
  r.self('在')
  const o1 = r.other('原木', '@阿哲 你下午来不来')
  assert.ok(!o1.convo, '@ 别人的那句不是跟她说的')
  assert.ok(r.convos.isIn(G, '原木', r.now()), '一句还不算转走')
  r.other('原木', '[回复 阿哲「我晚点到」] 那我等你')
  assert.ok(!r.convos.isIn(G, '原木', r.now()), '连续两句跟别人说：结束')
  assert.match(r.events.at(-1)?.why ?? '', /转去跟别人说了/)

  const r2 = room()
  r2.other('糖糖', '@沐沐 推荐首歌', { direct: true })
  r2.self('听听晴天')
  const bye = r2.other('糖糖', '好的谢谢')
  assert.ok(!bye.convo)
  assert.match(r2.events.at(-1)?.why ?? '', /收尾了/)
})

test('正在对话：idleSec 没人续就结束；对方连说几句她都没接也结束', () => {
  const r = room()
  r.other('七七', '@沐沐 晚上吃啥', { direct: true })
  r.self('火锅！')
  const late = r.other('七七', '那去哪家', { after: ((cfg.convo?.idleSec ?? 120) + 5) * 1000 })
  assert.ok(!late.convo, '两分钟后再说就不算接着聊')
  assert.match(r.events.at(-1)?.why ?? '', /秒没人续/)

  const r2 = room()
  r2.other('阿哲', '@沐沐 你喜欢什么歌', { direct: true }) // 她没接
  const n = cfg.convo?.maxUnanswered ?? 3
  const said = Array.from({ length: n + 1 }, (_, i) => r2.other('阿哲', `我自己说第 ${i + 1} 句话`))
  assert.ok(said.slice(0, n - 1).every(e => e.convo), '前几句还叫醒')
  assert.ok(!said.at(-1)?.convo, '她一直没接：不再叫醒')
  assert.match(r2.events.at(-1)?.why ?? '', /都没接/)
})

test('正在对话：她说了一句对方没接——对方隔着别人的话接着说自己的、和她那句没有共有词，就放下；回头 @ 她再聊上', () => {
  // 真群乙（2026-10-22 23:21–23:29）：她回了青山一句，青山接着跟群里聊火箭项目、群友都在 @ 他，他一次没回她，
  // 他的每句白话却都算「接着跟她说的」，她八分钟对他开口七次（群友：「这个机器人，他认为你在一直和他聊天」）
  const r = room()
  r.other('青山', '我们群友自己搞个火箭项目吧', { woke: true })
  r.self('龙哥你这破烂标准，能喷火就行')
  r.other('虎丸', '@星见雅 我去不早说')
  r.other('星见雅', '这怎么这么难找啊')
  const next = r.other('青山', '别想着跟那些竞争了')
  assert.ok(!next.convo, '他接着说自己的，不是在跟她说')
  assert.ok(!r.convos.isIn(G, '青山', r.now()), '放下了')
  assert.match(r.events.at(-1)?.why ?? '', /没接她的话/)
  const block = renderConvos(r.convos, r.now(), 6)
  assert.match(block, /【你说了对方没接】/)
  assert.match(block, /你上一句说给 青山：「龙哥你这破烂标准/)
  assert.match(block, /接着说的是「别想着跟那些竞争了」/)
  const more = r.other('青山', '我感觉最多就是弄出来一个中型火箭')
  assert.ok(!more.convo, '之后的话也不再算在跟她说')
  // 冲别人的长问句不算接她的话（真群 23:27「能不能不要老是说这些倭寇的语言」是冲另一个群友说的）
  const r2 = room()
  r2.other('青山', '成立一个群友基金', { woke: true })
  r2.self('群友基金？凑起来够买一桶推进剂不')
  r2.other('白石', '目前以最好的工具完成设计')
  const ask = r2.other('青山', '能不能不要老是说这些倭寇的语言')
  assert.ok(!ask.convo && !r2.convos.isIn(G, '青山', r2.now()), '隔着别人、没有共有词的长问句：没接她的话')
  // 他回头 @ 她：再聊上，「没接」那块撤掉
  r.other('青山', '@沐沐 你说喷火就行是啥意思', { direct: true })
  assert.ok(r.convos.isIn(G, '青山', r.now()))
  assert.doesNotMatch(renderConvos(r.convos, r.now(), 6), /【你说了对方没接】/)
})

test('正在对话：她说完对方一直没吭声、旁人连着说和她那句无关的，就放下；旁人接她的话、引用别人的话里带她的词都不算', () => {
  const r = room()
  r.other('青山', '成立一个群友基金', { woke: true })
  r.self('群友基金？凑起来够买一桶推进剂不')
  r.other('Novas', '钱怎么办，让群友去麦吗') // 和她那句有共有词：旁人在接她的话
  r.other('倒置', '@Novas 可以')
  r.other('千恋', '[回复 Novas「钱怎么办，让群友去麦吗」] 在麦了在麦了') // 引的是别人的话，自己说的部分和她无关
  assert.ok(r.convos.isIn(G, '青山', r.now()), '两句还不算')
  r.other('KT77', '给龙哥凑钱搞火箭')
  assert.ok(!r.convos.isIn(G, '青山', r.now()), `连着 ${cfg.topic?.switchAfter ?? 3} 句无关：放下`)
  assert.match(r.events.at(-1)?.why ?? '', /群里在聊别的/)
  assert.match(renderConvos(r.convos, r.now(), 6), /青山 没吭声，群里已经在聊别的了/)
})

test('正在对话：她说话那会儿旁人接着往下聊，她一说完对方接的是旁人的词——不是在回她', () => {
  // 模拟器 real-ignored 第二轮：她答青山说了 13 秒，KT77 在这期间引用青山「所以说不如搞上游」，她说完 1 秒青山「上游那些子系统配套我们也搞不定」
  const r = room()
  r.other('青山', '@沐沐 你觉得我们群友能搞出点名堂吗', { direct: true })
  const t0 = r.speak()
  r.other('KT77', '[回复 青山「我想拉群友一起搞个项目」] @青山 所以说不如搞上游', { after: 4000 })
  r.self('看搞什么吧，光有一腔热血可不行，得真有人肯干活', { after: 5000, startedAt: t0 })
  const next = r.other('青山', '上游那些子系统配套我们也搞不定', { after: 1000 })
  assert.ok(!next.convo && !r.convos.isIn(G, '青山', r.now()), '他接的是 KT77 的「上游」：没接她的话')
  // 对照：同样的时序，他接的是她的词——算回她
  const r2 = room()
  r2.other('青山', '@沐沐 你觉得我们群友能搞出点名堂吗', { direct: true })
  const t1 = r2.speak()
  r2.other('KT77', '[回复 青山「我想拉群友一起搞个项目」] @青山 所以说不如搞上游', { after: 4000 })
  r2.self('看搞什么吧，光有一腔热血可不行，得真有人肯干活', { after: 5000, startedAt: t1 })
  const ok = r2.other('青山', '干活的人我来找，热血我有的是', { after: 1000 })
  assert.ok(ok.convo && r2.convos.isIn(G, '青山', r2.now()), '接着她的「干活」「热血」说：算回她')
  // 第三轮：青山那句在她还没说完时就到了——说完再判，接的是 KT77 的词就不挂「还没接」（原来说完被推着回了一句冲别人的话）
  const r3 = room()
  r3.other('青山', '@沐沐 你觉得我们群友能搞出点名堂吗', { direct: true })
  const t2 = r3.speak()
  r3.other('KT77', '[回复 青山「我想拉群友一起搞个项目」] @青山 所以说不如搞上游', { after: 4000 })
  r3.other('青山', '上游那些子系统配套我们也搞不定', { after: 6000 })
  r3.self('光喊口号的话三天就散了，得有人真肯干活', { after: 4000, startedAt: t2 })
  assert.deepEqual(r3.convos.list(r3.now(), G).flatMap(c => r3.convos.pending(c).map(l => l.text)), [], '冲别人说的不算还没接')
})

test('正在对话：挨着她那句的回话不看词（「对吧，我还录屏了」）；隔着别人的短追问（「哦鲸鲸？」）也算接上', () => {
  const r = room()
  r.other('灰灰子', '这鱼怎么感觉没那么聪明', { woke: true })
  r.self('说鱼不聪明的那位你小心点哦')
  r.other('IIIBeta2III', '我没给他上太多功能')
  const q = r.other('灰灰子', '哦鲸鲸？')
  assert.ok(q.convo && r.convos.isIn(G, '灰灰子', r.now()), '短追问接上了')
  assert.equal(r.convos.view(G, '灰灰子', r.now())?.replies, 1, '他回了她一句')
  // 接上之后他接着说的，不再逐句查（没有她的新话可接）
  const on = r.other('灰灰子', '这样 我管你叫哦鲸鲸 你管我叫狗修金')
  assert.ok(on.convo)
})

test('话题：群里换走的话题，她又主动回头接里面的人，不另开一轮；参与者按她真在回谁', () => {
  // 真群乙 23:21:54 火箭话题判「换话题了」，5 秒后她接青山的旧话，新话题把还在聊火箭的人全算进「她参与的话题还在聊」
  const events: string[] = []
  const topics = new Topics(() => cfg.topic ?? {}, (type, t) => events.push(`${type}:${[...t.participants].join(',')}`))
  let at = 1_000_000
  const e = (who: string, text: string, direct = false): Entry => ({ at: (at += 5000), who, name: who, text, direct })
  const long = e('青山', '我们群友自己搞个火箭项目吧')
  topics.onSelf(G, e(SELF, '火箭项目听着就很燃'), long)
  assert.deepEqual(events, ['topic.opened:青山'])
  for (const text of ['猫咖今天开门吗', '外卖到了', '下午开会好烦']) topics.onOther(G, e('路人', text))
  assert.match(events.at(-1) ?? '', /topic.closed/)
  topics.onSelf(G, e(SELF, '龙哥你这破烂标准，能喷火就行'), long)
  assert.equal(events.filter(x => x.startsWith('topic.opened')).length, 1, '回头接旧话题的人：不另开')
  const back = topics.view(G, e('青山', '我感觉最多就是弄出来一个中型火箭'), at)
  assert.ok(back?.status === 'closed' && back.related, '他的话还算碰着已收尾的旧话题（judge 压到 afterClose）')
  // 被 @ 着答：照常开
  topics.onSelf(G, e(SELF, '在呢'), e('阿哲', '@沐沐 在吗', true))
  assert.equal(events.at(-1), 'topic.opened:阿哲')
  // 参与者「紧接着她那句」才不看词：隔着别人的闲话、他冲别人说的不算在接（模拟器 real-ignored：青山冲白石说「倭寇」被算成她参与的话题 p=0.31）
  topics.onOther(G, e('杜王', '如果你也是只小猫可以去猫咖卖萌喵'))
  const off = e('阿哲', '能不能不要老是说这些倭寇的语言')
  // 打分时（pre-beat）话题还没投影这句：按投影前的状态看
  assert.equal(topics.view(G, off, at)?.related, false, '隔着别人的话、没有共有词：不算在接她的话题')
  topics.onSelf(G, e(SELF, '嗯嗯'), e('阿哲', '@沐沐 晚上打游戏吗', true))
  assert.equal(topics.view(G, e('阿哲', '那八点上线'), at)?.related, true, '紧接着她那句的回话照旧算')
})

test('正在对话：账在她开口那刻销——说话期间到的追问被下一段 append 接住后不算「没接」，对话不会被「连说 3 句她都没接」误结束', () => {
  // 模拟器 convo-follow 复测：六句追问全在她说话时到，按说完那刻算账，第三、四句到时 unanswered 累到 3 就把对话结束了，后两句退回普通打分
  const r = room()
  r.other('大远', '@沐沐 火箭回收是怎么做到的', { direct: true })
  const t1 = r.speak() // 第一段：开口在下面两句之前
  r.other('大远', '那落到船上不会翻吗', { after: 8000 })
  r.other('大远', '回收一次大概能省多少钱', { after: 10_000 })
  r.self('一级分离完先掉头，发动机再点火减速', { after: 2000, startedAt: t1 })
  let c = r.convos.list(r.now(), G)[0]
  assert.equal(r.convos.pending(c).length, 2, '第一段说完，她说话时到的两句还没接')
  const t2 = r.speak() // 第二段 append：开口在前两句之后、后两句之前
  r.other('大远', '那为什么别的国家不这么干', { after: 6000 })
  r.other('大远', '星舰也能这样回收吗', { after: 14_000 })
  r.self('不会翻的，腿撑开重心低；省的话一次几千万美元', { after: 3000, startedAt: t2 })
  c = r.convos.list(r.now(), G)[0]
  assert.ok(c && c.status === 'open', '对话没被误结束')
  assert.equal(c.herLines, 2, '她在这段里接了两句')
  assert.deepEqual(r.convos.pending(c).map(l => l.text), ['那为什么别的国家不这么干', '星舰也能这样回收吗'], '只有第二段说话时到的两句还没接')
  const fifth = r.other('大远', '一级二级都能回收？', { after: 8000 })
  assert.ok(fifth.convo, '第五句还算在跟她说')
  // 第五句到时她没在说话：正常打分、没掷中就是没中，不挂成「还没接」——模拟器里她两分钟后被 timer 叫醒，看到挂着的「还没接」又回头答了一句
  assert.ok(!r.convos.pending(c).some(l => l.text === fifth.text), '她没在说话时到的句子不算「还没接」')
})

test('正在对话：纯表情包、一两个字不叫醒（真群：群友聊着发了张表情包，她 quick 了一句碎话）', () => {
  const r = room()
  r.other('原木', '@沐沐 可以写代码算？', { direct: true })
  r.self('当然可以啊，写个程序暴力搜一下')
  const said = r.other('原木', '感觉还得调试一下')
  const pic = r.other('原木', '[表情包：粉发蓝眼动漫女孩侧脸特写，表情冷淡。]')
  const six = r.other('原木', '6')
  assert.ok(said.convo, '说正事的那句是在跟她说')
  assert.ok(!pic.convo && !six.convo, '表情包、一个字不叫醒')
  assert.ok(r.convos.isIn(G, '原木', r.now()), '人还在，对话没断')
})

test('正在对话：对方转去说无关的短闲话（「摸鱼中」「困死了」）不算在跟她说；接着话题说的、问的照旧', () => {
  // 全量测试 2026-10-22 boring-rocket：她回了糖糖的火箭提问后，糖糖 30 秒后的灌水「摸鱼中」「困死了」被判成 p=1 在跟她说，她又接了两句
  const r = room()
  r.other('糖糖', '火箭这次是送什么卫星上去的？', { woke: true })
  r.self('好像是个通信卫星，后面还有一次星舰试飞')
  const idle1 = r.other('糖糖', '摸鱼中')
  const idle2 = r.other('糖糖', '困死了')
  assert.ok(!idle1.convo && !idle2.convo, '无关的短闲话不叫醒')
  assert.ok(r.convos.isIn(G, '糖糖', r.now()), '人还在，对话没断')
  // 这些也不该挂成「还没接」：模拟器 flood 里一句「好耶」挂着，大脑每说完一段就再补一段去接它
  const six = r.other('糖糖', '6')
  assert.ok(!six.convo)
  assert.deepEqual(r.convos.list(r.now(), G).flatMap(c => r.convos.pending(c).map(l => l.text)), [], '闲话、一两个字不算还没接')
  const on = r.other('糖糖', '星舰试飞啥时候')
  assert.ok(on.convo, '接着话题说的算在跟她说')
  const ask = r.other('糖糖', '真的假的？')
  assert.ok(ask.convo, '短的问句也算')
  const long = r.other('糖糖', '我今天看直播看到一半睡着了')
  assert.ok(long.convo, '说了一整句的算在跟她说，是不是真对她说交给大脑')
})

test('正在对话：她说话那会儿对方又说的，标「还没接」；大脑和发言者都看得到', () => {
  const r = room()
  r.other('原木', '@沐沐 火箭为什么要回收', { direct: true })
  const started = r.speak()
  r.other('原木', '回收的话要多带燃料吧', { after: 3000 }) // 她开口之后才到
  r.self('因为火箭太贵了，回收能省钱', { after: 4000, startedAt: started })
  const c = r.convos.list(r.now(), G)[0]
  assert.deepEqual(r.convos.pending(c).map(l => l.text), ['回收的话要多带燃料吧'])
  const block = renderConvos(r.convos, r.now(), 6)
  assert.match(block, /【你正在和人聊】/)
  assert.match(block, /回收的话要多带燃料吧 {2}← 还没接/)
  assert.match(block, /你：因为火箭太贵了/)
  const s = convoSection(r.convos, [c])
  assert.match(String(s?.render() ?? ''), /还在等你接：「回收的话要多带燃料吧」/)
  // 她接着又说了一段（哪怕这段被算成是回别人的）：那句她开口前就到了，大脑和发言者都看过，账销掉，不再补叫
  // （复测 2026-10-22 flood / group-feel：账没销，「取号」说了三遍、「最喜欢哪首」问了两遍）
  r.other('阿哲', '记得带充电宝', { woke: true })
  r.self('带带带，充电宝我随身的', { after: 3000 })
  assert.deepEqual(r.convos.pending(c), [], '她开口前到的话都算看过了')
  const t3 = r.speak()
  const mid = r.other('原木', '那回收的火箭还能再飞几次', { after: 2000 }) // 这句在她开口之后才到
  r.self('能飞十几次吧', { after: 5000, startedAt: t3 })
  assert.deepEqual(r.convos.pending(c).map(l => l.text), ['那回收的火箭还能再飞几次'], '只有她说话那会儿到的才算还没接')
  assert.ok(mid.convo)
})

test('话题内主动：她参与的话题还开着、这句在接它就值得想一想；接得越多越收着，兴趣话题起点高', () => {
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const topics = new Topics(() => cfg.topic ?? {}, () => {}, text => text.includes('火箭'))
  const list: Entry[] = []
  let at = 1_000_000
  const other = (who: string, text: string) => {
    const e: Entry = { at: (at += 5000), who, name: who, text }
    list.push(e)
    topics.onOther(G, e)
    return judge(cfg, e, list.slice(0, -1), { ...idle, topic: topics.view(G, e, at), interest: undefined })
  }
  const self = (text: string) => {
    const replyTo = list.findLast(x => x.who !== SELF)
    const e: Entry = { at: (at += 5000), who: SELF, text }
    list.push(e)
    topics.onSelf(G, e, replyTo)
  }
  other('小林', '今晚长征五号火箭发射你们看了吗')
  self('看了！火箭升空那下好震撼')
  const third = other('糖糖', '火箭发射那下我也看了，这次送的是通信卫星')
  const t = cfg.topic ?? {}
  assert.equal(third.p, Math.round((t.interestInTopic ?? 0.7) * (t.inTopicDecay ?? 0.75) * 1000) / 1000, third.why.join('、'))
  assert.ok(third.why.some(w => w.includes('她参与的话题还在聊')), third.why.join('、'))
  self('星舰那个回收能成就厉害了')
  const fourth = other('老王', '火箭回收上次就差一点')
  assert.ok(fourth.p < third.p, `接得越多越收着：${fourth.p} < ${third.p}`)
  // 灌水压得住
  const filler = other('阿哲', '6')
  assert.ok(filler.p <= (cfg.shortChat ?? 0.01), filler.why.join('、'))
})

test('阅读窗口：正在聊的那段整段带上，不被最近几条别人的话挤掉', () => {
  const pool: HistoryTurn[] = []
  let at = 1_000_000
  const push = (role: 'self' | 'other', id: string, text: string): void => {
    pool.push({ role, text, at: (at += 1000), channel: G, kind: role === 'self' ? 'utterance' : 'group.message', sender: role === 'other' ? { id, name: id } : undefined })
  }
  push('other', '原木', '@沐沐 火箭回收怎么做到的')
  push('self', '', '栅格舵加反推')
  push('other', '原木', '那落到船上不会翻吗')
  for (let i = 0; i < 30; i++) push('other', `路人${i}`, `闲聊 ${i}`)
  const win = readingWindow(pool, ['沐沐'], { recent: 6, dense: 6, limit: 10, threads: 0, mentions: 0 }, at, t => t.role === 'self' || t.sender?.id === '原木')
  const texts = win.map(t => t.text)
  for (const s of ['@沐沐 火箭回收怎么做到的', '栅格舵加反推', '那落到船上不会翻吗'])
    assert.ok(texts.includes(s), `带上「${s}」`)
  assert.ok(win.length <= 10)
  assert.ok(texts.includes('闲聊 29'), '最近的还在')
})

test('在跟别人说：@ 别人、回复别人；回复她、普通一句不算', () => {
  assert.ok(toOther('@阿哲 你来不来'))
  assert.ok(toOther('[回复 阿哲「我晚点到」] 好'))
  assert.ok(!toOther('[回复你「在」] 你在干嘛'))
  assert.ok(!toOther('今天好热'))
})

test('她问了谁、那人接着的回答：标 asked，judge 直接 p=1；「好的」「发吧」这种收束句、两个字也算，之后照常', () => {
  // 真群甲（2026-10-23 16:12）：主人让她发 mp3，她回「要我直接发群里吗？」，主人回「确认，发吧」按在聊打分 p=0.407 没叫醒，120 秒后才醒
  const idle = { replyHere: false, replyElsewhere: false, privateWaiting: false, startsLastMinute: 0 }
  const r = room()
  r.other('原木', '@沐沐 把你刚下的 mp3 发群里', { direct: true })
  r.self('要我直接发群里吗？')
  const yes = r.other('原木', '发吧')
  assert.ok(yes.convo && yes.asked, '两个字的「发吧」是在答她')
  const v = judge(cfg, yes, r.list.slice(0, -1), { ...idle, convo: { ...r.convos.view(G, '原木', r.now())!, asked: true } })
  assert.equal(v.p, 1)
  assert.match(v.why.join(''), /她刚问了 原木/)
  assert.equal(judge(cfg, yes, r.list.slice(0, -1), { ...idle, replyHere: true, convo: { ...r.convos.view(G, '原木', r.now())!, asked: true } }).p, 0, '她还在说：照旧等说完补判')
  const more = r.other('原木', '顺便说一下这首是洛天依的')
  assert.ok(!more.asked, '只管答她的那一句')

  const r2 = room()
  r2.other('原木', '@沐沐 把你刚下的 mp3 发群里', { direct: true })
  r2.self('好，我这就发')
  const ok = r2.other('原木', '好的')
  assert.ok(!ok.asked, '她没问，「好的」是收尾')
})

test('她在问人：问号、吗、X不X、一小句「不」收尾都算；带「什么」的陈述、「我还没」不算', () => {
  for (const s of ['主人～阿哲想听七里香，能发群里不', '阿哲又要稻香了，发不', '你看行不行', '要我发群里吗', '真的？', '主人～这首也发吗'])
    assert.ok(asks(s), s)
  for (const s of ['看搞什么吧，光有一腔热血可不行', '我还没', '好，我这就发', '那我才不', '发啦发啦'])
    assert.ok(!asks(s), s)
})

test('她点名问了不在「在回谁」里的人（路人要她发文件，她转头问主人）：那人的下一句也算在答她', () => {
  const r = room()
  r.other('阿哲', '@沐沐 把你电脑里的 a.mp3 发群里', { direct: true })
  const at = r.now() + 1000
  const owner: Entry = { at, who: '20009', name: '主人', text: '' } // 主人最近没在这个群说话（index.ts askedOf 从她这句聊上）
  const her: Entry = { at, who: SELF, text: '主人，阿哲要我把 a.mp3 发群里，发吗？' }
  r.list.push(her)
  r.convos.onSpeak(G, at)
  r.convos.onSelf(G, her, [owner, r.list[0]], at)
  const yes = r.other('20009', '行吧')
  assert.ok(yes.asked, '主人的「行吧」是在答她')
  const zhe = r.other('阿哲', '谢啦')
  assert.ok(zhe.asked, '她这句也是在回阿哲：阿哲接着的话同样算答')
})
