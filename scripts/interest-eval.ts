/**
 * 兴趣语义打分的对照集（2026-10-23）：20 句真在聊她的兴趣、20 句字面像 / 群里常见但不是，量一组参数分不分得开；
 * 另有 15 句「有具体话题、但不是她的兴趣」（篮球、股票、考研…），防止参数只学会了「短句都算假」。
 * 直接在本机加载向量模型算（不起后端）；兴趣表默认用清单里的人设种子（分都当 1，看的是相近度），也可以 --db 读一份库的 int_items。
 *   npx tsx scripts/interest-eval.ts                       # 现行默认值（插件里的 Semantic 原样算）：每句的相近度 + 汇总
 *   npx tsx scripts/interest-eval.ts --grid                # 比几组参数（减平时的算法 / 闲话基线 / 描述 / 模型 / 阈值）
 *   npx tsx scripts/interest-eval.ts --db data/mumu.db     # 用库里的兴趣表（克隆实例跑场景用的就是它）
 *   npx tsx scripts/interest-eval.ts --corpus data/corpus/real-2026-10-22-900902.jsonl   # 真群语料里相近度最高的 30 句（找假阳性用）
 * 汇总：AUC（随便抽一句真的、一句假的，真的那句分更高的概率；看减完平时的原始差值，和阈值无关）、
 *       相近度均值差（真兴趣平均 − 假阳性平均）、真的有几句 ≥ 0.5、假的有几句 > 0。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import process from 'node:process'
import { localBackend } from '../plugins/official/interests/local.ts'
import type { Item, Vec } from '../plugins/official/interests/semantic.ts'
import { clean, cosine, itemText, nearness, Semantic } from '../plugins/official/interests/semantic.ts'

const args = process.argv.slice(2)
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** [句子, 该是哪条兴趣]；兴趣写 '' = 不该相近 */
export const CONTROL: [string, string][] = [
  ['猎鹰九号那个回收你们看了吗', '航天'],
  ['马斯克的筷子又夹住一级了', '航天'],
  ['神舟二十号今晚几点点火', '航天'],
  ['昨晚长征五号发射直播看了没', '航天'],
  ['空间站的宇航员在上面怎么洗澡啊', '航天'],
  ['周杰伦新专辑终于出了，循环一晚上', '音乐'],
  ['有没有人去看五月天的演唱会', '音乐'],
  ['最近耳机里一直放陈奕迅', '音乐'],
  ['楼下新开了家蛋糕店，草莓千层绝了', '甜食'],
  ['下午茶来杯奶茶配提拉米苏', '甜食'],
  ['冰淇淋第二份半价冲不冲', '甜食'],
  ['我家橘猫又把杯子推地上了', '猫'],
  ['楼下流浪猫生了一窝小奶猫', '猫'],
  ['布偶掉毛好严重怎么办', '猫'],
  ['苹果发布会那个新芯片性能提升好大', '新科技'],
  ['折叠屏手机现在还容易坏吗', '新科技'],
  ['Vision Pro 戴着看电影是什么体验', '新科技'],
  ['你知道吗，章鱼有三颗心脏', '冷知识'],
  ['原来香蕉是浆果，草莓反而不是', '冷知识'],
  ['蜂蜜放三千年都不会坏', '冷知识'],
  // 字面像 / 群里常见，但不是在聊她的兴趣（前三句是 10-23 早上线上 / 克隆核对挂掉的；末三句是表现端的占位壳）
  ['吃了吗', ''],
  ['我管你叫哦鲸鲸 你管我叫狗修金', ''],
  ['又要加班', ''],
  ['火箭队今晚比赛谁去看', ''],
  ['房价涨得跟坐火箭似的', ''],
  ['他升职简直坐火箭', ''],
  ['这瓜甜不甜', ''],
  ['你这嘴真甜', ''],
  ['别猫在被窝里了快起床', ''],
  ['你是夜猫子吧天天这么晚', ''],
  ['发布会开完了，会议纪要谁写', ''],
  ['饭卡芯片坏了刷不了', ''],
  ['你知道吗，我昨天又被老板骂了', ''],
  ['原来是你偷吃了我的饼干', ''],
  ['外卖小哥是送到月球去了吧', ''],
  ['今天地铁好挤', ''],
  ['地铁挤，中午吃了碗面', ''],
  ['在吗', ''],
  ['[聊天记录：墨羽：[图片]；墨羽：[图片]；墨羽：[表情包：狗头]]', ''],
  ['[回复 墨羽「哈哈哈」] 笑死', ''],
]
/** 有具体话题、但不是她的兴趣：不进 40 句的汇总，单列一行 */
export const TOPICAL = ['湖人今天又输了，詹姆斯得了三十分', '这周A股跌麻了，基金全绿', '考研数学二今年难不难', '这个 bug 调了一下午，空指针', '原神新版本的角色抽不抽',
  '曼联换帅了你们知道吗', '房东又要涨房租', '驾照科目二又挂了', '我妈让我回家相亲', '高铁票抢不到了', '这件羽绒服打折到三百', '新来的同事是东北的', '明天体检要空腹吗', '电动车电池换一个多少钱', '周末去爬山吗']

