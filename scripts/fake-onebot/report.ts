/**
 * 一个场景的时间线：假 NapCat 自己记的收发 + 后端日志（SSE）里与这个频道有关的事件。
 * 场景的核对函数（scenes.ts）只通过这里的方法读事实；打印也在这里。
 */
import type { Scene } from './scenes.ts'

export interface In { t: number, ch: string, who: string, text: string, seen?: boolean, policy?: Policy }
export interface Policy { t: number, p: number, why: string[], wake: boolean }
export interface Out { t: number, ch: string, text: string }
export interface Start { t: number, ch: string, id: string, action: string }
export interface Settle { t: number, id: string, delivered: string, cause?: string }
export interface Think { t: number, note: string, intents: unknown[], aborted?: boolean }

export class Timeline {
  readonly t0 = Date.now()
  readonly ins: In[] = []
  readonly outs: Out[] = []
  readonly startList: Start[] = []
  readonly settles: Settle[] = []
  readonly thinks: Think[] = []
  readonly blocks: { t: number, why: string }[] = []
  readonly actions: { t: number, id: string, type: string, ch?: string, params?: Record<string, unknown> }[] = [] // 除 reply 外起的动作（computer、qq.* …）
  readonly guards: { t: number, action: string, who: string, why: string }[] = [] // guard 拦下的
  readonly marks: { t: number, type: string, text: string, until?: number }[] = [] // 她自己做的决定（temper.ignored / temper.forgiven …）
  readonly lines: string[] = []
  readonly commandOut: string[] = [] // 场景里跑的后端命令的输出
  private fails = 0

  /** 场景涉及的频道：第一个是主频道（多数场景只有它） */
  readonly channels = new Set<string>()

  constructor(
    readonly scene: Scene,
    readonly channel: string,
    private config: Record<string, unknown>,
  ) {
    this.channels.add(channel)
  }

  has(ch: string): boolean { return this.channels.has(ch) }

