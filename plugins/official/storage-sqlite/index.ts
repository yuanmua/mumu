/**
 * SQLite 存储：会话日志落盘、配置库、裸 db 句柄，三者共用一个本地库文件。
 *
 * 立场：
 * - 引导期插件（order < 0），配置只来自自己的清单 defaults。
 * - 配置库只存覆盖值；默认值在各插件 package.json 的 mumu.defaults，空库即全默认。
 * - 把 DatabaseSync 作为 `db` 服务暴露：别的插件（如 secrets）可以开自己的表，
 *   而不必把所有东西都塞进配置树。配置树会被打印、展示、导出，不适合放敏感或大体量数据。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConfigService, Disposer, LogEvent, Plugin } from '../../../src/index.ts'

/** 整库快照服务（别的插件清东西之前调）；返回备份文件路径 */
export interface BackupService {
  snapshot: (reason: string) => string
}

interface StorageConfig {
  dataDir?: string
  file?: string // 库文件名，相对 dataDir
}

const plugin: Plugin<StorageConfig> = {
  name: 'storage-sqlite',
  apply(ctx, cfg = {}) {
    const dataDir = cfg.dataDir ?? 'data'
    mkdirSync(dataDir, { recursive: true })
    const db = new DatabaseSync(join(dataDir, cfg.file ?? 'mumu.db'))
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    ctx.effect(() => () => db.close())
    ctx.provide('db', db)

    // ── 备份：任何清理（网页的清除按钮、清理脚本）之前先拍一份完整快照（项目规矩）。
    // VACUUM INTO 在 WAL 模式下也能拿到一致的整库副本，不用停写入
    const backupDir = join(dataDir, 'backups')
    const backup: BackupService = {
      snapshot(reason) {
        mkdirSync(backupDir, { recursive: true })
        const file = join(backupDir, `mumu-${new Date().toISOString().replace(/[:.]/g, '-')}-${reason.replace(/[^\w-]/g, '')}.db`)
        db.exec(`VACUUM INTO '${file.replace(/'/g, '\'\'')}'`)
        return file
      },
    }
    ctx.provide('backup', backup)

    // ── 配置库：顶层键存 JSON，点路径读写，变更通知带完整路径 ──
    const listeners = new Set<(path: string) => void>()
    const readTop = (key: string): unknown => {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
      return row ? JSON.parse(row.value) : undefined
    }
    const writeTop = (key: string, value: unknown, path: string): void => {
      db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value))
      for (const fn of listeners) {
        try {
          fn(path)
        }
        catch (e) {
          console.error('[storage] 配置监听器出错:', e)
        }
      }
    }

    const config: ConfigService = {
      get<T>(path: string, def?: T): T | undefined {
        const [top, ...rest] = path.split('.')
        let v: any = readTop(top)
        for (const k of rest) v = v?.[k]
        return (v ?? def) as T | undefined
      },
      set(path: string, value: unknown): void {
        const [top, ...rest] = path.split('.')
        if (!rest.length)
          return writeTop(top, value, path)
        const obj: any = readTop(top) ?? {}
        let cur = obj
        for (const k of rest.slice(0, -1)) cur = cur[k] ??= {}
        cur[rest[rest.length - 1]] = value
        // 通知带完整路径，装配层据此只重载受影响的那个插件
        writeTop(top, obj, path)
      },
      onChange(fn): Disposer {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    }
    ctx.provide('config', config)

    // ── 会话日志落盘，挂到内核持久化 seam ──
    const insert = db.prepare('INSERT INTO events (seq, at, type, data) VALUES (?, ?, ?, ?)')
    ctx.effect(() => ctx.log.attachPersistence({
      loadAll: () => (db.prepare('SELECT seq, at, type, data FROM events ORDER BY seq').all() as any[])
        .map(r => ({ seq: r.seq, at: r.at, type: r.type, data: JSON.parse(r.data) }) as LogEvent),
      append: (e) => {
        insert.run(e.seq, e.at, e.type, JSON.stringify(e.data))
      },
      clear: () => {
        db.exec('DELETE FROM events')
      },
    }))
  },
}

export default plugin
