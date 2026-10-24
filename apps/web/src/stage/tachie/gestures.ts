/**
 * 立绘的程序化动作：整张图只有一个刚体，能动的只有平移、旋转、缩放。
 * 名字与时长和 live2d/gestures.ts 一致，这样同一份词 → 动作的映射两种舞台都能用；
 * 另加三个原木专属词需要的动作（翻书、举杖、看树）。
 *
 * 单位：x / y 是立绘高度的百分比（正 y 向下），rot 是角度，scale 是在 1 之上的增量。
 * 偏移是叠加的，所以和呼吸、待机摆动、口型点头都叠得住。
 */
export interface Offset {
  x?: number
  y?: number
  rot?: number
  scale?: number
}

export interface TachieGesture {
  duration: number // 秒
  at: (p: number) => Offset
}

const env = (p: number): number => Math.sin(Math.PI * p) // 起落平滑的包络
const TAU = Math.PI * 2

export const TACHIE_GESTURES: Record<string, TachieGesture> = {
  nod: { duration: 1.0, at: p => ({ y: 1.2 * Math.sin(TAU * 2 * p) * env(p) }) },
  shake: { duration: 1.0, at: p => ({ x: 1.4 * Math.sin(TAU * 2 * p) * env(p), rot: 1.2 * Math.sin(TAU * 2 * p) * env(p) }) },
  tilt: { duration: 1.6, at: p => ({ rot: 4 * env(p) ** 0.6 }) },
  bounce: { duration: 0.7, at: p => ({ y: -2.4 * Math.sin(TAU * p) * env(p), scale: 0.02 * Math.sin(TAU * p) * env(p) }) },
  sway: { duration: 2.2, at: p => ({ x: 1.2 * Math.sin(TAU * p) * env(p), rot: 2 * Math.sin(TAU * p) * env(p) }) },
  think: { duration: 1.8, at: p => ({ rot: 3 * env(p) ** 0.5, y: -0.5 * env(p) ** 0.5 }) },
  sigh: { duration: 1.8, at: p => ({ y: 1.2 * env(p) ** 0.7, scale: -0.01 * env(p) ** 0.7 }) },
  shrug: { duration: 1.0, at: p => ({ y: -1 * env(p), rot: -2 * env(p) }) },
  wave: { duration: 1.4, at: p => ({ rot: 3 * Math.sin(TAU * 3 * p) * env(p), x: -0.5 * env(p) }) },
  flinch: { duration: 0.5, at: p => ({ y: -1.5 * env(p), scale: 0.015 * env(p) }) },
  // 原木专属：翻书是低头看手里的书；举杖是整个人抬一下；看树是转头仰望
  lookDown: { duration: 1.6, at: p => ({ y: 0.8 * env(p), rot: 1.5 * env(p) }) },
  lift: { duration: 1.4, at: p => ({ y: -1.5 * env(p), scale: 0.02 * env(p), rot: -2 * env(p) }) },
  lookUp: { duration: 2.0, at: p => ({ y: -0.6 * env(p) ** 0.6, rot: 2.5 * env(p) ** 0.6, x: 0.8 * env(p) ** 0.6 }) },
}

/** 呼吸：缓慢的 1–2% 起伏，周期约 4 秒 */
export function breath(tSec: number): Offset {
  const w = Math.sin(TAU * tSec / 4.2)
  return { scale: 0.008 * w, y: -0.6 * w }
}

/** 待机轻微摆动：两个不同周期叠加，避免看起来像钟摆 */
export function idleSway(tSec: number): Offset {
  return {
    rot: 0.5 * Math.sin(TAU * tSec / 6.3) + 0.25 * Math.sin(TAU * tSec / 2.9),
    x: 0.3 * Math.sin(TAU * tSec / 7.1),
  }
}

/** 说话时的微动：和 live2d 驱动一样，头随节奏轻轻动；没有口型图时点头幅度跟着 mouth 走 */
export function speakingMotion(tSec: number, mouth: number, nodForMouth: boolean): Offset {
  return {
    rot: 0.8 * Math.sin(tSec * 1.3),
    y: 0.3 * Math.sin(tSec * 2.1) + (nodForMouth ? mouth * 0.7 : 0),
  }
}

/** 下次眨眼的间隔（秒）：[min, max] 内均匀随机；rand 可注入方便测试 */
export function nextBlinkDelay(minSec: number, maxSec: number, rand: () => number = Math.random): number {
  const lo = Math.max(0.2, Math.min(minSec, maxSec))
  const hi = Math.max(lo, minSec, maxSec)
  return lo + rand() * (hi - lo)
}

export function addOffset(a: Offset, b: Offset): Offset {
  return {
    x: (a.x ?? 0) + (b.x ?? 0),
    y: (a.y ?? 0) + (b.y ?? 0),
    rot: (a.rot ?? 0) + (b.rot ?? 0),
    scale: (a.scale ?? 0) + (b.scale ?? 0),
  }
}

/** 把偏移变成 CSS transform；heightPx 是立绘实际像素高，百分比据此换算 */
export function toTransform(o: Offset, heightPx: number): string {
  const x = ((o.x ?? 0) / 100) * heightPx
  const y = ((o.y ?? 0) / 100) * heightPx
  return `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${(o.rot ?? 0).toFixed(3)}deg) scale(${(1 + (o.scale ?? 0)).toFixed(4)})`
}
