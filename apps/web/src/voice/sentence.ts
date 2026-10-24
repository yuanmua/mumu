/**
 * 分句：把流式到达的文本切成可以单独合成语音的句子。纯函数。
 *
 * 终止符（。！？…～换行等）立即成句；逗号类只在这一段已经够长时成句，
 * 否则短句太多、请求太碎、停顿太密。final 为真时剩余全部成句。
 */
const HARD = new Set(['。', '！', '？', '!', '?', '…', '～', '~', '\n', '；', ';'])
const SOFT = new Set(['，', ',', '、', '：', ':'])
const SOFT_MIN = 22

export interface Split {
  sentences: string[] // 已成句（已去首尾空白，非空）
  rest: string // 还不成句的尾巴
}

export function splitSentences(text: string, final = false): Split {
  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const hard = HARD.has(ch)
    const soft = SOFT.has(ch) && i - start >= SOFT_MIN
    if (!hard && !soft)
      continue
    // 连续标点（「？！」「……」）并入同一句
    let end = i + 1
    while (end < text.length && (HARD.has(text[end]) || text[end] === '」' || text[end] === '”' || text[end] === ')' || text[end] === '）'))
      end++
    const s = text.slice(start, end).trim()
    if (s)
      sentences.push(s)
    start = end
    i = end - 1
  }
  let rest = text.slice(start)
  if (final) {
    if (rest.trim())
      sentences.push(rest.trim())
    rest = ''
  }
  return { sentences, rest }
}
