import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ConfigService, Disposer } from '../src/index.ts'
import { Mumu } from '../src/kernel/index.ts'
import { installFreshHooks, withVersion } from '../src/loader/fresh.ts'
import { PluginLoader } from '../src/loader/loader.ts'
import { diffPatch, mergePatch } from '../src/loader/merge.ts'
import { DirFingerprint } from '../src/loader/watch.ts'

/** 探针插件把每次收到的配置推到 globalThis，跨动态 import 也看得见 */
const PROBE = `export default {
  name: %NAME%,
  apply(_ctx, config) {
    globalThis.__probe ??= []
    globalThis.__probe.push({ name: %NAME%, config })
  },
}
`

function probes(): { name: string, config: any }[] {
  return ((globalThis as any).__probe ??= []) as { name: string, config: any }[]
}

/** 建一个临时插件树；每项 = [相对路径, mumu 清单字段] */
function fixture(tree: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'mumu-loader-'))
  for (const [rel, mumu] of Object.entries(tree)) {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    const id = rel.split('/').pop()!
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: id, main: 'index.ts', mumu }))
    writeFileSync(join(dir, 'index.ts'), PROBE.replaceAll('%NAME%', JSON.stringify(id)))
  }
  return root
}

/** 内存配置库，形状与 storage-sqlite 提供的 config 服务一致 */
function memoryConfig(seed: Record<string, unknown> = {}): ConfigService & { store: Record<string, any> } {
  const store: Record<string, any> = structuredClone(seed)
  const listeners = new Set<(path: string) => void>()
  return {
    store,
    get<T>(path: string, def?: T): T | undefined {
      let v: any = store
      for (const k of path.split('.')) v = v?.[k]
      return (v ?? def) as T | undefined
    },
    set(path: string, value: unknown): void {
      const keys = path.split('.')
      let cur: any = store
      for (const k of keys.slice(0, -1)) cur = cur[k] ??= {}
      cur[keys[keys.length - 1]] = value
      for (const fn of listeners) fn(path)
    },
    onChange(fn): Disposer {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

async function boot(tree: Record<string, Record<string, unknown>>, config = memoryConfig()) {
  probes().length = 0
  const root = fixture(tree)
  const mumu = Mumu.create()
  mumu.container.registerService('config', config)
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  await loader.start()
  return {
    loader,
    config,
    root,
    async dispose() {
      loader.stop()
      await mumu.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 10))

/** 等到条件成立（重载是异步的；机器忙时 10ms 不够，实测在后端热重载时挂过）；超时就让后面的断言报出实际值 */
async function until(ok: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!ok() && Date.now() < end) await settle()
}

test('配置：默认在插件、覆盖在库（空库即全默认，无需播种）', async () => {
  const t = await boot({ 'official/alpha': { defaults: { greeting: '默认', keep: 1 } } })
  try {
    assert.deepEqual(probes().at(-1)!.config, { greeting: '默认', keep: 1 })
  }
  finally { await t.dispose() }
})

test('配置：库里的值覆盖清单默认，未覆盖的字段保留', async () => {
  const t = await boot(
    { 'official/alpha': { defaults: { greeting: '默认', keep: 1 } } },
    memoryConfig({ plugins: { alpha: { greeting: '被覆盖' } } }),
  )
  try {
    assert.deepEqual(probes().at(-1)!.config, { greeting: '被覆盖', keep: 1 })
  }
  finally { await t.dispose() }
})

test('配置：嵌套对象按键合并，库里只改一个子键不冲掉同层其余默认', async () => {
  const t = await boot(
    { 'official/alpha': { defaults: { roles: { default: { model: 'm0', url: 'u0' }, fast: { temp: 0.9 } } } } },
    memoryConfig({ plugins: { alpha: { roles: { fast: { model: 'm1' } } } } }),
  )
  try {
    assert.deepEqual(probes().at(-1)!.config, {
      roles: { default: { model: 'm0', url: 'u0' }, fast: { temp: 0.9, model: 'm1' } },
    })
  }
  finally { await t.dispose() }
})

test('配置：库里的 null 删掉该键（连同默认），数组整块替换不按下标合并', async () => {
  const t = await boot(
    { 'official/alpha': { defaults: { markers: { emo: ['脸红'], act: ['点头'] }, words: ['a', 'b'] } } },
    memoryConfig({ plugins: { alpha: { markers: { emo: null }, words: ['c'] } } }),
  )
  try {
    assert.deepEqual(probes().at(-1)!.config, { markers: { act: ['点头'] }, words: ['c'] })
  }
  finally { await t.dispose() }
})

test('mergePatch：RFC 7386 语义', () => {
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2 } }, { b: { d: 3 } }), { a: 1, b: { c: 2, d: 3 } })
  assert.deepEqual(mergePatch({ a: { b: 1 } }, { a: 'x' }), { a: 'x' }, '标量盖对象')
  assert.deepEqual(mergePatch({ a: 'x' }, { a: { b: 1 } }), { a: { b: 1 } }, '对象盖标量')
  assert.deepEqual(mergePatch({ a: 1 }, { b: null }), { a: 1 }, '删不存在的键无害')
  const base = { a: { b: 1 } }
  mergePatch(base, { a: { b: 2 } })
  assert.deepEqual(base, { a: { b: 1 } }, '不改写传入的默认值')
})

