/**
 * 「状态」页的模型路由卡：每个角色现在走哪个端点，各端点探活结果。
 *
 * 立场：
 * - 每次打开状态页现探（GET <baseURL>/models，3 秒限时、并发），不缓存「上次结果」：
 *   缓存就是 handbook §5.7 禁止的全局可变态，状态页也不是热路径。
 * - 级别按「她会不会哑」来定：某端点挂了但用它的角色都有 fallback → warn；有角色挂了又没退路 → err。
 */
import type { RoleBinding } from '../../../src/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import type { StatusCard } from '../surface-web/index.ts'

type Binding = RoleBinding & { apiKeyRef?: string, fallback?: string }

interface Probe { ok: boolean, text: string }

const PROBE_MS = 3000

async function probe(baseURL: string, key: string | undefined): Promise<Probe> {
  const t0 = Date.now()
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(PROBE_MS),
    })
    const ms = Date.now() - t0
    return res.ok ? { ok: true, text: `通 ${ms}ms` } : { ok: res.status < 500, text: `HTTP ${res.status} ${ms}ms` }
  }
  catch (e) {
    const why = e instanceof Error && e.name === 'TimeoutError' ? `${PROBE_MS / 1000} 秒没响应` : '连不上'
    return { ok: false, text: why }
  }
}

/**
 * extra：没有角色在用、但想知道通不通的端点（如本地 4090），方便判断「全走本地」此刻能不能切。
 * 它们只出现在探活行里，不影响卡片级别。
 */
export async function routeCard(bindings: Record<string, Binding>, secrets: SecretsService, extra: string[] = []): Promise<StatusCard> {
  const used = new Set(Object.values(bindings).map(b => b.baseURL).filter((u): u is string => !!u))
  const bases = [...new Set([...used, ...extra])]
  const results = new Map(await Promise.all(bases.map(async (u) => {
    const b = Object.values(bindings).find(x => x.baseURL === u)
    const key = b?.apiKey ?? (b?.apiKeyRef ? secrets.get(b.apiKeyRef) : undefined)
    return [u, await probe(u, key)] as const
  })))

  const down = (r: string): boolean => !results.get(bindings[r]?.baseURL ?? '')?.ok
  const mute = Object.keys(bindings).filter(r => down(r) && (!bindings[r].fallback || down(bindings[r].fallback!)))
  const shaky = Object.keys(bindings).filter(r => down(r) && !mute.includes(r))

  const host = (u?: string): string => u ? u.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '?'
  const items = [
    ...Object.entries(bindings).map(([r, b]) =>
      `${r}：${b.model} @ ${host(b.baseURL)}${b.fallback ? `，失败退 ${b.fallback}` : ''}${down(r) ? ' ⚠' : ''}`),
    ...bases.map(u => `探活 ${host(u)}：${results.get(u)!.text}${used.has(u) ? '' : '（暂无角色在用）'}`),
  ]
  const level = mute.length ? 'err' : shaky.length ? 'warn' : 'ok'
  const text = mute.length
    ? `${mute.join('、')} 的端点不通且没有可用的退路`
    : shaky.length
      ? `${shaky.join('、')} 的端点不通，正在退回 fallback`
      : `在用的 ${used.size} 个端点都通`
  return { id: 'model-routes', title: '模型路由', level, text, items }
}
