/**
 * OpenAI 兼容 provider：适配 DeepSeek、OpenAI 及任何 /v1/chat/completions 端点。
 *
 * 立场：
 * - 角色绑定由本插件自行持有，装配层与内核都不认识 roles。
 * - 密钥不在配置里：绑定只写 `apiKeyRef`，每次请求向 secrets 取值，改密钥不用重载。
 * - 取不到密钥不让插件加载失败（否则整个角色都起不来），而是让请求失败并打印完整的修复命令。
 * - fallback 只救「还没出字」的失败（连不上 / 超时 / 5xx）：已经吐出去的字收不回来，
 *   中途断流照常报错；4xx 是配置问题，换端点只会掩盖它，也不重试。
 *
 * 内核的 RoleBinding 只有固定字段；本插件需要的额外绑定项（apiKeyRef、responseFormat、fallback、timeoutMs）
 * 随配置对象一起进入 `model.bind`，resolve 时经对象展开原样带回，这里再读出来。
 *
 * 消息上的插件层字段 `images`（原图附件：媒体目录里的文件名）在发请求时才转成多模态 content，见 images.ts。
 */
import type { ChatMessage, Plugin, RoleBinding, StreamChunk } from '../../../src/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import type { StatusCard } from '../surface-web/index.ts'
import { resolve } from 'node:path'
import { DsmlFilter } from './dsml.ts'
import type { DsmlDrop } from './dsml.ts'
import type { ImageMessage, WireMessage } from './images.ts'
import { hasImages, toWire, withoutImages } from './images.ts'
import { routeCard } from './status.ts'

/** 本插件在 RoleBinding 之外认识的绑定项 */
interface Extras {
  apiKeyRef?: string
  responseFormat?: 'json' | 'text'
  /** 本绑定失败时改用哪个角色的端点重试一次 */
  fallback?: string
  /** 等到首个响应块的上限；配了 fallback 才默认启用，免得给不需要的绑定加限时 */
  timeoutMs?: number
  /** 角色名：绑定时由本插件填入，只用于日志（provider 收到的是解析后的绑定，看不到角色） */
  role?: string
}

interface OpenAIConfig {
  roles?: Record<string, Partial<RoleBinding> & Extras> // default 为所有角色的基底
  probe?: string[] // 状态页额外探活的端点（没有角色在用也探，如本地 4090）
  mediaDir?: string // 消息附件 images 里的文件名相对哪个目录（与 surface-onebot / surface-web 的媒体目录同一处）
}

export type { ImageAttachment, ImageMessage } from './images.ts'

type Binding = RoleBinding & Extras

/**
 * 配了 fallback 而没写 timeoutMs 时的首块等待上限。本地引擎同网下几百毫秒出首块；
 * 引擎停了而机器还在时，防火墙静默丢包，连接只能靠这个限时发现——有备胎就别久等。
 */
const FALLBACK_TIMEOUT_MS = 5_000

/** 换端点能救的失败；其余错误原样抛给调用方 */
class RetryableError extends Error {}
/** 端点明确拒了这次请求（4xx）：换端点救不了，但去掉原图可能就行 */
class RejectedError extends Error {}

const plugin: Plugin<OpenAIConfig> = {
  name: 'provider-openai',
  inject: ['secrets'],
  apply(ctx, cfg = {}) {
    const secrets = ctx.use<SecretsService>('secrets')
    const roles = cfg.roles ?? {}
    const mediaDir = resolve(cfg.mediaDir ?? 'data/media')

    for (const [role, b] of Object.entries(roles)) {
      if (b.fallback && !(b.fallback in roles))
        console.warn(`[provider-openai] 角色 ${role} 的 fallback「${b.fallback}」不在 roles 里，失败时会退到 default`)
    }

    /**
     * fallback 角色只换「去哪算」（端点、模型、密钥、限时），温度、长度、JSON 模式仍按原角色：
     * 发言退到 default 时不该丢掉发言自己的 temperature / maxTokens。
     */
    function fallbackBinding(from: Binding): Binding {
      const to = ctx.model.resolve(from.fallback!) as Binding
      if (to.provider !== 'openai')
        throw new Error(`fallback 角色 ${from.fallback} 的 provider 是 ${to.provider}，本插件只能接 openai`)
      return {
        ...from,
        baseURL: to.baseURL,
        model: to.model,
        apiKey: to.apiKey,
        apiKeyRef: to.apiKeyRef,
        timeoutMs: to.timeoutMs,
        fallback: undefined, // 只重试一次，不沿链往下找
      }
    }

    async function* stream(binding: Binding, original: ChatMessage[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
      const messages = toWire(original as ImageMessage[], mediaDir)
      const onDsml = (d: DsmlDrop): void => {
        ctx.log.append('provider.dsml-dropped', { role: binding.role, model: binding.model, ...d })
      }
      let started = false
      try {
        for await (const c of chat(resolveKey(binding, secrets), messages, signal, onDsml)) {
          started = true
          yield c
        }
        return
      }
      catch (e) {
        // 带了原图被端点拒（4xx）：同一个端点退回纯文字再来一次（images.ts 的 withoutImages），记一笔让人看得见
        if (!started && !signal?.aborted && e instanceof RejectedError && hasImages(original as ImageMessage[])) {
          ctx.log.append('provider.images-refused', { role: binding.role, model: binding.model, error: e.message })
          console.warn(`[provider-openai] ${binding.model} 不收这次的图（${e.message}），改用文字描述重试`)
          yield* stream(binding, withoutImages(original as ImageMessage[]), signal)
          return
        }
        if (started || signal?.aborted || !binding.fallback || !(e instanceof RetryableError))
          throw e
        const next = fallbackBinding(binding)
        const reason = e.message
        ctx.log.append('model.fallback', {
          from: { model: binding.model, baseURL: binding.baseURL },
          to: { role: binding.fallback, model: next.model, baseURL: next.baseURL },
          reason,
        })
        console.warn(`[provider-openai] ${binding.model} 不可用（${reason}），改用 ${binding.fallback} 的 ${next.model} 重试`)
        yield* chat(resolveKey(next, secrets), messages, signal, onDsml)
      }
    }

    ctx.effect(() => ctx.model.registerProvider({
      name: 'openai',
      stream: req => stream(req.binding as Binding, req.messages, req.signal),
    }))

    for (const [role, binding] of Object.entries(roles)) {
      // 额外项随对象一起进网关、resolve 时原样带回（见文件头）；role 由这里填，日志用
      const bound: Partial<RoleBinding> & Extras = { provider: 'openai', ...binding, role }
      ctx.effect(() => ctx.model.bind(role, bound))
    }

    // 网页「状态」页：每个角色现在走哪、各端点通不通（没装 surface-web 时这条水线没人调，无害）
    ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
      const bindings = Object.fromEntries(Object.keys(roles).map(r => [r, ctx.model.resolve(r) as Binding]))
      s.cards.push(await routeCard(bindings, secrets, cfg.probe))
      return next()
    })
  },
}