test('diffPatch：最小补丁，打回去等于想要的配置', () => {
  const defaults = { roles: { default: { url: 'u0', model: 'm0' }, fast: { temp: 0.9 } }, words: ['a'] }
  assert.equal(diffPatch(defaults, structuredClone(defaults)), undefined, '与出厂相同 → 不写库')
  const want = { roles: { default: { url: 'u0', model: 'm1' }, local: { url: 'u9' } }, words: ['a', 'b'] }
  const patch = diffPatch(defaults, want)
  assert.deepEqual(patch, { roles: { default: { model: 'm1' }, fast: null, local: { url: 'u9' } }, words: ['a', 'b'] })
  assert.deepEqual(mergePatch(defaults, patch), want)
})

test('配置变更即重载对应插件，且只重载它', async () => {
  const t = await boot({
    'official/alpha': { defaults: { v: 'a0' } },
    'official/beta': { defaults: { v: 'b0' } },
  })
  try {
    assert.equal(probes().length, 2)

    t.config.set('plugins.alpha.v', 'a1')
    await until(() => probes().length > 2)
    await settle() // 再等一拍：beta 若被误重载也该现形了

    const after = probes().slice(2)
    assert.deepEqual(after.map(p => p.name), ['alpha'], '只有 alpha 该被重载')
    assert.equal(after[0].config.v, 'a1', '重载时读到的是新配置')
  }
  finally { await t.dispose() }
})

test('配置变更：.enabled 不触发重载（那是 setEnabled 的职责，重复处理会打架）', async () => {
  const t = await boot({ 'official/alpha': {} })
  try {
    const before = probes().length
    t.config.set('plugins.alpha.enabled', true)
    await settle()
    assert.equal(probes().length, before, 'enabled 不该走重载路径')
  }
  finally { await t.dispose() }
})

test('配置变更：未加载的插件不被唤醒加载', async () => {
  const t = await boot(
    { 'official/alpha': {}, 'official/beta': { enabled: false } },
    memoryConfig(),
  )
  try {
    assert.deepEqual(probes().map(p => p.name), ['alpha'])
    t.config.set('plugins.beta.v', 1)
    await settle()
    assert.deepEqual(probes().map(p => p.name), ['alpha'], '停用的插件不该因改配置被拉起')
  }
  finally { await t.dispose() }
})

test('启停：setEnabled 立即生效并写库', async () => {
  const t = await boot({ 'official/alpha': { enabled: false } })
  try {
    assert.equal(probes().length, 0)
    await t.loader.setEnabled('alpha', true)
    assert.deepEqual(probes().map(p => p.name), ['alpha'])
    assert.equal(t.config.get('plugins.alpha.enabled'), true, '启停要持久化')

    await t.loader.setEnabled('alpha', false)
    assert.equal(t.loader.list().find(p => p.id === 'alpha')!.loaded, false)
  }
  finally { await t.dispose() }
})

