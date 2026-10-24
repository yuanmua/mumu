/**
 * 插件目录的文件指纹：fs.watch 报的变更，先比一比文件是不是真的变了。
 *
 * 为什么要它：Windows 上的递归 fs.watch 会为「只是被访问 / 属性被碰了一下」报事件——
 * 2026-10-21 把 C:\mumu 用 SMB 挂到 Mac 的那一刻，所有插件目录同时报变更，全体热重载，
 * storage-sqlite 一重载，别的插件手里的 db 句柄就成了关闭的（满屏 database is not open）。
 * 所以事件只当「可能变了」：文件的 mtime 与大小和上次记的一样就不算；点开头的文件（.DS_Store、._xx、
 * 编辑器的交换文件）与 node_modules 一律不算；目录自身的事件不算（里面的文件变了会单独报）。
 */
import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export class DirFingerprint {
  private seen = new Map<string, string>()

  constructor(private dir: string) {
    this.walk(dir, 0)
  }

  /** file 是 fs.watch 回调给的相对路径；没给（个别平台）时保守地当作变了 */
  changed(file: string | null): boolean {
    if (!file)
      return true
    if (file.split(/[\\/]/).some(p => p === 'node_modules' || p.startsWith('.')) || basename(file).startsWith('.'))
      return false
    const full = join(this.dir, file)
    const now = stamp(full)
    if (now === 'dir')
      return false
    const before = this.seen.get(full)
    if (now === undefined) {
      // 删掉了：原来有才算变
      this.seen.delete(full)
      return before !== undefined
    }
    if (now === before)
      return false
    this.seen.set(full, now)
    return true
  }

  private walk(dir: string, depth: number): void {
    if (depth > 8)
      return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    }
    catch {
      return // 目录读不了（权限 / 正被删）：不记指纹，之后它的事件按「新文件」算，最多多重载一次
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.'))
        continue
      const full = join(dir, ent.name)
      if (ent.isDirectory())
        this.walk(full, depth + 1)
      else {
        const s = stamp(full)
        if (s && s !== 'dir')
          this.seen.set(full, s)
      }
    }
  }
}

function stamp(file: string): string | undefined {
  try {
    const s = statSync(file)
    return s.isDirectory() ? 'dir' : `${s.mtimeMs}:${s.size}`
  }
  catch {
    return undefined
  }
}
