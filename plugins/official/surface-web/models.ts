/**
 * /api/models：provider-openai 角色绑定（模型路由）的合并视图与整表写入。契约见 docs/web-protocol.md §3。
 *
 * 立场：
 * - 与 persona.ts 同一条路：只认 provider-openai 的配置形状（见该插件 README），不认它的实现；
 *   写进 config 服务，装配层按既有规则重载 provider-openai。
 * - 界面编辑的是「想要的完整 roles」，落库前用 diffPatch 算出相对出厂的最小补丁：
 *   改回出厂值的项自动从库里消失，「恢复默认」就是把出厂值原样提交。
 * - 只收白名单字段且逐项校验：写错一个字段名会让某个角色悄悄退回 default，宁可当场 400。
 * - 不收 apiKey：密钥只存在 secrets 里，配置里只写名字（apiKeyRef）。
 * - 整个端点在本文件内处理完，index.ts 只挂一个分支（网页其他功能也在改 index.ts，少碰为好）。
 */
import type { ConfigService } from '../../../src/index.ts'
import { diffPatch, mergePatch, scanPlugins } from '../../../src/index.ts'
import type { SecretsService } from '../secrets/index.ts'

export interface Binding {
  provider?: string
  baseURL?: string
  model?: string
  apiKeyRef?: string
  fallback?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  responseFormat?: 'json' | 'text'
}

/** 界面上的一键填充：surface-web 配置 modelPresets 里给出，不进 provider */
export type Preset = Binding & { name: string }

export interface ModelsView {
  roles: Record<string, Binding> // 合并后的角色绑定；没写的项由 provider 从 default 继承
  defaults: Record<string, Binding> // 出厂值，「恢复默认」用
  keys: string[] // 已存的密钥名（只有名字）
  presets: Preset[]
}

const PROVIDER = 'provider-openai'
const PATH = `plugins.${PROVIDER}.roles`

type Rule = (v: unknown) => string | undefined
const text: Rule = v => typeof v === 'string' && v.trim() ? undefined : '要非空字符串'
const RULES: Record<keyof Binding, Rule> = {
  provider: text,
  model: text,
  apiKeyRef: text,
  fallback: text,
  baseURL: v => typeof v === 'string' && /^https?:\/\/\S+$/.test(v) ? undefined : '要 http(s):// 开头的地址',
  temperature: v => typeof v === 'number' && v >= 0 && v <= 2 ? undefined : '要 0～2 的数',
  maxTokens: v => Number.isInteger(v) && (v as number) > 0 ? undefined : '要正整数',
  timeoutMs: v => Number.isInteger(v) && (v as number) >= 0 ? undefined : '要非负整数（毫秒）',
  responseFormat: v => v === 'json' || v === 'text' ? undefined : '只能是 json 或 text',
}

/** provider-openai 清单里的 roles；没装返回 undefined。现扫 plugins/（与装配层同一个根），不是热路径 */
async function providerDefaults(): Promise<Record<string, Binding> | undefined> {
  const m = (await scanPlugins('plugins')).find(m => m.id === PROVIDER)
  return m ? (m.defaults?.roles ?? {}) as Record<string, Binding> : undefined
}

/** 请求体 → 完整 roles；形状不对抛错说清哪一项，调用方回 400，什么都不写 */
export function parseRoles(body: Record<string, unknown>): Record<string, Binding> {
  const roles = body.roles
  if (!roles || typeof roles !== 'object' || Array.isArray(roles))
    throw new Error('roles 必须是 { 角色名: 绑定 }')
  const out: Record<string, Binding> = {}
  for (const [role, b] of Object.entries(roles as Record<string, unknown>)) {
    if (!/^[\w.-]+$/.test(role))
      throw new Error(`角色名「${role}」只能用字母、数字、点、横线、下划线`)
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new Error(`${role} 必须是对象`)
    for (const [k, v] of Object.entries(b)) {
      if (k === 'apiKey')
        throw new Error(`${role}.apiKey：密钥别写进配置，用 /secret set <名字> <key>，这里填 apiKeyRef`)
      const rule = RULES[k as keyof Binding]
      if (!rule)
        throw new Error(`${role}.${k}：不认识的字段`)
      const bad = rule(v)
      if (bad)
        throw new Error(`${role}.${k}：${bad}`)
    }
    out[role] = b as Binding
  }
  if (!out.default?.model || !out.default.baseURL)
    throw new Error('default 必须有 baseURL 和 model：别的角色没写的项都从它继承')
  for (const [role, b] of Object.entries(out)) {
    if (b.fallback !== undefined && (b.fallback === role || !(b.fallback in out)))
      throw new Error(`${role}.fallback：要指向另一个已有的角色`)
  }
  return out
}

/**
 * 端点处理器：GET 读，POST 写完再读。返回状态码与 JSON 体，失败体为 { error }。
 * secrets 是可选服务：没装就不列密钥名，界面照样能用。
 */
export function modelsApi(ctx: { use: <T>(key: string) => T }, presets: Preset[] = []) {
  const config = ctx.use<ConfigService>('config')
  const keyNames = (): string[] => {
    try {
      return ctx.use<SecretsService>('secrets').list().map(k => k.name)
    }
    catch {
      return [] // 没装 secrets 插件：只是少了下拉提示
    }
  }

  async function read(): Promise<{ status: number, body: ModelsView | { error: string } }> {
    const defaults = await providerDefaults()
    if (!defaults)
      return { status: 404, body: { error: '没装 provider-openai 插件' } }
    const roles = mergePatch(defaults, config.get(PATH) ?? {}) as Record<string, Binding>
    return { status: 200, body: { roles, defaults, keys: keyNames(), presets } }
  }

  return async (method: string, body?: Record<string, unknown>): Promise<{ status: number, body: unknown }> => {
    if (method === 'GET')
      return read()
    if (method !== 'POST')
      return { status: 404, body: { error: '没有这个接口' } }
    let roles
    try {
      roles = parseRoles(body ?? {})
    }
    catch (e) {
      return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } }
    }
    // 只写 roles 这一个路径：provider-openai 恰好重载一次
    config.set(PATH, diffPatch(await providerDefaults() ?? {}, roles) ?? {})
    return read()
  }
}
