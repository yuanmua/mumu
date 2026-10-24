/**
 * 订阅后端日志（surface-web 的 /api/events），只留压测要的几类事实，断线自动重连、按 seq 去重。
 * 压测本身不清日志；万一别人在网页上点了清除，服务端发 __reset__、序号从头来，这里跟着归零。
 */
export interface Said { id: string, channel: string, startedAt: number, settledAt?: number, delivered?: string, cause?: string }
export interface Heard { at: number, channel: string, kind: string, who: string, name: string, text: string, direct: boolean }

export class Observer {
  readonly said = new Map<string, Said>()
  readonly heard: Heard[] = []
  readonly policy: { at: number, channel: string, p: number, wake: boolean }[] = []
  readonly counts = new Map<string, number>()
  open = new Set<string>()
  acting = new Set<string>()
  beating = false
  lastAt = 0
  private lastSeq = -1
  private ready = false

  constructor(private base: string) {}

  async start(): Promise<void> {
    void (async () => {
      while (true) {
        try {
          await this.connect()
        }
        catch (e) {
          if (!this.ready)
            throw e
        }
        await new Promise(r => setTimeout(r, 1000))
      }
    })()
    const end = Date.now() + 8000
    while (!this.ready && Date.now() < end) await new Promise(r => setTimeout(r, 50))
    if (!this.ready)
      throw new Error(`连不上后端 ${this.base}/api/events`)
  }

  count(type: string): number {
    return this.counts.get(type) ?? 0
  }

  private async connect(): Promise<void> {
    const res = await fetch(`${this.base}/api/events`)
    if (!res.ok || !res.body)
      throw new Error(`连不上后端 ${this.base}/api/events`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        return
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: '))
            continue
          const e = JSON.parse(line.slice(6)) as { type: string, seq?: number, at?: number, data?: any }
          if (e.type === '__live__') {
            this.ready = true
            this.lastSeq = Math.max(this.lastSeq, 0)
            continue
          }
          if (e.type === '__reset__') {
            this.lastSeq = 0
            continue
          }
          if (typeof e.seq !== 'number')
            continue
          if (!this.ready) {
            this.lastSeq = Math.max(this.lastSeq, e.seq)
            continue
          }
          if (e.seq <= this.lastSeq)
            continue
          this.lastSeq = e.seq
          this.on(e.type, e.at ?? Date.now(), e.data ?? {})
        }
      }
    }
  }

  private on(type: string, at: number, d: any): void {
    // 「安静」只看 QQ 那边：别的会话同时在用她（网页、电脑任务）不该拖住压测
    const qq = String(d.channel ?? '').startsWith('qq:') || (typeof d.id === 'string' && this.said.has(d.id))
    if (qq)
      this.lastAt = Date.now()
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1)
    switch (type) {
      case 'utterance.started':
        if (!String(d.channel ?? '').startsWith('qq:'))
          break
        this.open.add(d.id)
        this.said.set(d.id, { id: d.id, channel: d.channel, startedAt: at })
        break
      case 'utterance.settled': {
        this.open.delete(d.id)
        const s = this.said.get(d.id)
        if (s) {
          s.settledAt = at
          s.delivered = String(d.delivered ?? '')
          s.cause = d.cause
        }
        break
      }
      case 'percept.received':
        if (d.sender && String(d.channel ?? '').startsWith('qq:'))
          this.heard.push({ at, channel: d.channel, kind: d.kind, who: String(d.sender.id), name: String(d.sender.name ?? d.sender.id), text: String(d.text ?? ''), direct: d.kind === 'message' })
        break
      case 'group.policy':
        this.policy.push({ at, channel: d.channel, p: d.p, wake: !!d.wake })
        break
      case 'action.started':
        if (String(d.channel ?? '').startsWith('qq:'))
          this.acting.add(d.id)
        break
      case 'action.ended':
        this.acting.delete(d.id)
        break
      case 'beat.opened':
        this.beating = true
        break
      case 'beat.closed':
      case 'beat.failed':
        this.beating = false
        break
    }
  }

  /** QQ 这边安静了：没有在途发言、没有在跑的动作、quietMs 内没新动静（导演在不在想、别的会话忙不忙都不管） */
  async quiet(quietMs: number, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (!this.open.size && !this.acting.size && Date.now() - this.lastAt > quietMs)
        return true
      await new Promise(r => setTimeout(r, 250))
    }
    return false
  }
}