export default plugin

/** 密钥在请求时解析；缺失时抛出带修复命令的错误，调用方（动作）会把它回报给主大脑 */
function resolveKey(binding: Binding, secrets: SecretsService): Binding {
  if (binding.apiKey)
    return binding
  const ref = binding.apiKeyRef
  const key = ref ? secrets.get(ref) : undefined
  if (!key) {
    throw new Error(ref
      ? `缺少密钥「${ref}」。在终端执行：/secret set ${ref} <你的 API key>`
      : '角色绑定既没有 apiKey 也没有 apiKeyRef，检查 plugins.provider-openai.roles.default')
  }
  return { ...binding, apiKey: key }
}

async function* chat(
  binding: Binding,
  messages: WireMessage[],
  signal?: AbortSignal,
  onDsml?: (d: DsmlDrop) => void,
): AsyncGenerator<StreamChunk> {
  const base = (binding.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const timeoutMs = binding.timeoutMs ?? (binding.fallback ? FALLBACK_TIMEOUT_MS : 0)
  const timer = new AbortController()
  const t = timeoutMs > 0 ? setTimeout(() => timer.abort(), timeoutMs) : undefined
  const sig = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal
  /** 打断不算错误；限时到了算可重试的失败 */
  const failure = (what: string, e: unknown): Error | undefined => {
    if (signal?.aborted)
      return undefined
    if (timer.signal.aborted)
      return new RetryableError(`${timeoutMs}ms 内没有响应`)
    return new RetryableError(`${what}：${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`)
  }

  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${binding.apiKey}`,
      },
      body: JSON.stringify({
        model: binding.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(binding.temperature !== undefined ? { temperature: binding.temperature } : {}),
        ...(binding.maxTokens ? { max_tokens: binding.maxTokens } : {}),
        ...(binding.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: sig,
    })
  }
  catch (e) {
    clearTimeout(t)
    const err = failure('连不上', e)
    if (err)
      throw err
    return
  }
  if (!res.ok) {
    clearTimeout(t)
    const msg = `模型请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`
    throw res.status >= 500 ? new RetryableError(msg) : new RejectedError(msg)
  }
  if (!res.body) {
    clearTimeout(t)
    throw new Error('模型响应没有 body')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const dsml = new DsmlFilter() // 正文里漏出的 DeepSeek 工具调用标记不给下游（见 dsml.ts）
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      clearTimeout(t) // 首块到了就不再限时：之后的慢是生成慢，不是端点挂了
      if (done)
        break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      // eslint-disable-next-line no-cond-assign
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:'))
          continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          const rest = dsml.end()
          if (rest)
            yield { type: 'text', text: rest }
          yield { type: 'done' }
          return
        }
        try {
          const obj = JSON.parse(data)
          const delta = obj.choices?.[0]?.delta?.content
          const text = typeof delta === 'string' && delta ? dsml.push(delta) : ''
          if (text)
            yield { type: 'text', text }
          if (obj.usage) {
            yield {
              type: 'usage',
              prompt: obj.usage.prompt_tokens ?? 0,
              completion: obj.usage.completion_tokens ?? 0,
            }
          }
        }
        catch {
          // 坏帧（半截 JSON、心跳注释）跳过，流继续；SSE 一帧坏不代表整段坏
        }
      }
    }
    const rest = dsml.end() // 端点没发 [DONE] 就关了流：留着的尾巴照样结清
    if (rest)
      yield { type: 'text', text: rest }
  }
  catch (e) {
    const err = failure('读流中断', e)
    if (err)
      throw err // 打断时静默收尾
  }
  finally {
    clearTimeout(t)
    const dropped = dsml.report
    if (dropped)
      onDsml?.(dropped) // 每个请求记一条，打断、断流也算
    reader.releaseLock()
    if (sig.aborted)
      await res.body.cancel().catch(() => {})
  }
}