test('引导段先于常规段：order < 0 的插件在配置库消费者之前就位', async () => {
  const t = await boot({
    'official/late': { order: 10 },
    'official/boot': { order: -100 },
    'official/mid': { order: 0 },
  })
  try {
    assert.deepEqual(probes().map(p => p.name), ['boot', 'mid', 'late'])
  }
  finally { await t.dispose() }
})

test('热重载：插件目录内的子模块随入口刷新，目录外的模块不重复实例化', async () => {
  installFreshHooks()
  probes().length = 0
  const g = globalThis as any
  g.__sharedEvals = 0
  const root = mkdtempSync(join(tmpdir(), 'mumu-fresh-'))
  const dir = join(root, 'official', 'multi')
  mkdirSync(join(dir, 'sub'), { recursive: true })
  // shared.ts 在插件目录外，相当于 src/index.ts：重载时绝不能被再求值一次
  writeFileSync(join(root, 'shared.ts'), 'globalThis.__sharedEvals++\nexport const shared = 1\n')
  // type: module 与真插件一致；没有它 tsx 按 CJS 跑，走 require 缓存，不在本机制范围内
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'multi', type: 'module', main: 'index.ts' }))
  writeFileSync(join(dir, 'pack.ts'), `export const v = 'v1'\n`)
  // 深一层再 ../ 回到插件根：验证深度推算，不只是「往下」的 import
  writeFileSync(join(dir, 'sub', 'deep.ts'), `import { v } from '../pack.ts'\nexport const w = 'deep-' + v\n`)
  writeFileSync(join(dir, 'index.ts'), `import { v } from './pack.ts'
import { w } from './sub/deep.ts'
import { shared } from '../../shared.ts'
export default {
  name: 'multi',
  apply() {
    globalThis.__probe ??= []
    globalThis.__probe.push({ name: 'multi', config: { v, w, shared } })
  },
}
`)
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    await loader.start()
    assert.deepEqual(probes().at(-1)!.config, { v: 'v1', w: 'deep-v1', shared: 1 })

    // 子模块改值且新增导出：旧实现下入口拿到缓存里的旧 pack.ts，新导出直接找不到
    writeFileSync(join(dir, 'pack.ts'), `export const v = 'v2'\nexport const added = true\n`)
    writeFileSync(join(dir, 'index.ts'), `import { v, added } from './pack.ts'
import { w } from './sub/deep.ts'
import { shared } from '../../shared.ts'
export default {
  name: 'multi',
  apply() {
    globalThis.__probe.push({ name: 'multi', config: { v, w, shared, added } })
  },
}
`)
    await loader.reload('multi')
    assert.deepEqual(probes().at(-1)!.config, { v: 'v2', w: 'deep-v2', shared: 1, added: true })
    assert.equal(g.__sharedEvals, 1, '插件目录外的模块只求值一次')
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('热重载：版本号只在插件根之内传播', () => {
  const entry = 'file:///p/plugins/official/x/index.ts?mumu-v=3&mumu-d=0'
  assert.equal(withVersion(entry, 'file:///p/plugins/official/x/pack.ts'), 'file:///p/plugins/official/x/pack.ts?mumu-v=3&mumu-d=0')
  assert.equal(withVersion(entry, 'file:///p/plugins/official/x/a/b.ts'), 'file:///p/plugins/official/x/a/b.ts?mumu-v=3&mumu-d=1')
  // 深一层的模块 ../ 回插件根仍在根内；再往上就出界
  const deep = 'file:///p/plugins/official/x/a/b.ts?mumu-v=3&mumu-d=1'
  assert.equal(withVersion(deep, 'file:///p/plugins/official/x/pack.ts'), 'file:///p/plugins/official/x/pack.ts?mumu-v=3&mumu-d=0')
  assert.equal(withVersion(deep, 'file:///p/plugins/official/y/index.ts'), undefined, '别的插件')
  assert.equal(withVersion(entry, 'file:///p/src/index.ts'), undefined, '内核与公共 API')
  assert.equal(withVersion(entry, 'file:///p/plugins/official/x/node_modules/dep/i.js'), undefined, '插件自己的依赖')
  assert.equal(withVersion('file:///p/plugins/official/x/index.ts', 'file:///p/plugins/official/x/pack.ts'), undefined, '父模块没带版本号')
})

