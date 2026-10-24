import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanPlugins } from '../src/loader/manifest.ts'

function fixture(tree: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'mumu-plugins-'))
  for (const [rel, pkg] of Object.entries(tree)) {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    if (pkg !== null)
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  }
  return root
}

test('任意层级归类：深浅目录里的插件都能找到', async () => {
  const root = fixture({
    'top': { name: 'top' },
    'official/a': { name: '@mumu/a' },
    'official/surface/b': { name: '@mumu/b' },
    'user/我的/很深/c': { name: 'c' },
    'empty-group': null, // 纯归类目录，无 package.json
  })
  try {
    const found = await scanPlugins(root)
    assert.deepEqual(found.map(m => m.id).sort(), ['a', 'b', 'c', 'top'])
    // group 记录归类路径，仅供展示
    const byId = new Map(found.map(m => [m.id, m]))
    assert.equal(byId.get('top')!.group, '')
    assert.equal(byId.get('a')!.group, 'official')
    assert.equal(byId.get('b')!.group, 'official/surface')
    assert.equal(byId.get('c')!.group, 'user/我的/很深')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('插件目录内部不再下钻（子目录是它自己的事）', async () => {
  const root = fixture({
    'official/host': { name: 'host' },
    'official/host/vendor/nested': { name: 'nested' }, // 不应被当作插件
    'official/host/node_modules/dep': { name: 'dep' },
  })
  try {
    assert.deepEqual((await scanPlugins(root)).map(m => m.id), ['host'])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('id 与路径无关：挪窝不改身份', async () => {
  const a = fixture({ 'x': { name: '@mumu/same', mumu: { order: 3 } } })
  const b = fixture({ 'deep/deeper/y': { name: '@mumu/same', mumu: { order: 3 } } })
  try {
    const [m1] = await scanPlugins(a)
    const [m2] = await scanPlugins(b)
    assert.equal(m1.id, m2.id) // 目录名与层级都变了，id 不变
    assert.equal(m1.order, m2.order)
  }
  finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('id 冲突大声失败（否则配置会静默串台）', async () => {
  const root = fixture({
    'official/one': { name: '@mumu/dup' },
    'user/two': { name: '@other/dup' },
  })
  try {
    await assert.rejects(scanPlugins(root), /duplicate plugin id "dup"/)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('坏 package.json 跳过，不拖垮其余插件', async () => {
  const root = fixture({ 'good': { name: 'good' }, 'bad': null })
  writeFileSync(join(root, 'bad', 'package.json'), '{ 不是 JSON')
  try {
    assert.deepEqual((await scanPlugins(root)).map(m => m.id), ['good'])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('加载次序只看 order，与目录层级无关', async () => {
  const root = fixture({
    'z-group/late': { name: 'late', mumu: { order: 10 } },
    'a-group/early': { name: 'early', mumu: { order: -100 } },
  })
  try {
    assert.deepEqual((await scanPlugins(root)).map(m => m.id), ['early', 'late'])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
