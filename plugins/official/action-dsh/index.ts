/**
 * dsh 动作：在她自己的电脑里起 DeepSeek Harness（DSH）干多步工程活（工具即动作，handbook §9.4）。
 *
 * 立场：
 * - 分工：多步工程活（写代码、装东西、改配置、跑脚本）交给 DSH——它本身就是会写代码跑命令的 agent；
 *   点点按按、看屏幕、上网、打开写好的程序交给 computer。本插件不做决定，只起进程、翻译进度、回报结果。
 * - 后端与她的电脑同机（2026-10-21 起 C:\mumu 在 VM 上），所以直接起本机子进程（run.ts），不经身体服务。
 * - 进度要进她的感知，不能只躺在面板里：每步一句人话进 a.note 与日志 `dsh.step`；
 *   「手头的活」给导演（beat/gather）和发言者（段落），被问进度答得出；关键节点（动手了、出错了）另发 `dsh.progress`
 *   感知唤醒导演，让她在同一个对话里主动说一句；普通步骤不唤醒，免得刷屏。完成以 `dsh.result` 回报。这个动作从不说话。
 * - 三道护栏：DSH 自己的沙箱（默认 workspace-write）· 交给它的约定（preamble）· 每步事后拦截（guard.ts，碰了就停、回报要主人点头）。
 * - 不卡死：总时限、静默时限、急停都会杀掉整棵进程树并回报；同时只跑 concurrency 个，多的直接回报「在忙」。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MaterialBlock, Plugin } from '../../../src/index.ts'
import { formatElapsed, PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import { inspect } from './guard.ts'
import { describe, sayOf, workOf } from './progress.ts'
import type { DshEvent } from './run.ts'
import { runDsh } from './run.ts'
import { mountWeb } from './web.ts'

export interface DshConfig {
  entry?: string
  keySecret?: string
  workDir?: string
  sandbox?: string
  timeoutMin?: number
  idleSec?: number
  concurrency?: number
  resultChars?: number
  progressGapSec?: number
  preamble?: string
}

export interface Install { entry: string, version: string }

const OUTCOME: Record<string, string> = {
  done: '做完了',
  failed: '没做成',
  timeout: '超时被停了',
  idle: '卡住太久被停了（可能在等人确认）',
  aborted: '被叫停了',
  blocked: '停下了，要主人点头',
}

/** 找 DSH 的入口脚本：配置给了就用；否则找 npm 全局安装（每次现找，装上 / 升级不用重载插件） */
export function locate(cfg: DshConfig): Install | undefined {
  const pkgDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  try {
    if (cfg.entry)
      return existsSync(cfg.entry) ? { entry: cfg.entry, version: '?' } : undefined
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string, bin: string | Record<string, string> }
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.dsh
    const entry = join(pkgDir, bin)
    return existsSync(entry) ? { entry, version: pkg.version } : undefined
  }
  catch {
    return undefined // 没装 / 清单坏了：当作没装，调用方回报「没装 DSH」
  }
}

const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

