/**
 * 从真机日志库取一天的真实群记录，存成回放语料（2026-10-23，真实群记录回放的第一步）。只读：
 *   npx tsx scripts/replay/real-corpus.ts <库文件> <日期 YYYY-MM-DD> <群号…>
 * 每个群写一份 data/corpus/real-<日期>-<群号>.jsonl（data/ 不进 git），一行一条，按 seq 排：
 * - `msg`：别人的群消息（含 @ 她的）——seq、at、kind、who、name、text、bot、mentioned、replyTo、messageId、role；
 *   她自己的话不在感知里（surface-onebot 不收自己的），回放时由她现场说
 * - `poke` / `recall`：戳她、撤回（回放时照样发）
 * - `her`：她当天实际说出去的（utterance.settled 的 delivered，空的是发图）——只给报告对照，不回放
 * - `policy` / `pending` / `decision`：当天的读空气、说完补判、大脑决定——只给报告对照
 * 文字是 surface-onebot 渲染过的样子（「@沐沐」「[回复 X「…」]」「[图片：…]」），回放时再拆回消息段（replay-real.ts）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const [dbFile, day, ...groups] = process.argv.slice(2)
if (!dbFile || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !groups.length) {
  console.error('用法：npx tsx scripts/replay/real-corpus.ts <库文件> <日期 YYYY-MM-DD> <群号…>')
  process.exit(1)
}
const from = Date.parse(`${day}T00:00:00+08:00`)
const to = from + 86_400_000
const TYPES = ['percept.received', 'utterance.settled', 'group.policy', 'convo.pending', 'mind.decision']
const sql = `select seq, at, type, data from events where at>=${from} and at<${to} and type in (${TYPES.map(t => `'${t}'`).join(',')}) order by seq`
const rows = (JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', dbFile, sql], { maxBuffer: 1 << 30 }).toString() || '[]') as { seq: number, at: number, type: string, data: string }[])
  .map(r => ({ ...r, data: JSON.parse(r.data) as Record<string, any> }))

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}…` : t
}

mkdirSync('data/corpus', { recursive: true })
for (const g of groups) {
  const ch = `qq:group:${g}`
  const out: Record<string, unknown>[] = []
  for (const { seq, at, type, data: d } of rows) {
    if (type === 'percept.received' && d.channel === ch) {
      if (d.kind === 'group.message' || d.kind === 'message') {
        out.push({
          t: 'msg', seq, at, kind: d.kind, who: String(d.sender?.id ?? ''), name: String(d.sender?.name ?? ''), text: String(d.text ?? ''),
          ...(d.data?.bot ? { bot: true } : {}), mentioned: !!d.data?.mentioned,
          ...(d.data?.replyTo ? { replyTo: String(d.data.replyTo) } : {}),
          ...(d.data?.messageId !== undefined ? { messageId: String(d.data.messageId) } : {}),
          ...(d.data?.role ? { role: d.data.role } : {}),
        })
      }
      else if (d.kind === 'qq.poke' && String(d.text ?? '').includes('戳了戳你'))
        out.push({ t: 'poke', seq, at, who: String(d.sender?.id ?? ''), name: String(d.sender?.name ?? '') })
      else if (d.kind === 'qq.recall')
        out.push({ t: 'recall', seq, at, who: String(d.data?.userId ?? ''), text: String(d.text ?? '') })
    }
    else if (type === 'utterance.settled' && d.channel === ch)
      out.push({ t: 'her', seq, at, id: d.id, text: String(d.delivered ?? ''), ...(d.cause ? { cause: d.cause } : {}) })
    else if (type === 'group.policy' && d.channel === ch) {
      out.push({
        t: 'policy', seq, at, who: String(d.sender?.id ?? ''), name: String(d.sender?.name ?? ''), p: d.p, wake: !!d.wake, why: d.why ?? [],
        ...(d.state ? { state: d.state } : {}), ...(d.convo ? { convo: true } : {}), ...(d.task ? { task: true } : {}), ...(d.at ? { atHer: true } : {}), ...(d.bot ? { bot: true } : {}),
      })
    }
    else if (type === 'convo.pending' && d.channel === ch)
      out.push({ t: 'pending', seq, at, who: String(d.who ?? ''), name: d.name, p: d.p, wake: d.wake, why: d.why })
    else if (type === 'mind.decision') {
      const reasons = (d.reasons ?? []) as Record<string, any>[]
      const intents = (d.intents ?? []) as Record<string, any>[]
      if (!reasons.some(r => r.channel === ch) && !intents.some(i => i.channel === ch))
        continue
      out.push({
        t: 'decision', seq, at, note: clip(d.note, 300), aborted: !!d.aborted,
        intents: intents.map(i => ({ do: i.do, action: i.action, channel: i.channel, ...(i.params?.guidance ? { guidance: clip(i.params.guidance, 200) } : {}) })),
        reasons: reasons.map(r => ({ source: r.source, channel: r.channel, text: clip(r.text, 160), ...(r.sender ? { sender: r.sender } : {}) })),
      })
    }
  }
  const file = `data/corpus/real-${day}-${g}.jsonl`
  writeFileSync(file, `${out.map(x => JSON.stringify(x)).join('\n')}\n`)
  const n = (t: string): number => out.filter(x => x.t === t).length
  console.log(`${file}：别人的消息 ${n('msg')}（机器人 ${out.filter(x => x.t === 'msg' && x.bot).length}）、戳 ${n('poke')}、撤回 ${n('recall')}；她说的 ${out.filter(x => x.t === 'her' && x.text).length}、读空气 ${n('policy')}、补判 ${n('pending')}、大脑 ${n('decision')}`)
}
