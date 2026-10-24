/**
 * 贡献集合：插件往集合里放东西的统一机制。
 * 内核用于段落、动作类型、marker 词汇；插件 provide 一个 Registry 即开出新扩展点。
 * add 返回 disposer，配合 ctx.effect 精确回滚。
 */
import type { Disposer } from './container.ts'

export class Registry<T> {
  private items = new Map<string, T>()
  private seq = 0

  /**
   * @param label 出错信息里的集合名
   * @param keyOf 取唯一键；省略则允许重复项
   */
  constructor(private label: string, private keyOf?: (item: T) => string) {}

  add(item: T): Disposer {
    const key = this.keyOf ? this.keyOf(item) : `#${++this.seq}`
    if (this.keyOf && this.items.has(key))
      throw new Error(`${this.label} already registered: ${key}`)
    this.items.set(key, item)
    return () => { this.items.delete(key) }
  }

  get(key: string): T | undefined {
    return this.items.get(key)
  }

  has(key: string): boolean {
    return this.items.has(key)
  }

  list(): T[] {
    return [...this.items.values()]
  }

  get size(): number {
    return this.items.size
  }
}
