# stickers · 表情包

## 是什么

她的表情包：一个库（群里收的、网上找的、主人手放的），发之前一律审核；什么时候发由她此刻的状态决定；
库里没有合适的就按描述上网找，审核通过才入库、才发。表现端只管「怎么发出去」：

- **QQ**（surface-onebot）：发件箱遇到 `<|sticker:…|>` / `<|emo:…|>` 就问 `stickers` 服务要不要配一张，
  要找的话在队里占一格等它（后面的话等它，找不到就跳过），发出成功再回调 `sent()`。
- **网页**（以及别的没自己发表情包的频道）：这里直接兑现——听日志里她发言的 marker，挑 / 找到后拷进媒体目录（`data/media`），
  记一条 `surface.media`，网页把图挂到那条发言上。

| 文件 | 管什么 |
|---|---|
| `index.ts` | 接线：服务 `stickers`、发不发的决定、网页频道挂图、审核队列 |
| `collect.ts` | 群友的表情包：每张只看一次，描述 + 审核一次出，过了就入库 |
| `shrink.ts` | 送模型前缩图（动图抽帧拼一张），与 surface-onebot 的同一份实现 |
| `book.ts` | 库：`data/stickers/` + `index.json`（每张的描述、标签、用途、来源、审核结论、用过几次、学到的语境）+ `rejected.json`（网上被拦下的只记摘要） |
| `review.ts` | 看图审核 + 打标（一次调用，JSON 输出），规则原文在这里 |
| `search.ts` | 联网找：来源（so360 / fabiaoqing）、下载、审核、入库、限流 |
| `chance.ts` | 发不发：对方要就发；平时 = 基础概率 × 心情 × 热度 × 对方刚发没 ……；认真话题、刚发过不发；「对方在要表情包」的说法 |
| `prompt.ts` | 教发言者写 `<\|sticker:描述\|>`；按会话提醒「对方在要」「刚发过」；导演材料「表情包」 |
| `web.ts` | 面板「表情包库」、缩略图接口、状态卡、`/stickers` |

## 发不发

1. 一条发言最多一张。她写了 `<|sticker:描述|>` 就按描述挑；只写了 `<|emo:词|>` 时按 `emoChance` 顺手配一张情绪对得上的（QQ 上没有脸可演）。
2. **对方要（`askPatterns`：「发个表情」「来张图」「斗图」…，匹配对方原话）→ 一定发**，不看间隔；发言者这轮会被明确告知「这条回复里一定写一个」，导演规则也有一句「对方要表情包就给」。
3. 否则概率 = 基础（`chance` / `emoChance`）× 状态系数，落日志 `sticker.decided { p, why, send }`：

   | 因子 | 系数 |
   |---|---|
   | 心情好（valence ≥ 0.35）/ 不好（≤ -0.2） | ×1.5 / ×0.4 |
   | 兴奋（arousal ≥ 0.6）/ 没精神（≤ 0.2） | ×1.2 / ×0.6 |
   | 聊得热（`heatWindowSec` 内别人说了 ≥ 5 句）/ 冷清（0 句） | ×1.5 / ×0.6 |
   | 对方最近一两句发了表情包 | ×1.8 |
   | 对方说了一大段（≥ 50 字） | ×0.3 |
   | 导演让她认真答（tier deep）、她这句已经说了 `seriousChars` 字 | 不发 |
   | 离这个会话上一张不到 `minGapSec`、她上一条发言就带了表情包 | 不发（不连发） |

4. 库里挑：描述和每张的标签、描述、用途、学到的语境比字面重合，取最接近的几张随机一张，同一会话不连着发同一张。
5. 没有合适的 → `searchOn`：`explicit`（默认，她明说要发或对方要时）联网找；`asked` 只在对方要时找；`never` 不找。
6. 对方要、网上也没找到：库里有就发一张最接近的；库里一张都没有 → 给导演一条感知 `sticker.missing`（「跟对方说一声没找到」），她自己说一句。

