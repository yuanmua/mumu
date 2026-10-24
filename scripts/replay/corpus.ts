/**
 * 真实语料 → 群聊时间线。
 *
 * 语料：清华 thu-coai 的 LCCC-base（MIT，微博真实中文对话；data/corpus/lccc_base_*.jsonl.gz，一行一段对话，字之间空格分隔）。
 * 公开数据里没找到带发言人、时间戳的真实 QQ 群原始记录，所以句子是真人的，「群」是这里拼的：
 * 每段对话分给群里两三个人轮流说，同一个群里同时开着两三段对话交错进行，按群的活跃度定节奏，隔一阵安静一会儿（压缩的「夜里」）。
 * 后端的接话策略、冷场、刷屏都按真实挂钟算，所以不能把时间戳直接压缩——那样在她看来全是刷屏。
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

export interface Line { group: number, who: number, text: string }

/** 字之间的空格去掉；两个英文 / 数字词之间的保留 */
export function clean(tokens: string): string {
  const parts = tokens.trim().split(/\s+/)
  let out = ''
  for (const p of parts) {
    const prev = out.at(-1) ?? ''
    out += /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(p) ? ` ${p}` : p
  }
  return out
}

/** 读语料：只留像群聊的（每句 2～60 字、至少两句） */
export function loadDialogs(files: string[]): string[][] {
  const out: string[][] = []
  for (const f of files) {
    const lines = gunzipSync(readFileSync(f)).toString('utf8').split('\n')
    for (const l of lines) {
      if (!l.trim())
        continue
      let arr: unknown
      try {
        arr = JSON.parse(l)
      }
      catch {
        continue // 坏行跳过
      }
      if (!Array.isArray(arr))
        continue
      const d = arr.map(x => clean(String(x)))
      if (d.length >= 2 && d.every(s => s.length >= 2 && s.length <= 60))
        out.push(d)
    }
  }
  return out
}

/** 可重复的伪随机（同一个种子跑两次一样，便于回归对比） */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export interface GroupSpec { id: number, name: string, perMinute: number, members: number[] }

/**
 * 一个群的发言流：同时开着至多 3 段对话，每次随机接着某段说下一句或开新的一段。
 * 返回无限生成器，调用方按自己的节奏取。
 */
export function* groupStream(g: GroupSpec, dialogs: string[][], start: number, step: number, rand: () => number): Generator<Line> {
  const open: { lines: string[], i: number, speakers: number[] }[] = []
  let k = start
  while (true) {
    if (open.length < 3 && (open.length === 0 || rand() < 0.35)) {
      const d = dialogs[k % dialogs.length]
      k += step
      const n = d.length >= 4 ? 3 : 2
      const speakers: number[] = []
      while (speakers.length < n) {
        const m = g.members[Math.floor(rand() * g.members.length)]
        if (!speakers.includes(m))
          speakers.push(m)
      }
      open.push({ lines: d, i: 0, speakers })
    }
    const pick = open[Math.floor(rand() * open.length)]
    yield { group: g.id, who: pick.speakers[pick.i % pick.speakers.length], text: pick.lines[pick.i] }
    pick.i++
    if (pick.i >= pick.lines.length)
      open.splice(open.indexOf(pick), 1)
  }
}
