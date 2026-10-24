/**
 * 立绘档案：把内核的表情/动作**词汇**映射到一组整图。词汇归插件，映射归角色目录。
 *
 * 立绘没有参数可写，能做的只有「换整张图」与「整体位移」：
 * - 表情词 → 一张图（整图切换，淡入淡出），可附带一个程序化动作；
 * - 动作词 → 一个程序化动作（transform），可附带换图；
 * - 眨眼、口型各一张可选图：没有就跳过 / 用点头代替。
 * 这里只做解析与查询，不碰 DOM；缺词、缺图的降级规则也在这里定，方便测。
 */
import type { TachieGesture } from './gestures.ts'
import { TACHIE_GESTURES } from './gestures.ts'

export interface TachieDef {
  image?: string // 相对档案目录的图文件
  gesture?: string // TACHIE_GESTURES 里的名字
}

export interface TachieProfile {
  base: string
  eyesClosed?: string
  mouthOpen?: string
  fit: { height: number, y: number } // 立绘高 = 视口高 × height；底边抬高 = 视口高 × y
  expressions: Record<string, TachieDef> // emo 词
  actions: Record<string, TachieDef> // act 词
  moods: { happy?: string, sad?: string, angry?: string, neutral?: string } // 心情 → 表情词或图文件
  interrupted: TachieDef
  blink: { minSec: number, maxSec: number, holdMs: number }
}

export const EMOTION_HOLD_MS = 10_000 // 显式表情多久后回到心情基线

const IMAGE_RE = /\.(png|webp|jpe?g|gif|avif)$/i

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function def(v: unknown, where: string): TachieDef {
  if (typeof v === 'string')
    return IMAGE_RE.test(v) ? { image: v } : { gesture: v }
  if (!isRecord(v))
    throw new Error(`${where} 必须是图文件名、动作名或 { image, gesture }`)
  const out: TachieDef = {}
  if (v.image !== undefined) {
    if (typeof v.image !== 'string' || !v.image)
      throw new Error(`${where}.image 必须是文件名`)
    out.image = v.image
  }
  if (v.gesture !== undefined) {
    if (typeof v.gesture !== 'string' || !(v.gesture in TACHIE_GESTURES))
      throw new Error(`${where}.gesture 不认识：${String(v.gesture)}；可用 ${Object.keys(TACHIE_GESTURES).join(' ')}`)
    out.gesture = v.gesture
  }
  return out
}

function defs(v: unknown, where: string): Record<string, TachieDef> {
  if (v === undefined)
    return {}
  if (!isRecord(v))
    throw new Error(`${where} 必须是 { 词: 图或动作 }`)
  const out: Record<string, TachieDef> = {}
  for (const [word, raw] of Object.entries(v)) out[word] = def(raw, `${where}.${word}`)
  return out
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 解析 profile.json；形状不对就抛错说清哪一项，缺的可选项补默认 */
export function parseProfile(raw: unknown): TachieProfile {
  if (!isRecord(raw))
    throw new Error('profile.json 必须是对象')
  if (typeof raw.base !== 'string' || !raw.base)
    throw new Error('缺 base（底图文件名）')
  const fit = isRecord(raw.fit) ? raw.fit : {}
  const blink = isRecord(raw.blink) ? raw.blink : {}
  const moods = isRecord(raw.moods) ? raw.moods : {}
  const pick = (k: string): string | undefined => typeof moods[k] === 'string' ? moods[k] as string : undefined
  return {
    base: raw.base,
    eyesClosed: typeof raw.eyesClosed === 'string' ? raw.eyesClosed : undefined,
    mouthOpen: typeof raw.mouthOpen === 'string' ? raw.mouthOpen : undefined,
    fit: { height: num(fit.height, 1), y: num(fit.y, 0) },
    expressions: defs(raw.expressions, 'expressions'),
    actions: defs(raw.actions, 'actions'),
    moods: { happy: pick('happy'), sad: pick('sad'), angry: pick('angry'), neutral: pick('neutral') },
    interrupted: raw.interrupted === undefined ? { gesture: 'flinch' } : def(raw.interrupted, 'interrupted'),
    blink: { minSec: num(blink.minSec, 2), maxSec: num(blink.maxSec, 6), holdMs: num(blink.holdMs, 120) },
  }
}

export async function loadTachieProfile(dir: string): Promise<TachieProfile> {
  const res = await fetch(`/${dir}/profile.json`, { cache: 'no-cache' })
  if (!res.ok)
    throw new Error(`没有找到立绘档案 /${dir}/profile.json`)
  return parseProfile(await res.json())
}

/** 表情词的演法。查不到的词：回到底图并歪一下头，让人看出「她收到了但不会演」 */
export function resolveEmotion(p: TachieProfile, word: string): TachieDef & { known: boolean } {
  const d = p.expressions[word]
  return d ? { ...d, known: true } : { image: p.base, gesture: 'tilt', known: false }
}

/** 动作词的演法。查不到的词：小幅点头 */
export function resolveAction(p: TachieProfile, word: string): TachieDef & { known: boolean } {
  const d = p.actions[word]
  return d ? { ...d, known: true } : { gesture: 'nod', known: false }
}

/** 心情基线对应的图：moods 里的值可以是表情词（再查 expressions）或直接是图文件；都没有就底图 */
export function moodImage(p: TachieProfile, valence: number, arousal: number): string {
  const key = valence > 0.4 ? 'happy' : valence < -0.3 ? (arousal > 0.65 ? 'angry' : 'sad') : 'neutral'
  const v = p.moods[key] ?? p.moods.neutral
  if (!v)
    return p.base
  if (IMAGE_RE.test(v))
    return v
  return p.expressions[v]?.image ?? p.base
}

/** 档案引用到的全部图文件（去重，底图最前），用来预载与检查缺哪张 */
export function imageFiles(p: TachieProfile): string[] {
  const set = new Set<string>([p.base])
  if (p.eyesClosed)
    set.add(p.eyesClosed)
  if (p.mouthOpen)
    set.add(p.mouthOpen)
  for (const d of [...Object.values(p.expressions), ...Object.values(p.actions), p.interrupted]) {
    if (d.image)
      set.add(d.image)
  }
  for (const v of Object.values(p.moods)) {
    if (v && IMAGE_RE.test(v))
      set.add(v)
  }
  return [...set]
}

/** 每张图在说明卡里怎么称呼：底图、眨眼、口型，或「哪些词会用到它」 */
export function describeImage(p: TachieProfile, file: string): string {
  if (file === p.base)
    return '底图：全身、闭嘴、平静微笑（必需）'
  if (file === p.eyesClosed)
    return '眨眼：只把眼睛闭上，其他与底图完全一致（可选）'
  if (file === p.mouthOpen)
    return '口型：只把嘴张开，其他与底图完全一致（可选）'
  const words = Object.entries({ ...p.actions, ...p.expressions }).filter(([, d]) => d.image === file).map(([w]) => w)
  return words.length ? `表情：${words.join('、')}` : '档案引用到的图'
}

export function gestureOf(name: string | undefined): TachieGesture | undefined {
  return name ? TACHIE_GESTURES[name] : undefined
}
