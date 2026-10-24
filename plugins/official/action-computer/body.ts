/**
 * 身体服务（apps/body）的 HTTP 客户端 + 工具表。
 *
 * 立场：
 * - 工具表是「模型能叫的名字 → 身体服务的接口」的一张静态映射，说明文字直接进提示词；
 *   加一个工具 = 身体服务加一个接口 + 这里加一行。
 * - 身体服务回 4xx（找不到窗口 / 控件）不是故障，是「这条路不通」：当作观察结果交回模型，
 *   让它换办法；只有连不上才算故障。
 * - 一步超时 ≠ 连不上：实测一步 exec 等安装器卡在 UAC 上，后面三个任务都被判「连不上」整体失败。
 *   所以超时 / 断连 / 504 时先探活几次，活着就按「这一步还在执行」用 job 号查 /job 等它做完或等到上限，
 *   结果照常当观察交回；探活全失败才抛 BodyError。
 */
import { sleep } from '../../../src/index.ts'

export interface BodyConfig {
  url: string
  token?: string
  requestTimeoutSec: number
  stepWaitSec?: number // 一步超时后最多再等它多久（查 /job），默认 300
  pollMs?: number // 等的时候多久查一次 /job、探活间隔，默认 3000（测试给短的）
}

const PROBES = 3 // 判「连不上」之前探活几次
const RESENDS = 3 // 连接被重置 / 拒绝时原样重发几次（见 send）
const EXEC_MARGIN_SEC = 30 // exec 的请求超时 = 它自己的 timeoutSec + 这么多（身体服务超时后还要杀进程树、收输出）

export interface ToolDef {
  name: string
  path?: string // 身体服务接口；没有的是本地工具（wait）
  doc: string // 进提示词：干什么 + 参数
}

