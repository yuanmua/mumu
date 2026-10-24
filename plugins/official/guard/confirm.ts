/**
 * 「先问主人」的一来一回（规则 5、6，见 README）：登记、主人答话、嘴上先问的认定；index.ts 管拦、放行和替她起动作。
 *
 * 被拦下要主人点头的意图**整个登记**（不是只记一个键等大脑再起一次）：主人在同一个频道回了肯定的话，guard 直接替她起这个意图；
 * 回了否定的话就作废，过了窗口也作废。真群甲（2026-10-23 16:12）：主人让她把 mp3 发群里，guard 拦下要确认；
 * 她第二次学乖了只嘴上问、没起 qq.send，guard 没东西可登记，主人回「确认，发吧」不算数，她过后起 qq.send 又被拦一次。
 * 嘴上先问、主人答了之后大脑才起的，也认：要她做的人最后一句之后她在这个频道开过口、之后主人的答话是肯定的，同样算点头（told）。
 * **一句答复只算一件事**（used）：答过一件就用掉，别人再要新的，照样拦下、再问（复测：第一首点过头，第二首大脑说「主人刚点头过，直接发吧」被放行）。
 * 主人答过的事记一个窗口（settled）：做过的大脑再起不重做，不让做的不做。
 */

export interface Intentish { do: string, action?: string, channel?: string, params?: Record<string, unknown> }
export interface Waiting { at: number, room: string, key: string, intent: Intentish, label: string, who: string }
type Answer = 'yes' | 'no' | undefined

export class Confirms {
  private waiting = new Map<string, Waiting>()
  private settled = new Map<string, { at: number, ok: boolean }>()
  private spoke = new Map<string, number[]>() // 频道 → 她最近几次开口的时刻
  private used = new Set<number>() // 已经算过一次的主人答话（按听到的时刻）：一句答复只对应一件事

  constructor(private windowMs: () => number, private answer: (text: string) => Answer) {}

  clear(): void {
    this.waiting.clear()
    this.settled.clear()
    this.spoke.clear()
    this.used.clear()
  }

  /** 她在这个频道开口了（utterance.started） */
  spokeAt(ch: string, at: number): void {
    this.spoke.set(ch, [...(this.spoke.get(ch) ?? []).slice(-9), at])
  }

  wait(w: Waiting): void {
    this.waiting.set(w.key, w)
  }

  list(now: number): Waiting[] {
    return [...this.waiting.values()].filter(w => now - w.at < this.windowMs())
  }

  /**
   * 主人在 room 说了一句：答的是这个频道里最近登记的那一件（拿掉登记、记进 settled，这句答话记为用过）；
   * 不是答话、没有在等的就是 undefined。一句答复只对应一件事：同时等着两件，答一句只算最近问的那件
   */
  answered(room: string, at: number, text: string): { w: Waiting, ok: boolean } | undefined {
    const a = this.answer(text)
    if (!a)
      return undefined
    for (const w of [...this.waiting.values()]) {
      if (at - w.at > this.windowMs())
        this.waiting.delete(w.key)
    }
    const w = [...this.waiting.values()].filter(x => x.room === room).pop()
    if (!w)
      return undefined
    this.waiting.delete(w.key)
    this.used.add(at)
    this.settle(w.key, at, a === 'yes')
    return { w, ok: a === 'yes' }
  }

  /** 主人答过的同一件事（窗口内） */
  done(key: string, now: number): { at: number, ok: boolean } | undefined {
    const s = this.settled.get(key)
    return s && now - s.at < this.windowMs() ? s : undefined
  }

  settle(key: string, at: number, ok: boolean): void {
    this.settled.set(key, { at, ok })
  }

  /**
   * 嘴上先问的：since（要她做这件事的人在这个频道最后一句话）之后她在 room 开过口，开口之后主人第一句还没用过的答话；
   * 算了就记为用过。since 取那人最后一句、不只带任务词的：复测里阿哲第二次「再把 daoxiang.mp3 也发上来」不带任务词，
   * 原来退回到第一次请求，把第一首那次的「她问 → 主人发吧」又算了一遍，第二首没问就发了
   */
  told(room: string, since: number, now: number, owner: { at: number, text: string }[]): Answer {
    const asked = (this.spoke.get(room) ?? []).find(t => t > since && now - t < this.windowMs())
    if (asked === undefined)
      return undefined
    const h = owner.find(x => x.at > asked && !this.used.has(x.at) && this.answer(x.text))
    if (!h)
      return undefined
    this.used.add(h.at)
    return this.answer(h.text)
  }
}

/** 动作 + 子操作：qq.send 按 op 分（发文件和戳一戳不是一回事），其余就是动作名 */
export function opOf(action: string, params: Record<string, unknown> | undefined): string {
  return action === 'qq.send' && typeof params?.op === 'string' ? `qq.send:${params.op}` : action
}

/** 列表里写动作名（整个动作）或「动作:op」都认 */
export function listed(list: string[] | undefined, action: string, op: string): boolean {
  return !!list && (list.includes(action) || list.includes(op))
}

/** 给人和大脑看的「做什么」：qq.send:file（a.mp3） */
export function label(op: string, params: Record<string, unknown> | undefined): string {
  const what = ['name', 'path', 'text', 'who'].map(k => params?.[k]).find(v => typeof v === 'string' && v)
  return `${op}${what ? `（${String(what).split(/[\\/]/).pop()?.slice(0, 40)}）` : ''}`
}

/** 同一件事的键：在哪问的、做什么、往哪做、做的是哪个（发哪个文件 / 说哪句） */
export function keyOf(room: string, op: string, target: string, params: Record<string, unknown> | undefined): string {
  const what = ['path', 'text', 'who', 'name'].map(k => params?.[k]).find(v => typeof v === 'string' && v) ?? ''
  return `${room}|${op}|${target}|${String(what)}`
}

/**
 * 主人这句是不是在答「做不做」：去掉 @、引用、标点后不超过 maxChars 个字（长句是在聊别的，里面恰好有「可以」不算）；
 * 反问（「可以吗？」「发什么」）不是答。先看否定（「不可以」「不行」里也有「可以」「行」），再看肯定；
 * 一个字的肯定词（好 / 行 / 嗯）要打头才算（「好的」「行吧」，不是「这首歌挺好」）。
 */
export function answerOf(text: string, yes: string[], no: string[], maxChars = 16): 'yes' | 'no' | undefined {
  const own = text.replace(/\[[^\]]*\]/g, '').replace(/@\S+/g, '')
  if (/[?？]|吗|什么|哪|怎么/.test(own))
    return undefined
  const t = own.replace(/[\s\p{P}\p{S}~～]/gu, '').toLowerCase()
  if (!t || t.length > maxChars)
    return undefined
  if (no.some(w => w && t.includes(w.toLowerCase())))
    return 'no'
  if (yes.some(w => w && (w.length > 1 ? t.includes(w.toLowerCase()) : t.startsWith(w))))
    return 'yes'
  return undefined
}
