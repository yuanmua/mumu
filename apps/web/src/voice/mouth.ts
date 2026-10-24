/**
 * 口型值 0..1。两种来源：
 * - 真音量（有语音时）：音量经指数曲线与上限，再做 120ms 平滑；
 * - 文本节奏（无语音时）：每到新字符给一个随机目标值，随后衰减。
 * 舞台每帧读 value()。
 */
export class Mouth {
  private target = 0
  private current = 0
  private lastTick = performance.now()
  private textPulseUntil = 0

  /** 有音频时每帧喂音量 */
  fromLevel(level: number): void {
    this.target = Math.min(1, level ** 0.7 * 1.1)
  }

  /** 无音频时，新呈现了 n 个字符 */
  fromText(n: number): void {
    if (n <= 0)
      return
    this.target = 0.35 + Math.random() * 0.45
    this.textPulseUntil = performance.now() + 90 + Math.min(n, 6) * 25
  }

  silence(): void {
    this.target = 0
  }

  value(): number {
    const now = performance.now()
    const dt = Math.min(100, now - this.lastTick)
    this.lastTick = now
    if (this.textPulseUntil && now > this.textPulseUntil) {
      this.textPulseUntil = 0
      this.target = 0
    }
    // 张口快、闭口慢一点，看起来更像在说话
    const rate = this.target > this.current ? dt / 60 : dt / 120
    this.current += (this.target - this.current) * Math.min(1, rate)
    return this.current
  }
}