export const TOOLS: ToolDef[] = [
  {
    name: 'exec',
    path: '/exec',
    doc: '跑一段 PowerShell（以她的身份、在她的桌面会话里）。参数 {"command":"…","timeoutSec":60}。返回 exitCode / stdout / stderr。文件、文件夹、查路径、装软件、核实结果都优先用它',
  },
  {
    name: 'apps',
    path: '/apps',
    doc: '程序：{"op":"start","name":"notepad"}（也可以是完整路径，或 URI 如 "ms-settings:"（设置首页）、"https://…"，"args":[…] 可选）；{"op":"close","name":"notepad","force":false}（进程名，默认温和关闭；同名开了好几个时用 windows 里看到的 pid：{"op":"close","pid":5028,"force":true}）；{"op":"list"} 列出有窗口的程序',
  },
  {
    name: 'windows',
    path: '/ui/windows',
    doc: '列出桌面上的顶层窗口（标题、哪个在前台）。参数 {}',
  },
  {
    name: 'ui_tree',
    path: '/ui/tree',
    doc: '看一个窗口的控件树（UI Automation）。参数 {"window":"标题的一部分（省略=前台窗口）","depth":8}，或 {"pid":12416}（apps start 返回的 pid，同名窗口有多个时必须用它）。能操作的控件带编号 #n 和能力（可点/可选/可输入…），编号只在最近一次 ui_tree 内有效',
  },
  {
    name: 'ui_click',
    path: '/ui/click',
    doc: '点一个控件：{"ref":n} 用最近一次 ui_tree 的编号；或 {"window":"…"（或 "pid":n）,"name":"控件名","controlType":"Button","index":0}。"action" 可选 click（默认，先走控件模式再退回鼠标）/ double / right / select / toggle / expand / mouse',
  },
  {
    name: 'type',
    path: '/type',
    doc: '打字（中文可以）：{"text":"…","ref":n} 或 {"text":"…","window":"…"（或 "pid":n）,"name":"控件名","controlType":"Edit"}；只给 window / pid 就切到那个窗口打到它的焦点处，都不给就打到当前焦点。默认先全选再替换（"replace":false 则追加），"enter":true 打完按回车。返回 valueNow 可核对。文字是逐字直输（不走剪贴板，游戏 / 终端 / 任何输入框都收得到）；切不到前台时可加 "method":"setValue" 直接写控件的值（不需要键盘；但经典「另存为」对话框的文件名框上会不生效）',
  },
  {
    name: 'key',
    path: '/key',
    doc: '按键 / 快捷键：{"keys":"ctrl+s","window":"窗口标题的一部分"}（或 "pid":n 指定程序，同名窗口多个时标题会报歧义），多个用逗号："ctrl+a, delete"；"repeat":20 整串重复几遍（玩桌面游戏一步按几十下），"delayMs":100 两下之间的间隔，"holdMs":50 每下按住多久（游戏有时要 ≥50）。按键带扫描码，游戏窗口（tkinter / 原生游戏）也收得到。键盘只发给前台窗口，给 window 会先切过去。返回里 screenChanged / changeRatio 是按完后目标窗口画面变没变（粗判断：光标闪也算一点点，changeRatio 越大越可信），按了没反应就别再 look 确认',
  },
  {
    name: 'browser',
    path: '/browser',
    doc: '浏览器（她自己的 Edge 资料）：{"op":"open","url":"…"}；{"op":"read"} 读当前页文字、可点项和输入框；{"op":"click","text":"链接文字"}（或 "selector"）；{"op":"fill","selector":"#id"或"placeholder":"…"或"label":"…","value":"…","enter":true}；{"op":"press","key":"Enter"}（一次按一串用逗号："ArrowLeft,ArrowUp,ArrowLeft,ArrowDown"，"repeat":20 整串重复几遍、一步最多 300 下，"gapMs" 键间隔默认 150——玩游戏时一步按几十下再看局面）；'
      + '{"op":"eval","script":"JS 表达式或 () => {…}"} 在页面里跑 JS 把结果读回来（棋盘格子、分数、是否 game over，比看图准）；{"op":"back"}；{"op":"close"}。'
      + '找图、存图一律用它：{"op":"images"} 列出当前页的图片（编号、尺寸、原图地址 full），再 {"op":"download","index":编号,"dir":"C:\\\\Users\\\\…\\\\Pictures","name":"可选文件名"}（或 "url":"图片地址" / "selector":"img.xxx"）直接存到她电脑上，返回路径、字节数、宽高——'
      + '不要去右键「图片另存为」、不要在图片网格上点缩略图找大图（控件树里没有图片元素，点不开）。搜图直接 open 必应图片 https://www.bing.com/images/search?q=关键词 再 images。'
      + '结果里带 rebuilt 表示浏览器之前死了、这次自动重开过（页面已回到上次那页）；{"op":"reset"} 手动重开',
  },
  {
    name: 'mouse',
    path: '/mouse',
    doc: '鼠标（坐标取自 ui_tree 的 @(x,y) 或 look 的描述）：点 {"x":100,"y":200,"button":"left","double":false}；拖 {"x":100,"y":200,"toX":300,"toY":400}；滚轮 {"x":…,"y":…,"scroll":-3}（负数向下）。控件能用 ui_click 点就别用坐标',
  },
  {
    name: 'reflex',
    path: '/reflex',
    doc: '反射回路（你的「手上反应」）：实时的格子类游戏（蛇一直在跑的那种）你一步要好几秒跟不上，就把「怎么认局面、怎么动」交给它在本地 20 次/秒 看画面按键，你每隔几秒看 state 调策略。'
      + '只对 apps start 起的 pid 发键。步骤：① {"op":"probe","pid":n} 看窗口矩形和主要颜色；② 用 look / 截图量出棋盘区域与格子数，{"op":"grid","pid":n,"see":{…}} 核对字符画（蛇身 B 一两格、食物 F 一格就对了）；'
      + '③ {"op":"start","pid":n,"see":{"region":[l,t,r,b],"cols":20,"rows":20,"colors":{"head":[r,g,b],"body":[r,g,b],"food":[r,g,b]},"tolerance":50},"policy":{"kind":"chase","start":"r"},"hz":20,"maxSec":120,"stopWhen":{"foodEaten":5}}；'
      + '④ 每隔几秒 {"op":"state"} 看 head / food / length / foodEaten / dir / stopReason，不对就 stop 再 start 换策略（chase 追食物 / avoid 只求活 / keys 固定键序 sequence）。'
      + '这是你自己在玩（策略目标都是你定的，它只看画面按键，不读内存不改游戏），和写脚本代玩不同',
  },
  {
    name: 'look',
    doc: '看一眼：截当前屏幕（或给 "path" 看她电脑里的一张图片），交给看图模型回答你的问题。{"question":"要看什么，问具体","path":"可选，图片完整路径"}。'
      + '看视频画面、游戏局面、图片里画的是什么时用；能用 ui_tree / browser read 读到的文字优先读文字。它给的坐标不准，点东西仍按控件 / 文字',
  },
  {
    name: 'wait',
    doc: '等几秒让程序反应：{"sec":2}（最多 60；看视频就一次等 30～60 秒，别每 10 秒一步）',
  },
]

