/**
 * 音频播放队列 + 音量分析。一次只播一段，按入队顺序；stopAll 立即停并清空。
 * 口型取 AnalyserNode 的 RMS 音量，由 mouth.ts 再做曲线与平滑。
 */
export interface Clip {
  id: string
  buffer: ArrayBuffer
  onStart?: () => void
  onEnd?: (finished: boolean) => void // finished=false 表示被 stopAll 打断
}

export class Player {
  private ctx?: AudioContext
  private analyser?: AnalyserNode
  private data?: Uint8Array<ArrayBuffer>
  private queue: Clip[] = []
  private playing?: { clip: Clip, source: AudioBufferSourceNode }
  private generation = 0

  /** 浏览器要求用户手势后才能出声；在第一次点击时调用 */
  unlock(): void {
    this.ensure()
    if (this.ctx?.state === 'suspended')
      void this.ctx.resume()
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.smoothingTimeConstant = 0.5
      this.analyser.connect(this.ctx.destination)
      this.data = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))
    }
    return this.ctx
  }

  get busy(): boolean {
    return !!this.playing || this.queue.length > 0
  }

  enqueue(clip: Clip): void {
    this.queue.push(clip)
    void this.next()
  }

  private async next(): Promise<void> {
    if (this.playing || !this.queue.length)
      return
    const clip = this.queue.shift()!
    const gen = this.generation
    const ctx = this.ensure()
    let decoded: AudioBuffer
    try {
      decoded = await ctx.decodeAudioData(clip.buffer.slice(0))
    }
    catch (e) {
      console.warn('[player] 解码失败，跳过这句:', e)
      clip.onEnd?.(true)
      void this.next()
      return
    }
    if (gen !== this.generation) {
      clip.onEnd?.(false) // 解码期间被 stopAll
      return
    }
    const source = ctx.createBufferSource()
    source.buffer = decoded
    source.connect(this.analyser!)
    this.playing = { clip, source }
    clip.onStart?.()
    source.onended = () => {
      if (this.playing?.source !== source)
        return
      this.playing = undefined
      clip.onEnd?.(true)
      void this.next()
    }
    source.start()
  }

  /** 立即停止并清空队列；排队中的每一段都收到 onEnd(false) */
  stopAll(): void {
    this.generation++
    const cur = this.playing
    this.playing = undefined
    if (cur) {
      try {
        cur.source.onended = null
        cur.source.stop()
      }
      catch {
        // 已经停了
      }
      cur.clip.onEnd?.(false)
    }
    for (const c of this.queue.splice(0)) c.onEnd?.(false)
  }

  /** 当前音量 0..1（RMS），没在播为 0 */
  level(): number {
    if (!this.playing || !this.analyser || !this.data)
      return 0
    this.analyser.getByteTimeDomainData(this.data)
    let sum = 0
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128
      sum += v * v
    }
    return Math.min(1, Math.sqrt(sum / this.data.length) * 3)
  }
}
