/**
 * 写插件：让 task.agent 角色按 handbook §7 的契约写一个用户插件，并在落盘前查护栏。
 *
 * 护栏（第一版，宁严勿松）：
 * - 只写 plugins/user/<name>/ 下的平铺文件：package.json、index.ts、README.md，外加至多几个同目录 .ts。
 * - 只许 import '../../../src/index.ts'（公共 API）；不许 require、动态 import、child_process / fs 之类。
 * - package.json 不许有任何依赖；mumu.id 必须是 name。
 * 模型输出 JSON 用 JSON.parse 读；代码检查是逐行看 import 语句，不靠正则理解模型的意思。
 */
import type { ChatMessage } from '../../../src/index.ts'

export interface Draft {
  files: Record<string, string>
  summary: string
}

const ALLOWED_IMPORT = '../../../src/index.ts'
const BANNED = ['require(', 'import(', 'child_process', 'node:fs', '\'fs\'', 'process.exit', 'eval(', 'new Function', 'plugins/official']

/** 给模型的速查：只写这里列出的 API，都从 src/index.ts 导入 */
const CHEATSHEET = `可用的 API（全部从 '${ALLOWED_IMPORT}' 导入，类型用 import type）：
- 插件形状：const plugin: Plugin<配置类型> = { name: '<id>', apply(ctx, cfg = {}) { … } }; export default plugin
- ctx.on(...)、ctx.intercept(...)、ctx.provide(...) 自己就会在卸载时撤销，直接调，不要再包 ctx.effect。
  其余要撤销的东西（定时器、ctx.prompt.section 返回的撤销函数）用 ctx.effect(() => 返回撤销函数)：
  ctx.effect(() => { const t = setInterval(f, ms); return () => clearInterval(t) })。ctx.effect 的回调必须返回一个函数。
- 让她知道一件事并开口：await ctx.io.percept({ kind: '<插件名>.<事>', channel: '频道', text: '发生了什么（自然语言）' })
  —— 这会唤醒她的「导演」，导演决定要不要说、怎么说。不要自己拼她要说的话，只描述事实。
  频道：网页默认对话是 'main'；QQ 群是 'qq:group:<群号>'，私聊 'qq:private:<QQ号>'。
- 看所有发生的事：ctx.on<LogEvent>('log.appended', (e) => { … })。别人说话是 e.type === 'percept.received'，
  e.data = { kind, channel, sender: { id, name }, text }；她说完话是 e.type === 'utterance.settled'，e.data = { channel, delivered }。
  在这里只做轻活；要她回应就调 ctx.io.percept（用 void 不等待），别在里面写日志循环。
- 给她（发言者）常驻一段提示：ctx.effect(() => ctx.prompt.section({ id: '<插件名>', audience: 'performer', order: PROMPT_ORDER.teaching, render: () => '一两句' }))
- 记一条日志：ctx.log.append('<插件名>.<事>', { … })
- 配置：package.json 的 mumu.defaults 就是 cfg 的默认值；时区用 'Asia/Shanghai'（Intl.DateTimeFormat）。
- 现在时间：new Date()；判断几点用 Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })。`

