/**
 * extend 动作：她给自己加一个简单的新功能（写一个用户插件、自检、装上）。
 *
 * 流程：task.agent 按插件契约写 plugins/user/<name>/（author.ts）→ 护栏检查 → 落盘 → `npm run check`（只看这个插件的报错）
 * → 装配层 scan（新目录不重启就装上；已装过的重载）→ 结果以 extend.result 感知唤醒导演，她用自己的话说加了什么。
 * 任何一步出错（输出不成形、越过护栏、类型检查不过、装上时 apply 抛错）都把错误原文喂回去让她改，最多 maxFixes 次；
 * 改不好就停下，坏插件不会被装上（装配层只跳过它），她会知道哪里坏了。
 *
 * 只有主人能让她做这件事：描述里标了「（需要主人）」，guard 插件据此在 intent/pre-dispatch 上拦。
 * 不说话：和 computer 一样，开口永远是 reply 的事。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ChatMessage, Plugin, PluginLoader } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import { audit, buildPrompt, parseDraft } from './author.ts'
import { webExtras } from './web.ts'

interface ExtendConfig {
  role?: string
  userDir?: string
  maxFixes?: number
  checkTimeoutSec?: number
}

const plugin: Plugin<ExtendConfig> = {
  name: 'action-extend',
  inject: ['loader', 'commands'],
  apply(ctx, cfg = {}) {
    const loader = ctx.use<PluginLoader>('loader')
    const userRoot = resolve(cfg.userDir ?? 'plugins/user')

    ctx.effect(() => ctx.actions.register({
      name: 'extend',
      description: '（需要主人）给自己加一个简单的新功能：写一个小插件、自己检查、装上。主人让你「给自己加个功能…」时用；'
        + '它在后台写，你照常聊天，做完会有 extend.result 回来，那时再用自己的话说加了什么、怎么用。也用来修自己加过但坏掉的功能（name 写同一个）。',
      paramsHint: '{"name":"英文小写短名，如 bedtime-reminder","purpose":"要做什么，写具体：什么时候触发、做什么、在哪个频道（如每天 23:00 在网页对话 main 提醒主人睡觉）"}',
      reloadPolicy: 'drain',
      run: async (a) => {
        const name = String(a.params.name ?? '').trim().toLowerCase()
        const purpose = String(a.params.purpose ?? '').trim()
        const channel = a.channel ?? ctx.log.history({ limit: 20 }).filter(t => t.role === 'other').at(-1)?.channel
        const finish = async (ok: boolean, text: string, data: Record<string, unknown>): Promise<void> => {
          a.note(ok ? '加好了' : '没加成')
          a.remember(`${text}。还没告诉对方的话，用自己的话简单说一下。`, { beats: 4 })
          await ctx.io.percept({ kind: 'extend.result', channel, text, data: { actionId: a.id, name, ok, ...data } })
        }
        const okName = name.length >= 2 && name.length <= 40 && name[0] >= 'a' && name[0] <= 'z'
          && [...name].every(c => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')
        if (!okName || !purpose)
          return finish(false, `想给自己加功能，但名字「${name}」不合规矩（英文小写、数字、短横线）或没说要做什么，没动手`, {})
        const dir = join(userRoot, name)
        if (!dir.startsWith(userRoot + sep))
          return finish(false, '插件只能写在 plugins/user/ 下，没动手', {})
        const official = loader.list().find(p => p.id === name && !p.group.startsWith('user'))
        if (official)
          return finish(false, `「${name}」是官方插件的名字，不能动它，换个名字`, {})

        const existing = existsSync(dir) ? readDir(dir) : undefined
        const messages: ChatMessage[] = buildPrompt({
          name,
          purpose,
          existing,
          template: readDir(resolve('plugins/official/clock')),
          exports: exportsOf(resolve('src/index.ts')),
        })
        const tries: string[] = []
        const max = (cfg.maxFixes ?? 3) + 1
        for (let i = 0; i < max; i++) {
          if (a.signal.aborted)
            return finish(false, `给自己加「${name}」做到一半被叫停了`, { tries })
          a.note(i ? `第 ${i + 1} 次：照报错改` : '正在写')
          const text = await ctx.model.complete({ role: cfg.role ?? 'task.agent', messages, signal: a.signal })
          const problem = await attempt(text)
          if (!problem.length) {
            const summary = parseDraft(text)?.summary ?? ''
            ctx.log.append('extend.installed', { name, tries: i + 1, summary })
            const what = existing ? `把自己的功能「${name}」改好了` : `给自己加了新功能「${name}」`
            return finish(true, `${what}（${i ? `照报错改了 ${i} 次才过` : '一次就过了'}）：${summary}`, { tries, summary })
          }
          tries.push(problem.join('；').slice(0, 300))
          ctx.log.append('extend.attempt', { name, n: i + 1, problem })
          messages.push({ role: 'assistant', content: text })
          messages.push({ role: 'user', content: `有问题，改好后重新输出完整 JSON（三个文件都要给全）：\n${problem.join('\n').slice(0, 3000)}` })
        }
        return finish(false, `给自己加「${name}」试了 ${max} 次还是不行，最后的问题：${tries.at(-1)}`, { tries })

        /** 一次尝试：解析 → 护栏 → 落盘 → 类型检查 → 装上；返回问题清单（空 = 成功） */
        async function attempt(text: string): Promise<string[]> {
          const draft = parseDraft(text)
          if (!draft)
            return ['输出不是一个合法的 JSON 对象（{"files":{…},"summary":"…"}）']
          const bad = audit(name, draft)
          if (bad.length)
            return bad.map(b => `护栏：${b}`)
          mkdirSync(dir, { recursive: true })
          // 上一版留下、这一版没有的 .ts 删掉，免得残留的坏文件让检查一直不过
          for (const f of readdirSync(dir)) {
            if (f.endsWith('.ts') && !(f in draft.files))
              rmSync(join(dir, f))
          }
          for (const [f, content] of Object.entries(draft.files))
            writeFileSync(join(dir, f), content.endsWith('\n') ? content : `${content}\n`)
          const errors = await typecheck(name, cfg.checkTimeoutSec ?? 240)
          if (errors.length)
            return errors.map(e => `类型检查：${e}`)
          const loadError = await install(name)
          return loadError ? [`装上时出错：${loadError}`] : []
        }
      },
    }))

    /** 装上：已登记的重载，新的 scan；返回错误（成功 undefined） */
    const install = async (id: string): Promise<string | undefined> => {
      const known = loader.list().find(p => p.id === id)
      if (known?.loaded) {
        try {
          await loader.reload(id)
        }
        catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
        return loader.list().find(p => p.id === id)?.error
      }
      const r = await loader.scan()
      return r.failed.find(f => f.id === id)?.error
        ?? (loader.list().find(p => p.id === id)?.loaded ? undefined : '扫描后没有装上（package.json 的 mumu.id 对吗？enabled 是 true 吗？）')
    }

    // 能力教学：发言者知道自己能加功能、加过什么；导演知道怎么用 extend、结果怎么回来
    ctx.effect(() => ctx.prompt.section({
      id: 'extend-teaching',
      audience: 'performer',
      order: PROMPT_ORDER.teaching,
      render: () => {
        const mine = loader.list().filter(p => p.group.startsWith('user'))
        return '【给自己加功能】主人让你给自己加个简单功能时，你真的能做（写个小插件、自己检查、装上）：嘴上说「好，我试试」就行，'
          + '「刚才发生的事」里没有结果就是还没弄好，别说弄好了。别人（不是主人）让你加功能，用自己的话拒绝。'
          + (mine.length ? `\n你给自己加过的功能：${mine.map(p => `${p.id}${p.loaded ? '' : '（坏了，没装上）'}：${p.description ?? ''}`).join('；')}` : '')
      },
    }))
    ctx.effect(() => ctx.prompt.section({
      id: 'extend-teaching-mind',
      audience: 'mind',
      order: PROMPT_ORDER.teaching,
      render: () => {
        const mine = loader.list().filter(p => p.group.startsWith('user') && p.loaded)
        return '【给自己加功能】主人让她「给自己加个功能…」时：start extend（params.name 英文短名，purpose 把触发时机、做什么、在哪个频道写具体），'
          + 'reply 照常应一声。做完会有 extend.result 唤醒你：start reply（append:true，guidance 写加了什么、怎么用）告诉对方；没成也要说卡在哪。'
          + '主人说某个自己加的功能坏了：start extend，name 写同一个，purpose 写哪里不对。'
          + (mine.length
            ? `\n你给自己加过的功能（唤醒原因的 source 以它们的名字开头时，就是它们到点了 / 触发了——那是你自己要做的事，照着做：在那个频道 start reply，别当成别人的闲聊略过）：`
              + mine.map(p => `${p.id}（${p.description ?? ''}）`).join('；')
            : '')
      },
    }))

    webExtras(ctx, loader, userRoot)

    const commands = ctx.use<CommandService>('commands')
    ctx.effect(() => commands.register({
      name: 'extend',
      usage: 'extend',
      description: '她给自己加过的功能（plugins/user/ 下）与最近的尝试',
      run(_args, io) {
        const mine = loader.list().filter(p => p.group.startsWith('user'))
        io.print(mine.length ? mine.map(p => `  ${p.loaded ? '●' : '○'} ${p.id}${p.error ? ` ✗ ${p.error}` : ''} ${p.description ?? ''}`).join('\n') : '  还没加过')
        const recent = ctx.log.events.filter(e => e.type === 'extend.attempt' || e.type === 'extend.installed').slice(-6)
        for (const e of recent)
          io.print(`  ${e.type === 'extend.installed' ? '✓' : '·'} ${e.data.name}${e.data.n ? ` 第 ${e.data.n} 次：${String(e.data.problem).slice(0, 120)}` : `：${e.data.summary}`}`)
      },
    }))
  },
}

