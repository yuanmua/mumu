# @mumu/provider-openai

**是什么**：OpenAI 兼容的模型适配器。DeepSeek、OpenAI、任何提供 `/v1/chat/completions` 流式接口的本地端点都能用。

**暴露什么**

- provider `openai`，注册到内核模型网关。
- 角色绑定（`roles`）：`default` 是所有角色的基底，其余在其上覆盖——`mind.decide`（导演）、`performer`（导演发起的回复）、`performer.reflex`（反射回复）、`performer.deep`（认真答）、`task.agent`（电脑任务）、`vision.read`（看图）。插件要新角色（如 `memory.summarize`）就在配置里加一项。
- 网页「状态」页的「模型路由」卡（`status.ts`，认领 `web/status` 水线）：每个角色现在走哪个模型 / 端点、有没有 fallback，
  各端点现场探活（`GET <baseURL>/models`，3 秒限时）。端点不通但用它的角色都有退路 → 黄；有角色不通又没退路 → 红。
  配置 `probe`（默认本地 4090）列出没有角色在用也要探的端点：全走 API 时也能看出「全走本地」此刻能不能切，它们不影响卡片颜色。
- 网页「设置」里本插件显示为 `mumu.title`；`mumu.ui` 给每个角色字段写好了人话标签（温度是滑块、JSON 模式与「失败改用」是下拉）。
  角色名带点，`ui` 的键里写成 `roles.mind\\.decide.temperature`（协议 §7）。逐个角色套预设、一键全本地 / 全 API 用聊天页「模型」面板更顺手。
  `apiKeyRef` 不遮挡：它只是密钥的名字，密钥本身在 secrets 里，从不进配置。

**密钥**：绑定里只有 `apiKeyRef: "deepseek"` 这个**名字**。第一次运行前在终端执行：

```
/secret set deepseek sk-你的key
```

没设密钥时插件照常加载，模型请求会失败并把这条命令打印出来；主大脑会以「动作出错」的形式知道这件事。

**绑定项**（`roles.<角色>` 下可写）：`baseURL` · `model` · `temperature` · `maxTokens` · `apiKeyRef` · `responseFormat: "json" | "text"`（JSON 模式，导演用；端点不支持就写 `"text"`，mind-default 的 extractJson 能容忍代码围栏） · `fallback` · `timeoutMs`。

**fallback（本地挂了退回云端）**：`fallback: "<另一个角色>"`。本绑定的请求**还没出字就失败**时——连不上、`timeoutMs` 内没等到首个响应块、HTTP 5xx——
改用那个角色的绑定重试**一次**，并在会话日志记一条 `model.fallback`（`from` / `to` / `reason`，调试页事件流可见），终端打印一行。

- 只换「去哪算」：`baseURL` / `model` / `apiKey(Ref)` / `timeoutMs` 取自 fallback 角色；`temperature` / `maxTokens` / `responseFormat` 仍按原角色。
- 不重试的情形：4xx（配置错了，换端点只会掩盖它；带原图被拒的另有一次去图重试，见下）、已经出过字后断流（说出去的收不回）、调用方打断。
- 不沿链：fallback 角色自己的 `fallback` 不再生效。
- `timeoutMs` 只限「等首块」，首块到了之后不再限时；配了 `fallback` 而没写时默认 5 秒，没配 `fallback` 的绑定不限时（与以前一样）。
  本地引擎停了而机器还开着时，对端防火墙静默丢包、不回拒绝，只能靠这个限时发现，所以那一句会晚 5 秒左右。
- 不记「上次失败」去跳过本地端点（那是 handbook §5.7 禁止的全局可变态）：每个请求各自试一次本地、各自 fallback。
- 日志里的 `model.request` / `model.response` 仍记原绑定的模型名，紧挨着的 `model.fallback` 说明实际是谁答的。

**原图附件（`images.ts`）**：要带原图的调用方（发言者、大脑，选图由 surface-onebot 的服务 `images` 做）在消息对象上挂插件层字段
`images: [{ media, bytes, mime?, alt?, label? }]`（类型 `ImageMessage` / `ImageAttachment` 随本插件 `index.ts` 导出，消费方只 `import type`），`content` 仍是字符串。

