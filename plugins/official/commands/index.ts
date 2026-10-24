/**
 * 管理命令注册表。
 *
 * 立场：命令是「插件暴露给人的操作面」，不该绑死在某一个表现端里。
 * 本插件只提供登记与分发；谁登记（secrets 登记 /secret、surface-cli 登记 /plugins……）、
 * 谁执行（终端、Web 调试页、将来的聊天平台 Bot）都与它无关。
 * 输出经 CommandIO 回给调用方，本插件不碰 stdout。
 */
import type { Disposer, Plugin } from '../../../src/index.ts'
import { Registry } from '../../../src/index.ts'

export interface CommandIO {
  print: (line: string) => void
}

export interface Command {
  name: string // 不带斜杠，如 'secret'
  usage: string // 如 'secret set|del|list [名字] [值]'
  description: string
  run: (args: string[], io: CommandIO) => void | Promise<void>
}

export interface CommandService {
  register: (cmd: Command) => Disposer
  list: () => Command[]
  /** 执行一行输入；不是命令（不以 / 开头）返回 false，未知命令打印提示并返回 true */
  run: (line: string, io: CommandIO) => Promise<boolean>
}

const plugin: Plugin = {
  name: 'commands',
  apply(ctx) {
    const registry = new Registry<Command>('命令', c => c.name)

    const service: CommandService = {
      register: cmd => registry.add(cmd),
      list: () => registry.list().sort((a, b) => a.name.localeCompare(b.name)),
      async run(line, io) {
        const text = line.trim()
        if (!text.startsWith('/'))
          return false
        const [head, ...args] = text.slice(1).split(/\s+/)
        if (head === 'help' || head === '') {
          for (const c of service.list())
            io.print(`  /${c.usage}  — ${c.description}`)
          return true
        }
        const cmd = registry.get(head)
        if (!cmd) {
          io.print(`  未知命令 /${head}，/help 看全部`)
          return true
        }
        try {
          await cmd.run(args, io)
        }
        catch (e) {
          // 命令出错只告诉调用方，不能影响角色运行
          io.print(`  ✗ ${e instanceof Error ? e.message : String(e)}`)
        }
        return true
      },
    }
    ctx.provide('commands', service)
  },
}

export default plugin