export const TOOL_NAMES = new Set(TOOLS.map(t => t.name))

export class BodyError extends Error {}

export class BodyClient {
  constructor(private cfg: BodyConfig) {}

  get url(): string {
    return this.cfg.url.replace(/\/$/, '')
  }

  private get auth(): Record<string, string> {
    return this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}
  }

  private get pollMs(): number {
    return this.cfg.pollMs ?? 3000
  }

  /**
   * 发请求并读完回应；连接被重置 / 拒绝（不是超时、不是被叫停）时原样重发几次。
   * POST 带同一个 job 号，身体服务按号去重：送到过的不会重做，重发只会拿到同一个结果。
   * 起因：她电脑上的 AdGuard 会随机重置本机回环连接（2026-10-22 实测约一半），不重发几乎每步都要走一遍探活
   */
  private async send<T>(url: string, init: RequestInit, signal: AbortSignal, read: (res: Response) => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await read(await fetch(url, { ...init, signal }))
      }
      catch (e) {
        if (signal.aborted || i >= RESENDS)
          throw e
        await sleep(Math.min(300, this.pollMs), signal)
      }
    }
  }

  /**
   * 4xx / 5xx 的 {error} 原样返回当观察。超时、断连、504（身体服务那边到了上限还没做完）先探活：
   * 活着就等这一步的结果（onWait 报一句「还在执行」）；探活全失败才抛 BodyError
   */
  async call(path: string, args: Record<string, unknown>, signal: AbortSignal, onWait?: (text: string) => void): Promise<Record<string, unknown>> {
    const job = crypto.randomUUID().slice(0, 12)
    const sec = path === '/exec'
      ? Math.min(Math.max(Number(args.timeoutSec) || 60, 1), 600) + EXEC_MARGIN_SEC
      : this.cfg.requestTimeoutSec
    const timeout = AbortSignal.timeout(sec * 1000)
    let res: Response
    let text: string
    try {
      ;({ res, text } = await this.send(this.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Body-Job': job, ...this.auth },
        body: JSON.stringify(args),
      }, AbortSignal.any([signal, timeout]), async r => ({ res: r, text: await r.text() })))
    }
    catch (e) {
      if (signal.aborted)
        throw e
      return await this.settle(path, job, timeout.aborted ? `${sec} 秒没回应` : `连接断了（${errText(e)}）`, signal, onWait)
    }
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(text) as Record<string, unknown>
    }
    catch {
      // 不是 JSON（代理错误页之类）：把状态码和开头交给模型，比崩掉强
      return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    if (res.status === 504 && obj.state === 'running')
      return await this.settle(path, job, `做了 ${String(obj.sec)} 秒还没完`, signal, onWait)
    return obj
  }

  /** 这一步没拿到回应：身体服务还活着就查 /job 等它做完（最多 stepWaitSec），死了抛 BodyError */
  private async settle(path: string, job: string, why: string, signal: AbortSignal, onWait?: (text: string) => void): Promise<Record<string, unknown>> {
    try {
      await this.health(signal, PROBES)
    }
    catch (e) {
      if (signal.aborted)
        throw e
      throw new BodyError(`连不上身体服务 ${this.url}：${path} ${why}，之后探活 ${PROBES} 次都不通（${errText(e)}）`)
    }
    onWait?.(`${path} ${why}，身体服务还在，等这一步做完`)
    const until = Date.now() + (this.cfg.stepWaitSec ?? 300) * 1000
    let misses = 0
    for (;;) {
      const j = await this.job(job, signal)
      if (j === 'unreachable') {
        if (++misses >= PROBES)
          throw new BodyError(`连不上身体服务 ${this.url}：等 ${path} 的结果时断了，连着 ${PROBES} 次查不到`)
      }
      else if (j === undefined) {
        // 身体服务没有这一步的记录：请求没送到、身体服务重启过，或它是不认 job 号的旧版本
        return { error: `${path} ${why}；身体服务还活着，但没有这一步的记录（请求可能没送到，或身体服务重启过），结果不明：先用 windows / exec 核实现状，再决定要不要重做` }
      }
      else {
        misses = 0
        if (j.state === 'done')
          return (j.result ?? {}) as Record<string, unknown>
        if (j.state === 'cancelled')
          return { error: `${path} 排队太久没轮到（前面还有一步在做），这一步没有执行` }
        if (Date.now() >= until)
          return { error: `${path} 已经做了 ${String(j.sec)} 秒还没做完，还在电脑上执行。先别重复这一步：用 windows 看看是不是弹了提示框在等人，或 exec 查现状`, running: true }
      }
      await sleep(this.pollMs, signal)
      signal.throwIfAborted()
    }
  }

  /** 查一个 job：有记录回它的状态，没有这条记录回 undefined，连不上回 'unreachable' */
  private async job(id: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined | 'unreachable'> {
    let res: Response
    let text: string
    try {
      ;({ res, text } = await this.send(`${this.url}/job?id=${encodeURIComponent(id)}`, { headers: this.auth },
        AbortSignal.any([signal, AbortSignal.timeout(8000)]), async r => ({ res: r, text: await r.text() })))
    }
    catch (e) {
      if (signal.aborted)
        throw e
      return 'unreachable'
    }
    if (!res.ok)
      return undefined // 400 没有这个 job；旧版身体服务回 404 没有这个接口
    try {
      return JSON.parse(text) as Record<string, unknown>
    }
    catch {
      return undefined
    }
  }

  /** 截屏（不给 path，scale 为缩放比）或取本机一张图，身体服务那边已缩成 JPEG；4xx 当观察返回 */
  async image(path: string | undefined, signal: AbortSignal, scale = 0.5): Promise<{ bytes: Buffer, mime: string } | { error: string }> {
    const q = path ? `/image?max=1024&path=${encodeURIComponent(path)}` : `/screenshot?scale=${scale}&fmt=jpeg&q=60`
    try {
      return await this.send(this.url + q, { headers: this.auth },
        AbortSignal.any([signal, AbortSignal.timeout(this.cfg.requestTimeoutSec * 1000)]), async (res) => {
          const mime = res.headers.get('content-type') ?? ''
          if (!res.ok || !mime.startsWith('image/'))
            return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
          return { bytes: Buffer.from(await res.arrayBuffer()), mime }
        })
    }
    catch (e) {
      if (signal.aborted)
        throw e
      // 截图不排队，一般秒回；没回应先探活，活着就只是这一张没拿到
      try {
        await this.health(signal, PROBES)
      }
      catch {
        if (signal.aborted)
          throw e
        throw new BodyError(`连不上身体服务 ${this.url}：${errText(e)}，之后探活 ${PROBES} 次都不通`)
      }
      return { error: `这张图没取到（${errText(e)}），身体服务还在：再看一次，或换 ui_tree / browser read 读文字` }
    }
  }

  /** 自检；tries > 1 时失败隔一会儿再试（判「连不上」之前多给几次机会），都不通抛 BodyError */
  async health(signal: AbortSignal, tries = 1): Promise<Record<string, unknown>> {
    let why = ''
    for (let i = 0; i < tries && !signal.aborted; i++) {
      if (i)
        await sleep(this.pollMs, signal) // 被叫停时立即返回，下一轮循环条件退出
      try {
        const r = await this.send(`${this.url}/health`, { headers: this.auth }, AbortSignal.any([signal, AbortSignal.timeout(8000)]),
          async res => res.ok ? await res.json() as Record<string, unknown> : `/health 返回 ${res.status}`)
        if (typeof r !== 'string')
          return r
        why = r
      }
      catch (e) {
        why = errText(e)
      }
    }
    throw new BodyError(`连不上身体服务 ${this.url}：${why}${tries > 1 ? `（试了 ${tries} 次）` : ''}`)
  }
}

function errText(e: unknown): string {
  if (e instanceof Error)
    return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message
  return String(e)
}

/** /health 的 busy：身体服务各通道正在做 / 排队的活，人能读的一句；没有就空串 */
export function busyText(h: Record<string, unknown>): string {
  const busy = Array.isArray(h.busy) ? h.busy as Array<Record<string, unknown>> : []
  return busy.map(b => `${String(b.path)} ${b.state === 'queued' ? '排队' : '在做'} ${Math.round(Number(b.sec) || 0)} 秒`).join('、')
}
