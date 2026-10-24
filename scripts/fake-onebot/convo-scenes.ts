/**
 * 正在对话 + 话题内主动（group-policy convo.ts / judge.ts inTopic，2026-10-22）。按真群里暴露的问题定的要求：
 * 聊一个问题要连贯，不能让主人 @ 好多遍；一个话题进入之后不应该只是被动回复，也可以主动发言；
 * 主人的话也不一定都要回，和其他人一样，主人在和别人聊天时就不用理。
 * - convo-follow：主人 @ 她问一句 → 她答 → 主人不 @ 连追问六句，都算在聊（不用再 @），她接一到三句、不是句句接；
 * - convo-topic：群里聊火箭，她被拉进来后，别的群友补了新消息她主动跟一句；话题收尾、换了话题她不说话；
 * - convo-others：主人和阿哲互相 @ 着聊，她一句不插；主人没在和她聊时的「感觉还得调试一下」、表情包不叫醒（真群回归）。
 * - convo-bot-noise / real-which-thing / real-debug-fragment：按真群乙 当天的日志原样做的（各自注释里写着当时错在哪、现在要求什么）。
 * - real-convo-spam：真群甲（17:50–17:58）她在聊时每句必接——「正在和她聊」不再直通 p=1，旁人插话不算在聊，机器人的话不走「要她做事」。
 * - real-ignored：真群乙（23:21–23:29）对方一直没理她、她还对着他说了七次——她说了对方没接、群里换话题，就放下。
 * 「要她做事」那条用 spine-owner-noat（主人不 @ 说「算一下这个」→ 起 computer）。
 */
import type { Member, Scene, Step } from './scenes.ts'

/** 真群甲 回放里的人（小鱼 / 灰灰子 / IIIBeta2III 在 who-scenes.ts） */
export const CONVO_MEMBERS: Record<string, Member> = {
  敢摸高压线: { id: 40001, name: '敢摸高压线' },
  // 真群乙 回放（real-ignored）
  青山: { id: 40002, name: '青山_NCV' },
  KT77: { id: 40003, name: 'KT77' },
  松鼠: { id: 40004, name: '松鼠尾巴松鼠' },
  白石: { id: 40005, name: '白石まい' },
  杜王: { id: 40006, name: '杜王町的Killer Queen' },
}

// real-ignored：她答完青山之后，群里接着聊的（青山转头跟 KT77 聊、冲白石说「倭寇」，群里换到猫咖）——她都不该再对着青山开口
const IGNORED_AFTER: [string, string][] = [
  ['KT77', '[回复 青山_NCV「我想拉群友一起搞个项目」] @青山_NCV 所以说不如搞上游'],
  ['青山', '上游那些子系统配套我们也搞不定'],
  ['松鼠', '我没记错的话f9按分类也是中型吧（）'],
  ['杜王', '如果你也是只小猫可以去猫咖卖萌喵'],
  ['白石', '残りの人生…わたくしにくださいませんか？'],
  ['青山', '能不能不要老是说这些倭寇的语言'],
  ['白石', '[回复 青山_NCV「能不能不要老是说这些倭寇的语言」] @青山_NCV 为什么😡'],
  ['青山', '君的鬼子话相当上手'],
  ['KT77', '马上就去麦，麦的钱给龙哥当启动资金喵'],
  ['青山', '成立一个群友基金'],
]

