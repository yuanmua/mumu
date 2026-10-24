/**
 * 本机 CPU 上算句向量（semantic.ts 的 via local 后端）：transformers.js 跑 ONNX 小模型，不依赖 4090、不依赖网络
 * （优先在本地 CPU 上算 embedding，虚拟机自己算）。
 *
 * - 模型第一次用时从 remoteHost（默认 hf-mirror.com，国内直连）下载到 cacheDir（默认 data/models/，不进 git），之后离线加载。
 * - 插件装上就在后台加载（预热 Semantic.warm 第一次 embed 时触发），加载完之前 ready() 为 false，打分直接 0（不让第一句群消息等下载）。
 * - 加载失败（没网、包没装上）不抛给调用方：一分钟后再试，期间打分都是 0；错误交给 onError 记日志。
 * - 依赖动态 import：没装 @huggingface/transformers 时插件照样加载，只是兴趣分恒为 0。
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import type { Vec } from './semantic.ts'

export interface LocalConfig {
  model: string // 如 Xenova/bge-base-zh-v1.5
  dtype: string // q8 = 8 位量化（小、快，效果和 fp32 差不多）
  pooling: 'cls' | 'mean' | 'last_token' // bge 用 cls，e5 / jina 用 mean，Qwen3-Embedding 用 last_token
  cacheDir: string
  remoteHost: string
}

const RETRY_MS = 60_000

export function localBackend(cfg: LocalConfig, onError: (e: unknown) => void): { embed: (text: string) => Promise<Vec>, ready: () => boolean, dispose: () => Promise<void> } {
  let pipe: FeatureExtractionPipeline | undefined
  let loading: Promise<FeatureExtractionPipeline> | undefined
  let failedAt = 0
  let disposed = false

  const load = (): Promise<FeatureExtractionPipeline> => loading ??= (async () => {
    const t = await import('@huggingface/transformers')
    t.env.cacheDir = cfg.cacheDir
    t.env.remoteHost = cfg.remoteHost
    const p = await t.pipeline('feature-extraction', cfg.model, { dtype: cfg.dtype as 'q8' })
    if (disposed) {
      await p.dispose()
      throw new Error('插件已卸载')
    }
    pipe = p
    return p
  })().catch((e: unknown) => {
    loading = undefined
    failedAt = Date.now()
    if (!disposed)
      onError(e)
    throw e
  })

  return {
    ready: () => {
      if (pipe)
        return true
      if (!loading && Date.now() - failedAt > RETRY_MS)
        load().catch(() => {}) // 错误已经在 load 里交给 onError 了，这里只是别让它变成未处理的拒绝
      return false
    },
    embed: async (text) => {
      const p = pipe ?? await load()
      const out = await p(text, { pooling: cfg.pooling, normalize: true })
      return out.data as Float32Array
    },
    dispose: async () => {
      disposed = true
      await pipe?.dispose()
      pipe = undefined
    },
  }
}
