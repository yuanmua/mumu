/**
 * 兴趣表：用 storage-sqlite 给的 db 裸句柄开自己的表（int_*），不进配置树、不随日志清空。
 *
 * - int_items：一个兴趣一行（名字、一句描述 descr、关键词…）。分值 0～1 存的是「updated_at 那一刻」的值，读时按半衰期往 floor 回落（惰性衰减，
 *   不用定时器挨个改库）；人设种下的 floor 不为 0——人设里的爱好淡了也还在，自己学来的淡到 0 就算忘了。
 *   state：on = 在表里（参与打分、给大脑看）；candidate = 她投入聊过、但次数还没够进表的新话题（只在面板里看得见）。
 *   source：persona 人设种的 / self 她自己（聊出来的、显式说的、大脑标的）/ user 用户在网页或命令里改过。
 * - int_meta：seeded（种过一次就不再种：用户删掉的人设兴趣不会自己长回来）、cursor（日志看到哪了，重载后接着攒）。
 */
import type { DatabaseSync } from 'node:sqlite'

export type Source = 'persona' | 'self' | 'user'
export type State = 'on' | 'candidate'

export interface Interest {
  name: string
  desc: string // 一句话：这个话题平时聊些什么（算语义向量用，见 semantic.ts itemText）；人设种子写好的，她自己学来的由认话题的模型给
  keywords: string[]
  votes: Record<string, number> // 候选阶段每段给的词各几票（进表时只留 ≥2 票的，见 learn.ts）
  score: number // 已衰减到「现在」的值
  floor: number
  source: Source
  state: State
  hits: number // 投入聊过几次（候选靠它进表）
  misses: number // 连续几次聊到了她没接
  lastAt: number // 最近一次在聊天里被提到
  updatedAt: number
  note: string // 最近一次为什么变
  createdAt: number
}

export interface Seed { name: string, desc?: string, keywords?: string[], score?: number }

/** 一条相近的兴趣（semantic.ts 算的）：near 相近度 0～1，score = near × 兴趣分 */
export interface Hit { name: string, near: number, score: number }

interface Row {
  name: string
  descr: string
  keywords: string
  votes: string
  score: number
  floor: number
  source: string
  state: string
  hits: number
  misses: number
  last_at: number
  updated_at: number
  note: string
  created_at: number
}

const DAY = 86_400_000
const clamp = (v: number): number => Math.max(0, Math.min(1, v))
const round = (v: number): number => Math.round(v * 1000) / 1000

/** 衰减：从 updatedAt 起按半衰期往 floor 回落（高于 floor 往下、低于 floor 往上——被说过没意思的人设兴趣也会慢慢回来） */
export function decayed(score: number, floor: number, updatedAt: number, now: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0 || now <= updatedAt)
    return score
  return floor + (score - floor) * 0.5 ** ((now - updatedAt) / (halfLifeDays * DAY))
}

export class InterestStore {
  constructor(private db: DatabaseSync, private halfLifeDays: () => number) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS int_items (
        name TEXT PRIMARY KEY, keywords TEXT NOT NULL DEFAULT '[]', votes TEXT NOT NULL DEFAULT '{}', score REAL NOT NULL, floor REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'on', hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS int_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    // 后加的列（descr = 描述；desc 是 SQL 关键字，换个名）：只有加列之前建的表才缺，已有时报 duplicate column，忽略即可
    for (const col of [`votes TEXT NOT NULL DEFAULT '{}'`, `descr TEXT NOT NULL DEFAULT ''`]) {
      try {
        db.exec(`ALTER TABLE int_items ADD COLUMN ${col}`)
      }
      catch {
        // 见上
      }
    }
  }

  private toItem(r: Row, now: number): Interest {
    return {
      name: r.name,
      desc: r.descr ?? '',
      keywords: JSON.parse(r.keywords) as string[],
      votes: JSON.parse(r.votes || '{}') as Record<string, number>,
      score: round(decayed(r.score, r.floor, r.updated_at, now, this.halfLifeDays())),
      floor: r.floor,
      source: r.source as Source,
      state: r.state as State,
      hits: r.hits,
      misses: r.misses,
      lastAt: r.last_at,
      updatedAt: r.updated_at,
      note: r.note,
      createdAt: r.created_at,
    }
  }

