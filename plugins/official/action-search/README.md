# @mumu/action-search

**是什么**：`search` 动作——查资料、看新闻、找图直接调搜索 API，几秒就回，不再开她电脑上的浏览器（handbook §9.4「工具即动作」）。
以前她「上网搜」靠 `computer` 驱动身体服务开 Edge，几分钟才回、常失败（真群里搜图、查资料都走的那条）。

**参数**：`{ query: "关键词", kind?: "web" | "news" | "image", count?: 数字 }`

| kind | 来源（默认） | 结果 |
|---|---|---|
| `web`（缺省） | DeepSeek 官方 Search API | 每条：标题（站点 · 日期）、一句摘要、链接；默认 5 条，最多 10 |
| `news` | 同上，查询后面补 `after:<最近 newsDays 天>`（DeepSeek 的搜索语法），按发布时间从新到旧 | 同上 |
| `image` | 必应图片 + 360 图片搜索并行（DeepSeek 没有图片搜索；都不要密钥）；同时用 DeepSeek 网页搜索查一下这个词指什么 | 下载到本地目录的完整路径 + 图里是什么 + 来源站点 + 两行词义；默认 3 张，最多 6 |

不标「（需要主人）」：搜索只读、不碰她的电脑，谁请求都可以搜，guard 不拦。搜到的图发出去走 `image` 动作，规矩不变。

## 一次搜索怎么走

```
大脑 start search {query, kind}（通常同一拍 start reply 应一声「我搜搜」）
  └ runSearch（search.ts，永不抛错）
       web / news：取密钥（secrets 里 apiKeyRef，每次现取）→ POST endpoint {query, count} → 整理成一段人话
       image（images.ts）：几家图源并行（结果轮流取、去重；一家挂了用另一家）+ 同时网页搜一次词义 →
              候选并行下载（原图有防盗链就用缩略图）→ 按文件头认 png / jpg / gif / webp → 存进 dir（按内容摘要命名）→
              看图模型（vision.read）看要的两倍张数：一句话说图里是什么、和要找的对不对得上、能不能发群里（look.ts，JSON）
              → 不能发的扔掉；有对得上的就只留对得上的；一张都对不上（unfit）→ 别发，附上词义，叫大脑换个更准的词再搜一次
              → 看不了的按对得上处理、标「没看过」
  └ a.remember(结果 + 一句怎么用)            ← 发言者从「刚才发生的事」照着说，没写的不编
  └ 感知 search.result（带频道，唤醒大脑）    ← 同 dsh.result；data: { actionId, ok, kind, query, provider, elapsedMs, error?, hits? | images?, dropped?, unfit? }
大脑：查资料 / 新闻 → start reply（guidance 写要点）；找图 → start image {path: 结果里的路径} → 发完再 reply
```

失败（没关键词、没密钥、超时、401 / 402 / 429、连不上）都落成 `ok: false` 的结果，`text` 写清原因，她照实说一声。
action-reply 的 `resultKinds` 默认含 `search.result`：搜到之后那次带想法的发言就是「汇报」，围绕结果说，不去接群里别的闲话。
search 结束时内核还会唤醒大脑一次；结果那拍已经处理过的话，mind-default 的 `reported.ts` 把这次唤醒拿掉，免得同一批图再发一遍。

**为什么图片要两家 + 词义**：模拟器 2026-10-22 搜「可爱大肥鱼」，只用 360 时给的是王者荣耀的鲲、福娃抱鱼；
必应和 360 合起来、看图只留对得上的之后，至少是字面上的胖鱼。可「大肥鱼」在网上多指 DeepSeek 的蓝鲸少女形象，
看图只按字面判，群里到底说的哪个要她看上下文——所以结果里附两行词义，意思对不上就换词再搜。

## 教大脑 / 发言者的段落

| 段落 | 受众 | 说什么 |
|---|---|---|
| `search-teaching-mind` | mind | 查资料、新闻、要网上的图先 search，不用 computer；kind 怎么选；结果回来怎么接 reply / image；一般只发一张 |
| `search-teaching` | performer | 搜到的在「刚才发生的事」里，照那个说；还没回来别说「查到了」 |

动作描述（进大脑的动作目录）也写着「不用开电脑」「图接 image」。action-image、action-computer 的描述与 reflex 的「像要她做事」提示同步改成网上找图 / 查东西用 search。

## 配置（`mumu.defaults`，网页「设置」可改）

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `deepseek` | 网页 / 新闻来源（providers.ts `WEB_PROVIDERS` 的键） |
| `endpoint` | `""` | 接口地址；空 = 该来源默认（DeepSeek：`https://api.deepseek.com/v1/tools/search`） |
| `apiKeyRef` | `deepseek` | secrets 里密钥的名字。DeepSeek 搜索和对话用同一个密钥，默认直接复用；要单独一个就改名字再 `/secret set <名字> <key>` |
| `imageProviders` | `["bing", "so360"]` | 图片来源，几家并行（`IMAGE_PROVIDERS` 的键） |
| `count` / `imageCount` | 5 / 3 | 默认条数 |
| `timeoutMs` | 15000 | 搜索请求时限 |
| `imageBudgetMs` | 30000 | 图片下载 + 看图一共多久（看图要几秒，和搜索请求分开算） |
| `newsDays` | 7 | news 只要最近几天的 |
| `snippetChars` | 160 | 每条摘要最多几个字 |
| `look` / `lookRules` | 开 / 五条 | 发图前看一眼；沾上任何一条规则就扔掉 |
| `dir` / `keep` / `maxMB` | `data/search` / 200 / 10 | 图片下载目录、最多留几张（旧的自动删）、单张上限 |

密钥不写进任何文件：网页「密钥」面板或 `/secret set deepseek <key>`。没密钥时状态卡变黄、搜索结果写「没有搜索密钥」。

## 网页与命令

- `web/status`「搜索」卡片：已配置（来源名）/ 没密钥 / 不认识的来源；今天搜了几次、最近一次搜了什么。
- `/search [news|image] <关键词>`：直接搜一次看结果（不进对话，调试用）。

## 怎么换一家

1. 在 `providers.ts` 的 `WEB_PROVIDERS`（或 `IMAGE_PROVIDERS`）里加一项：`{ id, title, needsKey, search(query, count, kind, env) }`，
   用 `env.fetch` 发请求（带上 `env.signal`）、`env.key` 取密钥，返回 `WebHit[]`（图片返回 `ImageCandidate[]`）；HTTP 错误用 `SearchError` 抛出人话原因。
2. 网页来源：`package.json` 的 `mumu.ui.provider.options` 加一个选项，网页设置里把「网页 / 新闻来源」切过去，必要时改「搜索接口地址」「密钥名」。
   图片来源：把新 id 加进「图片来源」列表（`imageProviders`）即可，几家并行。配置改动自动重载本插件。

## 依赖

无（Node 自带 `fetch`）。
