/**
 * 事件总线，两种分发模式：
 * - emit：通知，不等待，监听器错误互相隔离。
 * - waterfall：环绕中间件，拦截器改写 payload 后 next() 委托，不调 next 即短路；
 *   terminal 是默认行为，因此拦截器可包裹或替换它。
 */
import type { Disposer } from './container.ts'

export type WaterfallMw<T = unknown, R = unknown> = (payload: T, next: () => Promise<R>) => Promise<R>

// 同一事件名的 payload 形状由发出方约定，总线不认识；存的时候抹成 unknown，类型由 on / intercept 的调用方声明
type Listener = (payload: unknown) => void

export class Bus {
  private listeners = new Map<string, Set<Listener>>()
  private interceptors = new Map<string, WaterfallMw[]>()

  on<T = unknown>(event: string, fn: (payload: T) => void): Disposer {
    let set = this.listeners.get(event)
    if (!set)
      this.listeners.set(event, set = new Set())
    const l = fn as Listener
    set.add(l)
    return () => { set.delete(l) }
  }

  emit(event: string, payload?: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(payload)
      }
      catch (e) {
        console.error(`[bus] listener failed: ${event}:`, e)
      }
    }
  }

  intercept<T, R = T>(name: string, mw: WaterfallMw<T, R>): Disposer {
    let arr = this.interceptors.get(name)
    if (!arr)
      this.interceptors.set(name, arr = [])
    const m = mw as WaterfallMw
    arr.push(m)
    return () => {
      const i = arr.indexOf(m)
      if (i >= 0)
        arr.splice(i, 1)
    }
  }

  /** 按注册序包裹 terminal；链在调用时快照，重载不影响在途调用 */
  async waterfall<T, R>(name: string, payload: T, terminal: (payload: T) => R | Promise<R>): Promise<R> {
    const chain = [...(this.interceptors.get(name) ?? [])] as WaterfallMw<T, R>[]
    const run = async (i: number): Promise<R> => {
      if (i >= chain.length)
        return terminal(payload)
      let called = false
      return chain[i](payload, () => {
        if (called)
          throw new Error(`next() called twice: ${name}`)
        called = true
        return run(i + 1)
      })
    }
    return run(0)
  }
}
