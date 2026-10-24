/**
 * DeepSeek「DSML」工具调用标记的流式过滤器。
 *
 * 为什么有它：deepseek-chat 在上下文「像要调工具」时（电脑任务的工具循环、对话里提到去搜 / 去操作电脑），
 * 即使请求里没有 tools 字段，也会把自己原生的工具调用格式直接写进正文：
 *   <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="look"><｜｜DSML｜｜ parameter name="args" string="false">{…}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>
 * 这些从来不是给人看的；本项目也没有任何地方按 DSML 取工具调用（工具一律走各动作自己的 JSON / marker 协议）。
 *
 * 规则：
 * - 开始标记起整段吞掉，按嵌套深度直到对应的结束标记；流结束时还没闭合的，剩下的也吞掉。
 * - 孤立的结束标记（只漏出了后半截）只吞标记本身。
 * - 写法宽容：全角「｜」与半角「|」、一根或两根、标记里的空格都认。
 * - 不用正则（handbook §9.2）：逐字符认标记；被切在两个 chunk 之间的可疑尾巴留到下一块再判，
 *   超过 HOLD_MAX 还凑不成标记就按普通文本放行，免得流卡住。
 * - 别的尖括号（含内核的 <|track:body|> marker）原样放行。
 */

/** 一个标记最长多少字：DSML 标记带属性也就几十字，留足余量 */
const HOLD_MAX = 256
const SAMPLE_MAX = 120

export interface DsmlDrop {
  chars: number // 吞掉的总字数
  sample: string // 开头一段，便于看清漏的是什么
}

type Tag = { len: number, closing: boolean, selfClosing: boolean }

const isBar = (c: string): boolean => c === '｜' || c === '|'

/** s[0] 是 '<'：是 DSML 标记返回它的长度与种类；不是返回 null；还看不出来返回 'partial' */
function readTag(s: string): Tag | null | 'partial' {
  let j = 1
  const closing = s[j] === '/'
  if (closing)
    j++
  const skipSpaces = (): void => {
    while (s[j] === ' ')
      j++
  }
  skipSpaces()
  if (j >= s.length)
    return 'partial'
  if (!isBar(s[j]))
    return null
  while (j < s.length && (isBar(s[j]) || s[j] === ' '))
    j++
  for (const c of 'DSML') {
    if (j >= s.length)
      return 'partial'
    if (s[j] !== c)
      return null
    j++
  }
  if (j >= s.length)
    return 'partial'
  if (!isBar(s[j]))
    return null
  const end = s.indexOf('>', j)
  if (end < 0)
    return 'partial'
  return { len: end + 1, closing, selfClosing: s[end - 1] === '/' }
}

export class DsmlFilter {
  private buf = ''
  private depth = 0
  private droppedChars = 0
  private sample = ''

  /** 喂一块模型文本，返回可以放行的部分（可能为空串） */
  push(text: string): string {
    this.buf += text
    return this.drain(false)
  }

  /** 流结束：把留着的尾巴结清 */
  end(): string {
    return this.drain(true)
  }

  /** 吞过东西才有 */
  get report(): DsmlDrop | undefined {
    return this.droppedChars ? { chars: this.droppedChars, sample: this.sample } : undefined
  }

  private drop(s: string): void {
    this.droppedChars += s.length
    if (this.sample.length < SAMPLE_MAX)
      this.sample = (this.sample + s).slice(0, SAMPLE_MAX)
  }

  private drain(final: boolean): string {
    let out = ''
    const take = (s: string): void => {
      if (this.depth > 0)
        this.drop(s)
      else out += s
    }
    while (this.buf) {
      const i = this.buf.indexOf('<')
      if (i < 0) {
        take(this.buf)
        this.buf = ''
        break
      }
      take(this.buf.slice(0, i))
      this.buf = this.buf.slice(i)
      const tag = readTag(this.buf)
      if (tag === 'partial' && !final && this.buf.length < HOLD_MAX)
        break // 等下一块再判
      if (tag === null || tag === 'partial') {
        take('<')
        this.buf = this.buf.slice(1)
        continue
      }
      this.drop(this.buf.slice(0, tag.len))
      this.buf = this.buf.slice(tag.len)
      if (tag.closing)
        this.depth = Math.max(0, this.depth - 1)
      else if (!tag.selfClosing)
        this.depth++
    }
    return out
  }
}