interface Defaults { seed: Seed[], semantic: { background: string[], threshold: number, full: number, model: string, cacheSize: number, query: string } }
interface Seed { name: string, keywords?: string[], desc?: string }
const D = (JSON.parse(readFileSync(new URL('../plugins/official/interests/package.json', import.meta.url), 'utf8')) as { mumu: { defaults: Defaults } }).mumu.defaults

/** 兴趣表：种子，或库里在表的（库里没写描述的人设兴趣按同名种子补，和插件装上时一样） */
function itemsOf(db?: string): Item[] {
  if (!db)
    return D.seed.map(s => ({ name: s.name, keywords: s.keywords ?? [], desc: s.desc ?? '', score: 1 }))
  const rows = new DatabaseSync(db, { readOnly: true }).prepare(`SELECT * FROM int_items WHERE state = 'on' AND score >= 0.05`).all() as { name: string, keywords: string, descr?: string }[]
  return rows.map(r => ({ name: r.name, keywords: JSON.parse(r.keywords) as string[], desc: r.descr || D.seed.find(s => s.name === r.name)?.desc || '', score: 1 }))
}

const backends = new Map<string, (t: string) => Promise<Vec>>()
function embedder(model: string): (t: string) => Promise<Vec> {
  let e = backends.get(model)
  if (!e) {
    const b = localBackend({ model, dtype: 'q8', pooling: 'cls', cacheDir: 'data/models', remoteHost: 'https://hf-mirror.com/' }, err => console.error(err))
    const cache = new Map<string, Promise<Vec>>()
    e = (t: string) => cache.get(t) ?? (cache.set(t, b.embed(t)), cache.get(t)!)
    backends.set(model, e)
  }
  return e
}

const mean = (a: number[]): number => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
const f2 = (v: number): string => v.toFixed(2)

/**
 * 消息那头减不减平时：item = 只减兴趣那头（10-23 早上的算法）；mean = 这句和全部闲话的平均；
 * near = 这句离最近 5 句闲话（现行，semantic.ts 的 NEAREST）
 */
type Own = 'item' | 'mean' | 'near'
interface Setup { model: string, background: string[], desc: boolean, own: Own, raw?: boolean } // raw = 不清洗（改前）
const topk = (a: number[], k: number): number => mean([...a].sort((x, y) => y - x).slice(0, k))
/**
 * 每句：减完平时后离哪条最近、差多少（原始值，没过阈值）。和 semantic.ts 同一个算法，拆开写是为了比别的算法
 * 和算 AUC（插件只给过了阈值、取两位的相近度）；现行默认值那一档由下面的 Semantic 原样再算一遍对得上。
 */
