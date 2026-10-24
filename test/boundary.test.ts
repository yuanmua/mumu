import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

function walk(dir: string, out: string[] = []): string[] {
  // plugins/ 可能不存在（核心单独 clone、外围尚未重建），没有目录就没有越界
  if (!existsSync(dir))
    return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules')
      continue
    const p = join(dir, name)
    if (statSync(p).isDirectory())
      walk(p, out)
    else if (name.endsWith('.ts') || name.endsWith('.vue'))
      out.push(p)
  }
  return out
}

/** 内核是独立的一块：外部只认 kernel/index.ts，内部路径不外溢 */
test('边界：内核之外不许 import 内核内部路径', () => {
  const outside = [...walk('src'), ...walk('plugins'), ...walk('test')]
    .filter(f => !f.startsWith('src/kernel/'))
  const offenders: string[] = []
  for (const f of outside) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      // 只允许 kernel/index.ts；子目录路径与 kernel/ 下的直接文件都不许
      if (/from\s+'[^']*\/kernel\/(?!index\.ts')/.test(line))
        offenders.push(`${f}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `应改为从 kernel/index.ts 导入：\n${offenders.join('\n')}`)
})

/** 插件只认公共 API 单一入口，不许绕到 src 内部 */
test('边界：插件只从 src/index.ts 导入', () => {
  const offenders: string[] = []
  for (const f of walk('plugins')) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      // 插件可任意分层，所以 ../ 的层数不固定，只校验落点是 src/index.ts
      const m = line.match(/from\s+'((?:\.\.\/)+src\/[^']+)'/)
      if (m && !m[1].endsWith('/src/index.ts'))
        offenders.push(`${f}: ${m[1]}`)
    }
  }
  assert.deepEqual(offenders, [], `插件应统一从 ../../src/index.ts 导入：\n${offenders.join('\n')}`)
})

/** 浏览器端只认协议：apps/ 下不许 import src/ 的任何文件 */
test('边界：apps/ 不许 import src/', () => {
  const offenders: string[] = []
  for (const f of walk('apps')) {
    if (f.includes('/dist/') || f.includes('/public/'))
      continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (/from\s+'(?:\.\.\/)+src\//.test(line) || /from\s+'[^']*\/src\/(?:kernel|loader|shared|index)/.test(line))
        offenders.push(`${f}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], `前端只认 docs/web-protocol.md，不许碰 src/：\n${offenders.join('\n')}`)
})
