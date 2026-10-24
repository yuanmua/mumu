/**
 * 测试数据整体隔离、换一个干净环境（2026-10-22，接真 QQ 之前用）。不删任何东西，全部挪进一个归档。
 *
 * 用法（在 C:\mumu 下，先停后端）：
 *   node scripts/fresh-env.cjs --dry-run     # 只列清单，什么都不动
 *   node scripts/fresh-env.cjs               # 真做（后端还在跑会拒绝）
 *   node scripts/fresh-env.cjs --web-only main   # 网页频道只留 main（c:* 测试对话的摘要、事实不带）
 *   --root <目录>                            # 对别的目录做（自测用：拷一份 data/ plugins/user/ 过去跑；此时不查后端）
 *
 * 做什么（归档名 test-archive-<时间>）：
 * 1. 整库归档：VACUUM INTO data/backups/test-archive-<时间>.db（全部测试事件、记忆，留着以后对比）。
 * 2. 新建干净的 data/mumu.db：表结构照旧，带过去的只有——
 *    - config、secrets 原样（persona、网名、guard owners、模型路由、NapCat 配置；密钥）；
 *    - 记忆里只留主人：mem_people 里主人那一条（guard.owners 里的 id、网页用户 web:*、以及 memory.aliases 把它们连起来的别名；
 *      含私下印象），它身上来源不是网页频道的事实去掉；mem_episodes / mem_groups / mem_cursor 只留网页频道（main、c:*；
 *      加 --web-only main 就只留 main）的；
 *    - events 清空（网页对话记录不用留）。
 *    旧库文件（含 -wal / -shm）挪到归档目录 data/backups/test-archive-<时间>/db/，不删。
 * 3. 文件：data/stickers 的表情包（全是测试期收的，她在真群里从零开始收）、data/media 的图（测试期收发的图、截图；
 *    配置里引用到的留下）、plugins/user 下她测试时给自己装的插件，都挪到归档目录下同名子目录。
 */
'use strict'
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

// 到这一刻真 QQ 还没登录过：qq:* 全是模拟器 / 压测造的；网页频道（main、c:*）的记忆留给主人
const args = process.argv.slice(2)
const dry = args.includes('--dry-run')
// --web-only main（可多次 / 逗号分隔）：只留这几个网页频道，c:* 那些测试对话不带
const webOnly = args.flatMap((a, i) => (a === '--web-only' && args[i + 1] ? args[i + 1].split(',') : []))
const isWebChannel = ch => (webOnly.length ? webOnly.includes(ch) : ch === 'main' || (typeof ch === 'string' && ch.startsWith('c:')))
const rootArg = args[args.indexOf('--root') + 1]
const root = args.includes('--root') && rootArg ? path.resolve(rootArg) : process.cwd()
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const name = `test-archive-${stamp}`
const dataDir = path.join(root, 'data')
const archiveDb = path.join(dataDir, 'backups', `${name}.db`)
const archiveDir = path.join(dataDir, 'backups', name)
const KEEP_TABLES = ['config', 'secrets']

function backendUp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3939/api/meta', { timeout: 1500 }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

const listFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name) : [])
const kb = bytes => `${Math.round(bytes / 1024)} KB`
const sizeOf = files => files.reduce((n, f) => n + fs.statSync(f).size, 0)

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
}

