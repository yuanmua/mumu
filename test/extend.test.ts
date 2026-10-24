import assert from 'node:assert/strict'
import { test } from 'node:test'
import { audit, parseDraft } from '../plugins/official/action-extend/author.ts'

const pkg = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: '@user/bedtime', type: 'module', main: 'index.ts', mumu: { id: 'bedtime', enabled: true, order: 0, defaults: {} }, ...extra })
const good = `import type { Plugin } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import { hhmm } from './time.ts'
const plugin: Plugin = { name: 'bedtime', apply() {} }
export default plugin
`

test('extend 护栏：只 import 公共 API 与同目录子模块、没有依赖的插件通过', () => {
  assert.deepEqual(audit('bedtime', { summary: '', files: { 'package.json': pkg(), 'index.ts': good, 'time.ts': 'export const hhmm = 1\n', 'README.md': '# x' } }), [])
})

test('extend 护栏：越界的一律拦下', () => {
  const bad = audit('bedtime', {
    summary: '',
    files: {
      'package.json': pkg({ dependencies: { axios: '^1' }, mumu: { id: 'other' } }),
      'index.ts': `import { readFileSync } from 'node:fs'\nimport x from '../../official/clock/index.ts'\nconst m = await import('./y.ts')\n`,
      '../escape.ts': 'x',
    },
  })
  const text = bad.join('\n')
  assert.match(text, /缺 README\.md/)
  assert.match(text, /mumu\.id 必须是 bedtime/)
  assert.match(text, /不许加依赖/)
  assert.match(text, /不许 import 'node:fs'/)
  assert.match(text, /不许 import '\.\.\/\.\.\/official\/clock\/index\.ts'/)
  assert.match(text, /import\(/)
  assert.match(text, /不许写 \.\.\/escape\.ts/)
})

test('extend 护栏：多行 import 也认得出模块名', () => {
  const code = `import {\n  PROMPT_ORDER,\n  formatElapsed,\n} from 'node:child_process'\n`
  const bad = audit('bedtime', { summary: '', files: { 'package.json': pkg(), 'index.ts': code, 'README.md': '#' } })
  assert.ok(bad.some(b => b.includes('child_process')))
})

test('extend：模型输出外层有多余文字也能解析，不是 JSON 返回 undefined', () => {
  const d = parseDraft('好的：{"files":{"index.ts":"x","README.md":1},"summary":"睡觉提醒"}')
  assert.deepEqual(d, { files: { 'index.ts': 'x' }, summary: '睡觉提醒' })
  assert.equal(parseDraft('写不出来'), undefined)
})