const plugin: Plugin<DshConfig> = {
  name: 'action-dsh',
  inject: ['secrets', 'commands'],
  apply(ctx, cfg = {}) {
    const secrets = ctx.use<SecretsService>('secrets')
    const commands = ctx.use<CommandService>('commands')
    const running = (): string[] => ctx.actions.snapshot().map(r => r.id).filter(id => id.startsWith('dsh#'))

    ctx.effect(() => ctx.actions.register({
      name: 'dsh',
      description: '（需要主人）在你自己的电脑里叫一个会写代码、跑命令的助手（DSH）去干多步的工程活：写程序 / 脚本、整理项目、在一个目录里搭东西。'
        + '它在后台做，你照常聊天；它动手了、出错了会有 dsh.progress 告诉你，做完有 dsh.result。'
        + '分工：要写代码、要跑一串命令的用 dsh；点界面、看屏幕、上网、打开写好的程序玩用 computer（dsh 自己开的窗口活不下来）。'
        + '它只能动工作目录里的东西，碰不了系统设置；一次交一件完整的事，同时只能跑一个。',
      paramsHint: '{"task":"要做的事，写完整具体：做什么、放哪、做完要能怎么用，如「在 snake 目录写一个 Python 贪吃蛇（tkinter），写完自测，告诉我怎么启动」","cwd":"可选，工作目录（它只能写这里），如 C:\\\\Users\\\\me\\\\Desktop\\\\snake"}',
      reloadPolicy: 'drain', // 改配置 / 改文件不掐正在跑的工程活；真要停用 /dsh stop
      run: async (a) => {
        const task = String(a.params.task ?? '').trim()
        // 同 computer：意图不带频道时取最近一条对方消息所在的对话，否则结果和进度回到别的对话里
        const channel = a.channel
          ?? ctx.log.history({ limit: 20 }).filter(t => t.role === 'other').at(-1)?.channel
        const startedAt = Date.now()
        const report = async (ok: boolean, outcome: string, result: string, steps = 0, cwd?: string): Promise<void> => {
          a.note(OUTCOME[outcome] ?? outcome)
          const line = `DSH 工程活「${task || '（没说）'}」${OUTCOME[outcome] ?? outcome}（${steps} 步，${formatElapsed(Date.now() - startedAt)}）：${result}`
          a.remember(`${line}。还没告诉对方的话，用自己的话简单说一下结果。`, { beats: 4 })
          // 先让带频道的感知唤醒导演，再让动作结算（理由同 action-computer）
          await ctx.io.percept({
            kind: 'dsh.result',
            channel,
            text: line,
            data: { actionId: a.id, task, ok, outcome, steps, elapsedMs: Date.now() - startedAt, cwd, result },
          })
        }
        // 关键节点：唤醒导演，让她在同一个对话里主动说一句。限频，出错连发时只说一次
        let lastProgress = 0
        const progress = (stage: string, text: string, step: number, force = false): void => {
          if (!force && Date.now() - lastProgress < (cfg.progressGapSec ?? 90) * 1000)
            return
          lastProgress = Date.now()
          void ctx.io.percept({
            kind: 'dsh.progress',
            channel,
            text: `DSH 工程活「${task.slice(0, 60)}」${text}`,
            data: { actionId: a.id, stage, step, elapsedMs: Date.now() - startedAt },
          })
        }

        if (!task)
          return report(false, 'failed', '没说要做什么（dsh 缺 task），什么也没做')
        const others = running().filter(id => id !== a.id)
        if (others.length >= Math.max(1, cfg.concurrency ?? 1))
          return report(false, 'failed', `已经有 ${others.join('、')} 在做，同时只能跑一个；要补充就等它做完再起`)
        const install = locate(cfg)
        if (!install)
          return report(false, 'failed', '电脑上没装 DSH（找不到 @deepseek-ai/dsh），要主人先装上')
        const key = secrets.get(cfg.keySecret ?? 'deepseek')
        if (!key)
          return report(false, 'failed', `密钥「${cfg.keySecret ?? 'deepseek'}」没设，要主人 /secret set 一下`)
        const cwd = typeof a.params.cwd === 'string' && a.params.cwd.trim() ? a.params.cwd.trim() : (cfg.workDir || join(homedir(), 'dsh-work'))
        try {
          mkdirSync(cwd, { recursive: true })
          if (!statSync(cwd).isDirectory())
            throw new Error('不是目录')
        }
        catch (e) {
          return report(false, 'failed', `工作目录 ${cwd} 用不了：${e instanceof Error ? e.message : String(e)}`)
        }

        // 导演 send 来的补充：headless 一次只收一个任务，跑着的时候递不进去，结束时如实带回
        const extra: string[] = []
        void (async () => {
          for await (const m of a.inbox) extra.push(m)
        })()

        let steps = 0
        let endReason = ''
        let blocked: { why: string, hit: string, say: string } | undefined
        const stop = new AbortController() // 护栏拦下时自己掐
        const calls = new Map<string, { step: number, tool: string, input: string, say: string }>()
        a.note('叫 DSH 起来干活')
        const sandbox = SANDBOXES.has(cfg.sandbox ?? '') ? cfg.sandbox! : 'workspace-write'
        const r = await runDsh({
          entry: install.entry,
          task: `${cfg.preamble ?? ''}${task}`,
          cwd,
          env: { ...process.env, DEEPSEEK_API_KEY: key, DSH_PERMISSION_MODE: sandbox },
          totalTimeoutMs: (cfg.timeoutMin ?? 20) * 60_000,
          idleTimeoutMs: (cfg.idleSec ?? 300) * 1000,
          signal: AbortSignal.any([a.signal, stop.signal]),
          onEvent: (e: DshEvent) => {
            if (e.type === 'tool_call') {
              const tool = String(e.tool)
              const say = sayOf(tool, e.input)
              calls.set(String(e.callId), { step: ++steps, tool, input: brief(e.input), say })
              a.note(`第 ${steps} 步：${say}`)
              const bad = blocked ? undefined : inspect(tool, e.input)
              if (bad) {
                blocked = { ...bad, say }
                ctx.log.append('dsh.blocked', { actionId: a.id, step: steps, tool, say, why: bad.why, hit: bad.hit })
                stop.abort()
                return
              }
              if (steps === 1)
                progress('started', `动手了，第一步：${say}`, steps, true)
            }
            else if (e.type === 'tool_result') {
              const c = calls.get(String(e.callId))
              ctx.log.append('dsh.step', {
                actionId: a.id,
                step: c?.step ?? steps,
                tool: c?.tool ?? '?',
                say: c?.say ?? '',
                input: c?.input ?? '',
                status: e.status,
                result: String(e.result ?? '').slice(0, 600),
              })
              if (e.status === 'error')
                progress('error', `第 ${c?.step ?? steps} 步「${c?.say ?? '?'}」没成功，它在换办法`, c?.step ?? steps)
            }
            else if (e.type === 'text' && typeof e.text === 'string' && e.text.trim()) {
              a.note(`第 ${steps} 步后：${e.text.trim().replace(/\s+/g, ' ').slice(0, 80)}`)
            }
            else if (e.type === 'status' && e.phase === 'turn_end') {
              const reason = e.reason as { kind?: string } | undefined
              endReason = reason?.kind ?? ''
            }
            else if (e.type === 'error') {
              endReason = String(e.message ?? e.code ?? 'error')
            }
          },
        })

        if (blocked) {
          return report(false, 'blocked', `第 ${steps} 步它想「${blocked.say}」，这属于${blocked.why}（${blocked.hit}），`
            + '我没让它继续——这类事要主人点头才行。之前做好的部分还在工作目录里。', steps, cwd)
        }
        const ok = r.outcome === 'done' && (!endReason || endReason === 'completed')
        let result = clip(r.final.trim(), cfg.resultChars ?? 1500)
        if (!result)
          result = r.stderrTail ? `没有总结，最后的输出：${r.stderrTail}` : '没有总结'
        if (r.outcome === 'failed' && endReason)
          result = `（结束原因 ${endReason}）${result}`
        if (extra.length)
          result += `（做的过程中对方补充了：${extra.join('；')}——这些还没交给 DSH）`
        await report(ok, ok ? 'done' : r.outcome === 'done' ? 'failed' : r.outcome, result, steps, cwd)
      },
    }))

    ctx.effect(() => ctx.prompt.section({
      id: 'dsh-teaching-mind',
      audience: 'mind',
      order: PROMPT_ORDER.teaching,
      render: () => '【DSH】你电脑里有个会写代码、跑命令的助手（dsh 动作）。对方要你写个程序 / 脚本、在一个目录里搭东西这类多步工程活：start dsh（task 写完整：做什么、放哪、做完要能怎么用）。'
        + '要点界面、看屏幕、上网、打开写好的程序玩，用 computer。dsh 同时只能跑一个。'
        + 'dsh.progress 来了（它动手了 / 出错在换办法），start reply（append:true）用一句话跟对方说进度，说人话别念命令；'
        + 'dsh.result 来了，start reply 告诉对方结果，没做成也要说；结果说「要主人点头」就原样问对方。对方问进度，照【手头的活】答。',
    }))

    // 发言者那边不另开段落：action-computer 的「手头的活」（computer-now）从日志一起投影 computer 与 dsh
    // （dsh.step 的 say、dsh.result），两边各写一段发言者会看到两遍（2026-10-22 合并）

    // 导演的「手头的活」：反射常常嘴上先说「写好了」，导演要看得到其实做到哪、卡在哪（同 action-computer 的理由）
    ctx.intercept<{ blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      const runs = ctx.actions.snapshot().filter(r => r.id.startsWith('dsh#'))
      const last = [...ctx.log.events].reverse().find(e => e.type === 'percept.received' && e.data.kind === 'dsh.result')
      if (runs.length || last) {
        const lines = runs.map(r => `- ${r.id} ${describe(workOf(ctx.log.events, r.id, r.runningMs))}`)
        if (last)
          lines.push(`- 最近一次结果（${formatElapsed(Date.now() - last.at)}前）：${String(last.data.text).slice(0, 200)}`)
        m.blocks.push({ from: 'action-dsh', order: 31, text: `【手头的活（DSH 工程活）】\n${lines.join('\n')}` })
      }
      return next()
    })

    mountWeb(ctx, cfg, () => locate(cfg), () => !!secrets.get(cfg.keySecret ?? 'deepseek'))

    ctx.effect(() => commands.register({
      name: 'dsh',
      usage: 'dsh [stop]',
      description: 'DSH（她电脑里写代码的助手）装没装、在跑什么；stop = 急停',
      run(args, io) {
        if (args[0] === 'stop') {
          const ids = running()
          for (const id of ids) ctx.actions.stop(id, '急停')
          io.print(ids.length ? `已叫停 ${ids.join('、')}` : '没有正在跑的 DSH 任务')
          return
        }
        const inst = locate(cfg)
        io.print(inst ? `DSH ${inst.version}：${inst.entry}` : '没装 DSH（npm i -g @deepseek-ai/dsh）')
        io.print(`密钥 ${cfg.keySecret ?? 'deepseek'}：${secrets.get(cfg.keySecret ?? 'deepseek') ? '已设' : '没设'} · 沙箱 ${cfg.sandbox ?? 'workspace-write'}`)
        const runs = ctx.actions.snapshot().filter(r => r.id.startsWith('dsh#'))
        io.print(runs.length ? runs.map(r => `${r.id} ${describe(workOf(ctx.log.events, r.id, r.runningMs))}`).join('\n') : '没有正在跑的任务')
      },
    }))
  },
}

export default plugin

/** 工具参数压成一行留档（面板用；给她看的是 sayOf 那句人话） */
function brief(input: unknown): string {
  if (!input || typeof input !== 'object')
    return String(input ?? '')
  const o = input as Record<string, unknown>
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query'])
    if (typeof o[k] === 'string')
      return String(o[k]).replace(/\s+/g, ' ').slice(0, 200)
  return JSON.stringify(o).slice(0, 200)
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…（截断，共 ${s.length} 字）`
}
