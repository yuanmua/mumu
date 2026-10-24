/**
 * 工具坏了的判定：同一个工具连着两次回同一个错误，就在这次任务里标为「暂不可用」。
 *
 * 起因（2026-10-22 16:18 computer#14）：身体服务的 browser 工具上下文早死了，open / read 每次都回同一句
 * `TargetClosedError: … has been closed`，她第 2、3、7、11 步都在试它，40 步一张图没存下；结果里只说「图点不开」，
 * 没人知道是浏览器工具坏了。单次出错是常态（控件没找到就换办法），但同一工具两次一字不差的错误不是「这条路不通」，
 * 是工具本身坏了——再试只会原样再错。
 *
 * 立场：只看「这个工具最近两次调用」（中间夹别的工具不算断），错误文字一字不差才算同一个（宁可漏判，
 * 不把 ui_click 换个控件再失败误判成坏了）；标了之后在提示里告诉模型换路线，它再叫就不去身体服务了；
 * 任务结束把坏掉的工具写进结果，她能如实说「浏览器工具坏了」。
 */
import { isError } from './view.ts'

export const SAME_ERRORS = 2 // 连着几次同一个错误算坏
const KEY_CHARS = 300 // 比较错误时取多长：TargetClosedError 这类一句话就够，太长的控件树错误也只看开头

/** 模型看到的叫法：她说「浏览器工具坏了」而不是念 browser */
const HUMAN: Record<string, string> = {
  browser: '浏览器工具',
  exec: '命令行',
  apps: '开程序',
  windows: '窗口列表',
  ui_tree: '控件树',
  ui_click: '点控件',
  type: '打字',
  key: '按键',
  mouse: '鼠标',
  reflex: '反射回路',
  look: '看图',
}

export const humanTool = (tool: string): string => HUMAN[tool] ?? tool

/** 从一条观察里取出用来比较的错误文字：{"error":"…"} 取 error 字段，「出错：…」取全文 */
export function errorKey(obs: string): string {
  if (!isError(obs))
    return ''
  if (obs.startsWith('{')) {
    try {
      const e = (JSON.parse(obs) as { error?: unknown }).error
      if (typeof e === 'string')
        return e.slice(0, KEY_CHARS)
    }
    catch {
      // 不是完整 JSON（截断过）：按整段比较，安全
    }
  }
  return obs.slice(0, KEY_CHARS)
}

export class ToolHealth {
  private last = new Map<string, { key: string, count: number }>()
  private readonly broken = new Map<string, string>() // 工具 → 让它坏掉的那句错误

  /** 记一次调用的结果；刚好在这一次标为坏了返回 true（调用方只在这一刻提醒一次） */
  record(tool: string, obs: string): boolean {
    const key = errorKey(obs)
    if (!key) {
      this.last.delete(tool)
      return false
    }
    const prev = this.last.get(tool)
    const count = prev && prev.key === key ? prev.count + 1 : 1
    this.last.set(tool, { key, count })
    if (count < SAME_ERRORS || this.broken.has(tool))
      return false
    this.broken.set(tool, key)
    return true
  }

  isBroken(tool: string): boolean {
    return this.broken.has(tool)
  }

  /** 标为坏了的那一步，附在观察后面给模型看 */
  notice(tool: string): string {
    const alts = tool === 'browser'
      ? 'apps start 开浏览器 + ui_tree / ui_click / key / look，或 exec 用 PowerShell（Invoke-WebRequest 下载）'
      : '别的工具'
    return `【工具暂不可用】${tool}（${humanTool(tool)}）连着 ${SAME_ERRORS} 次报同一个错误「${clip(this.broken.get(tool) ?? '', 120)}」，`
      + `这次任务里它坏了，别再调它，换路线：${alts}；换不了就输出 done ok:false，result 里如实写「${humanTool(tool)}坏了」。`
  }

  /** 模型还是叫了坏掉的工具：不去身体服务，直接回这句当观察 */
  refusal(tool: string): string {
    return `出错：${tool}（${humanTool(tool)}）已标为暂不可用（${clip(this.broken.get(tool) ?? '', 120)}），这一步没有执行。换别的工具，或 done ok:false 如实说明`
  }

  /** 任务结束写进结果的一句；没坏的工具返回空串 */
  summary(): string {
    if (!this.broken.size)
      return ''
    const parts = [...this.broken].map(([t, e]) => `${humanTool(t)}（${t}）坏了：每次都报「${clip(e, 100)}」`)
    return `这次${parts.join('；')}。跟对方说是${[...this.broken.keys()].map(humanTool).join('、')}出了问题，不是找不到或点不开`
  }

  get tools(): string[] {
    return [...this.broken.keys()]
  }
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
