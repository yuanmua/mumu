/**
 * 分段写法的归一化：模型该写 <|br|> 分段，实际常写成别的。
 *
 * - HTML 的 <br>：训练语料里 HTML 多。它若作为普通文字说出去，就会进 delivered、进历史、进记忆，下一轮又喂回给模型——
 *   越学越多，网页上显示成字面的「<br>」（实测）。
 * - 换行：模型也爱用换行分段，结果三句挤在一条气泡 / 一条 QQ 消息里（实测：「…起哄\n\n周五九点我记着呢…」）。
 * - 残缺的标记：<|br>、<br|>、<|br|、|br| 之类少了一边（实测 QQ 里出现字面「叫可乐好可爱<|br>三岁了还黏人」）。
 *   <|br> 尤其坏事：parseMarkers 见了 <| 会一直吞到下一个 |>，吞不到就整段当字说出去。
 *
 * 这里只做已知写法的归一化（不是解析模型的决策，不违反「不用正则解析模型输出」）：
 * - 输出流：在 parseMarkers 之前，<br> / <br/> / <br />、残缺的 <|br> 之类（大小写不论）和换行（连着几个算一个）都换成 <|br|>，交给分段机制；
 *   可能被切在两个 chunk 之间，所以结尾留住可能的前缀与换行；开头和结尾的换行直接丢掉。
 * - 历史：她以前说出去的话里的 <br> 与段间换行，喂回模型前写成 <|br|>，正面示范正确写法。
 */

import type { LogEvent } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'

/**
 * 认作分段的写法：左边 <| / < / |，中间 br（大小写不论），右边 |> / > / |，再加 HTML 的 <br/> <br />。
 * 只有一边的不认（<br 可能是 HTML 写到一半，|br 可能是正文），<|br 除外——它后面再也闭合不了标记。按长度从长到短试。
 */
const FORMS = [
  '<br />', '<|br|>',
  '<br/>', '<|br>', '<|br|', '<br|>', '|br|>',
  '<|br', '<br>', '<br|', '|br>', '|br|',
]
const MARK = '<|br|>'

/** newline：'all' = 任何换行都分段（默认）；'double' = 只有空行（连着两个以上）分段；'none' = 不管换行 */
export type NewlineMode = 'all' | 'double' | 'none'

/**
 * 把一段文字里出现的分段写法（含残缺的，见 FORMS）换成 to。
 * 流式时（more = 后面还有）：扫到末尾还凑不齐、再来几个字可能变成（或变长成）某个写法的，停下，那段原样作 rest 留到下一块
 */
function scanForms(s: string, to: string, more = false): { out: string, rest: string } {
  let out = ''
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] !== '<' && s[j] !== '|') j++
    out += s.slice(i, j)
    if (j >= s.length)
      break
    const head = s.slice(j, j + 6).toLowerCase()
    if (more && s.length - j < 6 && FORMS.some(f => f.startsWith(head) && f !== head))
      return { out, rest: s.slice(j) }
    const form = FORMS.find(f => head.startsWith(f))
    if (form) {
      out += to
      i = j + form.length
    }
    else {
      out += s[j]
      i = j + 1
    }
  }
  return { out, rest: '' }
}

const replaceForms = (s: string, to: string): string => scanForms(s, to).out

/**
 * 换行串（含 \r）按模式换成 to：'all' 每串一个；'double' 只换两个以上换行的串，单个换行变空格。
 * 紧挨着已有的 to（「嗯\n<|br|>好」）不再加，免得分出空消息；prevMark = 上一块是不是以 to 结尾
 */
function replaceNewlines(s: string, to: string, mode: NewlineMode, prevMark = false): string {
  if (mode === 'none' || !s.includes('\n'))
    return s
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] !== '\n' && s[i] !== '\r') {
      out += s[i++]
      continue
    }
    let n = 0
    let j = i
    while (j < s.length && (s[j] === '\n' || s[j] === '\r')) {
      if (s[j] === '\n')
        n++
      j++
    }
    if (mode === 'double' && n < 2)
      out += ' '
    else if (!(out ? out.endsWith(to) : prevMark) && !s.startsWith(to, j))
      out += to
    i = j
  }
  return out
}