- 内核不动：`ChatMessage.content` 是字符串（冻结契约 `ProviderAdapter` 用它），网关把消息对象原样转发、原样记进 `model.request`。
  所以日志里只有文件名和字节数（这次带了几张、多少字节一眼看得出），没有 base64——同一张图每拍都带，base64 落日志一天就是几百 MB。
  `mediaDir`（默认 `data/media`，与 surface-onebot / surface-web 同一处）按内容摘要命名、不覆盖，凭文件名就还原得出模型看到的那张（I1）。
- 发请求时才读文件、转成 OpenAI 多模态 content：`[文字, (label 文字,) image_url(data:…;base64), …]`，图紧跟在那条消息的文字后面。
  `label`（如「[图片1]」）在图前插一段文字，给一条消息里有好几张、要分清哪张是哪张的调用方用（大脑的【最近对话】是一整段）。
- 文件读不到（被清理了）：那张退回文字「[图片：alt]」，请求照发。
- 端点拒收（4xx：绑了不认图的模型、某张图它不吃）：同一端点去掉原图、附件换回描述再来一次，记 `provider.images-refused { role, model, error }`。
  不退的话那张图还在「最近几张」里的十几分钟，她每次开口都失败。
- 别的调用方直接传 `content` 数组（surface-onebot 看图、stickers 审核、action-search / action-computer 的 look）照旧原样转发，不受影响。
- 能力实测（2026-10-23，黑猫 + 一行字的图，问颜色和字）：DeepSeek `deepseek-chat` 与本地 4090 `qwen3.8-27b` 都答对（不带图时都在瞎编），
  多轮、图在较早那轮 user 里也认得。每张图的 prompt token：DeepSeek 1024×768 约 500、512×384 约 200；qwen 1024×768 约 770。
  时延：DeepSeek 整次 0.7–1.3 秒，与纯文字在同一抖动范围内；qwen 带图 0.33–0.36 秒（首块 26–41ms）。所以三个带图的角色都启用，没有要关的。
- 单测：`test/inline-images.test.ts`。

**DSML 过滤（`dsml.ts`）**：deepseek-chat 在上下文「像要调工具」时（电脑任务的工具循环、对话里说要去搜 / 去操作电脑），
即使请求**没带 `tools` 字段**（本插件从不带），也会把它原生的工具调用格式直接写进正文：`<｜｜DSML｜｜ calls>…</｜｜DSML｜｜ calls>`。
本项目没有任何地方按 DSML 取工具调用（各动作都用自己的 JSON / marker 协议），所以流式输出层对所有角色统一吞掉：

- 开始标记起整段吞到对应的结束标记（按嵌套深度；流结束还没闭合的吞到底）；孤立的结束标记只吞标记本身。
- 全角 / 半角竖线、标记里的空格都认；被切在两个 chunk 之间也认（可疑尾巴留到下一块再判，超过 256 字凑不成标记就按文本放行）。
- 别的尖括号与内核 `<|track:body|>` marker 原样放行；不用正则（handbook §9.2）。
- 每个吞过东西的请求记一条日志事件 `provider.dsml-dropped { role, model, chars, sample }`，调试页事件流里可搜，便于统计哪个角色在漏。
- 单测：`test/dsml.test.ts`（各种切法、孤立结束标记、半角写法、端到端经 SSE 帧）。

**怎么改它**（配置库是打在 defaults 上的 merge patch，见 handbook §8：只写要改的那几个键，其余默认保留）

- 换模型 / 换端点：`/config set plugins.provider-openai.roles.default.model deepseek-reasoner`，插件自动重载。
- 某个角色走本地、挂了退云端：
  ```
  /secret set local x
  /config set plugins.provider-openai.roles.performer {"baseURL":"http://127.0.0.1:8091/v1","model":"qwen3.8-27b","apiKeyRef":"local","fallback":"default"}
  ```
  只写端点几项即可，该角色的 `temperature` / `maxTokens` 仍取 package.json 里的默认。
- 把某项改回默认：`/config set` 写回 package.json 里的值（目前没有「删掉库里这一项」的命令）。
  写 `null` 是**删掉**它（连默认一起），不是恢复默认。
- 导演与发言用不同模型：给 `roles.mind.decide` 加 `model` / `baseURL` / `apiKeyRef`。
- 换协议（Anthropic、Gemini）：写一个新 provider 插件注册另一个 provider 名，角色绑定 `provider` 字段指过去。
