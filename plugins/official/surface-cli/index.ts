/**
 * CLI 表现端：配速呈现、送达回报、打断、管理命令。
 *
 * 立场：终端是管理命令的主入口（/secret 这种不该出现在网页上的命令只在这里敲），
 * 也是没有浏览器时验证角色的最小表现端。
 * 输出统一经 cli/render 水线，其他插件拦截即可改样式。
 * 命令不在本插件硬编码：登记到 commands 注册表，Web 调试页也能跑同一套。
 */
import * as readline from 'node:readline'
import process from 'node:process'
import type { ConfigService, Expression, Plugin, PluginLoader } from '../../../src/index.ts'
import { AsyncQueue, MAIN_CHANNEL, sleep } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'

/** /stream 的逐字间隔，以及每隔多少字唤醒一次 decider */
const STREAM_CHAR_MS = 260
const STREAM_WAKE_EVERY = 4

interface CliConfig {
  paceMs?: number
  yieldToWeb?: boolean // 有浏览器连着时终端不呈现发言、不回执（避免两个回执端打架），命令照常
}

/** cli/render 水线载荷；拦截方改 styled 即改样式 */
export interface CliRender {
  kind: 'name' | 'speech' | 'marker' | 'prompt' | 'stop' | 'system' | 'break'
  text: string
  styled: string
}

const ANSI = {
  dim: (s: string) => `\x1B[2m${s}\x1B[0m`,
  cyan: (s: string) => `\x1B[36m${s}\x1B[0m`,
  green: (s: string) => `\x1B[32m${s}\x1B[0m`,
}

type Unit
  = | { utt: string, kind: 'text', s: string }
    | { utt: string, kind: 'marker', s: string }
    | { utt: string, kind: 'break' }
    | { utt: string, kind: 'end' }

