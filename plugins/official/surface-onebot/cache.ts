/**
 * 记性：每个频道最近的消息 + 每个群见过的人。
 *
 * 为什么要：
 * - 引用回复（<|quote|>）要知道「她在回谁的哪一条」的 message_id；
 * - 撤回通知只带 message_id，要说出「撤回了什么」得自己记着原文；
 * - @ 人（<|at:小红|>）模型写的是名字，发出去要 QQ 号——从见过的群名片 / 昵称里找，找不到再查群成员列表。
 * 只在内存里，重启就忘；真源仍是内核日志。
 */

export interface Seen {
  messageId: string
  userId: string // 她自己 = selfId
  name: string
  text: string
  at: number
}

export interface Member {
  userId: string
  card?: string
  nickname?: string
  role?: string
}

export class Memory {
  private msgs = new Map<string, Seen[]>()
  private byId = new Map<string, Seen & { channel: string }>()
  private members = new Map<string, Map<string, Member>>() // 群号 → QQ 号 → 成员

  constructor(private keep: number) {}

  remember(channel: string, m: Seen): void {
    const list = this.msgs.get(channel) ?? []
    list.push(m)
    if (list.length > this.keep) {
      for (const old of list.splice(0, list.length - this.keep)) this.byId.delete(old.messageId)
    }
    this.msgs.set(channel, list)
    this.byId.set(m.messageId, { ...m, channel })
  }

  find(messageId: string): (Seen & { channel: string }) | undefined {
    return this.byId.get(String(messageId))
  }

  /** 这个频道里别人最近的一条；给了 who（名字或 QQ 号）就找那个人的 */
  lastFrom(channel: string, selfId: string | undefined, who?: string): Seen | undefined {
    const list = this.msgs.get(channel) ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.userId === selfId)
        continue
      if (!who || m.userId === who || m.name === who || m.name.includes(who))
        return m
    }
    return undefined
  }

  recent(channel: string, n: number): Seen[] {
    return (this.msgs.get(channel) ?? []).slice(-n)
  }

  meet(group: string, m: Member): void {
    const g = this.members.get(group) ?? new Map<string, Member>()
    g.set(m.userId, { ...g.get(m.userId), ...Object.fromEntries(Object.entries(m).filter(([, v]) => v)) } as Member)
    this.members.set(group, g)
  }

  memberName(group: string, userId: string): string | undefined {
    const m = this.members.get(group)?.get(userId)
    return m?.card || m?.nickname
  }

  /** 名字 → QQ 号：完全相同优先，其次包含；数字直接当 QQ 号 */
  resolve(group: string | undefined, who: string): string | undefined {
    const w = who.trim().replace(/^@/, '')
    if (/^\d{5,12}$/.test(w))
      return w
    const pool = group ? [...(this.members.get(group)?.values() ?? [])] : [...this.members.values()].flatMap(g => [...g.values()])
    const exact = pool.find(m => m.card === w || m.nickname === w)
    if (exact)
      return exact.userId
    return pool.find(m => (m.card && (m.card.includes(w) || w.includes(m.card))) || (m.nickname && (m.nickname.includes(w) || w.includes(m.nickname))))?.userId
  }

  knowsGroup(group: string): boolean {
    return (this.members.get(group)?.size ?? 0) > 3
  }
}

type Call = <T = unknown>(action: string, params?: Record<string, unknown>) => Promise<T>
interface MemberRow { user_id: number, card?: string, nickname?: string, role?: string }

/** 名字 ↔ QQ 号：先查记性，查不到再问 NapCat（问到的记下来） */
export function people(memory: Memory, call: Call): {
  resolve: (group: string | undefined, who: string) => Promise<string | undefined>
  nameOf: (group: string | undefined, user: string) => Promise<string>
} {
  return {
    async resolve(group, who) {
      const hit = memory.resolve(group, who)
      if (hit || !group || memory.knowsGroup(group))
        return hit
      // 失败或返回空（null）都当没查到，别让一次查询把动作弄崩
      const list = (await call<MemberRow[] | null>('get_group_member_list', { group_id: group }).catch(() => null)) ?? []
      for (const m of list) memory.meet(group, { userId: String(m.user_id), card: m.card, nickname: m.nickname, role: m.role })
      return memory.resolve(group, who)
    },
    async nameOf(group, user) {
      const known = group ? memory.memberName(group, user) : undefined
      if (known)
        return known
      const info = await (group
        ? call<MemberRow>('get_group_member_info', { group_id: group, user_id: user })
        : call<MemberRow>('get_stranger_info', { user_id: user })).catch(() => undefined)
      if (group && info)
        memory.meet(group, { userId: user, card: info.card, nickname: info.nickname, role: info.role })
      return info?.card || info?.nickname || user
    },
  }
}
