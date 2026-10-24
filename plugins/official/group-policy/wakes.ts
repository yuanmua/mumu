/**
 * 给大脑的【这次为什么叫醒你】：群聊策略最近几次把大脑叫醒时，她是「在聊」还是「没在聊」（judge.ts 的两种状态）。
 *
 * 没在聊天状态时少回一点，看一眼就过去；在聊天状态就接着多聊几句。策略层只决定要不要让大脑看一眼，
 * 插不插话是大脑按【群聊】规则定的——但它得知道这一眼是哪种：模拟器 flood / pingpong 里大脑被叫醒看一眼就每次都插话，
 * 因为材料里没写「你只是刷群刷到的」。这里只摆状态，不替它决定。
 * 没在聊那句原来还写「默认不插话、看一眼就过」：读空气那一掷（没在聊时 p 中位数约 0.03）本身就是「偶尔看一眼」，大脑再默认不说是双重把关——
 * 2026-10-23 真群回放里没被 @ 的叫醒大脑只说了 11%，note 大半照抄「看一眼就过」，她自己开口只占别人消息的 0.7%。所以只写状态 +「有想说的就说」
 */
import type { Decision } from './web.ts'

/** 最近 windowMs 内（默认 60 秒）叫醒过大脑、带状态的判断，按群各取最后一次 */
export function renderWakes(recent: Decision[], now: number, windowMs = 60_000): string {
  const byChannel = new Map<string, Decision>()
  for (const r of recent) {
    if (r.wake && r.state && now - r.at < windowMs)
      byChannel.set(r.channel, r)
  }
  if (!byChannel.size)
    return ''
  const lines = [...byChannel.values()].map((r) => {
    const group = r.channel.split(':').pop()
    const why = r.why.filter(w => !w.startsWith('在聊：')).join('、')
    return r.state === 'chatting'
      ? `- 群 ${group}（${r.who}：${r.why.find(w => w.startsWith('在聊：'))?.slice(3) ?? '在聊'}）：你在这个群聊着，接着聊几句也行；聊到没意思、没人接了就放下`
      : `- 群 ${group}（${r.who}：${why}）：你没在这个群聊着，刷到这一眼；有想说的就说，没有就过`
  })
  return `【这次为什么叫醒你】（群聊策略按「在聊 / 没在聊」叫醒你，插不插话你自己定）\n${lines.join('\n')}`
}
