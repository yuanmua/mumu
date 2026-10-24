/**
 * 语义打分：一段话离她兴趣表里的哪条近、有多近。是她喜欢的话题就乘上唤醒概率，
 * 不靠代码做字面匹配——原来是关键词包含匹配，
 * 「火箭队今晚比赛」算航天、「猎鹰九号回收了」反而不算。
 *
 * - 向量（via local，默认）：每条兴趣（名字 + 一句描述 + 关键词拼成一句）、每条消息（clean 剥掉占位后的正文）各一个句向量，取余弦相似度，
 *   再**两头都减「平时」**——用一组日常闲话（background：「好的」「吃饭了没」「今晚加班到十点」…）量：
 *   兴趣的平时 = 它和这些闲话的平均相似度：不减的话，带「紧张、准备」这类泛词的兴趣（面试）和「在吗」「上班好累」都有 0.45 上下；
 *   这句话的平时 = 它离最近的 5 句闲话有多近，比闲话彼此之间（同样取最近 5 句）近出多少：「吃了吗」「中午吃啥」贴着吃饭那几句闲话，
 *   只减兴趣那头时「吃了吗」对甜食还有 0.56（2026-10-23 对照集，见 README）。
 *   减完 ≤ threshold 算不相关（0），≥ full 算满（1），中间线性 = 「相近度」；感兴趣程度 = 相近度 × 这条兴趣自己的分，取最高的那条。
 *   向量按文本缓存：兴趣改了关键词 = 文本变了，自然重算；重复的消息不重算。兴趣表那头插件装上就预热（warm）。
 * - 模型打分（via model）：没有向量模型时的退路，一次聊天模型调用回 {"topic","near"}（read.ts），同样按文本缓存。
 * - 限时：读空气等不起。timeoutMs 内没出结果就当 0（算出来的照样进缓存，同样的话下一次直接用）；兴趣表那头还没算好时至少等 1 秒；
 *   后端还没就绪（模型在加载）直接 0，不排队；出错也是 0，不抛——兴趣只是往上乘的一项，没有它读空气照常。
 */
import type { Hit } from './store.ts'

export type Vec = ArrayLike<number>

/** 后端二选一：embed 给句向量；rate 直接给「这句离哪条兴趣最近、多近」 */
export interface Backend {
  embed?: (text: string) => Promise<Vec>
  rate?: (text: string, items: Item[]) => Promise<{ topic: string, near: number } | undefined>
  ready?: () => boolean // false = 还在加载，这次直接 0
}

export interface SemanticConfig {
  threshold: number // 余弦减去「平时」后低于它算不相关
  full: number // 减完到它算满分相近
  background: string[] // 日常闲话：兴趣和消息两头的「平时」都拿它量；空 = 不减
  query: string // 消息前面加的检索指令（bge 系：「为这个句子生成表示以用于检索相关文章：」）；兴趣那头不加
  cacheSize: number
}

export interface Item { name: string, keywords: string[], desc?: string, score: number }

const r2 = (v: number): number => Math.round(v * 100) / 100
const r3 = (v: number): number => Math.round(v * 1000) / 1000
const mean = (a: number[]): number => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
const NEAREST = 5 // 一句话的「平时」看离它最近的几句闲话（对照集上 1 / 3 / 5 / 10 / 全部比过，5 最好）
/** 最近 NEAREST 个相似度的平均 */
const closest = (sims: number[]): number => mean([...sims].sort((a, b) => b - a).slice(0, NEAREST))
const MIN = 0.05 // 淡到这以下的兴趣不参与打分
const COLD_MS = 1000 // 兴趣表这头还没算好时至少等这么久（见 near）

/**
 * 进向量前只留人说的正文。表现端把图、表情包、转发、回复引用写成占位（「[图片]」「[表情包：…]」「[聊天记录：墨羽：[图片]；…]」
 * 「[回复 某人「…」]」），这些字不是这个人在说的话：10-23 回放里一条只有转发壳的消息对「音乐」相近 0.53。
 * 方括号从里往外剥（转发里套着 [图片]）；语音转写是他说的话，留内容。@某人、链接也剥。剩下不足 2 个字（字母 / 汉字）的当没说话。
 */
