/**
 * 起一个 DSH headless 子进程跑一件事，把它的按行 JSON 事件流翻译成回调。
 *
 * 立场：
 * - 只用 DSH 公开的命令行契约：`dsh --profile headless --json -`，任务从 stdin 进（中文、引号、换行都不用转义），
 *   stdout 每行一个事件（session / status / thinking / text / tool_call / tool_result / final / error）。
 *   退出码 0 = 完成，其余 = 中止或出错（DSH headless README 的约定）。
 * - 密钥只进子进程的环境变量（DSH 默认读 DEEPSEEK_API_KEY），不落任何文件。
 * - 不经 shell：直接 node + DSH 的入口脚本，Windows 上省掉 .cmd 那层引号。
 * - 三种「不卡死」：总时限、静默时限（一直没有新事件，多半在等人或卡住）、外部叫停。
 *   到点杀整棵进程树——DSH 会再起 PowerShell / 子进程，只杀 node 会留孤儿。
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface DshEvent {
  type: string
  [k: string]: unknown
}

export interface RunOptions {
  entry: string
  task: string
  cwd: string
  env: Record<string, string | undefined>
  totalTimeoutMs: number
  idleTimeoutMs: number
  signal: AbortSignal
  onEvent: (e: DshEvent) => void
}

export interface RunResult {
  /** done 正常完成；failed DSH 自己报失败；timeout / idle / aborted 是这边掐断的 */
  outcome: 'done' | 'failed' | 'timeout' | 'idle' | 'aborted'
  exitCode: number | null
  final: string
  stderrTail: string
}

export function runDsh(o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [o.entry, '--profile', 'headless', '--json', '-'], {
      cwd: o.cwd,
      env: o.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let final = ''
    let stderr = ''
    let killedFor: RunResult['outcome'] | undefined
    let idleTimer: NodeJS.Timeout | undefined
    let settled = false

    const kill = (why: RunResult['outcome']): void => {
      if (killedFor)
        return
      killedFor = why
      killTree(child)
    }
    const touch = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => kill('idle'), o.idleTimeoutMs).unref()
    }
    const total = setTimeout(() => kill('timeout'), o.totalTimeoutMs).unref()
    const onAbort = (): void => kill('aborted')
    o.signal.addEventListener('abort', onAbort, { once: true })
    touch()

    createInterface({ input: child.stdout! }).on('line', (line) => {
      touch()
      let e: DshEvent
      try {
        e = JSON.parse(line) as DshEvent
      }
      catch {
        return // 非 JSON 行（启动器的杂项输出）不是事件，丢掉安全
      }
      if (e.type === 'final' && typeof e.text === 'string')
        final = e.text
      o.onEvent(e)
    })
    child.stderr!.on('data', (b: Buffer) => {
      touch() // stderr 有输出就说明还活着
      stderr = (stderr + b.toString('utf8')).slice(-4000)
    })
    child.stdin!.on('error', () => {}) // 进程启动即退时写 stdin 会 EPIPE，结果由 close 报，吞掉安全
    child.stdin!.end(o.task)

    const finish = (code: number | null): void => {
      if (settled)
        return
      settled = true
      clearTimeout(total)
      clearTimeout(idleTimer)
      o.signal.removeEventListener('abort', onAbort)
      resolve({
        outcome: killedFor ?? (code === 0 ? 'done' : 'failed'),
        exitCode: code,
        final,
        stderrTail: stderr.trim().slice(-800),
      })
    }
    child.on('error', (err) => {
      stderr += `\n启动失败：${err.message}`
      finish(null)
    })
    child.on('close', code => finish(code))
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null)
    return
  if (process.platform === 'win32') {
    // /T 连子进程一起杀；进程刚好自己退了时 taskkill 报错，无害
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  else {
    child.kill('SIGTERM')
  }
}
