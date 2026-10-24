/**
 * A 段的行为统计：每群收了多少、她开口几次、每分钟几条、@ 她的答没答（多快）、刷没刷屏、怪情况她怎么回，
 * 外加抽样给裁判的发言（按场景分：@ 她、主动插话、私聊、怪情况）。
 */
import type { Observer } from './observe.ts'

interface Ctx {
  start: number
  end: number
  sent: number
  groups: number[]
  weird: { label: string, group: number, at: number, what: string }[]
  plants: { who: string, where: string, at: number, text: string }[]
}

export function analyze(obs: Observer, outs: { at: number, channel: string, text: string }[], c: Ctx) {
  const inWin = (t: number): boolean => t >= c.start && t <= c.end + 60_000
  const said = [...obs.said.values()].filter(s => s.channel.startsWith('qq:') && inWin(s.startedAt))
  const heard = obs.heard.filter(h => inWin(h.at))
  const minutes = Math.max(1, (c.end - c.start) / 60_000)

  const perGroup = c.groups.map((g) => {
    const ch = `qq:group:${g}`
    const starts = said.filter(s => s.channel === ch).map(s => s.startedAt).sort((a, b) => a - b)
    let maxPerMin = 0
    for (const t of starts) maxPerMin = Math.max(maxPerMin, starts.filter(x => x >= t && x - t < 60_000).length)
    const policy = obs.policy.filter(p => p.channel === ch && inWin(p.at))
    return {
      group: g,
      heard: heard.filter(h => h.channel === ch).length,
      woke: policy.filter(p => p.wake).length,
      starts: starts.length,
      outs: outs.filter(o => o.channel === ch && inWin(o.at)).length,
      outsPerMinute: Number((outs.filter(o => o.channel === ch && inWin(o.at)).length / minutes).toFixed(2)),
      maxStartsPerMinute: maxPerMin,
    }
  })

  // @ 她 / 叫她 / 私聊：45 秒内有没有开口，多快
  const directs = heard.filter(h => h.direct)
  const latencies: number[] = []
  const outLatencies: number[] = []
  let missed = 0
  const missedList: string[] = []
  for (const d of directs) {
    const s = said.find(x => x.channel === d.channel && x.startedAt >= d.at - 200 && x.startedAt - d.at < 45_000)
    const o = outs.find(x => x.channel === d.channel && x.at >= d.at && x.at - d.at < 60_000)
    if (!s) {
      missed++
      missedList.push(`${d.channel} ${d.name}：${d.text.slice(0, 40)}`)
    }
    else {
      latencies.push(s.startedAt - d.at)
    }
    if (o)
      outLatencies.push(o.at - d.at)
  }

  const weird = c.weird.map(w => ({
    ...w,
    her: outs.filter(o => o.channel === `qq:group:${w.group}` && o.at >= w.at && o.at - w.at < 70_000).map(o => plain(o.text)),
  }))
  const plants = c.plants.map(p => ({
    ...p,
    her: outs.filter(o => o.at >= p.at && o.at - p.at < 40_000 && (p.where === 'private' ? o.channel.startsWith('qq:private:') : o.channel === `qq:group:${p.where}`)).map(o => plain(o.text)),
  }))

  // 抽样给裁判
  const sceneOf = (s: { channel: string, startedAt: number }): string => {
    if (s.channel.startsWith('qq:private:'))
      return '私聊'
    if (c.weird.some(w => s.channel === `qq:group:${w.group}` && s.startedAt >= w.at && s.startedAt - w.at < 70_000))
      return '怪情况'
    if (heard.some(h => h.direct && h.channel === s.channel && s.startedAt >= h.at - 200 && s.startedAt - h.at < 8000))
      return '@ 她 / 叫她'
    return '主动插话'
  }
  const byScene = new Map<string, unknown[]>()
  for (const s of said) {
    if (!s.delivered?.trim())
      continue
    const scene = sceneOf(s)
    const context = heard.filter(h => h.channel === s.channel && h.at <= s.startedAt).slice(-6).map(h => `${h.name}：${h.text.slice(0, 60)}`)
    const list = byScene.get(scene) ?? []
    list.push({ id: s.id, scene, context, reply: s.delivered.replace(/\s+/g, ' ').slice(0, 200) })
    byScene.set(scene, list)
  }
  const samples: unknown[] = []
  for (const list of byScene.values()) {
    const step = Math.max(1, Math.floor(list.length / 25))
    for (let i = 0; i < list.length && samples.length < 200; i += step) samples.push(list[i])
  }

  const avg = (xs: number[]): number | null => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null
  const pct = (xs: number[], p: number): number | null => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null
  return {
    minutes: Number(minutes.toFixed(1)),
    sent: c.sent,
    heard: heard.length,
    herStarts: said.length,
    herOuts: outs.filter(o => inWin(o.at)).length,
    perGroup,
    directs: directs.length,
    missedDirects: missed,
    missedList: missedList.slice(0, 20),
    startLatencyMs: { avg: avg(latencies), p50: pct(latencies, 0.5), p90: pct(latencies, 0.9) },
    firstOutMs: { avg: avg(outLatencies), p50: pct(outLatencies, 0.5), p90: pct(outLatencies, 0.9) },
    weird,
    plants,
    // 话题生命周期（napcat-group 做的 topic.opened / topic.closed）：开了几个、收了几个；收尾后还追问的看裁判的翻车项
    topics: { opened: obs.count('topic.opened'), closed: obs.count('topic.closed') },
    // 表情包：群友发的被收进库几张（sticker.analyzed）、她发了几张（发出去的图片段）、占她发言的比例
    stickers: {
      collected: obs.count('sticker.analyzed'),
      herSent: outs.filter(o => inWin(o.at) && o.text.includes('"type":"image"')).length,
      perStart: Number((outs.filter(o => inWin(o.at) && o.text.includes('"type":"image"')).length / Math.max(1, said.length)).toFixed(3)),
    },
    sceneCounts: Object.fromEntries([...byScene].map(([k, v]) => [k, v.length])),
    samples,
  }
}

function plain(json: string): string {
  try {
    const segs = JSON.parse(json) as { type: string, data?: Record<string, unknown> }[]
    return segs.map(s => s.type === 'text' ? String(s.data?.text ?? '') : `[${s.type}]`).join('')
  }
  catch {
    return json
  }
}