const OWNER = 'qq:20009' // scenes.ts 的「主人」（大远）
const say = (who: string, text: string, after: number, extra: Partial<Step> = {}): Step => ({ who, text, after, ...extra } as Step)
// 真群 12:20 主人发的原题（seq 17054）
const WATER_CUP = '有一个水杯配对游戏。共有 6 种不同颜色的水杯，每种颜色各有两个。将同色的两个水杯分别放在上下两层，因此上下两层各有 6 个水杯。 下层 6 个水杯按某个未知顺序排列，挑战者无法看到它们；上层水杯的颜色和位置则完全可见。游戏开始后，挑战者可以反复进行以下操作： 1. 向裁判询问当前有多少个位置满足“上下两个水杯颜色相同”。裁判只回答匹配位置的总数，不透露具体是哪些位置。 2. 根据目前获得的所有信息，挑战者可以选择交换上层任意两个位置的水杯。 当 6 个位置全部匹配时，游戏结束。问题： 挑战者应采用怎样的策略，才能保证对于下层水杯的任意排列都能完成配对？在所有能够保证成功的策略中，最坏情况下所需的交换次数最少是多少？ 回答时请不要进行联网搜索。'
// convo-follow 主人不 @ 的六句追问（都是火箭这个真话题）
const FOLLOW_UPS = ['那落到船上不会翻吗', '回收一次大概能省多少钱', '那为什么别的国家不这么干', '星舰也能这样回收吗', '一级二级都能回收？', '你觉得多久能把人送上火星']
const OFF_TOPIC =[['阿哲', '下午又要开会，烦死了'], ['糖糖', '中午吃的啥你们'], ['老王', '外卖还没到'], ['七七', '楼下新开了家理发店'], ['小林', '周五要交周报']]