  // ── 记录 ──
  /** 后端日志里的感知文字（看图后的样子）按到达顺序补到收件上 */
  percept(ch: string, text: string, sender: string): void {
    // 先按文字对（去掉 @、[图片…] 这些段再比）：只按「同一人第一条没对上的」对，漏一条感知后这个人后面的话全错一格
    //（2026-10-22 复测 boring-rocket「长征五号」对到了前一句灌水上，话题吸引力核对误判）
    const norm = (s: string): string => s.replace(/\[[^\]]*\]|@\S+|\s/g, '')
    const same = this.ins.find(x => !x.seen && x.who === sender && x.ch === ch && norm(x.text) && norm(x.text) === norm(text))
    const i = same ?? this.ins.find(x => !x.seen && x.who === sender && x.ch === ch)
    if (i) {
      i.text = text
      i.seen = true
    }
  }

  policy(ch: string, p: Policy, sender: string): void {
    const i = [...this.ins].reverse().find(x => !x.policy && x.who === sender && x.ch === ch)
    if (i)
      i.policy = p
  }

  // ── 核对用 ──
  starts(ch?: string): Start[] { return ch ? this.startList.filter(s => s.ch === ch) : this.startList }
  inbound(): In[] { return this.ins }
  /** 真说出了字的开口次数（第一句刚开口就被第二句打断、一个字没发出去的不算） */
  spokenStarts(): number { return this.startList.filter(s => (this.settles.find(x => x.id === s.id)?.delivered ?? 'x').trim()).length }
  outText(): string[] { return this.outs.map(o => o.text) }
  woken(): number { return this.ins.filter(i => i.policy?.wake).length }
  /** 本场景频道里起过这种动作（别的对话里同时起的不算，比如主人正在网页上让她干活） */
  actionStarted(type: string): boolean { return this.actions.some(a => a.type === type && !!a.ch && this.has(a.ch)) }

  /** 第 i 句之后、同频道下一句别人的话之前（最多 40 秒）她说的话，拼起来比对 */
  saidAfter(i: number, re: RegExp): boolean {
    const m = this.ins[i]
    if (!m)
      return false
    const next = this.ins.slice(i + 1).find(x => x.ch === m.ch)?.t ?? Infinity
    const said = this.outs.filter(o => o.ch === m.ch && o.t >= m.t && o.t < Math.min(next, m.t + 40_000)).map(o => o.text).join(' ')
    return re.test(said)
  }
  blockedList(): string[] { return this.guards.map(g => `${g.action}：${g.why}`) }
  cfg<T>(key: string, def: T): T { return (this.config[key] as T | undefined) ?? def }

  maxPerMinute(): number {
    let max = 0
    for (const s of this.startList)
      max = Math.max(max, this.startList.filter(x => x.t >= s.t && x.t - s.t < 60_000).length)
    return max
  }

  answered(i: number, withinMs: number): boolean {
    const m = this.ins[i]
    return !!m && this.startList.some(s => s.ch === m.ch && s.t >= m.t && s.t - m.t <= withinMs)
  }

  /** 第 i 句之后她在它那个频道第一次开口的时刻；没开口为 Infinity */
  firstAnswer(i: number): number {
    const m = this.ins[i]
    return this.startList.find(s => m && s.ch === m.ch && s.t >= m.t)?.t ?? Infinity
  }

  /** 同一时刻在不同频道并行说话的最多个数（一次只在一个会话里 → 应为 1） */
  maxParallel(): number {
    let max = 0
    for (const s of this.startList) {
      const live = this.startList.filter((x) => {
        // 没收到结算（被打断时偶尔漏）就以同频道下一次开口为止
        const end = this.settles.find(e => e.id === x.id)?.t
          ?? this.startList.find(y => y.ch === x.ch && y.t > x.t)?.t ?? Infinity
        return x.t <= s.t && end > s.t
      })
      max = Math.max(max, new Set(live.map(x => x.ch)).size)
    }
    return max
  }

  startsBetween(i: number, j: number): number {
    const a = this.ins[i]?.t ?? 0
    const b = this.ins[j]?.t ?? Infinity
    return this.startList.filter(s => s.t >= a && s.t < b).length
  }

  policyOf(i: number): string {
    const p = this.ins[i]?.policy
    return p ? `p=${p.p} ${p.wake ? '唤醒' : '没唤醒'}（${p.why.join('、')}）` : '没有打分（@/叫名字/私聊直达，或策略没装）'
  }

  policyReasons(i: number): string[] { return this.ins[i]?.policy?.why ?? [] }

  expect(ok: boolean, label: string): string {
    if (!ok)
      this.fails++
    return `${ok ? '✓' : '✗'} ${label}`
  }

  note(label: string): string { return `· ${label}` }

  get failed(): number { return this.fails }

  // ── 打印 ──
  private rel(t: number): string {
    return `+${((t - this.t0) / 1000).toFixed(1).padStart(6)}s`
  }

  private tag(ch: string): string {
    return this.channels.size > 1 ? `[${ch.replace(/^qq:/, '')}] ` : ''
  }

  render(): string[] {
    const rows: { t: number, s: string }[] = []
    for (const i of this.ins) {
      rows.push({ t: i.t, s: `IN     ${this.tag(i.ch)}${i.who}：${i.text}` })
      if (i.policy)
        rows.push({ t: i.policy.t, s: `  策略 p=${i.policy.p} ${i.policy.wake ? '→ 唤醒导演' : '→ 不唤醒'}（${i.policy.why.join('、')}）` })
    }
    for (const th of this.thinks)
      rows.push({ t: th.t, s: `  导演 ${th.aborted ? '(作废) ' : ''}${th.note}${th.intents.length ? ` ⇒ ${JSON.stringify(th.intents)}` : ''}` })
    for (const s of this.startList)
      rows.push({ t: s.t, s: `  开口 ${this.tag(s.ch)}${s.id}（${s.action}）` })
    for (const s of this.settles)
      rows.push({ t: s.t, s: `  说完 ${s.id}${s.cause ? `（${s.cause}）` : ''}` })
    for (const o of this.outs)
      rows.push({ t: o.t, s: `OUT    ${this.tag(o.ch)}沐沐：${o.text}` })
    for (const b of this.blocks)
      rows.push({ t: b.t, s: `  拦下导演的 reply（${b.why}）` })
    for (const a of this.actions)
      rows.push({ t: a.t, s: `  动作 ${a.id}${a.ch ? `（${a.ch}）` : ''}` })
    for (const g of this.guards)
      rows.push({ t: g.t, s: `  guard 拦下 ${g.action}（${g.who}：${g.why}）` })
    for (const m of this.marks)
      rows.push({ t: m.t, s: `  她决定 ${m.type}：${m.text}` })
    rows.sort((a, b) => a.t - b.t)
    return rows.map(r => `${this.rel(r.t)}  ${r.s}`)
  }

  /** 一个场景的统计：开口次数、发出条数、每分钟、最长沉默、刷屏 */
  stats(endAt: number): { line: string, perMin: number, spam: boolean } {
    const dur = Math.max(1, (endAt - this.t0) / 60_000)
    const perMin = this.outs.length / dur
    const marks = [this.t0, ...this.outs.map(o => o.t), endAt]
    let silence = 0
    for (let k = 1; k < marks.length; k++)
      silence = Math.max(silence, marks[k] - marks[k - 1])
    // 刷屏：10 秒内她发出 ≥4 条，且来自不止一次开口（一次开口分几条发是正常的）
    let spam = false
    for (const o of this.outs) {
      const win = this.outs.filter(x => x.t >= o.t && x.t - o.t < 10_000).length
      const startsIn = this.startList.filter(s => s.t >= o.t - 10_000 && s.t - o.t < 10_000).length
      if (win >= 4 && startsIn >= 2)
        spam = true
    }
    const line = `收 ${this.ins.length} 句 · 唤醒导演 ${this.woken()} 次 · 她开口 ${this.startList.length} 次、发出 ${this.outs.length} 条`
      + ` · ${perMin.toFixed(1)} 条/分钟 · 最长沉默 ${Math.round(silence / 1000)}s${spam ? ' · ⚠ 刷屏' : ''}`
    return { line, perMin, spam }
  }

  /** 每次开口前对方最后一句 + 她实际说出的话，人工看有没有答非所问 */
  pairs(): string[] {
    return this.startList.map((s) => {
      const before = [...this.ins].reverse().find(i => i.t <= s.t && i.ch === s.ch)
      const said = this.settles.find(x => x.id === s.id)?.delivered ?? '（没说完 / 没送达）'
      return `  ${this.tag(s.ch)}「${before ? `${before.who}：${before.text}` : '（无）'}」 → 「${said.replace(/\s+/g, ' ')}」`
    })
  }
}