/** 写一个插件目录；index 是入口源码 */
function writePlugin(root: string, rel: string, index: string, pkg: Record<string, unknown> = {}): void {
  const dir = join(root, rel)
  mkdirSync(dir, { recursive: true })
  const id = rel.split('/').pop()!
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: id, main: 'index.ts', ...pkg }))
  writeFileSync(join(dir, 'index.ts'), index)
}

test('配置服务自己被重载后，/config set 照样触发重载；整份覆盖 plugins.<id> 也触发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-cfgsvc-'))
  // 一个最小的「存储」插件：提供 config 服务，每次装上都是新实例（和 storage-sqlite 一样）
  writePlugin(root, 'official/store', `export default {
  name: 'store',
  apply(ctx) {
    globalThis.__cfgStore ??= {}
    const listeners = new Set()
    ctx.provide('config', {
      get(path) { let v = globalThis.__cfgStore; for (const k of path.split('.')) v = v?.[k]; return v },
      set(path, value) {
        const keys = path.split('.'); let cur = globalThis.__cfgStore
        for (const k of keys.slice(0, -1)) cur = cur[k] ??= {}
        cur[keys.at(-1)] = value
        for (const fn of listeners) fn(path)
      },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    })
  },
}
`, { mumu: { order: -100 } })
  writePlugin(root, 'official/alpha', PROBE.replaceAll('%NAME%', '"alpha"'))
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    ;(globalThis as any).__cfgStore = {}
    probes().length = 0
    await loader.start()
    await loader.reload('store') // 配置服务换了新实例
    const before = probes().length
    mumu.container.get<ConfigService>('config').set('plugins.alpha.v', 1)
    await until(() => probes().length > before)
    assert.equal(probes().length, before + 1, '新实例上的改动也要触发 alpha 重载')
    mumu.container.get<ConfigService>('config').set('plugins.alpha', { v: 2 })
    await until(() => probes().at(-1)!.config.v === 2)
    assert.equal(probes().at(-1)!.config.v, 2, '整份覆盖也要重载，并拿到新值')
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('失败隔离：坏插件只跳过它并记下原因，启动照常', async () => {
  const root = fixture({ 'official/alpha': {} })
  writePlugin(root, 'user/broken', 'export default { name: "broken", apply() { throw new Error("我坏了") } }\n')
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    probes().length = 0
    await loader.start()
    assert.deepEqual(probes().map(p => p.name), ['alpha'])
    const broken = loader.list().find(p => p.id === 'broken')!
    assert.equal(broken.loaded, false)
    assert.match(broken.error ?? '', /我坏了/)
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('scan：运行中新出现的插件目录不重启就装上，修好的坏插件再试一次', async () => {
  const root = fixture({ 'official/alpha': {} })
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    probes().length = 0
    await loader.start()
    writePlugin(root, 'user/fresh', PROBE.replaceAll('%NAME%', '"fresh"'))
    writePlugin(root, 'user/oops', 'export default { name: "oops", apply() { throw new Error("第一版有错") } }\n')
    const r1 = await loader.scan()
    assert.deepEqual(r1.added.sort(), ['fresh', 'oops'])
    assert.deepEqual(r1.loaded, ['fresh'])
    assert.equal(r1.failed[0]?.id, 'oops')
    assert.match(r1.failed[0].error, /第一版有错/)
    assert.deepEqual(probes().map(p => p.name), ['alpha', 'fresh'])

    writePlugin(root, 'user/oops', PROBE.replaceAll('%NAME%', '"oops"'))
    const r2 = await loader.scan()
    assert.deepEqual(r2, { added: [], loaded: ['oops'], failed: [] }, '已登记的不重复加，修好的再试')
    assert.equal(loader.list().find(p => p.id === 'oops')!.error, undefined)
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('重载服务提供者：注入它的插件一并重载，拿到新服务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-deps-'))
  writePlugin(root, 'official/store', `export default {
  name: 'store',
  apply(ctx) {
    globalThis.__gen = (globalThis.__gen ?? 0) + 1
    ctx.provide('store', { gen: globalThis.__gen })
  },
}
`, { mumu: { order: -10 } })
  writePlugin(root, 'official/user', `export default {
  name: 'user',
  inject: ['store'],
  apply(ctx) {
    globalThis.__probe ??= []
    globalThis.__probe.push({ name: 'user', config: { gen: ctx.use('store').gen } })
  },
}
`)
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    probes().length = 0
    ;(globalThis as any).__gen = 0
    await loader.start()
    assert.deepEqual(probes().map(p => p.config.gen), [1])
    await loader.reload('store')
    assert.deepEqual(probes().map(p => p.config.gen), [1, 2], '依赖者随提供者重载，拿到的是新服务')
    assert.equal(loader.list().find(p => p.id === 'user')!.loaded, true)
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('重载时重读清单：改了 package.json 的 defaults 不必重启', async () => {
  const t = await boot({ 'official/alpha': { defaults: { v: 1 } } })
  try {
    const dir = join(t.root, 'official', 'alpha')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'alpha', main: 'index.ts', mumu: { defaults: { v: 2 } } }))
    await t.loader.reload('alpha')
    assert.equal(probes().at(-1)!.config.v, 2)
  }
  finally { await t.dispose() }
})