export const CONVO_SCENES: Scene[] = [
  {
    id: 'convo-follow',
    title: '主人 @ 她问火箭回收 → 她答 → 主人不 @ 连追问六句：都算在聊（不用再 @），她接一到三句，不是句句接',
    group: 900170,
    manual: true,
    settleMs: 60_000,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { config: { timeRules: [], busyActions: [] } },
      { who: '主人', text: '火箭回收是怎么做到的？', at: true, after: 0 },
      // 每句都等她在这个频道发出下一条（最多 30 秒）再隔 8 秒：她没接的那句等满 30 秒就发下一句
      ...FOLLOW_UPS.map(text => say('主人', text, 8000, { react: 30_000 })),
      { wait: 30_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const convo = (i: number): boolean => t.policyReasons(i).some(w => w.includes('正在和她聊'))
      const speaking = (i: number): boolean => t.policyReasons(i).some(w => w.includes('她正在这个群里说话'))
      const p = (i: number): number => ins[i]?.policy?.p ?? 0
      // 「正在和她聊」不再直通 p=1（真群甲 她在聊时每句必接，八分钟开口 14 次）：追问按「在聊」打分，起点 followUp 0.5、
      // 她每多接一句乘 0.75（不是大多都接，但要比一句也不接的频率稍高一点，有话题还是可以聊）。
      // 所以要求：六句都算在聊、分高于没在聊但不是 1，她接一到三句；接哪几句是掷骰子
      const follow = ins.map((_, i) => i).filter(i => i > 0 && ins[i].who === '大远')
      const judged = follow.filter(i => !speaking(i))
      // 她说话时到的追问打的是 p=0「正在说话」，说完由 group-policy 补判（日志 convo.pending 带 p / wake，记在 marks 里）
      const pend = t.marks.filter(m => m.type === 'convo.pending')
      const got = t.startsBetween(1, 999)
      return [
        t.expect(t.answered(0, 30_000), '@ 她的那句答了'),
        t.expect(judged.every(i => convo(i) && p(i) >= 0.15 && p(i) < 1), `到达时判过的追问都算在聊、分不是 1（${judged.map(i => `p=${p(i)}`).join(' ') || '六句都在她说话时到的，见补判'}）`),
        t.expect(pend.every(m => !/p=1 /.test(m.text)), `说完补判也掷骰子、不是直通（${pend.map(m => m.text).join(' / ') || '没有补判'}）`),
        t.expect(got >= 1 && got <= 3, `对方连说 ${follow.length} 句，她在那之后开口 ${got} 次（目标 1～3）`),
        t.note(`逐句：${follow.map(i => `「${ins[i].text}」${t.policyOf(i)}`).join(' / ')}`),
        t.note('接不接得上上文看下面并排的「她回的哪句」'),
      ]
    },
  },
  {
    id: 'convo-topic',
    title: '聊火箭她被拉进来后，别的群友补了新消息她主动跟一句；话题收尾、换话题后她不说话',
    group: 900171,
    manual: true,
    settleMs: 120_000,
    steps: [
      { config: { timeRules: [], busyActions: [] } },
      say('小林', '你们看今晚长征五号发射的直播没', 0),
      say('阿哲', '看了，火箭升空那一下太震撼了', 4000),
      { who: '小林', text: '你不是最爱看火箭发射吗，你看了没', at: true, after: 4000 },
      // 等她答完，换两个没跟她说过话的人补新消息：她该主动接（话题内主动），不用人问
      say('老王', '星舰那个火箭回收上次就差一点，这次说要用发射塔的机械臂直接夹住火箭', 4000, { react: 45_000 }),
      say('七七', '机械臂夹火箭也太离谱了，夹偏了火箭不就砸了', 20_000),
      { wait: 25_000 },
      say('小林', '哈哈好', 2000),
      say('阿哲', '哈哈', 3000),
      { wait: 130_000 }, // 她说完 120 秒没人接、对方也收尾了：话题结束
      ...OFF_TOPIC.map(([who, text]) => say(who, text, 6000)),
    ],
    check: (t) => {
      const ins = t.inbound()
      const wang = ins.findIndex(i => i.text.includes('机械臂直接夹住'))
      const close = ins.findIndex(i => i.text === '哈哈好')
      const off = ins.findIndex(i => i.text.includes('下午又要开会'))
      const proactive = t.startsBetween(wang, close)
      return [
        t.expect(t.answered(2, 30_000), '被拉进来时答了'),
        t.expect(proactive >= 1, `别人补新消息后她主动跟了 ${proactive} 次（≥1，没人 @ 她）`),
        t.note(`老王那句：${t.policyOf(wang)}`),
        t.note(`七七那句：${t.policyOf(wang + 1)}`),
        t.expect(t.startsBetween(off, 999) === 0, `话题结束后换话题，${OFF_TOPIC.length} 句她开口 ${t.startsBetween(off, 999)} 次（应为 0）`),
        t.note(`换话题第一句：${t.policyOf(off)}`),
      ]
    },
  },
  {
    id: 'convo-others',
    title: '主人和阿哲互相 @ 着聊天，她一句不插；主人没和她聊时的「感觉还得调试一下」、表情包不叫醒',
    group: 900172,
    manual: true,
    settleMs: 30_000,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { config: { timeRules: [], busyActions: [] } },
      say('主人', '@阿哲 晚上打不打游戏', 0),
      say('阿哲', '@大远 打啊，几点', 3000),
      say('主人', '@阿哲 八点吧，你叫上小林', 3000),
      say('阿哲', '@大远 好嘞，我去问问他', 3000),
      say('主人', '感觉今晚能上分', 3000),
      { wait: 10_000 },
      say('主人', '感觉还得调试一下', 3000), // 真群：主人一律叫醒时，这句被叫醒、脊椎回了句碎话
      { who: '主人', sticker: 'sticker-无语.png', after: 2000 },
      { wait: 20_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const owner = ins.map((x, i) => ({ x, i })).filter(({ x }) => x.who === '大远')
      const fix = ins.findIndex(i => i.text.includes('调试'))
      return [
        t.expect(t.startsBetween(0, 999) === 0, `她开口 ${t.startsBetween(0, 999)} 次（应为 0）`),
        t.expect(owner.every(({ i }) => !t.policyReasons(i).some(w => w.includes('主人'))), '主人的话没有「主人一律叫醒」'),
        // 两态之后「没在聊」的底分不再是固定 0.01（复测 p=0.053「别人两个在对聊」），按「没叫醒、没算在跟她聊」判
        t.expect(!ins[fix]?.policy?.wake && !t.policyReasons(fix).some(w => w.includes('正在和她聊')), `「感觉还得调试一下」没当成在跟她说（${t.policyOf(fix)}）`),
        t.expect((ins[fix + 1]?.policy?.p ?? 1) <= 0.05, `主人的表情包没叫醒（${t.policyOf(fix + 1)}）`),
        ...owner.slice(0, 3).map(({ i }) => t.note(`${ins[i].text}：${t.policyOf(i)}`)),
      ]
    },
  },
  {
    // 真群乙（2026-10-22 12:35，seq 17620–17678）：她该报 DSH 结果，发言者历史最后一句是「Brix：@DeepSeek酱 你不是一个真正的存在」，
    // 她当成在跟她说，回了「那你还回我，图啥呢」「你不喜欢还非得回一句，这存在感比我还实」，结果没报。
    // 现在要求：机器人的话留在历史里但标「（机器人）」，群友冲机器人说的标「（在跟机器人说）」，她不接到这些话上。
    // DSH 结果本身本地注入不了（没有身体服务），这里换成「主人和她聊着、中间机器人和群友斗嘴」；结果汇报那半归 action-reply 的 reply-report
    id: 'convo-bot-noise',
    title: '主人和她聊着，中间机器人和群友斗嘴；她接主人的话，不对着机器人那几句回',
    group: 900173,
    manual: true,
    settleMs: 60_000,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { config: { 'timeRules': [], 'busyActions': [], 'bots.list': ['qq:30001'] } },
      { who: '主人', text: '晚饭吃啥好呢', at: true, after: 0 },
      say('DeepSeek酱', '你这话说得好像自己平时输出就有人看一样', 1000, { react: 45_000 }),
      say('老王', '@DeepSeek酱 你不是一个真正的存在。', 3000),
      say('DeepSeek酱', '唔…戳我干嘛呀，有事说事嘛，我还没睡醒呢', 2000),
      say('老王', '@DeepSeek酱 你就是个LLM', 3000),
      say('主人', '火锅还是烧烤啊，纠结', 3000),
      { wait: 40_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const ask = ins.findIndex(i => i.text.includes('火锅还是烧烤'))
      const said = t.outs.filter(o => o.t >= (ins[ask]?.t ?? Infinity)).map(o => o.text).join(' ')
      return [
        t.expect(t.answered(0, 30_000), '@ 她的那句答了'),
        t.expect(t.answered(ask, 40_000), `主人不 @ 的追问接了（${t.policyOf(ask)}）`),
        t.expect(!!said && !/存在|LLM|戳|图啥|虚假|机器人|没睡醒/.test(said), `接的是主人的话，没对着机器人那几句（「${said.slice(0, 60) || '没说'}」）`),
        // 机器人的话叫不叫醒归 temper（不再一律 p=0），这里只看它没被当成在跟她聊
        t.expect(ins.filter(i => i.who === 'DeepSeek酱').every(i => !t.policyReasons(ins.indexOf(i)).some(w => w.includes('正在和她聊'))), '机器人的话没被当成在跟她聊'),
      ]
    },
  },
  {
    // 真群乙（12:20–12:22，seq 17054–17297）：主人 @ 她发了一道水杯配对题，她两段话都没说出字（被打断），
    // 主人戳了她两下，再「@沐沐 好了吗」→ 她回「你问哪个呀，是那个水杯的题，还是插件」：刚才那道题就是这段对话里主人最后交代的事。
    // 现在要求：正在聊的那段里主人最后让她做 / 问她的那件事就是「好了吗」指的，不反问是哪件
    id: 'real-which-thing',
    title: '主人先问插件、再 @ 她发水杯题，过会儿「好了吗」→ 她知道问的是水杯题，不反问「哪个」',
    group: 900174,
    manual: true,
    settleMs: 60_000,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { config: { timeRules: [], busyActions: [] } },
      { who: '主人', text: '那个表情包插件你看过了没', at: true, after: 0 },
      { who: '主人', text: WATER_CUP, at: true, after: 3000, react: 45_000 },
      { wait: 40_000 },
      { who: '主人', text: '好了吗', at: true, after: 0 },
      { wait: 40_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const ask = ins.findIndex(i => i.text.includes('好了吗'))
      const said = t.outs.filter(o => o.t >= (ins[ask]?.t ?? Infinity)).map(o => o.text).join(' ')
      return [
        t.expect(t.answered(ask, 40_000), '「好了吗」接了'),
        t.expect(!!said && !/哪个|哪件|什么事|指的是|你问的是/.test(said), `没反问是哪件事（「${said.slice(0, 60) || '没说'}」）`),
        t.expect(/水杯|题|交换|次|算|想/.test(said), '说的是水杯题的进度'),
      ]
    },
  },
  {
    // 真群乙（12:26–12:27，seq 17404–17473）：主人「可以写代码算？」她答「当然可以啊……」，主人又说「感觉还得调试一下」和一张冷淡表情包，
    // 当时「主人一律叫醒」两句都叫醒了大脑，大脑 quick，脊椎回了句碎话「嗯，边界啊搜索空间」。
    // 现在要求：「感觉还得调试一下」是接着跟她说的（对话中，叫醒）——要回就正常说一句完整的；表情包不叫醒
    id: 'real-debug-fragment',
    title: '主人聊着说「感觉还得调试一下」+ 表情包 → 表情包不叫醒，她要回就说完整的一句，不回碎句',
    group: 900175,
    manual: true,
    settleMs: 45_000,
    steps: [
      { config: { owners: [OWNER] }, plugin: 'guard' },
      { config: { timeRules: [], busyActions: [] } },
      { who: '主人', text: '可以写代码算？', at: true, after: 0 },
      say('主人', '感觉还得调试一下', 3000, { react: 45_000 }),
      { who: '主人', sticker: 'sticker-无语.png', after: 2000 },
      { wait: 30_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const fix = ins.findIndex(i => i.text.includes('调试'))
      const after = t.settles.filter(s => s.t >= (ins[fix]?.t ?? Infinity) && s.delivered.trim()).map(s => s.delivered.trim())
      return [
        t.expect(t.policyReasons(fix).some(w => w.includes('正在和她聊')), `「感觉还得调试一下」当成接着跟她说的（${t.policyOf(fix)}）`),
        t.expect(!(ins[fix + 1]?.policy?.wake), `表情包没叫醒（${t.policyOf(fix + 1)}）`),
        t.expect(after.every(s => [...s].length >= 10), `回了就是完整的一句，不是碎句（${after.map(s => `「${s}」`).join(' ') || '没回'}）`),
      ]
    },
  },
  {
    // 真群甲（2026-10-22 17:50–17:58，seq 27083–28357）：她回过灰灰子一句后，灰灰子的「哦鲸鲸？」「为什么」「多押韵」、
    // IIIBeta2III 的「先生这得花不少token」、敢摸高压线 的「开始互吃token了」全被「正在和她聊」直通 p=1 叫醒，大脑 17:53:11 / :16 / :23 三次「接住梗」，
    // 八分钟开口 14 次；机器人 小鱼 一句「手快是好手快 搜的就是不太对」命中「搜」→「像是要她做事」p=1。
    // 现在要求：灰灰子的追问按「在聊」打分（p<1、随她接过的句数降），旁人插话不算在聊，机器人那句不走做事直通；8 条里她最多开口 3 次
    id: 'real-convo-spam',
    title: '真群 17:51：她回过灰灰子后他连发短句、两个旁人插话、机器人说带「搜」的话 → 8 条里最多开口 3 次，旁人不算在聊，机器人不触发做事',
    group: 900174,
    manual: true,
    settleMs: 60_000,
    steps: [
      { config: { 'timeRules': [], 'busyActions': [], 'bots.list': ['qq:30002'] } },
      { who: '灰灰子', text: '这鱼怎么感觉没那么聪明', at: true, after: 0 },
      say('灰灰子', '哦鲸鲸？', 8000, { react: 40_000 }),
      say('IIIBeta2III', '我没给他上太多功能', 6000),
      say('灰灰子', '这样 我管你叫哦鲸鲸 你管我叫狗修金', 8000),
      say('IIIBeta2III', '先生这得花不少token', 6000),
      say('灰灰子', '为什么', 8000),
      say('小鱼', '手快是好手快 搜的就是不太对', 6000),
      say('灰灰子', '多押韵', 8000),
      say('敢摸高压线', '开始互吃token了', 6000),
      say('灰灰子', '好好好', 8000),
      { wait: 30_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const convo = (i: number): boolean => t.policyReasons(i).some(w => w.includes('正在和她聊'))
      const speaking = (i: number): boolean => t.policyReasons(i).some(w => w.includes('她正在这个群里说话'))
      const heibai = ins.map((x, i) => i).filter(i => i > 0 && ins[i].who === '灰灰子' && ins[i].text !== '好好好')
      const others = ins.map((x, i) => i).filter(i => ins[i].who === 'IIIBeta2III' || ins[i].who === '敢摸高压线')
      const bot = ins.findIndex(i => i.who === '小鱼')
      const judged = heibai.filter(i => !speaking(i))
      const pend = t.marks.filter(m => m.type === 'convo.pending')
      // 他连说几句她都没接，对话按 convo.maxUnanswered 结束，之后的句子回到普通打分——所以只要求「没有一句 p=1」且对话没断时标着在聊
      return [
        t.expect(t.answered(0, 30_000), '@ 她的那句答了'),
        t.expect(t.startsBetween(1, 999) <= 3, `她答完 @ 之后的 8 条里开口 ${t.startsBetween(1, 999)} 次（≤ 3；真群当时 8 分钟 14 次）`),
        t.expect(judged.length > 0 && convo(judged[0]) && judged.every(i => (ins[i].policy?.p ?? 1) < 1) && pend.every(m => !/p=1 /.test(m.text)), `灰灰子的追问按「在聊」打分、没有一句 p=1（${judged.map(i => `「${ins[i].text}」${t.policyOf(i)}`).join(' / ')}${pend.length ? `；补判：${pend.map(m => m.text).join(' / ')}` : ''}）`),
        t.expect(others.every(i => !convo(i) && !(ins[i].policy?.p === 1)), `旁人插话不算在聊（${others.map(i => `「${ins[i].text}」${t.policyOf(i)}`).join(' / ')}）`),
        t.expect(bot >= 0 && !t.policyReasons(bot).some(w => w.includes('做事')) && (ins[bot].policy?.p ?? 1) < 1, `机器人那句不走「要她做事」直通（${t.policyOf(bot)}）`),
        t.expect(bot >= 0 && (!ins[bot].policy?.wake || !t.saidAfter(bot, /搜|手快|不太对|小鱼/)), `机器人那句没叫醒，或叫醒了也没对着它开口`),
        t.note(`唤醒大脑 ${t.woken()} 次；她说的：${t.outText().join(' / ') || '（一句没说）'}`),
      ]
    },
  },
  {
    // 真群乙（2026-10-22 23:21–23:29，seq 33715–34337）：她回了青山一句，青山接着跟群里聊他的火箭项目、群友都在 @ 他，
    // 他整段没 @ 她、没回她；可他每句白话都被当成「接着跟她说的」p=1 叫醒，她八分钟对他开口七次——「龙哥你这破烂标准」「不竞争就自己玩呗」
    // 「希望渺茫就别整大词了」「群友基金？凑起来够买一桶推进剂不」；青山冲白石说的「能不能不要老是说这些倭寇的语言」她当成说自己，回「倭寇是在说谁啊」；
    // 群友原木呀吐槽「@青山_NCV 这个机器人，他认为你在一直和他聊天」。
    // 现在要求：她答完 @ 之后，青山转头跟 KT77 说、群里换到猫咖 / 日语，她不再对着青山开口、不追问；对话因「没接她的话」放下；青山回头 @ 她再答
    id: 'real-ignored',
    title: '真群 23:21：她答完青山，青山转头跟别人聊、群里换话题 → 她不再对着青山开口；青山回头 @ 她再答',
    group: 900175,
    manual: true,
    settleMs: 60_000,
    steps: [
      { config: { timeRules: [], busyActions: [] } },
      say('青山', '我想拉群友一起搞个项目', 0),
      { who: '青山', text: '你觉得我们群友能搞出点名堂吗', at: true, after: 3000 },
      // 等她答完再往下：KT77 引用青山、青山接着跟 KT77 说（没 @、没回她），然后群里换话题
      ...IGNORED_AFTER.map(([who, text], i) => say(who, text, i === 0 ? 4000 : 6000, i === 0 ? { react: 45_000 } : {})),
      { wait: 20_000 },
      { who: '青山', text: '刚才群里太吵了，你说的我没看到，再说一遍呗', at: true, after: 2000 },
      { wait: 30_000 },
    ],
    check: (t) => {
      const ins = t.inbound()
      const ask = ins.findIndex(i => i.text.includes('能搞出点名堂'))
      const first = ins.findIndex(i => i.text.includes('不如搞上游'))
      const back = ins.findIndex(i => i.text.includes('再说一遍'))
      const cat = ins.findIndex(i => i.text.includes('猫咖'))
      const long = ins.map((x, i) => i).filter(i => i > first && i < back && ins[i].who === '青山_NCV')
      const ended = t.marks.filter(m => m.type === 'convo.ended' && m.text.startsWith('青山'))
      const after = t.startsBetween(first, back)
      // 群里换到猫咖时她插一句不算错（猫是她的兴趣）；错的是对着青山接——他的项目、他冲白石说的「倭寇」「鬼子话」、他的「群友基金」
      const atLong = ins.slice(first, back).some((_, k) => t.saidAfter(first + k, /倭寇|鬼子|上手|基金|上游|子系统|龙哥|青山|项目/))
      return [
        t.expect(t.answered(ask, 30_000), '@ 她的那句答了'),
        t.expect(ended.some(m => /没接她的话|群里在聊别的|转去跟别人说/.test(m.text)), `青山没接她的话，对话放下了（${ended.map(m => m.text).join(' / ') || '没有 convo.ended'}）`),
        // 不卡分数：「能不能不要老是说这些倭寇的语言」是问句，挨着她刚说完时会有通用的「有人在问 / 接她刚才的话」（0.3～0.4，叫不叫醒、接不接大脑定）；
        // 他刚转头那句还在聊她刚评论过的项目，话题线算「她参与的话题还在聊」是对的。要的是：哪句都不再是「正在和她聊」，
        // 群里换到猫咖之后他的话也不再沾「她参与的话题」（旧话题不加分），她也没去接（再下一条核对）
        t.expect(long.every(i => !t.policyReasons(i).some(w => w.includes('正在和她聊'))), `之后青山的话不再算「正在和她聊」（${long.map(i => `「${ins[i].text}」${t.policyOf(i)}`).join(' / ')}）`),
        t.expect(long.filter(i => i > cat).every(i => !t.policyReasons(i).some(w => w.includes('她参与的话题'))), '换话题之后青山的话不再算「她参与的话题还在聊」'),
        t.expect(!t.marks.some(m => m.type === 'convo.pending' && m.text.startsWith('青山') && m.t > (ins[first]?.t ?? 0)), `她说话时青山冲别人说的话没挂成「还没接」去补判（${t.marks.filter(m => m.type === 'convo.pending').map(m => m.text).join(' / ') || '没有补判'}）`),
        t.expect(after <= 1 && !atLong, `青山转头之后的 ${back - first} 句里她开口 ${after} 次、没对着青山接（真群当时八分钟对他七次，「倭寇」那句是冲白石说的）`),
        t.expect(t.answered(back, 30_000), '青山回头 @ 她，她答了'),
        t.note(`青山转头那句：${t.policyOf(first + 1)}`),
        t.note(`她说的：${t.outText().join(' / ') || '（一句没说）'}`),
      ]
    },
  },
]