async function raw(s: Setup, items: Item[], texts: string[]): Promise<{ name: string, diff: number }[]> {
  const embed = embedder(s.model)
  const iv = await Promise.all(items.map(i => embed(itemText({ ...i, desc: s.desc ? i.desc : '' }))))
  const bv = await Promise.all(s.background.map(t => embed(t)))
  const base = iv.map(v => mean(bv.map(x => cosine(v, x))))
  const k = s.own === 'near' ? 5 : bv.length
  const self = mean(bv.map((x, i) => topk(bv.filter((_, j) => j !== i).map(y => cosine(x, y)), k)))
  const out = []
  for (const t of texts) {
    const said = s.raw ? t.trim() : clean(t)
    if (!said) {
      out.push({ name: '', diff: -1 })
      continue
    }
    const q = await embed(said)
    const own = s.own !== 'item' && bv.length ? topk(bv.map(x => cosine(q, x)), k) - self : 0
    let best = { name: '', diff: -Infinity }
    iv.forEach((v, k) => {
      const d = cosine(q, v) - base[k] - own
      if (d > best.diff)
        best = { name: items[k].name, diff: d }
    })
    out.push(best)
  }
  return out
}

function auc(pos: number[], neg: number[]): number {
  let n = 0
  for (const p of pos) {
    for (const q of neg) n += p > q ? 1 : p === q ? 0.5 : 0
  }
  return n / (pos.length * neg.length)
}

/** r：CONTROL 40 句 + TOPICAL 15 句 + SCENE 的原始差值 */
function summary(r: { diff: number }[], th: number, full: number): string {
  const n = (x: { diff: number }): number => nearness(x.diff, { threshold: th, full })
  const pos = r.slice(0, 20)
  const neg = r.slice(20, 40)
  const topical = r.slice(40, 55)
  const scene = r.slice(55)
  const pm = mean(pos.map(n))
  const nm = mean(neg.map(n))
  return `${f2(auc(pos.map(x => x.diff), neg.map(x => x.diff)))} | ${f2(pm)} | ${f2(nm)} | ${f2(pm - nm)} | ${pos.filter(x => n(x) >= 0.5).length}/20 | ${neg.filter(x => n(x) > 0).length}/20 | ${topical.filter(x => n(x) > 0).length}/15 | ${scene.filter(x => n(x) > 0).length}/${scene.length}`
}
const HEAD = 'AUC | 真均 | 假均 | 均值差 | 真≥0.5 | 假>0 | 话题负例>0 | 场景闲话>0'

/** 模拟器 boring-rocket 前 40 句灌水与 real-convo-spam 里不该沾兴趣的话（去重；纯符号的剥完就没了，不列） */
const SCENE = ['哈哈哈', '吃了吗', '今天好热', '上班好累', '摸鱼中', '下午开会', '外卖到了', '困死了', '又要加班', '周五了', '下雨了', '地铁好挤', '我先下了',
  '回来了', '真的假的', '笑死', '好家伙', '中午吃啥', '随便', '不知道', '有道理', '确实', '嗯嗯', '这鱼怎么感觉没那么聪明', '哦鲸鲸？', '我没给他上太多功能',
  '这样 我管你叫哦鲸鲸 你管我叫狗修金', '先生这得花不少token', '为什么', '手快是好手快 搜的就是不太对', '多押韵', '开始互吃token了', '好好好']

const items = itemsOf(opt('db'))
const texts = [...CONTROL.map(c => c[0]), ...TOPICAL, ...SCENE]