export function clean(text: string): string {
  let s = text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').replace(/@\S+\s?/g, ' ')
  for (let prev = ''; prev !== s;) {
    prev = s
    s = s.replace(/\[([^[\]]*)\]/g, (_, inner: string) => inner.startsWith('语音：') ? ` ${inner.slice(3)} ` : ' ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  return (s.match(/[\p{L}]/gu)?.length ?? 0) >= 2 ? s : ''
}

/**
 * 兴趣拿来算向量的那句话：名字 + 一句描述 + 关键词（关键词只在这里和展示、认同一个话题时用，不再拿来包含匹配）。
 * 只有名字和几个词时向量很「薄」：「猎鹰九号回收」对「航天：火箭、发射…」只有 0.1～0.2；写上这个话题平时聊什么，真在聊它的话才贴得近。
 */
export function itemText(i: { name: string, keywords: string[], desc?: string }): string {
  const kw = i.keywords.join('、')
  if (i.desc)
    return `${i.name}：${i.desc}${kw ? `。${kw}` : ''}`
  return kw ? `${i.name}：${kw}` : i.name
}

export function cosine(a: Vec, b: Vec): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** 余弦 → 相近度：低于 threshold 为 0，到 full 为 1 */
export function nearness(sim: number, c: Pick<SemanticConfig, 'threshold' | 'full'>): number {
  if (sim <= c.threshold)
    return 0
  return Math.min(1, (sim - c.threshold) / Math.max(1e-6, c.full - c.threshold))
}

export class Semantic {
  private cache = new Map<string, Promise<unknown>>()
  private hot = new Set<string>() // 兴趣那头已经算好的文本（向量 + 平时）

  constructor(private backend: Backend, private cfg: () => SemanticConfig, private onError: (e: unknown) => void = () => {}) {}

  /** 按 key 缓存一个异步结果（LRU）；失败的不留，下次重算 */
  private memo<T>(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as Promise<T> | undefined
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const p = make()
    p.catch(() => this.cache.delete(key))
    this.cache.set(key, p)
    const max = this.cfg().cacheSize
    while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value!)
    return p
  }

  private vec(text: string): Promise<Vec> {
    return this.memo(`v:${text}`, () => this.backend.embed!(text))
  }

  /** 日常闲话的向量，和一句闲话离别的闲话有多近（每句取最近 NEAREST 句的平均，再平均：消息那头减平时的参照） */
  private chatter(): Promise<{ vs: Vec[], self: number }> {
    return this.memo('chatter', async () => {
      const c = this.cfg()
      const vs = await Promise.all(c.background.map(s => this.vec(`${c.query}${s}`)))
      return { vs, self: mean(vs.map((x, i) => closest(vs.filter((_, j) => j !== i).map(y => cosine(x, y))))) }
    })
  }

  /** 一条兴趣的向量和它的「平时」（和日常闲话的平均相似度）；按兴趣文本缓存，兴趣变了 = 文本变了，只重算那一条 */
  private item(text: string): Promise<{ v: Vec, base: number }> {
    return this.memo(`i:${text}`, async () => {
      const [v, bg] = await Promise.all([this.vec(text), this.chatter()])
      this.hot.add(text)
      return { v, base: mean(bg.vs.map(x => cosine(v, x))) }
    })
  }

  /**
   * 预热：兴趣表这头（闲话基线、每条兴趣的向量与平时）先算好，之后每句群消息只算它自己。插件装上就调，兴趣表变了再调（缓存着的不重算）。
   * 不预热的话重载 / 重启后第一句要把整张表和几十句闲话一起算，虚拟机上超过限时，那句兴趣分是 0（10-23 早上线上量到 513 毫秒）。
   */
  async warm(items: Item[]): Promise<void> {
    if (!this.backend.embed)
      return
    await Promise.all([this.chatter(), ...items.filter(i => i.score >= MIN).map(i => this.item(itemText(i)))]).catch(e => this.onError(e))
  }

  /**
   * 这段话离哪些兴趣近（感兴趣程度高的在前；不近的不列）。先 clean 掉占位与转发壳。
   * timeoutMs：读空气给 300 毫秒；日志投影（谁提到了兴趣、她接没接）不卡谁，可以多等。
   * 兴趣表这头还没算好（刚装上 / 刚重载、预热没跑完，或表里刚加了一条）时至少等 COLD_MS：这一次要连兴趣一起算。
   */
  async near(text: string, items: Item[], timeoutMs: number): Promise<Hit[]> {
    const list = items.filter(i => i.score >= MIN)
    const said = clean(text)
    if (!said || !list.length || this.backend.ready?.() === false)
      return []
    const cold = !!this.backend.embed && list.some(i => !this.hot.has(itemText(i)))
    const work = this.compute(said, list).catch((e: unknown) => {
      this.onError(e)
      return [] as Hit[]
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<Hit[]>((resolve) => {
      timer = setTimeout(() => resolve([]), cold ? Math.max(timeoutMs, COLD_MS) : timeoutMs)
    })
    try {
      return await Promise.race([work, late])
    }
    finally {
      clearTimeout(timer)
    }
  }

  private async compute(text: string, items: Item[]): Promise<Hit[]> {
    const c = this.cfg()
    if (this.backend.embed) {
      const [q, bg, its] = await Promise.all([this.vec(`${c.query}${text}`), this.chatter(), Promise.all(items.map(i => this.item(itemText(i))))])
      // 这句自己的平时：它离最近的几句闲话有多近，比闲话彼此之间近出多少。「吃了吗」「中午吃啥」贴着吃饭那几句闲话、「狗修金」贴着称呼那几句：
      // 是闲话就减得多；「猎鹰九号回收」离哪句闲话都远，减得少（甚至加回来）。取全部闲话的平均会被别的几十句冲淡，「中午吃啥」对甜食还有 0.99
      // 闲话不到两句量不出「闲话彼此之间」，这头不减
      const own = bg.vs.length > 1 ? closest(bg.vs.map(x => cosine(q, x))) - bg.self : 0
      const out: Hit[] = []
      items.forEach((i, k) => {
        const near = r2(nearness(cosine(q, its[k].v) - its[k].base - own, c))
        if (near > 0)
          out.push({ name: i.name, near, score: r3(near * i.score) })
      })
      return out.sort((a, b) => b.score - a.score)
    }
    if (this.backend.rate) {
      const key = `r:${items.map(itemText).join('|')}:${text}`
      const got = await this.memo(key, () => this.backend.rate!(text, items))
      const it = got && items.find(i => i.name === got.topic)
      const near = it ? r2(Math.max(0, Math.min(1, got.near))) : 0
      return it && near > 0 ? [{ name: it.name, near, score: r3(near * it.score) }] : []
    }
    return []
  }
}
