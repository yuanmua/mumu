/**
 * 记忆的表：用 storage-sqlite 给的 db 裸句柄开自己的表（mem_*），不进配置树、不随日志清空。
 *
 * - mem_people：一人一行。interacted 表示跟她打过交道（只有这些人才有印象与事实）；其他人只记名字。
 *   印象分两份：impression 只由群聊更新、哪儿都能想起；private_impression 只由一对一更新、只在跟本人一对一时想起。
 *   私事不能靠提示词「别写进印象」来挡（模型照写过），所以从结构上隔开。
 * - mem_episodes：中期摘要。一段会话一行，记来源频道、时间范围、参与的人（召回按人、按来源过滤）。
 * - mem_groups：群印象。
 * - mem_cursor：每个会话压到哪个时刻了（重启后从日志里接着攒）。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface Fact { text: string, channel: string, at: number }

export interface Person {
  id: string
  name: string
  names: string[]
  impression: string // 公开印象：群聊里形成的，哪儿都能想起
  privateImpression: string // 一对一里形成的，只在跟本人一对一时想起
  facts: Fact[]
  interacted: boolean
  firstAt: number
  lastAt: number
  lastChannel: string
}

export interface Episode {
  id: number
  channel: string
  fromAt: number
  toAt: number
  summary: string
  cues: string[]
  people: string[]
}

export class MemoryStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mem_people (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, names TEXT NOT NULL DEFAULT '[]',
        impression TEXT NOT NULL DEFAULT '', facts TEXT NOT NULL DEFAULT '[]', interacted INTEGER NOT NULL DEFAULT 0,
        first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, last_channel TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS mem_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
        summary TEXT NOT NULL, cues TEXT NOT NULL DEFAULT '[]', people TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_mem_episodes_channel ON mem_episodes(channel, to_at);
      CREATE TABLE IF NOT EXISTS mem_groups (channel TEXT PRIMARY KEY, impression TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mem_cursor (channel TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `)
    try {
      db.exec('ALTER TABLE mem_people ADD COLUMN private_impression TEXT NOT NULL DEFAULT \'\'')
    }
    catch {
      // 列已经有了（第二次起）：ALTER 报 duplicate column，安全
    }
  }

  person(id: string): Person | undefined {
    const r = this.db.prepare('SELECT * FROM mem_people WHERE id = ?').get(id) as Row | undefined
    return r ? toPerson(r) : undefined
  }

  /** 按名字找（/memory who 用）：现名或曾用名 */
  findByName(name: string): Person[] {
    const rows = this.db.prepare('SELECT * FROM mem_people WHERE name = ? OR names LIKE ? LIMIT 10').all(name, `%"${name}"%`) as unknown as Row[]
    return rows.map(toPerson)
  }

  /** 见到一个人：没有就建，名字变了记进曾用名；interacted 只升不降 */
  seen(id: string, name: string, channel: string, at: number, interacted: boolean): void {
    const p = this.person(id)
    if (!p) {
      this.db.prepare('INSERT INTO mem_people (id, name, names, first_at, last_at, last_channel, interacted) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, JSON.stringify([name]), at, at, channel, interacted ? 1 : 0)
      return
    }
    const names = p.names.includes(name) ? p.names : [...p.names, name].slice(-8)
    this.db.prepare('UPDATE mem_people SET name = ?, names = ?, last_at = ?, last_channel = ?, interacted = MAX(interacted, ?) WHERE id = ?')
      .run(name, JSON.stringify(names), at, channel, interacted ? 1 : 0, id)
  }

  /** 摘要后更新：整条印象换新（群聊更新公开印象，一对一更新私下印象），事实追加去重、只留最近 maxFacts 条 */
  update(id: string, impression: string, facts: Fact[], maxFacts: number, oneToOne = false): void {
    const p = this.person(id)
    if (!p)
      return
    const all = [...p.facts]
    for (const f of facts) {
      if (f.text && !all.some(x => x.text === f.text))
        all.push(f)
    }
    const col = oneToOne ? 'private_impression' : 'impression'
    this.db.prepare(`UPDATE mem_people SET ${col} = ?, facts = ? WHERE id = ?`)
      .run(impression || (oneToOne ? p.privateImpression : p.impression), JSON.stringify(all.slice(-maxFacts)), id)
  }

  /**
   * 她自己做的、要记住的事（group-policy 的 temper：不理 / 拉黑了谁、为什么）：
   * 一句话追加进公开印象（群里形成的，哪儿都想得起），再记一条带来源的事实。印象里已经有这句就不重复；
   * 之后压摘要会整条换新印象，但事实留着，召回时还看得到
   */
  note(id: string, name: string, channel: string, at: number, impressionNote: string, fact: string | undefined, maxFacts: number): void {
    this.seen(id, name, channel, at, true)
    const p = this.person(id)!
    const impression = impressionNote && !p.impression.includes(impressionNote)
      ? [p.impression, impressionNote].filter(Boolean).join('；')
      : p.impression
    const facts = fact && !p.facts.some(f => f.text === fact) ? [...p.facts, { text: fact, channel, at }].slice(-maxFacts) : p.facts
    this.db.prepare('UPDATE mem_people SET impression = ?, facts = ? WHERE id = ?').run(impression, JSON.stringify(facts), id)
  }

  /** 网页面板 / 命令改印象 */
  // ── 网页面板用：列、删 ──
  listPeople(limit: number): Person[] {
    const rows = this.db.prepare('SELECT * FROM mem_people WHERE interacted = 1 ORDER BY last_at DESC LIMIT ?').all(limit) as unknown as Row[]
    return rows.map(toPerson)
  }

  listGroups(): { channel: string, impression: string, updatedAt: number }[] {
    const rows = this.db.prepare('SELECT channel, impression, updated_at FROM mem_groups ORDER BY updated_at DESC').all() as unknown as { channel: string, impression: string, updated_at: number }[]
    return rows.map(r => ({ channel: r.channel, impression: r.impression, updatedAt: r.updated_at }))
  }

  listEpisodes(limit: number): Episode[] {
    const rows = this.db.prepare('SELECT * FROM mem_episodes ORDER BY to_at DESC LIMIT ?').all(limit) as unknown as EpisodeRow[]
    return rows.map(toEpisode)
  }

  deleteEpisode(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM mem_episodes WHERE id = ?').run(id).changes) > 0
  }

  deleteGroup(channel: string): boolean {
    return Number(this.db.prepare('DELETE FROM mem_groups WHERE channel = ?').run(channel).changes) > 0
  }

  /** 清掉一个人的印象与事实，但留着「认识这个人」（名字） */
  wipe(id: string): boolean {
    return Number(this.db.prepare('UPDATE mem_people SET impression = \'\', private_impression = \'\', facts = \'[]\' WHERE id = ?').run(id).changes) > 0
  }

  /** 打过交道的人的名字表（召回时认「话里提到了谁」） */
  knownNames(): { id: string, names: string[] }[] {
    const rows = this.db.prepare('SELECT id, names FROM mem_people WHERE interacted = 1').all() as unknown as { id: string, names: string }[]
    return rows.map(r => ({ id: r.id, names: parseArr<string>(r.names) }))
  }

  forget(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM mem_people WHERE id = ?').run(id).changes) > 0
  }

  addEpisode(e: Omit<Episode, 'id'>): void {
    this.db.prepare('INSERT INTO mem_episodes (channel, from_at, to_at, summary, cues, people, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.channel, e.fromAt, e.toAt, e.summary, JSON.stringify(e.cues), JSON.stringify(e.people), Date.now())
  }

  /** 某会话最近的几段摘要（新的在后） */
  episodesOf(channel: string, limit: number): Episode[] {
    const rows = this.db.prepare('SELECT * FROM mem_episodes WHERE channel = ? ORDER BY to_at DESC LIMIT ?').all(channel, limit) as unknown as EpisodeRow[]
    return rows.map(toEpisode).reverse()
  }

  /** 有某人参与的摘要（新的在前）；召回时再按来源过滤 */
  episodesWith(person: string, limit: number): Episode[] {
    const rows = this.db.prepare('SELECT * FROM mem_episodes WHERE people LIKE ? ORDER BY to_at DESC LIMIT ?').all(`%"${person}"%`, limit) as unknown as EpisodeRow[]
    return rows.map(toEpisode)
  }

  groupImpression(channel: string): string {
    const r = this.db.prepare('SELECT impression FROM mem_groups WHERE channel = ?').get(channel) as { impression: string } | undefined
    return r?.impression ?? ''
  }

  setGroupImpression(channel: string, text: string): void {
    this.db.prepare('INSERT INTO mem_groups (channel, impression, updated_at) VALUES (?, ?, ?) ON CONFLICT(channel) DO UPDATE SET impression = excluded.impression, updated_at = excluded.updated_at')
      .run(channel, text, Date.now())
  }

  cursor(channel: string): number {
    const r = this.db.prepare('SELECT at FROM mem_cursor WHERE channel = ?').get(channel) as { at: number } | undefined
    return r?.at ?? 0
  }

  cursors(): Map<string, number> {
    const rows = this.db.prepare('SELECT channel, at FROM mem_cursor').all() as { channel: string, at: number }[]
    return new Map(rows.map(r => [r.channel, r.at]))
  }

  setCursor(channel: string, at: number): void {
    this.db.prepare('INSERT INTO mem_cursor (channel, at) VALUES (?, ?) ON CONFLICT(channel) DO UPDATE SET at = excluded.at').run(channel, at)
  }

  stats(): { people: number, interacted: number, episodes: number, groups: number, bytes: number } {
    const one = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number | null }).n ?? 0)
    return {
      people: one('SELECT COUNT(*) AS n FROM mem_people'),
      interacted: one('SELECT COUNT(*) AS n FROM mem_people WHERE interacted = 1'),
      episodes: one('SELECT COUNT(*) AS n FROM mem_episodes'),
      groups: one('SELECT COUNT(*) AS n FROM mem_groups'),
      bytes: one('SELECT SUM(LENGTH(impression) + LENGTH(facts)) AS n FROM mem_people') + one('SELECT SUM(LENGTH(summary) + LENGTH(cues)) AS n FROM mem_episodes'),
    }
  }
}

interface Row {
  id: string
  name: string
  names: string
  impression: string
  private_impression?: string
  facts: string
  interacted: number
  first_at: number
  last_at: number
  last_channel: string
}

interface EpisodeRow {
  id: number
  channel: string
  from_at: number
  to_at: number
  summary: string
  cues: string
  people: string
}

function toPerson(r: Row): Person {
  return {
    id: r.id,
    name: r.name,
    names: parseArr<string>(r.names),
    impression: r.impression,
    privateImpression: r.private_impression ?? '',
    facts: parseArr<Fact>(r.facts),
    interacted: !!r.interacted,
    firstAt: r.first_at,
    lastAt: r.last_at,
    lastChannel: r.last_channel,
  }
}

function toEpisode(r: EpisodeRow): Episode {
  return { id: r.id, channel: r.channel, fromAt: r.from_at, toAt: r.to_at, summary: r.summary, cues: parseArr<string>(r.cues), people: parseArr<string>(r.people) }
}

function parseArr<T>(s: string): T[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v as T[] : []
  }
  catch {
    return [] // 库里这一格坏了：当空的，下次写入覆盖掉
  }
}