/** 去掉开头的换行与 <|br|>（模型常以空行开头），结尾同理 */
function trimBreaks(s: string, end: 'start' | 'end'): string {
  let t = s
  while (true) {
    const before = t
    if (end === 'start') {
      t = t.replace(/^[\r\n]+/, '')
      if (t.startsWith(MARK))
        t = t.slice(MARK.length)
    }
    else {
      t = t.replace(/[\r\n]+$/, '')
      if (t.endsWith(MARK))
        t = t.slice(0, -MARK.length)
    }
    if (t === before)
      return t
  }
}

/** 流式：字面 <br> 与换行 → <|br|>，跨 chunk 也认 */
export async function* normalizeBr(source: AsyncIterable<string>, mode: NewlineMode = 'all'): AsyncGenerator<string> {
  let buf = ''
  let started = false
  let lastMark = false // 上一次吐出的是不是以 <|br|> 结尾
  for await (const chunk of source) {
    // 凑不齐的写法留到下一块（<|br| 后面可能还有 >，先换掉的话 > 就漏成了字；正确的 <|br|> 被切开也要留，
    // 换行紧挨着它时得看清才不重复分段，实测「…\n\n<|b」+「r|>」分出了空消息）
    const { out: head, rest } = scanForms(buf + chunk, MARK, true)
    // 结尾的换行也留着：可能还有下一个换行（\n\n）、后面可能紧跟 <|br|>，也可能是整段结尾（该丢）
    let cut = head.length
    while (cut > 0 && (head[cut - 1] === '\n' || head[cut - 1] === '\r')) cut--
    let out = replaceNewlines(head.slice(0, cut), MARK, mode, lastMark)
    buf = head.slice(cut) + rest
    if (!started) {
      out = trimBreaks(out, 'start')
      if (out)
        started = true
    }
    if (out) {
      lastMark = out.endsWith(MARK)
      yield out
    }
  }
  const rest = trimBreaks(replaceNewlines(replaceForms(buf, MARK), MARK, mode, lastMark), 'end')
  if (rest)
    yield rest
}

/**
 * 喂回模型的她的历史发言：<br> 与段间换行都写成 <|br|>（分段说出去的话，delivered 里是用换行拼起来的）。
 * 不改写成换行再靠教学说「换行就是另发一条」：她看到的自己的历史就是要模仿的写法，示范对的比讲道理稳
 */
export function historyBr(s: string, mode: NewlineMode = 'all'): string {
  return trimBreaks(replaceNewlines(replaceForms(s.trim(), MARK), MARK, mode), 'end')
}

/**
 * 她分段说出去的话在 delivered 里是粘在一起的：内核只把 Part.text 计入送达，break 片段不留痕（实测「…好吗你才机器人呢…」）。
 * 从日志的 utterance.part 找回分段位置，把 <|br|> 插回 delivered；只看 since 之后定稿的发言。
 * 返回 `${channel}|${at}` → 带标记的文字，对应 log.history() 里 self 条目的 channel 与 at。
 */
export function selfSegments(events: readonly LogEvent[], since: number): Map<string, string> {
  const settled = new Map<string, LogEvent>() // utt id → settled 事件
  const parts = new Map<string, { kind: string, text?: string }[]>() // utt id → 片段（倒着收，最后翻转）
  const pending = new Set<string>() // 见到了 settled、还没倒回到 started 的
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.at < since && !pending.size)
      break
    const id = e.data?.id
    if (e.type === 'utterance.settled' && e.at >= since && e.data?.delivered) {
      settled.set(id, e)
      pending.add(id)
    }
    else if (e.type === 'utterance.part' && pending.has(id)) {
      const list = parts.get(id) ?? []
      list.push(e.data.part)
      parts.set(id, list)
    }
    else if (e.type === 'utterance.started') {
      pending.delete(id)
    }
  }
  const out = new Map<string, string>()
  for (const [id, e] of settled) {
    const delivered: string = e.data.delivered
    const cuts: number[] = []
    let len = 0
    for (const p of (parts.get(id) ?? []).reverse()) {
      if (p.kind === 'break' && len > 0 && len < delivered.length && cuts.at(-1) !== len)
        cuts.push(len)
      len += p.text?.length ?? 0
    }
    if (!cuts.length)
      continue
    let text = ''
    let from = 0
    for (const c of cuts) {
      text += delivered.slice(from, c) + MARK
      from = c
    }
    out.set(`${e.data.channel ?? MAIN_CHANNEL}|${e.at}`, text + delivered.slice(from))
  }
  return out
}
