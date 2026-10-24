/**
 * 语音输入：浏览器 SpeechRecognition 的中间结果流式送进内核（io.perceive 的 Web 映射）。
 * 一开口就打断角色（urgent），每隔几次中间结果唤醒一次导演让它决定插话还是等。
 * 不支持的浏览器里 supported() 为假，界面不显示按钮。
 */
import { startPerception } from '../protocol/client.ts'
import type { PerceptionHandle } from '../protocol/client.ts'

type Recognition = EventTarget & {
  lang: string
  interimResults: boolean
  continuous: boolean
  start: () => void
  stop: () => void
  onresult: ((e: { resultIndex: number, results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: unknown) => void) | null
}

function ctor(): (new () => Recognition) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition, webkitSpeechRecognition?: new () => Recognition }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export function supported(): boolean {
  return !!ctor()
}

export class Listener {
  private rec?: Recognition
  private handle?: PerceptionHandle
  private updates = 0
  active = false

  async start(onState: (active: boolean) => void): Promise<void> {
    const C = ctor()
    if (!C || this.active)
      return
    const rec = new C()
    rec.lang = 'zh-CN'
    rec.interimResults = true
    rec.continuous = false
    this.rec = rec
    this.active = true
    onState(true)
    this.handle = await startPerception({ kind: 'speech', urgent: true })
    let finalText = ''
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal)
          finalText += r[0].transcript
        else interim += r[0].transcript
      }
      const text = finalText + interim
      this.updates++
      this.handle?.update(text, this.updates % 3 === 0) // 修订语义：整体覆盖
    }
    rec.onend = () => {
      this.active = false
      onState(false)
      if (finalText.trim())
        this.handle?.end(finalText.trim())
      else this.handle?.cancel('empty')
      this.handle = undefined
    }
    rec.onerror = () => rec.stop()
    rec.start()
  }

  stop(): void {
    this.rec?.stop()
  }
}
