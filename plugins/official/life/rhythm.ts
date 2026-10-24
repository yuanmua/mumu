/**
 * 作息与抽签（纯函数，单测直接测）。
 *
 * 一天切成几个时段（rhythm），每个时段一组「候选活动 → 权重」，周末可以另给一组；
 * 到点（上一件事做完、或进了新时段而手上这件事不在新时段的候选里）就从候选里抽一个。
 * 衔接规则只有三条，都写在活动自己身上：
 * - 不连着做同一件事（`repeat: true` 的除外，如睡觉：深夜时段只剩睡觉，就一直睡）；
 * - `gapMin`：做完之后多少分钟内不再做（刚吃完不会马上又吃）；
 * - `notAfter`：紧跟在哪些事后面不做（刚吃完饭不洗澡）。
 * 全被规则筛光了就退一步：只守「不连着做同一件事」，再不行就不守。
 *
 * 随机可复现：一次抽签只用一个种子（mulberry32），活动、细节、时长都从它出；种子写进日志。
 */

export interface Activity {
  name: string
  details?: string[] // 细节候选：「在吃火锅」「叫了麻辣烫外卖」
  minutes?: [number, number] // 一次做多久（分钟），在这之间随机
  busy?: number // 「忙不忙」系数，给接话意愿乘（1 = 不忙）
  asleep?: boolean // 睡着了：不主动找话
  repeat?: boolean // 可以连着做（睡觉）
  gapMin?: number
  notAfter?: string[]
  words?: string[] // 用户 / 她自己写「在吃火锅」时，靠这些词认出是哪个活动
}

export interface Slot {
  from: string // 'HH:MM'，到下一个时段的 from 为止
  label: string // 「午饭」「深夜」
  pick: Record<string, number> // 活动名 → 权重
  weekend?: Record<string, number> // 周末换这一组（不给就和平时一样）
}

export interface Clock {
  minute: number // 当天第几分钟（0～1439，按配置的时区）
  day: number // 星期几，0 = 周日
  weekend: boolean
  hm: string // 'HH:MM'
}

export interface Draw {
  activity: string
  detail: string
  minutes: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function clockAt(ms: number, timeZone: string, weekendDays: number[] = [0, 6]): Clock {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const get = (t: string): string => parts.find(p => p.type === t)?.value ?? ''
  const h = Number(get('hour')) % 24
  const m = Number(get('minute'))
  const day = WEEKDAYS[get('weekday')] ?? 0
  return { minute: h * 60 + m, day, weekend: weekendDays.includes(day), hm: hmOf(h * 60 + m) }
}

export function hmOf(minute: number): string {
  return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** 'HH:MM' → 当天第几分钟；写错了给 undefined */
export function parseHM(s: string): number | undefined {
  const [h, m] = s.trim().split(/[:：]/).map(Number)
  if (h === undefined || !Number.isInteger(h) || h < 0 || h > 23)
    return undefined
  const mm = m ?? 0
  if (!Number.isInteger(mm) || mm < 0 || mm > 59)
    return undefined
  return h * 60 + mm
}

/** 这一分钟落在哪个时段；`left` = 离下一个时段开始还有几分钟。from 写错的时段跳过 */
export function slotAt(rhythm: Slot[], minute: number): { slot: Slot, index: number, left: number } | undefined {
  const list = rhythm
    .map((slot, index) => ({ slot, index, at: parseHM(slot.from) }))
    .filter((x): x is { slot: Slot, index: number, at: number } => x.at !== undefined)
    .sort((a, b) => a.at - b.at)
  if (!list.length)
    return undefined
  // 比第一个时段还早 = 还在昨天最后一个时段里
  let i = list.length - 1
  for (let k = 0; k < list.length; k++) {
    if (list[k]!.at <= minute)
      i = k
  }
  const next = list[(i + 1) % list.length]!.at
  const left = ((next - minute + 1440) % 1440) || 1440
  return { slot: list[i]!.slot, index: list[i]!.index, left }
}

export function weightsOf(slot: Slot, weekend: boolean): Record<string, number> {
  return weekend && slot.weekend ? slot.weekend : slot.pick
}

/**
 * 这个时段能做什么（带权重），已按衔接规则筛过。
 * `lastEnd`：每个活动上一次做完的时刻（含手上这件，按「此刻」算做完）。
 */
export function candidates(acts: Activity[], slot: Slot, weekend: boolean, current: string | undefined, lastEnd: Record<string, number>, now: number): { name: string, weight: number }[] {
  const known = new Map(acts.map(a => [a.name, a]))
  const all = Object.entries(weightsOf(slot, weekend))
    .filter(([n, w]) => w > 0 && known.has(n))
    .map(([name, weight]) => ({ name, weight }))
  const ok = all.filter(({ name }) => {
    const a = known.get(name)!
    if (name === current && !a.repeat)
      return false
    const end = lastEnd[name]
    if (a.gapMin && end !== undefined && name !== current && now - end < a.gapMin * 60_000)
      return false
    return !(current && a.notAfter?.includes(current))
  })
  if (ok.length)
    return ok
  const notSame = all.filter(c => c.name !== current)
  return notSame.length ? notSame : all
}

/** mulberry32：一个 32 位种子出一串 [0,1) */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function newSeed(): number {
  return Math.floor(Math.random() * 4294967296)
}

function pickWeighted<T extends { weight: number }>(r: () => number, list: T[]): T {
  const total = list.reduce((s, c) => s + c.weight, 0)
  let x = r() * total
  for (const c of list) {
    x -= c.weight
    if (x < 0)
      return c
  }
  return list[list.length - 1]!
}

export function minutesOf(a: Activity | undefined, r: () => number): number {
  const [lo, hi] = a?.minutes ?? [20, 60]
  return Math.max(1, Math.round(lo + r() * Math.max(0, hi - lo)))
}

/** 同一个种子 + 同一组候选 → 同一个结果 */
export function draw(seed: number, cands: { name: string, weight: number }[], acts: Activity[]): Draw | undefined {
  if (!cands.length)
    return undefined
  const r = rng(seed)
  const name = pickWeighted(r, cands).name
  const a = acts.find(x => x.name === name)
  const details = a?.details ?? []
  const detail = details.length ? details[Math.floor(r() * details.length)]! : ''
  return { activity: name, detail, minutes: minutesOf(a, r) }
}

/**
 * 「在吃火锅」→ 吃饭。先认活动名，再认 words（取命中的最长那个词，少认错）；都没有就是一件表里没有的事。
 * 只用在用户 / 她自己写的一句话上，不是解析模型的结构化输出。
 */
export function matchActivity(acts: Activity[], text: string): Activity | undefined {
  const byName = acts.find(a => text.includes(a.name))
  if (byName)
    return byName
  let best: { a: Activity, len: number } | undefined
  for (const a of acts) {
    for (const w of a.words ?? []) {
      if (w && text.includes(w) && (!best || w.length > best.len))
        best = { a, len: w.length }
    }
  }
  return best?.a
}

/** 面板 / 命令里写的「在拼乐高 40」→ { text: '在拼乐高', minutes: 40 }；结尾不是数字就没有分钟 */
export function parseSetInput(s: string): { text: string, minutes?: number } {
  const t = s.trim()
  const m = t.match(/^(.*?)[\s,，]*(\d{1,4})\s*(分钟|分|min)?$/)
  if (m && m[1]!.trim()) {
    const n = Number(m[2])
    if (n > 0)
      return { text: m[1]!.trim(), minutes: n }
  }
  return { text: t }
}
