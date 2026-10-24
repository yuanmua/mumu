# bench · 压测工具

**是什么**：给 `scripts/replay.ts`（真实语料回放压测）用的两个接口，平时可以 `/plugin disable bench`，不影响她。

| 接口 | 做什么 |
|---|---|
| `GET /api/bench/usage?since=&until=` | 从真源的 `model.request` / `model.response` 按模型角色统计：调用次数、被打断次数、输入 / 输出 token、耗时、用到的模型；另估「缓存命中」的输入 token（provider 的用量里没有命中数，按每个请求与最近 30 个请求的最长公共前缀占比估——DeepSeek 的缓存按前缀命中） |
| `POST /api/bench/judge` | 请求体 `{ items: [{ id, scene, context[], reply }] }`，`bench.judge` 角色当「老群友」给每条发言打 1～5 分、列翻车点（复读、客服腔、答非所问、太长太有条理、刷屏、不该插话、该说的没说、该收尾没收尾、话题结束后还追问、编造、人设崩、语气不对） |

命令 `/bench [分钟]`：最近 N 分钟各角色的用量。

| `GET /api/bench/thread?channel=&since=&until=` | 一个频道一段时间的对话行（她每句标上是谁起的：`reflex` / `mind` / `deep` / `append`）、渲染好的带秒数对话稿，和几个数：反射 / 导演 / 认真答 / 补充各几次、`appendAfterReflex`（补充紧跟在反射后面、中间对方没说话——多半是在重复反射）、完整说完 / 被打断 / 被打断时一个字没出、平均字数、回应率（`thread.ts`） |
| `POST /api/bench/judge-thread` | 请求体 `{ threads: [{ id, transcript }] }`，整段读一段私聊，打「像不像过了脑子的人」1～5 分，数逐条回、抢答、复读反问、答非所问、太浅、车轱辘、该收尾没收尾、语气不对各几次，摘最差 / 最好的原句。逐条打分看不出「每句都秒回、连着四句吐槽同一件事」，所以单列。裁判自己波动不小，`scripts/chat-replay.ts` 默认打 3 次取平均 |

**怎么改**：`judgeRole`（裁判用哪个模型角色，没绑就走 `default`）、`charsPerToken`（用量缺失时按字数粗估 token 的比例）。

**立场**：只读真源，不改任何东西；裁判自己的调用也落日志，统计时按角色名区分（`bench.judge` 单列，不算进她的花费）。
