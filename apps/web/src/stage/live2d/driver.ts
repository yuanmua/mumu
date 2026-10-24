/**
 * 驱动：把舞台状态（情绪词、动作词、口型、心情基线、说话中）变成每帧的模型参数。
 *
 * 挂在 internalModel 的 beforeModelUpdate 事件上——它在动作、表情、注视、呼吸、物理之后、
 * 模型求值之前触发，这时写参数才不会被覆盖。角度类用 add（叠在待机动作上），嘴用 set。
 *
 * 词查不到的降级：情绪词 → 轻轻歪头；动作词 → 小幅点头。不报错，不卡住。
 */
import type { Cubism4InternalModel, Live2DModel } from 'pixi-live2d-display/cubism4'
import { MotionPriority } from 'pixi-live2d-display/cubism4'
import { GESTURES } from './gestures.ts'
import type { Gesture } from './gestures.ts'
import type { EmotionDef, Profile } from './profile.ts'

interface Running { g: Gesture, startedAt: number }
interface Pose { params: Record<string, number>, startedAt: number, hold: number }

const SET_PARAMS = new Set<string>() // 需要 set 而非 add 的参数（嘴）
const EMOTION_HOLD_MS = 10_000 // 显式情绪多久后回到心情基线

export class Driver {
  private gestures: Running[] = []
  private pose?: Pose
  private mouth = 0
  private speaking = false
  private speakingSince = 0
  private lastEmotionAt = 0
  private expression?: string
  private moodExpression?: string
  private readonly mouthParam: string
  private readonly mouthMax: number

  constructor(private model: Live2DModel<Cubism4InternalModel>, private profile: Profile) {
    this.mouthParam = profile.mouth?.param ?? 'ParamMouthOpenY'
    this.mouthMax = profile.mouth?.max ?? 0.9
    SET_PARAMS.add(this.mouthParam)
    model.internalModel.on('beforeModelUpdate', () => this.apply())
  }

  setMouth(v: number): void {
    this.mouth = Math.max(0, Math.min(1, v))
  }

  setSpeaking(on: boolean): void {
    if (on && !this.speaking)
      this.speakingSince = performance.now()
    this.speaking = on
  }

  /** 内核表情词 */
  emotion(word: string): boolean {
    const def = this.profile.emotions?.[word]
    this.lastEmotionAt = performance.now()
    if (!def) {
      this.play('tilt')
      return false
    }
    this.perform(def)
    return true
  }

  /** 内核动作词 */
  action(word: string): boolean {
    const def = this.profile.actions?.[word]
    if (!def) {
      this.play('nod')
      return false
    }
    if (def.motion)
      void this.model.motion(def.motion, def.index, MotionPriority.NORMAL)
    this.perform(def)
    return true
  }

  interrupted(): void {
    this.perform(this.profile.interrupted ?? { gesture: 'flinch' })
    this.lastEmotionAt = performance.now()
  }

  /** 情绪插件给的心情基线：没有显式表情时的默认脸 */
  mood(valence: number, arousal: number): void {
    const m = this.profile.moods
    if (!m)
      return
    const key = valence > 0.4 ? 'happy' : valence < -0.3 ? (arousal > 0.65 ? 'angry' : 'sad') : 'neutral'
    this.moodExpression = m[key] ?? m.neutral
  }

  private perform(def: EmotionDef): void {
    if (def.expression)
      this.setExpression(def.expression)
    if (def.pose)
      this.pose = { params: def.pose, startedAt: performance.now(), hold: 6000 }
    if (def.gesture)
      this.play(def.gesture)
  }

  private play(name: string): void {
    const g = GESTURES[name]
    if (g)
      this.gestures.push({ g, startedAt: performance.now() })
  }

  private setExpression(name: string): void {
    if (this.expression === name)
      return
    this.expression = name
    void this.model.expression(name).catch(() => {}) // 模型没有这个表情文件：静默，pose/gesture 仍生效
  }

  /** 每帧：合成全部偏移写进模型 */
  private apply(): void {
    const core = this.model.internalModel.coreModel
    const now = performance.now()
    const add: Record<string, number> = {}
    const bump = (id: string, v: number): void => { add[id] = (add[id] ?? 0) + v }

    // 程序化动作
    this.gestures = this.gestures.filter(r => now - r.startedAt < r.g.duration * 1000)
    for (const r of this.gestures) {
      const p = (now - r.startedAt) / (r.g.duration * 1000)
      for (const [id, v] of Object.entries(r.g.at(p))) bump(id, v)
    }

    // 参数姿态：300ms 进入，保持，1.5s 淡出
    if (this.pose) {
      const t = now - this.pose.startedAt
      const w = t < 300 ? t / 300 : t < this.pose.hold ? 1 : Math.max(0, 1 - (t - this.pose.hold) / 1500)
      if (w <= 0)
        this.pose = undefined
      else for (const [id, v] of Object.entries(this.pose.params)) bump(id, v * w)
    }

    // 说话时的微动：头轻轻跟着节奏
    if (this.speaking) {
      const t = (now - this.speakingSince) / 1000
      bump('ParamAngleX', 3 * Math.sin(t * 1.3))
      bump('ParamAngleY', 2 * Math.sin(t * 2.1) + this.mouth * 2)
      bump('ParamBodyAngleX', 1.5 * Math.sin(t * 0.9))
    }

    for (const [id, v] of Object.entries(add)) {
      try {
        core.addParameterValueById(id, v)
      }
      catch {
        // 模型没有这个参数：忽略，别的参数照常
      }
    }
    try {
      core.setParameterValueById(this.mouthParam, this.mouth * this.mouthMax)
    }
    catch {
      // 同上
    }

    // 显式情绪过了保持期 → 回到心情基线
    if (this.moodExpression && now - this.lastEmotionAt > EMOTION_HOLD_MS && this.expression !== this.moodExpression)
      this.setExpression(this.moodExpression)
  }
}