test('文件指纹：内容没变的监视事件不算变更（SMB 挂载、杀毒扫描会报这种）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-print-'))
  try {
    writeFileSync(join(root, 'index.ts'), 'a')
    mkdirSync(join(root, 'sub'))
    const prints = new DirFingerprint(root)
    assert.equal(prints.changed('index.ts'), false, '只是被访问')
    assert.equal(prints.changed('sub'), false, '目录自身')
    assert.equal(prints.changed('.DS_Store'), false, '点开头的文件')
    assert.equal(prints.changed(join('node_modules', 'x.js')), false)
    writeFileSync(join(root, 'index.ts'), 'abc')
    assert.equal(prints.changed('index.ts'), true, '内容变了')
    assert.equal(prints.changed('index.ts'), false, '同一次变更只算一次')
    writeFileSync(join(root, 'sub', 'new.ts'), 'x')
    assert.equal(prints.changed(join('sub', 'new.ts')), true, '新文件')
    rmSync(join(root, 'sub', 'new.ts'))
    assert.equal(prints.changed(join('sub', 'new.ts')), true, '删掉')
    assert.equal(prints.changed('ghost.ts'), false, '本来就没有的文件')
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('重载：重扫清单失败不悄悄沿用旧清单——记进 list().error、这次不重载，插件照旧跑旧代码', async () => {
  const t = await boot({ 'official/alpha': { defaults: { v: 1 } } })
  try {
    // 另一个目录也叫 alpha：重扫时 id 冲突大声失败
    writePlugin(t.root, 'user/alpha', PROBE.replaceAll('%NAME%', '"alpha"'))
    await assert.rejects(t.loader.reload('alpha'), /duplicate plugin id/)
    const alpha = t.loader.list().find(p => p.id === 'alpha')!
    assert.equal(alpha.loaded, true, '没卸：旧代码照旧跑')
    assert.match(alpha.error ?? '', /duplicate plugin id/)
    assert.equal(probes().length, 1, '没有重新装')

    rmSync(join(t.root, 'user', 'alpha'), { recursive: true, force: true })
    await t.loader.reload('alpha')
    assert.equal(t.loader.list().find(p => p.id === 'alpha')!.error, undefined, '修好后重载成功，毛病清掉')
    assert.equal(probes().length, 2)
  }
  finally { await t.dispose() }
})

test('失败口径一处：装上了但 inject 的服务还没有，list().error 说的和 scan() 是同一句', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-waiting-'))
  writePlugin(root, 'official/user', 'export default { name: "user", inject: ["nothing"], apply() {} }\n')
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    await loader.start()
    const user = loader.list().find(p => p.id === 'user')!
    assert.equal(user.loaded, true)
    assert.match(user.error ?? '', /waiting for services: nothing/)

    writePlugin(root, 'official/giver', 'export default { name: "giver", apply(ctx) { ctx.provide("nothing", {}) } }\n')
    const r = await loader.scan()
    assert.deepEqual(r, { added: ['giver'], loaded: ['giver'], failed: [] })
    assert.equal(loader.list().find(p => p.id === 'user')!.error, undefined, '依赖到了就没毛病了')
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

const STORE_OK = 'export default { name: "store", apply(ctx) { ctx.provide("store", {}) } }\n'
const USER = 'export default { name: "user", inject: ["store"], apply(ctx) { globalThis.__probe ??= []; globalThis.__probe.push({ name: "user", config: {} }); ctx.provide("userSvc", {}) } }\n'

test('提供者重载失败：依赖者挂回等待队列、list() 看得见在等什么；提供者修好后自动装回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-provider-'))
  writePlugin(root, 'official/store', STORE_OK, { mumu: { order: -10 } })
  writePlugin(root, 'official/user', USER)
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    probes().length = 0
    await loader.start()
    writePlugin(root, 'official/store', 'export default { name: "store", apply() { throw new Error("改坏了") } }\n', { mumu: { order: -10 } })
    await assert.rejects(loader.reload('store'), /改坏了/)
    const user = loader.list().find(p => p.id === 'user')!
    assert.equal(user.loaded, true)
    assert.match(user.error ?? '', /waiting for services: store/)
    assert.equal(mumu.container.has('userSvc'), false, '旧的已卸下，不攥着关掉的服务')

    writePlugin(root, 'official/store', STORE_OK, { mumu: { order: -10 } })
    await loader.reload('store')
    assert.equal(loader.list().find(p => p.id === 'user')!.error, undefined)
    assert.equal(probes().filter(p => p.name === 'user').length, 2, '提供者回来，依赖者自动装回')
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('停用提供者：依赖者一并卸下挂回等待队列，再启用自动装回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-disable-'))
  writePlugin(root, 'official/store', STORE_OK, { mumu: { order: -10 } })
  writePlugin(root, 'official/user', USER)
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    probes().length = 0
    await loader.start()
    await loader.setEnabled('store', false)
    assert.equal(mumu.container.has('userSvc'), false)
    assert.match(loader.list().find(p => p.id === 'user')!.error ?? '', /waiting for services: store/)
    await loader.setEnabled('store', true)
    assert.equal(mumu.container.has('userSvc'), true)
    assert.equal(probes().filter(p => p.name === 'user').length, 2)
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('等依赖的插件 apply 抛错：错记在它自己头上（plugin.failed），触发激活的那个照常，改好后能重试', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-waiter-'))
  writePlugin(root, 'official/a', 'export default { name: "a", inject: ["web"], apply() { throw new Error("a 坏了") } }\n')
  writePlugin(root, 'official/b', 'export default { name: "b", apply(ctx) { ctx.provide("web", {}) } }\n', { mumu: { order: 10 } })
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    await loader.start()
    const by = (id: string) => loader.list().find(p => p.id === id)!
    assert.deepEqual([by('b').loaded, by('b').error], [true, undefined])
    assert.equal(by('a').loaded, false)
    assert.match(by('a').error ?? '', /a 坏了/)
    assert.ok(mumu.log.events.some(e => e.type === 'plugin.failed' && e.data.name === 'a'))
    mumu.assertReady()

    writePlugin(root, 'official/a', PROBE.replaceAll('%NAME%', '"a"'))
    const r = await loader.scan()
    assert.deepEqual(r, { added: [], loaded: ['a'], failed: [] })
    assert.deepEqual([by('a').loaded, by('a').error], [true, undefined])
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('并发重载串行执行，不报「已加载」的假失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mumu-serial-'))
  writePlugin(root, 'official/slow', 'export default { name: "slow", async apply() { await new Promise(r => setTimeout(r, 50)) } }\n')
  const mumu = Mumu.create()
  const loader = new PluginLoader(mumu, { dir: root, watch: false })
  try {
    await loader.start()
    await Promise.all([loader.reload('slow'), loader.reload('slow')])
    assert.deepEqual([loader.list()[0].loaded, loader.list()[0].error], [true, undefined])
  }
  finally {
    loader.stop()
    await mumu.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
