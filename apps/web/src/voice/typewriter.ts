/**
 * 打字机：语音关着时，字幕按阅读速度逐字呈现，而不是模型吐多快就显多快。
 *
 * 为什么：模型两秒能吐两百字，瞬间全显的话「打断」永远发生在她「说完」之后，
 * 回执记的 delivered 也就不是用户真看到的。按阅读速度呈现，delivered = 已呈现的字符数，
 * 打断停在哪一个字就是哪一个字（和终端的打字机呈现同一纪律）。
 *
 * 节奏：每字 32ms；句末停 320ms；分段（换行）停 520ms。时钟可注入，便于测试。
 */
export interface TypewriterOptions {
  charMs?: number
  pauseMs?: number
  breakMs?: number
  now?: () => number
}

const PAUSE = new Set(['。', '！', '？', '!', '?', '…', '～', '~', '；', ';', '，', ','])

export class Typewriter {
  private text = ''
  private shown = 0
  private nextAt = 0
  private readonly charMs: number
  private readonly pauseMs: number
  private readonly breakMs: number
  private readonly now: () => number

  constructor(opts: TypewriterOptions = {}) {
    this.charMs = opts.charMs ?? 32
    this.pauseMs = opts.pauseMs ?? 320
    this.breakMs = opts.breakMs ?? 520
    this.now = opts.now ?? (() => performance.now())
  }

  /** 新文本到达（累计全文） */
  feed(text: string): void {
    // 追上了末尾再等来新文本（模型吐得比打字慢）：从现在起算，不把等待期当成欠账一次补上
    const wasDone = this.shown >= this.text.length
    this.text = text
    if (this.nextAt === 0 || wasDone)
      this.nextAt = Math.max(this.nextAt, this.now())
  }

  get done(): boolean {
    return this.shown >= this.text.length
  }

  get revealed(): number {
    return this.shown
  }

  /** 推进到当前时刻，返回新呈现的字符数 */
  tick(): number {
    const now = this.now()
    let n = 0
    while (this.shown < this.text.length && now >= this.nextAt) {
      const ch = this.text[this.shown]
      this.shown++
      n++
      let wait = this.charMs
      if (ch === '\n')
        wait = this.breakMs
      else if (PAUSE.has(ch))
        wait = this.pauseMs
      // 按时间表推进而不是按「现在」推进：后台标签页定时器被限到每秒一次时，
      // 一次 tick 要把这一秒该出的字全部补上，否则 30 字要 30 秒
      this.nextAt += wait
      if (this.nextAt < now - 2000)
        this.nextAt = now - 2000 // 隐藏太久回来不要一次倾倒全文，最多补 2 秒
    }
    return n
  }

  /** 立刻全显（如刷新后的重放） */
  flush(): number {
    const n = this.text.length - this.shown
    this.shown = this.text.length
    return n
  }
}
