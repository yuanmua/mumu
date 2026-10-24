/**
 * 清掉模拟器 / 压测灌进正式实例的假数据（2026-10-21 测试期用）。
 *
 * 用法（在 C:\mumu 下，先停后端）：
 *   node scripts/clean-sim.cjs --dry-run              # 只列要删什么，什么都不动
 *   node scripts/clean-sim.cjs                        # 真删（后端还在跑会拒绝）
 *   node scripts/clean-sim.cjs --prefix qq: --prefix c:extend-test   # 自己指定频道前缀（默认见 DEFAULT_PREFIXES）
 *   --remove-plugin weather-report（可多次；默认只挪 weather-report）  --purge-files（连模拟器的图片、报告、语料一起删）
 *
 * 判定「假」的依据：到清理这一刻真 QQ 还没登录过，所以所有 qq:* 频道、qq:* 的人都是模拟器 / 压测造的；
 * 网页里只有测试时开的几个对话（c:extend-test*、c:br-check、c:web-chat-*）是假的，主人的其他网页对话不动。
 *
 * 删什么：
 * 1. events 表：频道是假的事件；按 id 关联的（utterance.part、action.ended）；内容里带假频道 id 的（导演请求 / 决定里列着假群）。
 * 2. mem_people：qq:* 的人整行删；剩下的人（主人）事实里来源是假频道的那几条删掉。
 *    mem_episodes / mem_groups / mem_cursor：来源是假频道的删。
 * 3. data/stickers：从假频道收来的表情包（index.json 的 from）连文件一起删。
 * 4. 她装的假数据插件：挪到 data/extend-trash/（不直接删，挪回来能恢复）。
 */
'use strict'
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const DEFAULT_PREFIXES = ['qq:', 'c:extend-test', 'c:br-check', 'c:web-chat-', 'c:probe-']
const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
const many = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []))
const prefixes = many('--prefix').length ? many('--prefix') : DEFAULT_PREFIXES
const plugins = many('--remove-plugin').length ? many('--remove-plugin') : ['weather-report']
const purge = args.includes('--purge-files')
const root = process.cwd()
const isFakeChannel = (ch) => typeof ch === 'string' && prefixes.some(p => ch.startsWith(p))
const isFakePerson = (id) => typeof id === 'string' && id.startsWith('qq:')