export function buildPrompt(o: { name: string, purpose: string, template: Record<string, string>, existing?: Record<string, string>, exports: string }): ChatMessage[] {
  const system = `你在给一个数字角色（她叫沐沐）写一个小插件，让她多一个功能。项目是 TypeScript + Node 22，ESM，插件只能用公共 API。

插件约定：
- 目录 plugins/user/${o.name}/，三个文件：package.json、index.ts、README.md（可以再加同目录的 .ts 子模块）。
- package.json：{"name":"@user/${o.name}","version":"0.1.0","private":true,"type":"module","main":"index.ts","description":"一句话","mumu":{"id":"${o.name}","enabled":true,"order":0,"description":"一句话说清做什么","defaults":{…可调的数都放这里…}}}。不许有 dependencies。
- index.ts：default 导出 Plugin。只许 import '${ALLOWED_IMPORT}'，不许 import 别的任何东西（包括 node 内置模块）。
- README.md：是什么 · 怎么触发 · 怎么改（配置键）。中文。
- 代码风格：单引号、无分号、两空格缩进；中文注释写为什么；不用 any；TypeScript 严格模式要能过。

${CHEATSHEET}

公共 API 导出的名字（只用这些）：
${o.exports}

参考一个最简单的官方插件（时间感 clock，注意它在 plugins/official/ 下，所以 import 路径同样是三层 ../）：
--- package.json ---
${o.template['package.json']}
--- index.ts ---
${o.template['index.ts']}

只输出一个 JSON 对象，不要代码块，不要解释：
{"files":{"package.json":"…","index.ts":"…","README.md":"…"},"summary":"一句话：加了什么、怎么触发（给她自己看，她会用自己的话转述）"}`
  const user = [
    `插件名：${o.name}`,
    `要做的功能：${o.purpose}`,
    o.existing ? `这个插件已经存在，下面是现在的代码，在它基础上改：\n${Object.entries(o.existing).map(([f, c]) => `--- ${f} ---\n${c}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export function parseDraft(text: string): Draft | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as { files?: unknown, summary?: unknown }
    if (!o.files || typeof o.files !== 'object')
      return undefined
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.files as Record<string, unknown>)) {
      if (typeof v === 'string')
        files[k] = v
    }
    return { files, summary: typeof o.summary === 'string' ? o.summary : '' }
  }
  catch {
    return undefined // 不是合法 JSON：调用方让模型重来
  }
}

/** 护栏：返回违反的条目（空 = 通过） */
export function audit(name: string, d: Draft): string[] {
  const bad: string[] = []
  for (const need of ['package.json', 'index.ts', 'README.md']) {
    if (!d.files[need])
      bad.push(`缺 ${need}`)
  }
  const ts = Object.keys(d.files).filter(f => f.endsWith('.ts'))
  for (const f of Object.keys(d.files)) {
    if (f.includes('/') || f.includes('\\') || f.startsWith('.') || !(f === 'package.json' || f === 'README.md' || f.endsWith('.ts')))
      bad.push(`不许写 ${f}（只能是同目录的 package.json / README.md / *.ts）`)
  }
  if (ts.length > 4)
    bad.push('.ts 文件太多（第一版最多 4 个）')
  try {
    const pkg = JSON.parse(d.files['package.json'] ?? '{}') as Record<string, any>
    if (pkg.mumu?.id !== name)
      bad.push(`package.json 的 mumu.id 必须是 ${name}`)
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkg[k] && Object.keys(pkg[k]).length)
        bad.push(`不许加依赖（${k}）`)
    }
    if (pkg.type !== 'module')
      bad.push('package.json 要有 "type": "module"')
  }
  catch {
    bad.push('package.json 不是合法 JSON')
  }
  for (const f of ts) {
    const code = d.files[f]
    for (const b of BANNED) {
      if (code.includes(b))
        bad.push(`${f} 里不许出现 ${b}`)
    }
    for (const spec of importSpecifiers(code)) {
      if (spec !== ALLOWED_IMPORT && !(spec.startsWith('./') && ts.includes(spec.slice(2))))
        bad.push(`${f} 不许 import '${spec}'（只能 import '${ALLOWED_IMPORT}' 和同目录的子模块）`)
    }
  }
  return bad
}

/** 逐行找 import / export … from 的模块名（引号里的部分） */
function importSpecifiers(code: string): string[] {
  const out: string[] = []
  const lines = code.split('\n').map(l => l.trim())
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.startsWith('import') && !l.startsWith('export'))
      continue
    // 多行 import：拼到出现 from 或引号为止
    const bare = (s: string): boolean => s.startsWith('import \'') || s.startsWith('import "') // import './x.ts'
    let stmt = l
    for (let j = i + 1; j < lines.length && !stmt.includes(' from ') && !bare(stmt) && j < i + 30; j++)
      stmt += ` ${lines[j]}`
    if (!stmt.includes(' from ') && !bare(stmt))
      continue
    const tail = stmt.includes(' from ') ? stmt.slice(stmt.lastIndexOf(' from ') + 6) : stmt.slice(6)
    const q = tail.trim()[0]
    if (q !== '\'' && q !== '"')
      continue
    const s = tail.trim().slice(1)
    out.push(s.slice(0, s.indexOf(q)))
  }
  return out
}
