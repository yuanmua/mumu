/**
 * 「是谁让她做的」：认人规则，纯函数（index.ts 把听到的话、本拍原因喂进来）。
 *
 * 顺序：
 * 1. 大脑写的 requestedBy——号或名字 / 群名片都认，对照这个频道窗口内说过话的真人映射回号；
 *    对上了就是他，但他最后一句之后又有别的真人（不是主人）要她做事，就算插进来的那个人要的。
 *    名字对上好几个号（有人改成同样的群名片冒充）不认，往下走。
 * 2. 本拍唤醒原因里像在要她做事的真人（@ 她 / 私聊，或带任务词）。
 * 3. 频道窗口内最后一条任务请求（带任务词）的真人。
 * 4. 都没有：没找到是谁要的。
 * 机器人和系统播报不算人：真群里机器人回了句「截图失败: …」（带「截图」），被当成频道里最后一条任务请求，
 * 主人紧接着说的「点进去保存」被判成机器人要的，拦下（2026-10-22）。
 */
import type { Sender } from '../../../src/index.ts'

export interface Heard {
  at: number
  channel: string
  sender: Sender
  text: string
  task: boolean // 带任务词
  direct: boolean // @ 她 / 私聊
  bot: boolean // 群里的机器人
}

export interface Verdict {
  via: 'claim' | 'beat' | 'record' | 'none'
  reqs: { sender: Sender, channel: string }[]
  /** via claim：认出的人最后一句之后，插进来要她做事的别的真人（不是主人） */
  cutIn?: Heard
  /** 大脑写了 requestedBy，但对不上这个频道窗口内说过话的任何一个真人（或对上好几个号） */
  claimLost: boolean
}

/** requestedBy → 频道里最近说过话的那个真人的最后一句；对不上或对上多个号返回 undefined */
export function resolveClaim(claim: unknown, humans: Heard[]): Heard | undefined {
  if (typeof claim !== 'string' || !claim.trim())
    return undefined
  const c = claim.trim().replace(/^@/, '')
  const lastOf = (id: string): Heard | undefined => [...humans].reverse().find(h => h.sender.id === id)
  const ids = [...new Set(humans.map(h => h.sender.id))]
  // 号：原样、「qq:号」，或名字后面带着号（「原木呀(10001)」）
  const byId = ids.find(id => c === id || c.endsWith(`:${id}`)) ?? ids.find(id => id.length >= 5 && c.includes(id))
  if (byId)
    return lastOf(byId)
  // 名字：先精确，再互相包含；同名的不止一个号就不认（冒充者改成同样的群名片）
  const named = (match: (name: string) => boolean): string[] =>
    [...new Set(humans.filter(h => !!h.sender.name && match(h.sender.name)).map(h => h.sender.id))]
  const exact = named(n => n === c)
  const pick = exact.length ? exact : named(n => n.includes(c) || c.includes(n))
  return pick.length === 1 ? lastOf(pick[0]) : undefined
}

export function whoAsked(o: {
  claim: unknown
  /** 本拍目标频道里有 sender 的唤醒原因 */
  beat: Heard[]
  /** 目标频道窗口内听到的真人的话（已去掉机器人），按时间排 */
  humans: Heard[]
  isOwner: (s: Sender) => boolean
}): Verdict {
  const claimed = resolveClaim(o.claim, o.humans)
  if (claimed) {
    // 按听到的先后比，不比时间戳：同一毫秒到的两条也分得出前后
    const cutIn = o.humans.slice(o.humans.indexOf(claimed) + 1).filter(h => h.task && h.sender.id !== claimed.sender.id && !o.isOwner(h.sender)).pop()
    return { via: 'claim', reqs: [claimed], cutIn, claimLost: false }
  }
  const claimLost = typeof o.claim === 'string' && !!o.claim.trim()
  const fromBeat = o.beat.filter(b => !b.bot && (b.direct || b.task))
  if (fromBeat.length)
    return { via: 'beat', reqs: fromBeat, claimLost }
  const last = o.humans.filter(h => h.task).pop()
  if (last)
    return { via: 'record', reqs: [last], claimLost }
  return { via: 'none', reqs: [], claimLost }
}