function backendUp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3939/api/meta', { timeout: 1500 }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function main() {
  if (!dry && await backendUp()) {
    console.error('后端还在跑（3939 有响应）：先停掉再清，否则内存里的日志会和库对不上。只想看清单就加 --dry-run。')
    process.exit(1)
  }
  console.log(`${dry ? '【只列清单，不动】' : '【真删】'} 假频道前缀：${prefixes.join('、')}`)
  const db = new DatabaseSync(path.join(root, 'data', 'mumu.db'))

  // ── 1. 事件 ──
  const rows = db.prepare('SELECT seq, type, data FROM events').all()
  const fakeIds = new Set()
  const fakeChannels = new Set()
  for (const r of rows) {
    const d = JSON.parse(r.data)
    if (isFakeChannel(d.channel)) {
      fakeChannels.add(d.channel)
      if (d.id)
        fakeIds.add(d.id)
      if (d.action)
        fakeIds.add(d.action)
    }
  }
  const delSeq = []
  const byType = new Map()
  for (const r of rows) {
    const d = JSON.parse(r.data)
    const hit = isFakeChannel(d.channel) || (d.id && fakeIds.has(d.id)) || [...fakeChannels].some(ch => r.data.includes(`"${ch}"`) || r.data.includes(`[${ch}]`))
    if (hit) {
      delSeq.push(r.seq)
      byType.set(r.type, (byType.get(r.type) ?? 0) + 1)
    }
  }
  console.log(`\n1. events：共 ${rows.length} 条，要删 ${delSeq.length} 条（${fakeChannels.size} 个假频道）`)
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${t}: ${n}`)

  // ── 2. 记忆 ──
  const hasMem = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'mem_people\'').get()
  let memPlan = { people: [], factFix: [], episodes: [], groups: [], cursors: [] }
  if (hasMem) {
    const people = db.prepare('SELECT id, name, facts FROM mem_people').all()
    memPlan.people = people.filter(p => isFakePerson(p.id))
    for (const p of people.filter(p => !isFakePerson(p.id))) {
      const facts = JSON.parse(p.facts || '[]')
      const bad = facts.filter(f => isFakeChannel(f.channel))
      if (bad.length)
        memPlan.factFix.push({ id: p.id, name: p.name, keep: facts.filter(f => !isFakeChannel(f.channel)), bad })
    }
    memPlan.episodes = db.prepare('SELECT id, channel, summary FROM mem_episodes').all().filter(e => isFakeChannel(e.channel))
    memPlan.groups = db.prepare('SELECT channel FROM mem_groups').all().filter(g => isFakeChannel(g.channel))
    memPlan.cursors = db.prepare('SELECT channel FROM mem_cursor').all().filter(c => isFakeChannel(c.channel))
    console.log(`\n2. 记忆：删 ${memPlan.people.length} 个假人（${memPlan.people.slice(0, 20).map(p => p.name).join('、')}${memPlan.people.length > 20 ? '…' : ''}）`)
    for (const f of memPlan.factFix) console.log(`   ${f.name}（${f.id}）删 ${f.bad.length} 条来自假频道的事实：${f.bad.map(b => b.text).slice(0, 5).join('；')}`)
    console.log(`   中期摘要删 ${memPlan.episodes.length} 段，群印象删 ${memPlan.groups.length} 个，整理进度删 ${memPlan.cursors.length} 条`)
    const owner = people.find(p => p.id === 'web:web-user')
    if (owner)
      console.log('   注意：主人的「印象」是整段文字，可能夹着测试期的事（加功能、骰子），脚本不改它；要清就在网页「记忆 · 人」点「清掉印象」')
  }

  // ── 3. 表情包 ──
  const stickerDir = path.join(root, 'data', 'stickers')
  const indexFile = path.join(stickerDir, 'index.json')
  let stickers = []
  let fakeStickers = []
  if (fs.existsSync(indexFile)) {
    stickers = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    fakeStickers = stickers.filter(s => isFakeChannel(s.from))
    console.log(`\n3. 表情包：库里 ${stickers.length} 张，删 ${fakeStickers.length} 张从假群收来的（${fakeStickers.slice(0, 10).map(s => s.desc).join('、')}${fakeStickers.length > 10 ? '…' : ''}）`)
  }

  // ── 4. 假数据插件 ──
  const userDir = path.join(root, 'plugins', 'user')
  const movePlugins = plugins.filter(p => fs.existsSync(path.join(userDir, p)))
  console.log(`\n4. 她装的插件：挪走 ${movePlugins.join('、') || '无'} 到 data/extend-trash/`)
  if (fs.existsSync(userDir)) {
    for (const p of fs.readdirSync(userDir).filter(p => !movePlugins.includes(p)))
      console.log(`   留着：${p}${p === 'bedtime-reminder' ? '（提醒发在测试对话 c:extend-test 里，主人看不到；要留就改 channel，不要就 --remove-plugin bedtime-reminder）' : ''}`)
  }
  const purgeDirs = ['data/sim-images', 'data/sim-reports', 'data/replay-reports', 'data/corpus'].filter(d => fs.existsSync(path.join(root, d)))
  console.log(`\n5. 模拟器文件：${purge ? `删 ${purgeDirs.join('、')}` : `留着 ${purgeDirs.join('、')}（加 --purge-files 一起删）`}`)

  if (dry) {
    console.log('\n（--dry-run：什么都没动）')
    return
  }

  // ── 真删 ── 先整库备份（规矩：任何清理前自动备份）
  const backupDir = path.join(root, 'data', 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const backupFile = path.join(backupDir, `mumu-${new Date().toISOString().replace(/[:.]/g, '-')}-clean-sim.db`)
  db.exec(`VACUUM INTO '${backupFile.replace(/'/g, '\'\'')}'`)
  console.log(`\n已备份整库到 ${backupFile}（表情包目录与插件目录是挪 / 删文件，备份前先看清单）`)
  db.exec('BEGIN')
  const del = db.prepare('DELETE FROM events WHERE seq = ?')
  for (const s of delSeq) del.run(s)
  if (hasMem) {
    for (const p of memPlan.people) db.prepare('DELETE FROM mem_people WHERE id = ?').run(p.id)
    for (const f of memPlan.factFix) db.prepare('UPDATE mem_people SET facts = ? WHERE id = ?').run(JSON.stringify(f.keep), f.id)
    for (const e of memPlan.episodes) db.prepare('DELETE FROM mem_episodes WHERE id = ?').run(e.id)
    for (const g of memPlan.groups) db.prepare('DELETE FROM mem_groups WHERE channel = ?').run(g.channel)
    for (const c of memPlan.cursors) db.prepare('DELETE FROM mem_cursor WHERE channel = ?').run(c.channel)
  }
  db.exec('COMMIT')
  db.close()
  if (fakeStickers.length) {
    for (const s of fakeStickers) fs.rmSync(path.join(stickerDir, s.file), { force: true })
    fs.writeFileSync(indexFile, `${JSON.stringify(stickers.filter(s => !isFakeChannel(s.from)), null, 1)}\n`)
  }
  if (movePlugins.length) {
    const trash = path.join(root, 'data', 'extend-trash')
    fs.mkdirSync(trash, { recursive: true })
    for (const p of movePlugins) fs.renameSync(path.join(userDir, p), path.join(trash, `${p}-${Date.now()}`))
  }
  if (purge) {
    for (const d of purgeDirs) fs.rmSync(path.join(root, d), { recursive: true, force: true })
  }
  console.log('\n清完了。重启后端生效。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
