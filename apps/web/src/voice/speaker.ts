/**
 * 发声控制：把一条 utterance 的流式文本变成「字幕呈现 + 语音播放 + 送达回执」三件同步的事。
 *
 * 语音开：按句合成；一句开始播放时字幕显示到该句末尾；一句播完时回执到该句末尾。
 *          被打断 → 立停、清队列；回执停在已播完的句子。
 * 语音关：打字机按阅读速度逐字呈现，回执跟着呈现进度；口型走文本节奏。
 *          模型吐多快不重要，delivered 永远是用户真看到的。
 * 呈现进度写回 store（message.reveal），回执经 protocol/client。
 * 本模块不认识舞台；舞台只读 tick() 返回的口型值。
 */
import { fetchSpeech, reportDelivered } from '../protocol/client.ts'
import type { Projection } from '../store/projection.ts'
import { Mouth } from './mouth.ts'
import { Player } from './player.ts'
import { splitSentences } from './sentence.ts'
import { Typewriter } from './typewriter.ts'

interface Track {
  uttId: string
  text: string // 已收到的全部文本
  consumed: number // 已切成句的字符数（语音）
  reported: number // 已回执的字符数
  lastReportAt: number
  pending: Promise<void> // 合成请求串行化，保证入队顺序 = 文本顺序
  typer?: Typewriter // 语音关时的打字机
  ended: boolean
  aborted: boolean
}

const REPORT_EVERY_MS = 200

export class Speaker {
  readonly mouth = new Mouth()
  readonly player = new Player()
  enabled = false
  private tracks = new Map<string, Track>()
  private timer?: ReturnType<typeof setInterval>

  constructor(private state: Projection) {
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => this.step()) // 切到后台立刻把没打完的字补上
  }

  private get voiceOn(): boolean {
    return this.enabled && this.state.meta.voice
  }

  private message(uttId: string) {
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      if (this.state.messages[i].id === uttId)
        return this.state.messages[i]
    }
    return undefined
  }

  private reveal(uttId: string, chars: number): void {
    const m = this.message(uttId)
    if (m && chars > m.reveal)
      m.reveal = Math.min(chars, m.text.length)
  }

  private report(t: Track, chars: number, force = false): void {
    const now = performance.now()
    if (chars > t.reported && (force || now - t.lastReportAt >= REPORT_EVERY_MS)) {
      t.reported = chars
      t.lastReportAt = now
      reportDelivered(t.uttId, chars)
    }
  }

  private track(uttId: string): Track {
    let t = this.tracks.get(uttId)
    if (!t) {
      t = { uttId, text: '', consumed: 0, reported: 0, lastReportAt: 0, pending: Promise.resolve(), ended: false, aborted: false }
      this.tracks.set(uttId, t)
    }
    return t
  }

  /** 新文本到达 */
  feed(uttId: string, text: string, _total: number): void {
    const t = this.track(uttId)
    t.text += text
    if (this.voiceOn) {
      this.cut(t, false)
      return
    }
    t.typer ??= new Typewriter()
    t.typer.feed(t.text)
    this.ensureTimer()
    // 页面隐藏时定时器可能一分钟才醒一次；文本一到就在这里直接处理（SSE 不被节流）
    if (typeof document !== 'undefined' && document.hidden)
      this.step()
  }

  /** utterance 收尾 */
  finish(uttId: string, truncated: boolean): void {
    const t = this.tracks.get(uttId)
    if (!t)
      return
    t.ended = true
    if (truncated) {
      // 打断：声音立停、打字机停在当前字；账目已随进度回执过了
      t.aborted = true
      this.player.stopAll()
      this.mouth.silence()
      this.tracks.delete(uttId)
      return
    }
    if (this.voiceOn)
      this.cut(t, true)
    else
      this.step() // 语音关：立刻处理一次（隐藏页面时定时器可能很久才醒），剩下的字由 step 打完
  }

  stopAll(): void {
    this.player.stopAll()
    this.mouth.silence()
    this.tracks.clear()
  }

  // ── 语音关：打字机 ──
  private ensureTimer(): void {
    if (this.timer)
      return
    this.timer = setInterval(() => this.step(), 30)
  }

  private step(): void {
    let busy = false
    // 页面不可见：没人在看，而且浏览器会把定时器节流到每分钟一次，按阅读速度呈现没有意义，
    // 直接全显并回执（与内核等不到回执时的超时记账一致）
    const hidden = typeof document !== 'undefined' && document.hidden
    for (const t of [...this.tracks.values()]) {
      if (!t.typer)
        continue
      const n = hidden ? t.typer.flush() : t.typer.tick()
      if (n > 0) {
        this.reveal(t.uttId, t.typer.revealed)
        this.mouth.fromText(n)
      }
      // 追平已到文本时必须无条件回执：内核要等「全部送达」才结算，而结算之后才会有 finish()。
      // 若最后一次回执被 200ms 节流吞掉，就再没有新字来触发它，内核只能等 60s 超时——探针抓到过。
      this.report(t, t.typer.revealed, t.typer.done)
      if (t.typer.done && t.ended) {
        this.tracks.delete(t.uttId)
        this.mouth.silence()
      }
      else {
        busy = true
      }
    }
    if (!busy && this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  // ── 语音开：分句合成 ──
  private cut(t: Track, final: boolean): void {
    const { sentences } = splitSentences(t.text.slice(t.consumed), final)
    let offset = t.consumed
    for (const s of sentences) {
      const idx = t.text.indexOf(s, offset)
      const end = idx < 0 ? offset + s.length : idx + s.length
      offset = end
      t.consumed = end
      this.schedule(t, s, end)
    }
    if (final && !sentences.length && !this.player.busy)
      this.tracks.delete(t.uttId)
  }

  private schedule(t: Track, sentence: string, end: number): void {
    t.pending = t.pending.then(async () => {
      if (t.aborted)
        return
      const buf = await fetchSpeech(sentence)
      if (t.aborted)
        return
      if (!buf) {
        // 合成失败：这句降级为无声字幕，账照样记
        this.reveal(t.uttId, end)
        this.report(t, end, true)
        return
      }
      this.player.enqueue({
        id: `${t.uttId}:${end}`,
        buffer: buf,
        onStart: () => this.reveal(t.uttId, end),
        onEnd: (finished) => {
          if (finished)
            this.report(t, end, true)
          if (t.ended && t.consumed === end && !this.player.busy)
            this.tracks.delete(t.uttId)
        },
      })
    })
  }

  /** 舞台每帧调用，返回口型 0..1 */
  tick(): number {
    if (this.voiceOn && this.player.busy)
      this.mouth.fromLevel(this.player.level())
    return this.mouth.value()
  }
}