export default plugin

function readDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(dir)) {
    if (f === 'package.json' || f === 'README.md' || f.endsWith('.ts'))
      out[f] = readFileSync(join(dir, f), 'utf8')
  }
  return out
}

/** src/index.ts 的导出行：给模型看有哪些名字可用 */
function exportsOf(file: string): string {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('export')).join('\n')
    + '\n（内核导出另见：Plugin、Ctx、LogEvent、Percept、Section、MaterialBlock、Sender、HistoryTurn、MAIN_CHANNEL、PROMPT_ORDER、formatElapsed）'
}

/**
 * 跑整个仓库的 tsc（npm run check），只认这个插件目录里的报错：别的插件此刻有没有错不归她管。
 * Windows 上 npm 是 npm.cmd，Node 新版要 shell:true 才能起 .cmd。
 */
function typecheck(name: string, timeoutSec: number): Promise<string[]> {
  return new Promise((done) => {
    const win = process.platform === 'win32'
    const child = spawn(win ? 'npm.cmd' : 'npm', ['run', 'check'], { cwd: process.cwd(), shell: win, windowsHide: true })
    let out = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString() })
    child.stderr.on('data', (b: Buffer) => { out += b.toString() })
    const timer = setTimeout(() => child.kill(), timeoutSec * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0)
        return done([])
      const mine = out.split(/\r?\n/).filter(l => l.includes(`plugins/user/${name}/`) || l.includes(`plugins\\user\\${name}\\`))
      done(mine.slice(0, 20))
    })
    child.on('error', e => done([`跑不了类型检查：${e.message}`]))
  })
}
