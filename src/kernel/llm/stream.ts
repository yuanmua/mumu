/**
 * 流原语：StreamChunk 词汇 + <|track:body|> 内联 marker 流式解析。
 * 内核只认 marker 语法，含义由插件定义。
 */

export type StreamChunk
  = | { type: 'text', text: string }
    | { type: 'marker', track: string, body: string } // track 是 marker 通道，与会话 channel 无关
    | { type: 'usage', prompt: number, completion: number }
    | { type: 'done' }

const OPEN = '<|'
const CLOSE = '|>'
/** 超长未闭合即按普通文本吐出，避免流卡死 */
const MAX_TAG = 128

/** 把文本流解析为 text/marker 块 */
export async function* parseMarkers(source: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let buf = ''
  let inTag = false
  for await (const part of source) {
    buf += part
    while (buf) {
      if (!inTag) {
        const i = buf.indexOf(OPEN)
        if (i < 0) {
          // 尾部可能是 OPEN 的前缀，留到下一块再判
          const hold = buf.endsWith('<') ? 1 : 0
          const emit = buf.slice(0, buf.length - hold)
          buf = buf.slice(buf.length - hold)
          if (emit)
            yield { type: 'text', text: emit }
          break
        }
        if (i > 0) {
          yield { type: 'text', text: buf.slice(0, i) }
          buf = buf.slice(i)
        }
        inTag = true
      }
      else {
        const j = buf.indexOf(CLOSE)
        if (j < 0) {
          if (buf.length > MAX_TAG) {
            // 永不闭合的标记按普通文本处理
            yield { type: 'text', text: buf }
            buf = ''
            inTag = false
          }
          break
        }
        const inner = buf.slice(OPEN.length, j)
        buf = buf.slice(j + CLOSE.length)
        inTag = false
        const k = inner.indexOf(':')
        yield k < 0
          ? { type: 'marker', track: inner.trim(), body: '' }
          : { type: 'marker', track: inner.slice(0, k).trim(), body: inner.slice(k + 1).trim() }
      }
    }
  }
  // 流结束：残余按文本吐出，未闭合的标记也不吞
  if (buf)
    yield { type: 'text', text: buf }
}

/** 异步队列；动作 inbox 与表现端打印机共用 */
export class AsyncQueue<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    if (this.closed)
      return
    const w = this.waiters.shift()
    if (w)
      w({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0))
      w({ value: undefined as never, done: true })
  }

  get size(): number {
    return this.items.length
  }

  async* [Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!
        continue
      }
      if (this.closed)
        return
      const r = await new Promise<IteratorResult<T>>(res => this.waiters.push(res))
      if (r.done)
        return
      yield r.value
    }
  }
}

/** 可取消的 sleep；signal 触发时立即返回，不抛错 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted)
      return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', done)
      clearTimeout(t)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