发出去之后：工作记忆「刚发了一张表情包（…）」（只在那个会话里可见）；发言者下一次在这个会话里看到「你刚才在这里发过表情包：…，别连着发」；
导演材料「表情包」写库里几张、今天发了几张、唤醒原因所在会话最近发过什么、对方是不是还在等。

## 审核（原文）

一次看图调用（`review.role`，默认 `vision.read`），打标与过滤并成一份，
要求只回 JSON：`desc` 画面、`emotion` 情绪、`tags` 最多 5 个标签、`usage` 什么时候发、`isSticker` 是不是表情包、`flags` 沾上了哪几条、`ok`、`reason`。

不合适的标准（`review.rules`，默认如下，可整份替换；最后一条按 `review.maxChars` 自动补上）：

1. 色情、擦边、裸露或性暗示
2. 暴力、血腥、恐怖、自残、虐待动物
3. 政治人物、国家领导人、政党 / 国旗 / 军队 / 宗教等敏感符号，或时政话题
4. 真人照片（明星、网红、路人、自拍），或可能泄露隐私的内容（证件、聊天记录、手机号、住址、车牌）
5. 广告、二维码、联系方式、网址，或明显的网站水印、商标
6. 辱骂、歧视、低俗、违法违规的文字
7. 任何形式的截图（聊天记录、视频、网页、游戏、电视画面）
8. 图上的字超过 12 个

判定不全信模型的 `ok`：`isSticker` 为真、`flags` 为空、模型说 ok、描述 / 标签里不含 `review.blockWords` 的禁词——全满足才过。
禁词还拦在两处：搜索词里有就不搜，网上结果标题里有就不下。
看不了（模型挂了、超时、没按 JSON 回）：网上找来的**不入库**；群里收的保持「没审」，**不能发**；只有主人手放进目录的没审也能发。
规则改了把 `REVIEW_VERSION` 加一：库里旧版本审过的照旧能发，后台按新规则一张张再审（`recheck`）。

## 联网找

| 来源 | 怎么找 | 备注 |
|---|---|---|
| `so360` | 360 图片搜索 JSON 接口 `image.so.com/j?q=<描述> 表情包` | 快（< 1 秒）；原图常有防盗链，取不到就用它的缩略图（qhimgs1 CDN） |
| `fabiaoqing` | 「发表情」fabiaoqing.com 搜索页，按 `<img data-original>` 取图 | 表情包专站，图带 Referer 才给；页面较慢（实测 7 秒） |

两个都不要密钥。别的 bot 常用的斗图啦（doutula）、逗比表情包（dbbqb）接口实测已不通，搜狗图片接口拒绝（2026-10-22），没收。

每次：按 `providers` 顺序试，一个失败 / 没结果 / 全被拦就换下一个；最多下载审核 `perSearch` 张；每小时最多 `perHour` 次；
单个请求 `timeoutMs`、整次 `budgetMs`；同一个描述同时只找一次。下载回来先认图片头（防盗链给的网页不要），已在库里的直接用，
`rejected.json` 里有的跳过。日志：`sticker.search`（每次一条：找到没有、看了几张、拦了几张、为什么失败）、
`sticker.rejected`（每张被拦的：来源、地址、所在页面、模型描述、沾上的规则、原因）、`sticker.added`（入库：带来源）。
网络失败只是「这次没找到」，不影响聊天。

## 网页

- **面板「表情包库」**（设置 → 面板）：每张一张卡——缩略图（`GET /api/stickers/img/<文件名>`）、画面、情绪 / 场景、什么时候发、来源（群 / 网上哪个来源按什么词 / 主人放的）、
  审核结论、状态、她发过几次、群里见过几次、学到的语境；按钮「禁用」「恢复」「重新审核」「删除」（删了以后再见到也不收）。
  顶部输入框 +「按描述联网找并入库」手动补库，「全部按新规则重审」。
- **状态卡「表情包」**：库里几张（能发几张）、今天发了几张、联网找了几次（入库 / 拦下）、这一小时还能找几次、排队审核几张。
- **对话里**：网页频道她发的表情包按 `surface.media`（`platform:'web'`）挂到那条发言上；只有表情包没有字的那条也会单独显示。

