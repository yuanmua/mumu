/**
 * 模型网关。内核不含 provider：插件声明角色（mind.decide / performer / …），
 * 配置把角色绑到 provider+model，绑定由装配层从配置库读入。
 *
 * 每次调用记账进日志，记到能直接当训练素材的程度：model.request 记完整输入与采样参数（不记密钥），
 * model.response 记模型原始输出（文本与 marker 按到达顺序）、用量、是否中断、provider 报的错。
 */
import type { Disposer } from '../core/container.ts'
import type { Part } from '../io/port.ts'
import type { SessionLog } from '../session/log.ts'
import type { StreamChunk } from './stream.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string // 文本；有 parts 时是它们的文字摘要，给只认文本的 provider 兜底
  parts?: Part[] // 多模态片段（图、音频…，本体按 ref 去 BlobStore 取）；provider 不认识就只用 content
}

/** model.response 里的原始输出：相邻文本合并，marker 原样保留位置 */
export type OutputPiece = { type: 'text', text: string } | { type: 'marker', track: string, body: string }

export interface RoleBinding {
  provider: string
  model: string
  baseURL?: string
  apiKey?: string // 配置存本地库，不走环境变量
  temperature?: number
  maxTokens?: number
}

export interface ModelRequest {
  role: string
  messages: ChatMessage[]
  signal?: AbortSignal
}

export interface ProviderAdapter {
  name: string
  stream: (req: { binding: RoleBinding, messages: ChatMessage[], signal?: AbortSignal }) => AsyncIterable<StreamChunk>
}

/** 逐 chunk 观察事件；不落日志，内容已被 model.request/response 覆盖 */
export interface ModelStreamEvent {
  reqId: string
  at: number
  chunk: StreamChunk
}

export class ModelGateway {
  private providers = new Map<string, ProviderAdapter>()
  private bindings = new Map<string, Partial<RoleBinding>>()

  constructor(
    private log: SessionLog,
    private hooks: { onStream?: (e: ModelStreamEvent) => void } = {},
  ) {}

  registerProvider(p: ProviderAdapter): Disposer {
    if (this.providers.has(p.name))
      throw new Error(`provider ${p.name} 已注册`)
    this.providers.set(p.name, p)
    return () => { this.providers.delete(p.name) }
  }

  /** 'default' 是所有角色的基底，具体角色在其上覆盖 */
  bind(role: string, binding: Partial<RoleBinding>): Disposer {
    this.bindings.set(role, binding)
    return () => { this.bindings.delete(role) }
  }

  resolve(role: string): RoleBinding {
    const merged = { ...this.bindings.get('default'), ...this.bindings.get(role) }
    if (!merged.provider || !merged.model)
      throw new Error(`角色 ${role} 没有完整的模型绑定（缺 provider/model，检查配置 roles.default）`)
    return merged as RoleBinding
  }

  /** 流式调用：记账 model.request / model.response，逐 chunk 走观察钩子 */
  async* stream(req: ModelRequest): AsyncGenerator<StreamChunk> {
    const binding = this.resolve(req.role)
    const provider = this.providers.get(binding.provider)
    if (!provider)
      throw new Error(`provider ${binding.provider} 未注册`)
    const { data: { reqId } } = this.log.appendNew('req', 'model.request', reqId => ({
      reqId,
      role: req.role,
      provider: binding.provider,
      model: binding.model,
      params: { temperature: binding.temperature, maxTokens: binding.maxTokens },
      messages: req.messages,
    }))
    let chars = 0
    let usage: { prompt: number, completion: number } | undefined
    let error: string | undefined
    const output: OutputPiece[] = []
    try {
      for await (const chunk of provider.stream({ binding, messages: req.messages, signal: req.signal })) {
        this.hooks.onStream?.({ reqId, at: Date.now(), chunk })
        if (chunk.type === 'usage') {
          usage = chunk
          continue
        }
        if (chunk.type === 'done')
          continue
        if (chunk.type === 'text') {
          chars += chunk.text.length
          const last = output.at(-1)
          if (last?.type === 'text')
            last.text += chunk.text
          else output.push({ type: 'text', text: chunk.text })
        }
        else {
          output.push({ type: 'marker', track: chunk.track, body: chunk.body })
        }
        yield chunk
      }
    }
    catch (e) {
      error = e instanceof Error ? e.message : String(e)
      throw e
    }
    finally {
      // 调用方中途不再读（break）也会走到这里：output 是模型实际吐出、已交给调用方的部分
      this.log.append('model.response', {
        reqId,
        role: req.role,
        model: binding.model,
        output,
        chars,
        usage,
        aborted: req.signal?.aborted ?? false,
        ...(error === undefined ? {} : { error }),
      })
    }
  }

  /** 收集完整文本，供决策类调用 */
  async complete(req: ModelRequest): Promise<string> {
    let text = ''
    for await (const c of this.stream(req)) {
      if (c.type === 'text')
        text += c.text
    }
    return text
  }
}