  meta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM int_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO int_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /** 第一次装上时从人设种下；种过就不再种（删掉的不会自己长回来） */
  seed(seeds: Seed[], floor: number, now = Date.now()): number {
    if (this.meta('seeded'))
      return 0
    let n = 0
    for (const s of seeds) {
      if (!s.name || this.get(s.name))
        continue
      const score = clamp(s.score ?? 0.6)
      this.put({ name: s.name, desc: s.desc ?? '', keywords: s.keywords ?? [], votes: {}, score, floor: Math.min(floor, score), source: 'persona', state: 'on', hits: 0, misses: 0, lastAt: 0, updatedAt: now, note: '人设里的爱好', createdAt: now })
      n++
    }
    this.setMeta('seeded', String(now))
    return n
  }

  /**
   * 种子里的描述补给同名、还没有描述的条目：描述是后加的（10-23），早先种下的人设兴趣没有；以后种子改了描述也照这样补到空的上。
   * 有描述的不动（她自己 / 用户写的不被种子盖掉）。只改描述，不动分和时间。
   */
  describe(seeds: Seed[]): void {
    const st = this.db.prepare(`UPDATE int_items SET descr = ? WHERE name = ? AND descr = ''`)
    for (const s of seeds) {
      if (s.name && s.desc)
        st.run(s.desc, s.name)
    }
  }

  list(now = Date.now()): Interest[] {
    return (this.db.prepare('SELECT * FROM int_items').all() as unknown as Row[]).map(r => this.toItem(r, now))
      .sort((a, b) => (a.state === b.state ? 0 : a.state === 'on' ? -1 : 1) || b.score - a.score)
  }

  active(now = Date.now()): Interest[] {
    return this.list(now).filter(i => i.state === 'on')
  }

  get(name: string, now = Date.now()): Interest | undefined {
    const r = this.db.prepare('SELECT * FROM int_items WHERE name = ?').get(name) as Row | undefined
    return r ? this.toItem(r, now) : undefined
  }

  /** 同一个话题：名字相同，或一方的名字是另一方的关键词，或共有两个以上关键词 */
  find(name: string, keywords: string[] = [], now = Date.now()): Interest | undefined {
    const exact = this.get(name, now)
    if (exact)
      return exact
    const kws = new Set([name, ...keywords].map(k => k.toLowerCase()))
    return this.list(now).find((i) => {
      const theirs = [i.name, ...i.keywords].map(k => k.toLowerCase())
      if (kws.has(i.name.toLowerCase()) || theirs.includes(name.toLowerCase()))
        return true
      return theirs.filter(k => kws.has(k)).length >= 2
    })
  }

  put(it: Interest): void {
    this.db.prepare(`INSERT INTO int_items (name, descr, keywords, votes, score, floor, source, state, hits, misses, last_at, updated_at, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET descr = excluded.descr, keywords = excluded.keywords, votes = excluded.votes, score = excluded.score, floor = excluded.floor, source = excluded.source,
        state = excluded.state, hits = excluded.hits, misses = excluded.misses, last_at = excluded.last_at, updated_at = excluded.updated_at, note = excluded.note`)
      .run(it.name, it.desc, JSON.stringify(it.keywords.slice(0, 12)), JSON.stringify(it.votes), round(clamp(it.score)), it.floor, it.source, it.state, it.hits, it.misses, it.lastAt, it.updatedAt, it.note, it.createdAt)
  }

  /** 改一条：先把衰减结算到现在，再套改动；分值夹在 0～1 */
  change(name: string, fn: (it: Interest) => void, now = Date.now()): Interest | undefined {
    const it = this.get(name, now)
    if (!it)
      return undefined
    fn(it)
    it.score = clamp(it.score)
    it.updatedAt = now
    this.put(it)
    return it
  }

  remove(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM int_items WHERE name = ?').run(name).changes) > 0
  }

  /** 聊天里被提到：只记时间，不动分 */
  touch(names: string[], at: number): void {
    const st = this.db.prepare('UPDATE int_items SET last_at = MAX(last_at, ?) WHERE name = ?')
    for (const n of names) st.run(at, n)
  }

  /** 忘掉：自己学来的淡到几乎为 0、又很久没被提到；候选很久没再聊到。人设和用户加的不自动删 */
  sweep(now: number, idleDays: number): string[] {
    const gone = this.list(now).filter(i => i.source === 'self' && now - Math.max(i.lastAt, i.updatedAt) > idleDays * DAY && (i.state === 'candidate' || i.score < 0.05))
    for (const i of gone) this.remove(i.name)
    return gone.map(i => i.name)
  }
}