const plugin: Plugin<CliConfig> = {
  name: 'surface-cli',
  inject: ['loader', 'app', 'config', 'commands'],
  apply(ctx, cfg = {}) {
    const pace = cfg.paceMs ?? 0
    const commands = ctx.use<CommandService>('commands')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    // 无终端（stdin 不是 TTY 或已关闭）时 readline 会立刻 close；之后任何 prompt() 都会抛错杀进程。
    // 只开网页不开终端是正常用法，所以关闭后本插件只是变得安静，不退出。
    let closed = false
    rl.on('close', () => { closed = true })
    const prompt = (): void => {
      if (!closed)
        rl.prompt(true)
    }
    const queue = new AsyncQueue<Unit>()
    const stopped = new Set<string>()
    const printed = new Map<string, number>()
    let speaking: string | undefined // 正在打印的 utterance，控制换行与提示符

    /** 默认终端样式；主题插件可拦截覆盖 styled */
    const render = async (kind: CliRender['kind'], text: string): Promise<string> => {
      const fallback = kind === 'name'
        ? ANSI.cyan(text)
        : kind === 'marker' || kind === 'stop' || kind === 'system'
          ? ANSI.dim(text)
          : kind === 'prompt' ? ANSI.green(text) : text
      const out = await ctx.bus.waterfall<CliRender, CliRender>(
        'cli/render',
        { kind, text, styled: fallback },
        async p => p,
      )
      return out.styled
    }

    // 终端只在「有人可能在看」时才是表现端：stdin 是 TTY，且没有浏览器连着（可配）。
    // 否则它的打字机会比网页快，内核会按它的进度记 delivered，网页里的打断就不准了。
    const interactive = !!process.stdin.isTTY
    const yieldToWeb = cfg.yieldToWeb ?? true
    let webClients = 0
    let surfaceOff: (() => void) | undefined
    const syncSurface = (): void => {
      const shouldPresent = interactive && !(yieldToWeb && webClients > 0)
      if (shouldPresent && !surfaceOff)
        surfaceOff = connectSurface()
      else if (!shouldPresent && surfaceOff) {
        surfaceOff()
        surfaceOff = undefined
        if (webClients > 0)
          console.log(ANSI.dim('  （浏览器已连接，发言在网页呈现；终端只保留命令）'))
      }
    }
    ctx.on<{ count: number }>('web/clients', ({ count }) => {
      webClients = count
      syncSurface()
    })
    ctx.effect(() => () => surfaceOff?.())

    const connectSurface = (): (() => void) => ctx.io.connect({
      name: 'cli',
      channels: [MAIN_CHANNEL],
      capabilities: { deliveredReport: true },
      onExpression: (e: Expression) => {
        if (e.type === 'part') {
          const { kind, text, data } = e.part
          if (kind === 'text' && text) {
            // 配速时逐字入队以便 stop 精确截断，否则整块直出
            if (pace > 0) {
              for (const ch of text)
                queue.push({ utt: e.uttId, kind: 'text', s: ch })
            }
            else {
              queue.push({ utt: e.uttId, kind: 'text', s: text })
            }
          }
          else if (kind === 'marker') {
            queue.push({ utt: e.uttId, kind: 'marker', s: `〔${data?.value ?? data?.track}〕` })
          }
          else if (kind === 'break') {
            queue.push({ utt: e.uttId, kind: 'break' })
          }
          // 不认识的片段 kind 直接忽略，即能力降级
        }
        else if (e.type === 'end') {
          queue.push({ utt: e.uttId, kind: 'end' })
        }
        else if (e.type === 'stop') {
          stopped.add(e.uttId)
          if (speaking === e.uttId) {
            void render('stop', ' ⏹').then((s) => {
              process.stdout.write(`${s}\n`)
              prompt()
            })
            speaking = undefined
          }
        }
      },
    })
    syncSurface()

    // 串行呈现队列，边输出边回报送达进度
    void (async () => {
      for await (const u of queue) {
        if (stopped.has(u.utt))
          continue
        if (u.kind === 'end') {
          if (speaking === u.utt) {
            process.stdout.write('\n')
            speaking = undefined
            prompt()
          }
          continue
        }
        if (speaking !== u.utt) {
          process.stdout.write(`\n${await render('name', '沐沐')} › `)
          speaking = u.utt
        }
        if (u.kind === 'break') {
          process.stdout.write(await render('break', '\n     '))
          continue
        }
        process.stdout.write(await render(u.kind === 'marker' ? 'marker' : 'speech', u.s))
        if (u.kind === 'text') {
          const n = (printed.get(u.utt) ?? 0) + u.s.length
          printed.set(u.utt, n)
          ctx.io.reportDelivered(u.utt, n)
          if (pace > 0)
            await sleep(pace)
        }
      }
    })()

    rl.on('line', (line) => {
      const text = line.trim()
      if (!text)
        return prompt()
      if (text.startsWith('/')) {
        void commands.run(text, { print: l => console.log(l) }).then(prompt)
        return
      }
      void ctx.io.percept({
        kind: 'message',
        channel: MAIN_CHANNEL,
        sender: { id: 'user' },
        text,
        urgent: true, // 直接的用户插话：默认打断正在说的话
      })
    })

    // ── 管理命令登记；装配层与配置库均为服务，表现端只消费 ──
    const loader = ctx.use<PluginLoader>('loader')
    const config = ctx.use<ConfigService>('config')

    ctx.effect(() => commands.register({
      name: 'quit',
      usage: 'quit',
      description: '退出',
      run: () => ctx.use<{ shutdown: () => Promise<void> }>('app').shutdown(),
    }))
    ctx.effect(() => commands.register({
      name: 'plugins',
      usage: 'plugins',
      description: '列出插件（● 已加载 ○ 未加载）',
      run(_args, io) {
        for (const [group, list] of Map.groupBy(loader.list(), p => p.group)) {
          io.print(ANSI.dim(`  ${group || '(顶层)'}/`))
          for (const p of list)
            io.print(`    ${p.loaded ? '●' : '○'} ${p.id}${p.enabled ? '' : '（停用）'}${p.error ? ` ✗ ${p.error}` : ''} ${ANSI.dim(p.description ?? '')}`)
        }
      },
    }))
    ctx.effect(() => commands.register({
      name: 'plugin',
      usage: 'plugin enable|disable|reload <id> | plugin scan',
      description: '启停或重载插件；scan = 重扫插件目录，新插件不重启就装上',
      async run(args, io) {
        const [op, id] = args
        if (op === 'scan') {
          const r = await loader.scan()
          io.print(`  新发现 ${r.added.length ? r.added.join('、') : '无'}；装上 ${r.loaded.length ? r.loaded.join('、') : '无'}`)
          for (const f of r.failed)
            io.print(`  ✗ ${f.id}：${f.error}`)
          return
        }
        if (op === 'enable')
          await loader.setEnabled(id, true)
        else if (op === 'disable')
          await loader.setEnabled(id, false)
        else if (op === 'reload')
          await loader.reload(id)
        else throw new Error('用法: /plugin enable|disable|reload <id>')
        io.print(`  ✓ ${op} ${id}`)
      },
    }))
    ctx.effect(() => commands.register({
      name: 'config',
      usage: 'config get|set <路径> [值]',
      description: '读写配置库（plugins.<id>.…），set 后对应插件自动重载',
      run(args, io) {
        const [op, path, ...valueParts] = args
        if (op === 'get') {
          io.print(`  ${JSON.stringify(config.get(path ?? ''), null, 2)}`)
        }
        else if (op === 'set') {
          const raw = valueParts.join(' ')
          let value: unknown
          try {
            value = JSON.parse(raw)
          }
          catch {
            value = raw // 非 JSON 按字符串存
          }
          config.set(path, value)
          io.print(`  ✓ ${path} 已更新`)
        }
        else {
          throw new Error('用法: /config get|set <路径> [值]')
        }
      },
    }))
    ctx.effect(() => commands.register({
      name: 'log',
      usage: 'log [n]',
      description: '看最近 n 条日志',
      run(args, io) {
        const n = Number(args[0] ?? 10)
        for (const e of ctx.log.events.slice(-n))
          io.print(`  ${e.seq} ${e.type} ${ANSI.dim(JSON.stringify(e.data).slice(0, 140))}`)
      },
    }))
    ctx.effect(() => commands.register({
      name: 'stream',
      usage: 'stream <要逐字说出的话>',
      description: '模拟语音逐字输入，每隔几个字唤醒一次导演',
      async run(args) {
        // 真实语音端改为传入 ASR partial，机制相同
        const text = args.join(' ')
        if (!text)
          throw new Error('用法: /stream <要逐字说出的话>')
        const perception = ctx.io.perceive({
          kind: 'message',
          channel: MAIN_CHANNEL,
          sender: { id: 'user' },
          urgent: true, // 一开口就打断角色正在说的话
        })
        process.stdout.write(`${await render('prompt', '你')} ${ANSI.dim('（逐字中）')} › `)
        let said = ''
        for (const ch of text) {
          said += ch
          process.stdout.write(ch)
          await perception.update(said, { wake: said.length % STREAM_WAKE_EVERY === 0 })
          await sleep(STREAM_CHAR_MS)
        }
        process.stdout.write('\n')
        await perception.end()
      },
    }))

    ctx.effect(() => {
      rl.setPrompt('你 › ')
      void render('prompt', '你').then((s) => {
        rl.setPrompt(`${s} › `)
        prompt()
      })
      return () => {
        closed = true
        rl.close()
        queue.close()
      }
    })
  },
}

export default plugin
