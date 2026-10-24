/**
 * 群聊阅读窗口：她开口前「读」哪几条。
 *
 * 几万人的群一分钟能刷几十句，原样喂最近 N 条，N 小了漏掉在跟她说的话，N 大了全是噪声还烧钱。
 * 真人点开一个热闹的群也是这样读的：扫最近几条；往上翻找有没有人提到自己；记得自己刚才在跟谁聊什么。
 * 所以窗口 = 最近几条（越密读得越少）+ 更早里提到她的 + 她最近几次开口各自接的那句与她那句
 * + 她正在聊的那段（inConvo：对方和她这段对话里的话，最多 reading.convo 条——群里一热闹，最近几条全是别人，
 * 对方三句前问的那句就被挤出去了，她接不上）；按时间排好、去重、限总数（对话那段不让「限总数」裁掉）。
 * 更早的事交给记忆插件的中期摘要。
 */
import type { HistoryTurn } from '../../../src/index.ts'
import type { ReadingConfig } from './judge.ts'

export function readingWindow(pool: HistoryTurn[], names: string[], cfg: ReadingConfig, now = Date.now(), inConvo?: (t: HistoryTurn) => boolean): HistoryTurn[] {
  if (!pool.length)
    return pool
  const perMinute = pool.filter(t => t.role === 'other' && now - t.at < 60_000).length
  const recentN = perMinute > (cfg.densePerMinute ?? 6) ? cfg.dense ?? 16 : cfg.recent ?? 30
  const pick = new Set<number>()
  for (let i = Math.max(0, pool.length - recentN); i < pool.length; i++) pick.add(i)

  // 更早里提到她的（@ 她、叫名字）
  let mentions = 0
  for (let i = pool.length - recentN - 1; i >= 0 && mentions < (cfg.mentions ?? 6); i--) {
    const t = pool[i]
    if (t.role === 'other' && names.some(n => n && t.text.includes(n))) {
      pick.add(i)
      mentions++
    }
  }
  // 她最近几次开口：她那句 + 她接的那句（前一条别人的话）
  let threads = 0
  for (let i = pool.length - 1; i >= 0 && threads < (cfg.threads ?? 4); i--) {
    if (pool[i].role !== 'self')
      continue
    pick.add(i)
    const prev = pool.slice(0, i).findLastIndex(t => t.role === 'other')
    if (prev >= 0)
      pick.add(prev)
    threads++
  }

  // 正在聊的那段：从后往前收，最多 reading.convo 条
  const convo = new Set<number>()
  for (let i = pool.length - 1; inConvo && i >= 0 && convo.size < (cfg.convo ?? 20); i--) {
    if (inConvo(pool[i]))
      convo.add(i)
  }
  const limit = cfg.limit ?? 48
  const rest = [...pick].filter(i => !convo.has(i)).sort((a, b) => a - b)
  const keep = new Set([...convo, ...rest.slice(-Math.max(0, limit - convo.size))])
  return [...keep].sort((a, b) => a - b).map(i => pool[i])
}

/**
 * 给大脑的历史里，把某个群那几条换成它的阅读窗口（别的频道的照旧），按时间排回去。
 * 内核给大脑的最近几十条是所有频道混着的，热闹的群几秒就把它刷满，大脑只看得到眼前几句。
 */
export function mergeWindow(history: HistoryTurn[], channel: string, window: HistoryTurn[]): HistoryTurn[] {
  return [...history.filter(t => t.channel !== channel), ...window].sort((a, b) => a.at - b.at)
}