接口：`GET /api/stickers/items` · `GET /api/stickers/img/<文件名>` · `POST /api/stickers/items/{disable,enable,delete,recheck}`（`{ item: { file } }`）·
`POST /api/stickers/recheck-all` · `POST /api/stickers/find`（`{ input: 描述 }` → `{ ok, file, desc, provider, rejected, message }`，找不到 422 `{ error }`）。

命令：`/stickers`（概况）· `/stickers find <描述>` · `/stickers recheck`。

## 服务 `stickers`

```ts
import type { StickerService } from '../stickers/index.ts'
const s = ctx.use<StickerService>('stickers') // 现取，别注入：表情包插件重载不该连带断开表现端
s.resolve({ channel, uttId, track, value }) // undefined = 这次不发；Promise<StickerPick | undefined> = 挑 / 找
s.sent(pick, channel, uttId) // 真发出去了
s.see({ raw, view, channel, budget }) // 群友发的表情包：给感知用的描述，顺手收进库（collect.ts）
```

`see()` 每张只看一次：库里有（按内容摘要）直接用库里的描述并学一次用法；看过没进库的记在内存里；同时来两张同样的只看一次；
新的先扣表现端的看图额度（`budget`，不给就返回 `{ refused }`），用表现端缩好的图（`view`）一次调用同时出描述和审核结论，过了带着结论入库，没过不落盘。

## 怎么改

配置在 `package.json` 的 `mumu.defaults`，网页「设置 → 表情包」有表单：

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` / `mediaDir` | `data/stickers` / `data/media` | 库目录；网页挂图用的媒体目录（与 surface-web 同一处） |
| `max` | 500 | 最多收几张 |
| `collect` / `learn` | 开 | 收群友发的表情包 / 学用法 |
| `chance` / `emoChance` | 0.5 / 0.15 | 她写 sticker / 只写 emo 时的基础概率 |
| `minGapSec` | 120 | 同一会话两张至少隔几秒（对方要的时候不限） |
| `heatWindowSec` / `seriousChars` | 180 / 60 | 算「聊得热」看最近几秒 / 她一句说到多少字算在认真说事 |
| `askPatterns` | 见清单 | 「对方在要表情包」的说法（正则，匹配对方原话） |
| `searchOn` | `explicit` | 什么时候联网找 |
| `selfServed` | `["qq:"]` | 这些频道前缀的表现端自己发（经服务）；其余频道这里挂进网页 |
| `recheck` | 开 | 后台按新规则重审旧的 |
| `review` | 见上 | `role`、`rules`、`maxChars`、`blockWords`、`timeoutMs` |
| `search` | 见上 | `enabled`、`providers`、`perSearch` 3、`perHour` 20、`timeoutMs` 10 秒、`budgetMs` 40 秒、`maxBytes` 2MB、`suffix` |

加一个来源：在 `search.ts` 的 `builtinProviders` 里加一项（`search(query, n, signal) → Candidate[]`），再把 id 写进 `search.providers`。

## 测试图不进库

- 模拟器（`scripts/fake-onebot.ts`、`scripts/replay`）发的图片段带 `sim: true`：surface-onebot 照常描述，`see()` 不收进库、不学用法。
- 库目录不能指到 `data/backups/**`（构造时直接报错）；归档里的图也不要手工并回来——2026-10-22 并过一次测试归档，
  20 张模拟器的纯色文字图混进正式库，其中一张被她在真群里发了出去，已删（删除即进 `rejected.json`，以后再见到也不收）。
- 面板「来源」列写着从哪个会话收的，「审核」列带规则版本号。

## 现状与限制

- 选图只比字面，不调模型：描述和库里标签差得远时会去网上找，而不是挑一张意思相近的。
- QQ 上表情包要找的时候，它后面的话会等它（最多 `budgetMs`）；网页上图是找完才挂上去的。
- 审核靠看图模型：小模型可能漏判；禁词与「不是表情包就不要」是兜底，主人在面板上还能禁用 / 删除。
- 动图在 Windows 上抽 4 帧拼成一张给模型看；macOS 上只看第一帧（sips 不会抽帧），帧与帧之间的画面没审到。
