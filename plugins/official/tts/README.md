# @mumu/tts

**是什么**：语音合成服务。文本进、音频出，走 OpenAI 兼容的 `POST /v1/audio/speech`。

**暴露什么**：服务 `tts`

```ts
interface TtsService {
  ready(): boolean                                        // 配置 + 密钥都齐
  synthesize(text, { signal? }): Promise<{ mime, bytes }> // 一句话一段音频
}
```

`surface-web` 的 `GET /api/meta` 用 `ready()` 决定 `voice.available`，`POST /api/tts` 调 `synthesize`。

**默认服务商**：硅基流动（`https://api.siliconflow.cn/v1`，CosyVoice2）。第一次用前：

```
/secret set tts sk-你的硅基流动key
```

**换服务商**（都是改配置，自动重载）

| 服务商 | baseURL | model | voice |
|---|---|---|---|
| 硅基流动 | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` | `FunAudioLLM/CosyVoice2-0.5B:anna` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini-tts` | `alloy` |
| 本地（GPT-SoVITS 等 OpenAI 兼容网关） | `http://127.0.0.1:9880/v1` | 按网关 | 按网关 |

**怎么改它**：要用非 OpenAI 协议的服务商，写另一个插件 provide 同名 `tts` 服务，契约只有上面两个方法。流式合成（边生成边播）等音频接口统一后再做，前端已按「一句一段」排队播放。
