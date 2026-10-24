/**
 * /api/persona 的读写：persona 插件配置的合并视图与补丁校验。契约见 docs/web-protocol.md §3。
 *
 * 立场：
 * - 本插件不认识 persona 的实现，只认它的配置形状（plugins/official/persona/README.md）。
 *   写入走 config 服务，由装配层按既有规则重载 persona——和 /character use 是同一条路。
 * - 「合并后」与装配层同一规则：清单 defaults 被配置库 plugins.persona 覆盖，
 *   这样网页上看到的就是她此刻实际拿到的，而不是只看配置库里那半截。
 * - 不经 /config set 拼字符串：人设里常有引号与换行，命令行转义不可靠。
 */
import type { ConfigService } from '../../../src/index.ts'
import { mergePatch, scanPlugins } from '../../../src/index.ts'

export interface PersonaView {
  name: string
  prompt: string
  style: string
  rules: string | null // null = 用 persona 内置的「要求」；'' = 不要这一段
  markers: Record<string, string[]>
  aliases: Record<string, string> // 各平台网名：{ 平台: 网名 }
}

const PERSONA = 'persona'
const PATH = `plugins.${PERSONA}`

/**
 * persona 的清单默认值；没装 persona 返回 undefined。
 * 扫工作目录下的 plugins/：装配层（src/main.ts 的 PluginLoader 默认目录）扫的就是它，两边才对得上。
 * 每次读都重扫：清单改了不用重启也能看到，代价是读几十个小 JSON，这个接口不是热路径。
 */
async function personaDefaults(): Promise<Record<string, unknown> | undefined> {
  const m = (await scanPlugins('plugins')).find(m => m.id === PERSONA)
  return m ? (m.defaults ?? {}) : undefined
}

function cleanWords(words: unknown, what: string): string[] {
  if (!Array.isArray(words) || words.some(w => typeof w !== 'string'))
    throw new Error(`${what} 必须是字符串数组`)
  return [...new Set((words as string[]).map(w => w.trim()).filter(Boolean))]
}

function parseMarkers(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('markers 必须是 { 通道: [词…] }')
  const out: Record<string, string[]> = {}
  for (const [track, words] of Object.entries(v as Record<string, unknown>)) {
    const list = cleanWords(words, `markers.${track}`)
    if (list.length) // 空通道不落库：persona 对空数组本来也什么都不做
      out[track] = list
  }
  return out
}

function parseAliases(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('aliases 必须是 { 平台: 网名 }')
  const out: Record<string, string> = {}
  for (const [platform, handle] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[a-z][\w-]{0,31}$/.test(platform))
      throw new Error(`aliases 的平台名「${platform}」只许小写字母开头的字母数字`)
    if (typeof handle !== 'string')
      throw new Error(`aliases.${platform} 必须是字符串`)
    if (handle.trim()) // 空网名 = 这个平台不要网名
      out[platform] = handle.trim()
  }
  return out
}

function view(c: Record<string, unknown>): PersonaView {
  let markers: Record<string, string[]> = {}
  try {
    markers = c.markers === undefined ? {} : parseMarkers(c.markers)
  }
  catch {
    // 配置库里的 markers 形状坏了（手写 /config set 写错）：读视图给空，不让整个面板打不开
  }
  let aliases: Record<string, string> = {}
  try {
    aliases = c.aliases === undefined || c.aliases === null ? {} : parseAliases(c.aliases)
  }
  catch {
    // 同上：形状坏了给空
  }
  return {
    name: typeof c.name === 'string' ? c.name : '',
    prompt: typeof c.prompt === 'string' ? c.prompt : '',
    style: typeof c.style === 'string' ? c.style : '',
    rules: typeof c.rules === 'string' ? c.rules : null,
    markers,
    aliases,
  }
}

export async function readPersona(config: ConfigService): Promise<PersonaView | undefined> {
  const defaults = await personaDefaults()
  if (!defaults)
    return undefined
  return view(mergePatch(defaults, config.get(PATH) ?? {}) as Record<string, unknown>)
}

/** 请求体 → 补丁；形状不对抛错说清哪一项，调用方回 400，什么都不写 */
export function parsePersonaPatch(body: Record<string, unknown>): Partial<PersonaView> {
  const out: Partial<PersonaView> = {}
  for (const k of ['name', 'prompt'] as const) {
    const v = body[k]
    if (v === undefined)
      continue
    if (typeof v !== 'string' || !v.trim())
      throw new Error(`${k} 必须是非空字符串`)
    out[k] = v.trim()
  }
  if (body.style !== undefined) {
    if (typeof body.style !== 'string')
      throw new Error('style 必须是字符串')
    out.style = body.style.trim()
  }
  if (body.rules !== undefined) {
    if (body.rules !== null && typeof body.rules !== 'string')
      throw new Error('rules 必须是字符串或 null')
    out.rules = body.rules === null ? null : body.rules.trim()
  }
  if (body.markers !== undefined)
    out.markers = parseMarkers(body.markers)
  if (body.aliases !== undefined)
    out.aliases = parseAliases(body.aliases)
  return out
}

/**
 * 写入并触发 persona 恰好一次重载：先整棵写（顶层路径不触发重载），再写一个改到的叶子。
 * 逐个叶子写会触发多次并发重载，装配层的 unload/load 会互相打架（characters 插件同一个坑）。
 *
 * 库里存的是 merge patch（见 src/loader/merge.ts）：`rules: null` 删掉自定义、回到内置「要求」；
 * 面板上去掉的表情通道写成 `null`，否则清单默认里的同名通道会合并回来。
 */
export function writePersona(config: ConfigService, patch: Partial<PersonaView>, current: PersonaView): void {
  const keys = Object.keys(patch) as (keyof PersonaView)[]
  if (!keys.length)
    return
  const prev = config.get<Record<string, unknown>>(PATH) ?? {}
  const stored: Record<string, unknown> = { ...patch }
  // markers / aliases 是按键合并的对象：面板上删掉的键要写成 null，否则清单默认里的同名键会合并回来；
  // 库里已有的删除标记也要留着
  for (const k of ['markers', 'aliases'] as const) {
    const want = patch[k]
    if (!want)
      continue
    const prevObj = prev[k]
    const prevKeys = typeof prevObj === 'object' && prevObj ? Object.keys(prevObj) : []
    const removed = [...new Set([...Object.keys(current[k]), ...prevKeys])].filter(t => !(t in want))
    stored[k] = { ...want, ...Object.fromEntries(removed.map(t => [t, null])) }
  }
  const next = { ...prev, ...stored }
  config.set(PATH, next)
  config.set(`${PATH}.${keys[0]}`, next[keys[0]])
}
