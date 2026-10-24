/**
 * 语音合成服务：文本 → 音频。
 *
 * 立场：
 * - 密钥不能到浏览器，所以合成在服务端；前端只拿 text 换 audio。
 * - 只认 OpenAI 兼容的 /v1/audio/speech 协议（硅基流动、OpenAI、本地 GPT-SoVITS 网关都提供），
 *   换服务商改配置，不改代码。
 * - 没配密钥时服务存在但 ready() 为假，surface-web 据此告诉前端「语音不可用」，不报错。
 */
import type { Plugin } from '../../../src/index.ts'
import type { SecretsService } from '../secrets/index.ts'

export interface TtsService {
  ready: () => boolean
  synthesize: (text: string, opts?: { signal?: AbortSignal }) => Promise<{ mime: string, bytes: Uint8Array }>
}

interface TtsConfig {
  baseURL?: string
  model?: string
  voice?: string
  format?: 'mp3' | 'wav' | 'opus' | 'pcm'
  speed?: number
  apiKeyRef?: string
}

const MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', pcm: 'audio/pcm' }

const plugin: Plugin<TtsConfig> = {
  name: 'tts',
  inject: ['secrets'],
  apply(ctx, cfg = {}) {
    const secrets = ctx.use<SecretsService>('secrets')
    const base = (cfg.baseURL ?? '').replace(/\/$/, '')
    const format = cfg.format ?? 'mp3'
    const keyOf = (): string | undefined => cfg.apiKeyRef ? secrets.get(cfg.apiKeyRef) : undefined

    const service: TtsService = {
      ready: () => !!base && !!cfg.model && !!keyOf(),
      async synthesize(text, opts = {}) {
        const key = keyOf()
        if (!base || !cfg.model)
          throw new Error('tts 未配置 baseURL / model')
        if (!key)
          throw new Error(`缺少密钥「${cfg.apiKeyRef}」。在终端执行：/secret set ${cfg.apiKeyRef} <你的 API key>`)
        const res = await fetch(`${base}/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model: cfg.model,
            input: text,
            voice: cfg.voice,
            response_format: format,
            speed: cfg.speed ?? 1,
          }),
          signal: opts.signal,
        })
        if (!res.ok)
          throw new Error(`语音合成失败 ${res.status}: ${(await res.text()).slice(0, 200)}`)
        const mime = res.headers.get('content-type') ?? MIME[format] ?? 'application/octet-stream'
        return { mime, bytes: new Uint8Array(await res.arrayBuffer()) }
      },
    }
    ctx.provide('tts', service)
  },
}

export default plugin
