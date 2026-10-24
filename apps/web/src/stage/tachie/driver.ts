/**
 * 立绘驱动：把舞台状态（情绪词、动作词、口型、心情基线、说话中、被打断）变成每帧的
 * 「整体偏移 + 该显示哪张图 + 眼睛闭没闭 + 口型图多透明」。
 *
 * 不碰 DOM、不读时钟（now / rand 可注入），所以能用 vitest 测时间线；
 * 组件只负责把 frame() 的结果写到元素上。
 * 与 live2d/driver.ts 同一套语义：显式表情保持 10 秒后回到心情基线；词查不到就降级成小动作。
 */
import type { Offset, TachieGesture } from './gestures.ts'
import { addOffset, breath, idleSway, nextBlinkDelay, speakingMotion } from './gestures.ts'
import type { TachieDef, TachieProfile } from './profile.ts'
import { EMOTION_HOLD_MS, gestureOf, moodImage, resolveAction, resolveEmotion } from './profile.ts'

export interface Frame {
  offset: Offset
  image: string // 当前表情图（文件名）
  eyesClosed: boolean
  mouth: number // 0..1；没有口型图时恒为 0
}

interface Running { g: TachieGesture, startedAt: number }

export class TachieDriver {
  private image: string
  private moodImg?: string
  private lastEmotionAt = -Infinity
  private gestures: Running[] = []
  private mouth = 0
  private speaking = false
  private speakingSince = 0
  private nextBlinkAt: number
  private blinkUntil = 0
  private readonly startedAt: number
  private readonly now: () => number
  private readonly rand: () => number

  constructor(private profile: TachieProfile, opts: { now?: () => number, rand?: () => number } = {}) {
    this.now = opts.now ?? (() => performance.now())
    this.rand = opts.rand ?? Math.random
    this.image = profile.base
    this.startedAt = this.now()
    this.nextBlinkAt = this.startedAt + this.blinkDelay()
  }

  setMouth(v: number): void {
    this.mouth = Math.max(0, Math.min(1, v))
  }

  setSpeaking(on: boolean): void {
    if (on && !this.speaking)
      this.speakingSince = this.now()
    this.speaking = on
  }

  /** 内核表情词；返回档案里有没有这个词 */
  emotion(word: string): boolean {
    const d = resolveEmotion(this.profile, word)
    this.lastEmotionAt = this.now()
    this.perform(d)
    return d.known
  }

  /** 内核动作词 */
  action(word: string): boolean {
    const d = resolveAction(this.profile, word)
    this.perform(d)
    return d.known
  }

  interrupted(): void {
    this.lastEmotionAt = this.now()
    this.perform(this.profile.interrupted)
  }

  /** 情绪插件给的心情基线：没有显式表情时的默认脸 */
  mood(valence: number, arousal: number): void {
    this.moodImg = moodImage(this.profile, valence, arousal)
    // 还没有过显式表情时直接换脸，不用等保持期
    if (this.lastEmotionAt === -Infinity)
      this.image = this.moodImg
  }

  private perform(d: TachieDef): void {
    if (d.image)
      this.image = d.image
    const g = gestureOf(d.gesture)
    if (g)
      this.gestures.push({ g, startedAt: this.now() })
  }

  private blinkDelay(): number {
    return nextBlinkDelay(this.profile.blink.minSec, this.profile.blink.maxSec, this.rand) * 1000
  }

  frame(): Frame {
    const now = this.now()
    const t = (now - this.startedAt) / 1000
    let o: Offset = addOffset(breath(t), idleSway(t))

    this.gestures = this.gestures.filter(r => now - r.startedAt < r.g.duration * 1000)
    for (const r of this.gestures)
      o = addOffset(o, r.g.at((now - r.startedAt) / (r.g.duration * 1000)))

    const hasMouthImage = !!this.profile.mouthOpen
    if (this.speaking)
      o = addOffset(o, speakingMotion((now - this.speakingSince) / 1000, this.mouth, !hasMouthImage))

    // 眨眼：到点就闭 holdMs；没有闭眼图就只排下一次，不闭
    let eyesClosed = false
    if (now >= this.nextBlinkAt) {
      if (this.profile.eyesClosed)
        this.blinkUntil = now + this.profile.blink.holdMs
      this.nextBlinkAt = now + this.blinkDelay()
    }
    if (this.profile.eyesClosed && now < this.blinkUntil)
      eyesClosed = true

    // 显式表情过了保持期 → 回到心情基线
    if (this.moodImg && now - this.lastEmotionAt > EMOTION_HOLD_MS && this.image !== this.moodImg)
      this.image = this.moodImg

    return { offset: o, image: this.image, eyesClosed, mouth: hasMouthImage ? this.mouth : 0 }
  }
}