if (!process.argv[1]?.endsWith('interest-eval.ts')) {
  // 被别的脚本 import 来拿对照集：不跑
}
else if (opt('text')) {
  // 现场看几句（| 分隔）：每条兴趣减完平时的原始差值和相近度
  const cfg = D.semantic
  for (const t of opt('text')!.split('|')) {
    const all = await Promise.all(items.map(async i => ({ i, r: (await raw({ model: cfg.model, background: cfg.background, desc: true, own: 'near' }, [i], [t]))[0] })))
    console.log(`${t} → ${all.sort((a, b) => b.r.diff - a.r.diff).slice(0, 3).map(x => `${x.i.name} ${x.r.diff.toFixed(3)}（${f2(nearness(x.r.diff, cfg))}）`).join('  ')}`)
  }
}
else if (opt('corpus')) {
  const rows = readFileSync(opt('corpus')!, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: string, text?: string })
  const lines = [...new Set(rows.filter(r => r.t === 'msg' && r.text).map(r => r.text!))].slice(0, Number(opt('limit') ?? 3000))
  const r = await raw({ model: D.semantic.model, background: D.semantic.background, desc: true, own: (opt('own') ?? 'near') as Own }, items, lines)
  const top = r.map((x, k) => ({ ...x, text: lines[k], near: nearness(x.diff, D.semantic) })).sort((a, b) => b.diff - a.diff).slice(0, 30)
  for (const x of top) console.log(`${f2(x.near)}  ${x.name.padEnd(4, '　')}  ${x.text.slice(0, 60)}`)
}
else if (args.includes('--grid')) {
  const models = (opt('models') ?? 'Xenova/bge-base-zh-v1.5,Xenova/bge-large-zh-v1.5').split(',')
  const ths: [number, number][] = [[0.06, 0.16], [0.10, 0.20], [0.12, 0.22], [0.14, 0.24], [0.16, 0.26], [0.18, 0.28], [0.20, 0.30]]
  const ownName = { item: '只兴趣', mean: '两头·均值', near: '两头·最近5' }
  console.log(`| 模型 | 减平时 | 闲话 | 描述 | 阈值 | ${HEAD} |\n|${'---|'.repeat(13)}`)
  for (const model of models) {
    for (const own of ['item', 'mean', 'near'] as const) {
      for (const [bgName, background] of [['20', D.semantic.background.slice(0, 20)], ['60', D.semantic.background]] as const) {
        for (const desc of [false, true]) {
          const r = await raw({ model, background, desc, own }, items, texts)
          for (const [th, full] of ths) console.log(`| ${model.split('/')[1]} | ${ownName[own]} | ${bgName} | ${desc ? '有' : '无'} | ${th.toFixed(2)}/${full.toFixed(2)} | ${summary(r, th, full)} |`)
        }
      }
    }
  }
}
else {
  // 现行默认值：插件里的 Semantic 原样算（含清洗、描述、两头减平时）
  const cfg = { ...D.semantic, threshold: Number(opt('threshold') ?? D.semantic.threshold), full: Number(opt('full') ?? D.semantic.full) }
  const sem = new Semantic({ embed: embedder(cfg.model) }, () => cfg, e => console.error(e))
  const t0 = performance.now()
  await sem.warm(items)
  console.log(`${cfg.model} 闲话 ${cfg.background.length} 句 阈值 ${cfg.threshold}/${cfg.full}（预热 ${Math.round(performance.now() - t0)} 毫秒）`)
  // 改前 = 10-23 早上线的：不清洗、只减兴趣那头、20 句闲话、没描述、阈值 0.06/0.16
  const OLD = { threshold: 0.06, full: 0.16 }
  const before = await raw({ model: cfg.model, background: cfg.background.slice(0, 20), desc: false, own: 'item', raw: true }, items, texts)
  console.log('| 句子 | 该是 | 改前 | 现在 |\n|---|---|---|---|')
  const r = await raw({ model: cfg.model, background: cfg.background, desc: true, own: 'near' }, items, texts)
  for (const [k, t] of texts.entries()) {
    const hit = (await sem.near(t, items, 5000))[0]
    const old = nearness(before[k].diff, OLD)
    const show = (name: string | undefined, v: number): string => v > 0 ? `${name} ${f2(v)}` : '0'
    console.log(`| ${t.replace(/\|/g, '｜')} | ${k < 20 ? CONTROL[k][1] : '—'} | ${show(before[k].name, old)} | ${clean(t) ? show(hit?.name, hit?.near ?? 0) : '0（剥完没字）'} |`)
    if (Math.abs((hit?.near ?? 0) - nearness(r[k].diff, cfg)) > 0.011)
      console.error(`对不上：${t} 插件 ${hit?.near} / 脚本 ${f2(nearness(r[k].diff, cfg))}`)
  }
  console.log(`\n| | ${HEAD} |\n|${'---|'.repeat(9)}\n| 改前 | ${summary(before, OLD.threshold, OLD.full)} |\n| 现在 | ${summary(r, cfg.threshold, cfg.full)} |`)
}
if (process.argv[1]?.endsWith('interest-eval.ts'))
  process.exit(0) // transformers 的线程池不会自己退
