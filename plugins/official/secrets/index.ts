/**
 * 密钥服务。
 *
 * 立场：密钥**物理上**与配置树分离——独立表、独立服务、`list()` 只返回名字。
 * 配置树会被 `/config get` 打印、被调试页展示、将来可能被导出；密钥一旦混进去迟早被打出来。
 * 其他插件（provider、tts）只存一个 `apiKeyRef` 名字，取值时才来这里要。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Plugin } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'

export interface SecretsService {
  get: (name: string) => string | undefined
  set: (name: string, value: string) => void
  del: (name: string) => boolean
  /** 只有名字，没有值 */
  list: () => { name: string, updatedAt: number }[]
}

const plugin: Plugin = {
  name: 'secrets',
  inject: ['db', 'commands'],
  apply(ctx) {
    const db = ctx.use<DatabaseSync>('db')
    db.exec('CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')

    const service: SecretsService = {
      get(name) {
        const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: string } | undefined
        return row?.value
      },
      set(name, value) {
        if (!name || !value)
          throw new Error('名字与值都不能为空')
        db.prepare('INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
          .run(name, value, Date.now())
      },
      del(name) {
        return db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0
      },
      list() {
        return (db.prepare('SELECT name, updated_at FROM secrets ORDER BY name').all() as any[])
          .map(r => ({ name: r.name, updatedAt: r.updated_at }))
      },
    }
    ctx.provide('secrets', service)

    ctx.effect(() => ctx.use<CommandService>('commands').register({
      name: 'secret',
      usage: 'secret set <名字> <值> | del <名字> | list',
      description: '管理密钥（值永不显示）',
      run(args, io) {
        const [op, name, ...rest] = args
        if (op === 'set') {
          service.set(name, rest.join(' '))
          io.print(`  ✓ 密钥 ${name} 已保存`)
        }
        else if (op === 'del') {
          io.print(service.del(name) ? `  ✓ 密钥 ${name} 已删除` : `  没有叫 ${name} 的密钥`)
        }
        else if (op === 'list') {
          const all = service.list()
          io.print(all.length
            ? all.map(s => `  ${s.name}（${new Date(s.updatedAt).toLocaleString('zh-CN')}）`).join('\n')
            : '  没有任何密钥；/secret set <名字> <值>')
        }
        else {
          throw new Error('用法: /secret set <名字> <值> | del <名字> | list')
        }
      },
    }))
  },
}

export default plugin