async function main() {
  if (!dry && !args.includes('--root') && await backendUp()) {
    console.error('后端还在跑（3939 有响应）：先停掉再做，否则它会接着往旧库写。只想看清单就加 --dry-run。')
    process.exit(1)
  }
  const dbFile = path.join(dataDir, 'mumu.db')
  if (!fs.existsSync(dbFile)) {
    console.error(`找不到 ${dbFile}`)
    process.exit(1)
  }
  console.log(`${dry ? '【只列清单，不动】' : '【真做】'} 归档名 ${name}（${root}）`)

  // ── 1. 库 ──
  const db = new DatabaseSync(dbFile)
  const schema = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC`).all()
  const tables = schema.filter(s => s.type === 'table').map(s => s.name)
  console.log('\n1. 库：整库归档后新建空库，只带 config / secrets')
  for (const t of tables) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
    console.log(`   ${t.padEnd(14)} ${String(n).padStart(6)} 行 → ${KEEP_TABLES.includes(t) ? '原样带过去' : t.startsWith('mem_') ? '只留主人 / 网页频道的（见下）' : '清空（归档里留着）'}`)
  }
  const config = db.prepare('SELECT key, value FROM config ORDER BY key').all()
  const secrets = db.prepare('SELECT name FROM secrets ORDER BY name').all()
  for (const r of config) {
    let inner = ''
    try {
      const v = JSON.parse(r.value)
      if (v && typeof v === 'object' && !Array.isArray(v))
        inner = `（${Object.keys(v).join('、')}）`
    }
    catch {}
    console.log(`   带过去的配置：${r.key}${inner}`)
  }
  console.log(`   带过去的密钥（只列名字）：${secrets.map(r => r.name).join('、')}`)
  // 配置里还挂着测试痕迹的，列出来让人决定（脚本不改配置）
  const ownerIds = (() => {
    try {
      return JSON.parse(config.find(r => r.key === 'plugins')?.value ?? '{}').guard?.owners ?? []
    }
    catch {
      return []
    }
  })()
  const TRACE = /qq:(?:group:|private:)?\d+|c:extend-test|c:probe|c:br-check/
  for (const r of config) {
    let entries = [[r.key, r.value]]
    try {
      const v = JSON.parse(r.value)
      if (v && typeof v === 'object' && !Array.isArray(v))
        entries = Object.entries(v).map(([k, x]) => [`${r.key}.${k}`, JSON.stringify(x)])
    }
    catch {}
    for (const [k, text] of entries) {
      if (k.endsWith('.guard'))
        continue // 主人的 QQ 号就该在这
      const m = TRACE.exec(ownerIds.reduce((t, id) => t.replaceAll(id, ''), text)) // 主人的 QQ 号（guard.owners、memory.aliases 里）就该在
      if (m)
        console.log(`   注意：${k} 里像有测试期的频道 / 人：…${text.slice(Math.max(0, m.index - 40), m.index + 60)}…`)
    }
  }
  const configText = config.map(r => r.value).join('\n')

  // ── 记忆：只留主人 ──
  const plugins = (() => {
    try {
      return JSON.parse(config.find(r => r.key === 'plugins')?.value ?? '{}')
    }
    catch {
      return {}
    }
  })()
  const owners = new Set(plugins.guard?.owners ?? [])
  const aliases = plugins.memory?.aliases ?? {}
  const has = t => tables.includes(t)
  const people = has('mem_people') ? db.prepare('SELECT id, name, facts, impression, private_impression FROM mem_people').all() : []
  const keepIds = new Set(people.filter(p => owners.has(p.id) || p.id.startsWith('web:')).map(p => p.id))
  for (const [from, to] of Object.entries(aliases)) {
    if (keepIds.has(to) || owners.has(to) || keepIds.has(from) || owners.has(from)) {
      keepIds.add(from)
      keepIds.add(to)
    }
  }
  const keepPeople = people.filter(p => keepIds.has(p.id)).map((p) => {
    const facts = JSON.parse(p.facts || '[]')
    return { ...p, keepFacts: facts.filter(f => isWebChannel(f.channel)), dropFacts: facts.filter(f => !isWebChannel(f.channel)) }
  })
  const webRows = (t) => {
    if (!has(t))
      return []
    return db.prepare(`SELECT channel FROM "${t}"`).all().filter(r => isWebChannel(r.channel))
  }
  const keepEpisodes = webRows('mem_episodes')
  const keepGroups = webRows('mem_groups')
  const keepCursor = webRows('mem_cursor')
  const byChannel = rows => [...rows.reduce((m, r) => m.set(r.channel, (m.get(r.channel) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join('、')
  console.log(`\n   记忆只留主人${webOnly.length ? `，网页频道只留 ${webOnly.join('、')}` : ''}：主人 id ${[...owners].join('、') || '（guard.owners 为空）'}，memory.aliases ${Object.keys(aliases).length} 条`)
  console.log(`   mem_people 留 ${keepPeople.length} / ${people.length}：${keepPeople.map(p => `${p.id}「${p.name}」事实 ${p.keepFacts.length} 条、公开印象 ${p.impression.length} 字、私下印象 ${(p.private_impression ?? '').length} 字`).join('；') || '（没有）'}`)
  for (const p of keepPeople) {
    console.log(`     公开印象：${p.impression || '（空）'}`)
    console.log(`     私下印象：${p.private_impression || '（空）'}`)
    for (const f of p.keepFacts) console.log(`     留：[${f.channel}] ${f.text.slice(0, 70)}`)
    for (const f of p.dropFacts) console.log(`     去掉：[${f.channel}] ${f.text.slice(0, 70)}`)
  }
  if (owners.size && ![...owners].some(id => keepIds.has(id)))
    console.log(`   注意：主人的 QQ（${[...owners].join('、')}）在记忆里还没有人物，也没有别名连到网页主人；要让 QQ 里的主人认得网页里的记忆，配 memory.aliases：{"${[...owners][0]}": "${[...keepIds].find(id => id.startsWith('web:')) ?? 'web:web-user'}"}`)
  console.log(`   mem_episodes 留 ${keepEpisodes.length}：${byChannel(keepEpisodes) || '（没有）'}`)
  console.log(`   mem_groups 留 ${keepGroups.length}${keepGroups.length ? `：${byChannel(keepGroups)}` : ''}；mem_cursor 留 ${keepCursor.length}${keepCursor.length ? `：${byChannel(keepCursor)}` : ''}`)

  // ── 2. 表情包 ──
  const stickerDir = path.join(dataDir, 'stickers')
  const indexFile = path.join(stickerDir, 'index.json')
  let stickers = []
  if (fs.existsSync(indexFile))
    stickers = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const testStickers = stickers
  const listed = new Set(stickers.map(s => s.file))
  const strays = listFiles(stickerDir).filter(f => f !== 'index.json' && !listed.has(f)) // 索引里没有的文件（删过条目留下的）
  console.log(`\n2. 表情包：库里 ${stickers.length} 张，全部挪走（测试期收的，真群里从零开始）${strays.length ? `，另有 ${strays.length} 个索引外的文件一起挪` : ''}`)
  if (testStickers.length)
    console.log(`   ${testStickers.slice(0, 12).map(s => s.desc).join('、')}${testStickers.length > 12 ? '…' : ''}`)

  // ── 3. 图片 ──
  const mediaDir = path.join(dataDir, 'media')
  const media = listFiles(mediaDir)
  const keepMedia = media.filter(f => configText.includes(f))
  const moveMedia = media.filter(f => !keepMedia.includes(f))
  console.log(`\n3. 图片 data/media：${media.length} 个文件，挪走 ${moveMedia.length} 个（${kb(sizeOf(moveMedia.map(f => path.join(mediaDir, f))))}）${keepMedia.length ? `，配置里引用的留下：${keepMedia.join('、')}` : ''}`)

  // ── 4. 她装的插件 ──
  const userDir = path.join(root, 'plugins', 'user')
  const userPlugins = fs.existsSync(userDir) ? fs.readdirSync(userDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : []
  console.log(`\n4. 她给自己装的插件：挪走 ${userPlugins.length ? userPlugins.join('、') : '（没有）'}`)
  console.log(`\n归档：${path.relative(root, archiveDb)} + ${path.relative(root, archiveDir)}/{db,stickers,media,plugins-user}`)

  if (dry) {
    db.close()
    console.log('\n（--dry-run：什么都没动）')
    return
  }

  // 先归档整库；失败就什么都不做
  fs.mkdirSync(path.dirname(archiveDb), { recursive: true })
  db.exec(`VACUUM INTO '${archiveDb.replace(/'/g, '\'\'')}'`)
  db.close()
  const check = new DatabaseSync(archiveDb, { readOnly: true })
  const archived = check.prepare('SELECT COUNT(*) AS n FROM events').get().n
  check.close()
  console.log(`\n✓ 整库归档：${archiveDb}（events ${archived} 行）`)

  // 新库：同样的表结构，只灌 config / secrets
  const freshFile = path.join(dataDir, `mumu.fresh-${stamp}.db`)
  const fresh = new DatabaseSync(freshFile)
  fresh.exec('PRAGMA journal_mode = WAL')
  for (const s of schema) fresh.exec(s.sql)
  fresh.exec(`ATTACH DATABASE '${archiveDb.replace(/'/g, '\'\'')}' AS old`)
  for (const t of KEEP_TABLES.filter(t => tables.includes(t))) fresh.exec(`INSERT INTO main."${t}" SELECT * FROM old."${t}"`)
  // 主人的记忆：人物整行带过去（事实去掉 qq 测试频道来的），网页频道的摘要 / 群印象 / 进度
  const keepChannels = [...new Set([...keepEpisodes, ...keepGroups, ...keepCursor].map(r => r.channel))]
  const web = `channel IN (${keepChannels.map(c => `'${c.replace(/'/g, '\'\'')}'`).join(',') || "''"})`
  if (has('mem_people')) {
    const ids = [...keepIds]
    if (ids.length)
      fresh.prepare(`INSERT INTO main.mem_people SELECT * FROM old.mem_people WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
    for (const p of keepPeople) fresh.prepare('UPDATE main.mem_people SET facts = ? WHERE id = ?').run(JSON.stringify(p.keepFacts), p.id)
  }
  for (const t of ['mem_episodes', 'mem_groups', 'mem_cursor'].filter(has)) fresh.exec(`INSERT INTO main."${t}" SELECT * FROM old."${t}" WHERE ${web}`)
  fresh.exec('DETACH DATABASE old')
  const freshCounts = Object.fromEntries(tables.map(t => [t, fresh.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]))
  fresh.close()

  // 旧库文件挪进归档（不删），新库就位
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix))
      move(dbFile + suffix, path.join(archiveDir, 'db', `mumu.db${suffix}`))
  }
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(freshFile + suffix))
      fs.renameSync(freshFile + suffix, dbFile + suffix)
  }
  console.log(`✓ 新库 data/mumu.db：${Object.entries(freshCounts).map(([t, n]) => `${t} ${n}`).join('，')}`)

  for (const s of testStickers) {
    const f = path.join(stickerDir, s.file)
    if (fs.existsSync(f))
      move(f, path.join(archiveDir, 'stickers', s.file))
  }
  for (const f of strays) move(path.join(stickerDir, f), path.join(archiveDir, 'stickers', f))
  if (fs.existsSync(indexFile)) {
    fs.copyFileSync(indexFile, path.join(archiveDir, 'stickers', 'index.json'))
    fs.writeFileSync(indexFile, '[]\n')
  }
  console.log(`✓ 表情包挪走 ${testStickers.length + strays.length} 个文件`)

  for (const f of moveMedia) move(path.join(mediaDir, f), path.join(archiveDir, 'media', f))
  console.log(`✓ 图片挪走 ${moveMedia.length} 个`)

  for (const p of userPlugins) move(path.join(userDir, p), path.join(archiveDir, 'plugins-user', p))
  console.log(`✓ 插件挪走 ${userPlugins.length} 个`)
  console.log(`\n完成。要回到测试环境：停后端，把 ${path.relative(root, archiveDir)}/db/mumu.db* 挪回 data/，其余子目录挪回原处。`)
}

main().catch((e) => {
  console.error('✗ 出错，已停下：', e)
  process.exit(1)
})
