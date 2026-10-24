# surface-onebot · QQ 表现端（OneBot v11 / NapCat）

## 是什么

让沐沐用一个 QQ 小号在私聊和群里说话、做事。NapCat 负责登录 QQ 并开 OneBot v11 WebSocket 服务端，
本插件用 Node 自带的 WebSocket 正向连过去（零依赖）：消息和通知变成感知；她的发言按真人打字节奏分条发出；
说话以外的 QQ 能力（发图、戳一戳、群管、查询、NapCat 的任意接口）作为**动作**交给导演——导演看动作目录就会用。

```
QQ ⇄ NapCat（WebSocket 服务端 127.0.0.1:3001）⇄ surface-onebot ⇄ 沐沐内核
```

| 文件 | 管什么 |
|---|---|
| `index.ts` | 接线：连接、出口节流、发件箱、表现端注册、动作注册 |
| `segments.ts` | **对外稳定层**：消息段 / 上报事件的类型与构造函数（`seg.*`、`ev.*`），模拟器也用它 |
| `receive.ts` | 进来的方向：消息 / 通知事件 → 感知（带来源与图片） |
| `media.ts` | 存图给网页看（`data/media`）、拼来源字段、记她发出的表情包（`surface.media`） |
| `web.ts` | 网页：状态卡、三个面板、会话目录、`/onebot` 命令 |
| `config.ts` | 配置的类型（默认值在 package.json，表单说明在 `mumu.ui`） |
| `onebot.ts` | 协议层：连接 / 重连、事件分发、`{action, params, echo}` 调用配对 |
| `inbound.ts` | 消息段 → 一句文字（引用带原文、@ 用群名片、转发展开、语音转文字、卡片取标题），判断是不是在叫她 |
| `notices.ts` | 通知 / 请求事件 → `qq.*` 感知 |
| `cache.ts` | 记性：每个频道最近的消息、每个群见过的人（名字 ↔ QQ 号） |
| `throttle.ts` | 出口节流：所有写操作排一条队，手速间隔、打字时间、每分钟上限 |
| `outbox.ts` · `compose.ts` | 发件箱：切分、送达回执、被打断即弃；`<\|quote\|>` / `<\|at:名字\|>` 穿插进消息 |
| `actions.ts` · `queries.ts` | 给导演的动作：`qq.send` · `qq.manage` · `qq.query` · `qq.call` |
| `vision.ts` · `shrink.ts` | 看图：先缩图（动图抽帧拼一张），普通图交给 `vision.read` 分类并描述，表情包交给 stickers 插件；按图片内容缓存、每会话限流 |
| `inline.ts` | 原图进上下文：收图时另存给模型看的副本；服务 `images` 挑「这段历史里哪几张带原图」（见「原图进上下文」） |
| （表情包） | 库、审核、发不发、联网找图都在 [stickers](../stickers/README.md) 插件；这里只把群友的表情包交给它（`collect`），发言里的 marker 问它要图（`resolve`）、发出后告诉它（`sent`） |

## 能力表

**收（进感知）**

| QQ 里发生的事 | 感知 |
|---|---|
| 私聊消息 | `message`，`qq:private:<QQ号>`，urgent → 反射开口 |
| 群里 @ 她 / 叫她名字 / 回复她的消息 | `message` + urgent，`qq:group:<群号>` → 大幅加权（group-policy 按好感 × 心情决定接不接，主人必答） |
| 其余群消息 | `group.message`（要不要接由 group-policy 与导演定） |
| 发的人是群里的机器人（问 group-policy 的服务 `bots`，现取不注入） | kind 照上面两行，但**不 urgent**（它 @ 她不打断她正说的话），`data.bot = true`；理不理由 group-policy 定（默认不理） |
| 每条群消息 | `data.role` = NapCat 的 `sender.role`（owner / admin / member…），group-policy 认机器人时用 |
| 引用回复 | 文字里带「[回复 名字「原文前 30 字」]」或「[回复你「…」]」；`data.replyTo` |
| @ 别人 | 「@群名片」 |
| 图片 / 截图 / 表情包 | 「[图片：画面，上面写着「…」（梗 / 情绪）]」「[截图：…]」「[表情包：…（情绪）]」；没看成写「[图片：没看清]」，限流或排队太久写「[图片：没顾上看]」（见「看图」） |
| 语音 | 「[语音：转写]」（NapCat `fetch_ptt_text`；`voiceToText`） |
| 合并转发 | 「[聊天记录：A：…；B：…]」（前 5 条；全文用 `qq.query forward`） |
| 卡片 / 小程序 / 文件 / 视频 / 骰子 | 「[卡片：标题]」「[文件：名字]」「[视频]」「[骰子：3]」 |
| 有人戳她 | `qq.poke`，带 sender，文字「[戳了戳你]」（进对话历史） |
| 撤回 | `qq.recall`，「明哥 撤回了一条消息：「原文」」（原文来自记性） |
| 有人进群 / 退群 / 被踢 | `qq.notice` |
| 她被禁言 / 解禁 / 踢出 | `qq.notice` |
| 加好友申请 / 拉她进群 | `qq.request`（导演用 `qq.manage accept_friend / accept_group` 同意） |

`qq.*` 的感知不带 sender 时不进对话历史，只是导演的一次唤醒原因。每类可在 `notices` 里关。

**发（她说话时）**

| 写法 | 效果 |
|---|---|
| 普通文字 | 攒到 `<\|br\|>`、换行或句末（攒够 `split.minChars`）发一条；什么时候真的发出去由出口节流决定（见「节流」） |
| `<\|quote\|>` / `<\|quote:名字\|>` | 这条消息引用对方（或某人）最近一条 |
| `<\|at:名字或QQ号\|>` | 在那个位置 @ 那个人；认不出是谁就写成「@名字」文字 |
| `<\|sticker:描述\|>` / `<\|emo:词\|>` | 问 stickers 插件要不要配一张表情包（对方要就一定发，平时按她的状态；库里没有会联网找），要就单独发一条；还在找的时候它在队里占一格，后面的话等它，找不到就跳过 |
| 别的动作发的图片 `Part{kind:'image', data:{media}}`（如 action-image 的截图） | `mediaDir`（默认 `data/media`）里的那张单独发一条；文件名只认纯文件名，文件不在就不发 |
| `<\|emo:…\|>` `<\|act:…\|>` | QQ 上没有身体可演，吞掉（emo 先问一下要不要顺手配表情包） |

每条**发送成功才回执**（I2）；被打断：等待作废、没发出去的不发。发送失败 / 断线：停掉那条发言，内核按已回执前缀结算。

**做（导演的动作）**——频道用意图自带的（必须是 `qq:*`），对象写名字或 QQ 号；做完记一句进工作记忆，失败作为动作出错回报。

| 动作 | op | NapCat 接口 |
|---|---|---|
| `qq.send` | 发图片以外的东西（发图用 action-image 的 `image`）：`file` 文件（mp3 / zip / pdf…，`path` 是她电脑上的完整路径，群和私聊都行，NapCat 同机直接读）· `voice` 语音（`text` 走 tts 合成，或 `path`）· `image` 图片（本机路径或链接）· `poke` 戳一戳 · `react` 表情回应 · `like` 点赞 · `qzone` 发说说 | `send_*_msg` · `upload_group_file` / `upload_private_file` · `send_poke` · `set_msg_emoji_like` · `send_like` · `send_qzone_msg` |
| `qq.manage` | `recall` 撤回（默认她自己最近一条）· `ban` / `unban` · `card` 改群名片（默认她自己）· `kick` · `admin` / `unadmin` · `title` 头衔 · `group_name` · `mute_all` / `unmute_all` · `essence` 精华 · `accept_friend` · `accept_group` · `leave` | `delete_msg` · `set_group_ban` · `set_group_card` · `set_group_kick` · `set_group_admin` · `set_group_special_title` · `set_group_name` · `set_group_whole_ban` · `set_essence_msg` · `set_friend_add_request` · `set_group_add_request` · `set_group_leave` |
| `qq.query` | `members` 群成员 · `who` 某人资料 · `groups` · `friends` · `history` 最近聊天记录 · `forward` 读合并转发 · `ocr` 图片识字 · `status` | `get_group_member_list` · `get_stranger_info` + `get_group_member_info` · `get_group_list` · `get_friend_list` · `get_group_msg_history` / `get_friend_msg_history` · `get_forward_msg` · `ocr_image` · `get_login_info` + `get_status` |
| `qq.call` | NapCat / OneBot 的**任意接口**（`{"action":"…","params":{…}}`，group_id / user_id 按频道自动补） | 一百多个，见 NapCat 文档；`denyCall` 里的不让调（默认 `bot_exit`、`set_restart`） |

她将来给自己写的 NapCat 插件新增的接口，也从 `qq.call` 调。

## 节流

人只有一双手。所有会在 QQ 里留下痕迹的操作——发消息、发图、表情包、语音、文件、撤回、戳一戳、表情回应、点赞、说说、群管、
`qq.call` 调的写接口——都过 `throttle.ts` 这一道门：

1. **全局一条队列**，按进队顺序出：每个会话自己的顺序不变，不同群之间也不会同时刷。
2. **手速间隔**：任意两次操作之间隔 `minGapMs`～`maxGapMs` 之间的随机时长（默认 1500～4000ms；2026-10-22 嫌群里打字太快，从 600～1400 调慢）。
3. **打字时间**：发文字再加 `typingBaseMs + 字数 × msPerChar`（默认 1500ms + 350ms/字，最多 `maxTypingMs` 15 秒，±`jitter` 25% 抖动），
   从手空下来那一刻算起；一段发言的第一条从发言开始算起（模型想词的时间也算打字）。表情包按 4 个字算「找图」时间。
4. **正在输入**：私聊里打字时间 ≥ `inputStatusMinMs`（默认 1.5 秒）时，开始打字就显示「对方正在输入…」。
5. **每分钟上限** `perMinute`（默认 8 次）：满了往后排，不丢。
6. **被打断**：排队中、还在「打字」的那几条直接作废（AbortError），什么都没发出去；内核按已回执的前缀结算（I2）。已经交给 NapCat 的撤不回。

不过门的：只读接口（`get_*`、`fetch_*`、`can_*`、`ocr_image`…）和「正在输入」提示本身——看一眼、显示个状态不需要手，也不算一次操作。

`/onebot` 显示出口队列长度和最近几次操作各等了多久。改快慢：`/config set plugins.surface-onebot.throttle.perMinute 30` 之类。

验证用的时间线（minGap 500～900、base 300、100ms/字、perMinute 12）：三个会话加两个群管操作并发，逐条间隔都 ≥ 手速 + 打字时间下限、同一时刻没有两件事；
私聊说到一半被打断，只发出了第一句，结算 `delivered` 恰是它；连发超过上限时第 13 次操作正好排到第 1 次之后 60 秒。

## 网页上

不改 surface-web、不改前端，全走 docs/web-protocol.md §7 的水线（`web.ts`）：

- **设置**：「QQ（NapCat）」表单，标签、说明、滑块都在清单的 `mumu.ui` 里；token 用密码框（空着就按 `tokenRef` 去密钥库取）。
- **状态页**：「QQ」卡片，显示已连上 / 未连接（原因）、账号、在几个群、出口队列、地址。
- **面板**：「QQ 会话」（群 / 私聊、名字、最近一条、今天她说话几次；顶部有「重连 NapCat」）、「QQ 发送队列」（节流时间线）、「QQ 能力」（动作 ↔ NapCat 接口、能不能用）。
- **会话来源**（给聊天页区分群聊、私聊，显示群友名字）：
  - 网页实际读的是 docs/web-protocol.md §5「平台感知的 data」约定的平铺字段：`chat`（`'group'|'private'`）、`groupName`（拿到真群名才给）、
    `avatar`（发言人头像）、`images`（`[{ url, alt?, sticker? }]`，有它就出图、去掉正文里的「[图片：…]」占位）。
  - 另有一份完整的 `data.source` = `{ platform:'qq', kind:'group'|'private', chatId, chatTitle, chatAvatar, senderId?, senderName?, senderAvatar? }`（通知类感知可能没有 sender）。
  - 会话目录：`meta.chats` 与 `GET /api/surface-onebot/chats`，形如 `[{ channel, platform:'qq', kind, title, memberCount?, avatar }]`。群名来自 NapCat 的 `get_group_list`（连上时取一次，之后每 10 分钟刷新）。
- **图片**：收到的图片 / 表情包下载一份存进 `mediaDir`（与 action-image 同目录同命名），感知的 `data.media` = `[{ kind:'image'|'sticker', media, url:'/api/media/<名>', mime, alt? }]`，文字里的「[图片：描述]」照留作降级。
  她发出的表情包（base64 的那种）真正发出后记一条日志 `surface.media` = `{ uttId, utt, channel, platform:'qq', kind, media, url, mime, alt }`（`utt` 与 `uttId` 同值，网页按它挂图）。
  发言片段在到达表现端之前就由内核写进日志，表现端没法回头给它补 url，所以单记一条，按 uttId 挂到那条发言上。
  `saveMedia:false` 关掉存图（网页就只剩文字）。

## 给模拟器的协议层

模拟器（如 `scripts/fake-onebot.ts`）只要像 NapCat 一样开一个 WebSocket 服务端：

- **推事件**：用 `segments.ts` 的 `ev.privateMessage / groupMessage / poke / groupRecall / friendRecall / groupIncrease / groupDecrease / groupBan / friendRequest / groupInvite`
  构造，消息体用 `seg.text / at / reply / image / record / file / face / poke …`。可选：连上后推一条 `{post_type:'meta_event', meta_event_type:'lifecycle', self_id}`。
  模拟器发的图片段在 `data` 里加 `sim: true`：照常描述，但不收进表情包库（测试图混进正式库她会在真群里发出去）。
- **答调用**：收到 `{action, params, echo}`，回 `{status:'ok', retcode:0, data, echo}`；失败回 `{status:'failed', retcode:非 0, wording}`。
  插件主动调用、模拟器至少要答的：

| 接口 | 什么时候调 | 期望 data |
|---|---|---|
| `get_login_info` | 连上时 | `{ user_id, nickname }` |
| `send_group_msg` / `send_private_msg` | 每发一条 | `{ message_id }` |
| `set_input_status` | 私聊等待时 | 任意（失败无妨） |
| `get_msg` | 收到引用、本地没记着原文时 | `{ sender:{card,nickname}, message:[段] }` |
| `get_forward_msg` | 收到合并转发 | `{ messages:[{ sender, message }] }` |
| `fetch_ptt_text` | 收到语音 | `{ text }` |
| `get_group_member_list` | @ / 群管找人、记性里没有时 | `[{ user_id, card, nickname, role }]` |
| `get_group_member_info` / `get_stranger_info` | 通知里要说出名字时 | `{ card?, nickname }` |

动作用到的其余接口按上面的能力表答即可；不认识的回失败，动作会报错给导演，不影响别的。

## 怎么改

配置全在 `package.json` 的 `mumu.defaults`，`/config set plugins.surface-onebot.<键> <值>` 覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `url` | `ws://127.0.0.1:3001` | NapCat 的 WebSocket 服务端（沐沐和 NapCat 同在她的虚拟机上） |
| `token` | 空 | 直接填 token（网页设置里是密码框，显示时遮住）；空着就按 `tokenRef` 去密钥库取 |
| `tokenRef` | `onebot` | token 在密钥库里的名字：`/secret set onebot <token>`（下次重连生效）；NapCat 没设 token 就不用管 |
| `reconnectMs` / `callTimeoutMs` | 5 秒 / 10 秒 | 断线重连间隔（从没连上过时加倍，免得刷屏）/ 单个接口调用超时 |
| `names` | `["沐沐"]` | 群里叫到这些名字 = 在叫她 |
| `privateUrgent` / `inputStatus` / `voiceToText` | 开 | 私聊新消息打断她 / 私聊显示正在输入 / 语音转文字 |
| `keepMessages` | 80 | 每个频道记住最近几条（引用、撤回原文、@ 人） |
| `inline` | 开 | 教发言者用 `<\|quote\|>` / `<\|at:名字\|>`（一段很短的提示） |
| `actions` | 开 | 注册 `qq.*` 四个动作 |
| `mediaDir` | `data/media` | 别的动作产出的图片在哪；收到的图也存这里给网页看 |
| `saveMedia` / `maxMediaBytes` | 开 / 8MB | 收到的图、她发的表情包存一份给网页 |
| `throttle` | 见「节流」 | 手速、打字时间、每分钟上限 |
| `split` | `minChars 6`，去句尾句号 | 切分 |
| `notices` | 全开 | `poke` `recall` `join` `ban` `request` 各自开关 |
| `query` | 1200 字，禁 `bot_exit` `set_restart` | 查询结果截断长度、`qq.call` 黑名单 |
| `vision` | `vision.read`，缩到 512px，≤400KB，缓存 2000 张（`data/vision-cache.json`），每会话每分钟 10 张，排队超 45 秒不看，动图抽 4 帧 | 看图（见「看图」）；`enabled:false` 关掉 |
| `images.inline` | 最近 3 张、15 分钟内、长边 1024、质量 80、表情包也带、总共 ≤2MB | 原图进发言者 / 大脑的上下文（见「原图进上下文」）；`count:0` 关掉 |
| `stickers` | 开 | 表情包交给 stickers 插件（服务 `stickers`，现取不注入）；`false` 或没装它 = 群友的表情包只看不收、发言里的 sticker 吞掉 |

## 部署 NapCat（她的虚拟机，图形界面）

沐沐和 NapCat 都在她的 Windows 虚拟机上（虚拟机），全程图形界面：

1. 装官方 QQ（im.qq.com 下载，正常安装）。
2. 装 NapCat 官方的图形管理器 **NapCatQQ-Desktop**（github.com/NapNeko/NapCatQQ-Desktop 的 MSI，核对发布页的 SHA256SUMS）。
3. 在 NapCatQQ-Desktop 里点 NapCat 卡片的「安装」（选 NapCat，不选 SnowLuma：要 NapCat 的插件系统让她以后自己加接口）。
4. 新建 Bot（QQ 号填小号）→ 网络配置加「WebSocket 服务端」：地址 `127.0.0.1`、端口 `3001`、消息格式 `array`、上报自身消息关、token 可留空。
5. 启动 Bot，用手机 QQ 小号扫码登录。本插件 `url` 默认就是 `ws://127.0.0.1:3001`，连上后网页「状态」里的 QQ 卡片变绿，`/onebot` 显示账号。

合并转发解析、语音转文字由本插件按需调接口，NapCat 不用额外开。NapCat 不在本机时改 `url`，并在防火墙只放行沐沐那台机器的网段。

## 现状与限制

- 全部能力在假 NapCat（`scripts/fake-onebot.ts` 与插件自带的进程内自检）上验过：收发、打断与回执、引用 / @、通知、四个动作、出口节流时间线、网页字段。
  **真 QQ 还没扫码验收**：私聊 / 群里 @ / 说到一半插话 / 三人群聊，以及群管类动作（要小号在群里有管理权限）、`voice` 的 tts 合成、QQ 空间接口，都要真机再过一遍。
- 已经交给 NapCat 的那一条撤不回：打断时正在发的那一条会照常发出，但不再回执，日志按内核结算的前缀记。
- 撤回原文、引用、名字 ↔ QQ 号只靠内存里的记性（`keepMessages`），重启后要重新见过才认得。

## 看图

每张收到的图走一遍：下载一次（也存进媒体目录给网页看）→ 按内容摘要查缓存 → 没看过才问模型。

- **缩图**（`shrink.ts`）：macOS 用系统自带的 sips；Windows（她的虚拟机）用系统自带 PowerShell + System.Drawing，常驻一个进程按行接活（每起一次要 2～3 秒，常驻后每张 0.1～0.4 秒），
  动图抽 `gifFrames` 帧从左到右拼成一张，告诉模型「这是动图」。缩完超过 `maxBytes` 的不看。
  以前 Windows 上不缩图，超过 400KB 的直接跳过——虚拟机上没描述的「[图片]」有 77/78 张是这么来的（多是几 MB 的动图表情包）。
- **一张图只看一次**：普通图按内容摘要记在内存 + `cacheFile`（重启也认得）；表情包交给 stickers 插件的 `see()`——库里有就用库里的描述，
  新的那张一次调用同时出描述和审核结论、过了就入库（以前是这里看一遍描述、入库再看一遍审核，同一张图被看 2～5 次）。
  以前的缓存键是 QQ 给的 `file` 字段，不同的图会撞键、套上别的图的描述（实测两张不同的图都被说成「马斯克穿黑皮衣…」）；现在按图片内容。
- **限流**：每个会话每分钟最多 `perMinute` 次真去问模型（命中缓存不算），消息时间离现在超过 `staleSec` 的不看——群里刷图时后面的图等太久，对话早过去了。
  这两种写成「[图片：没顾上看]」；下载失败、模型失败 / 超时、缩完还太大写成「[图片：没看清]」。发言者段落 `qq-images` 教她：没看到内容的图别装看懂，想知道就问。
- **描述**：普通图让模型先分清照片 / 截图 / 带字图 / 表情包，再写画面主体、图上的字（摘原文）、梗或情绪，
  JSON 输出拼成一句；截图写成「[截图：…]」。

**看图**依赖 `vision.read` 绑到支持图片的模型，并要求 provider 原样转发 messages（内核 `ChatMessage.content` 声明是 string，这里传 OpenAI 多模态数组，见 `vision.ts` 文件头）。图片会进 `model.request` 日志，所以先缩小。

## 原图进上下文（`images.inline`，`inline.ts`）

描述是看图模型的转述，会偏（看错颜色、漏了图上的字、把梗看成字面），她照着转述接话就和群友看到的图对不上。
DeepSeek 与本地 qwen 都直接收图（实测见 [provider-openai](../provider-openai/README.md)），所以**聊天里最近几张图以原图跟着那条消息进发言者和大脑的上下文**，像人一样看图说话。

- **收图时**：看图的同时（并行，不多占等待）另存一份长边 `maxSide`、JPEG `quality` 的副本进媒体目录；文件名与字节数记进感知 `data.media[].inline`，
  连同感知文字里这张图的原文 `shown`（「[图片：…]」，与渲染用同一个函数 `imageLabel` 写，换得掉）、`what`（图片 / 截图 / 表情包）一起落日志。
  选图只读日志，重启也认得。转不成 JPEG / PNG 的（个别 webp）不做副本，免得模型端拒收整次请求。`saveMedia:false` 时没有副本。
- **选图**（服务 `images`：`inline(turns, { numbered? })`，契约 `ImagesService` 随 `index.ts` 导出）：每个频道最近 `count` 张、`withinMin` 分钟内的；
  `stickers:false` 时表情包不算；加起来超过 `maxBytes` 从最旧的开始退回文字。她自己发的图不带（assistant 轮次带不了图，她也知道自己发的是什么）。
  返回「第几轮 → 换过占位的文字 + 附件 + 换了哪几段」：原图在上下文里的那几条，描述换成简短的「[图片]」「[表情包]」（numbered 时「[图片1]」），免得描述和原图打架。
- **谁带**：发言者 `performer` / `performer.deep`（action-reply）和大脑 `mind.decide`（mind-default）带；快回 `performer.reflex` 只求快、不带。
  附件挂在消息的插件层字段 `images` 上，provider-openai 发请求时才读文件转 base64（日志里只有文件名和字节数）。
- **描述照旧生成**：记忆摘要、阅读窗口、搜索、日志、网页都用文字描述；更早的、超额的图在提示词里也仍是文字。
- 发言者段落 `qq-images` 跟着改：「[图片]」后面附了原图的照图说，「[图片：…]」是当时看到的内容，没附图又没描述的别装看懂。

| 键 | 默认 | 说明 |
|---|---|---|
| `images.inline.count` | 3 | 每个会话最近几张带原图；0 = 关掉（也不再另存副本） |
| `images.inline.withinMin` | 15 | 多少分钟内的图 |
| `images.inline.maxSide` / `quality` | 1024 / 80 | 副本长边像素（小图不放大）/ JPEG 质量；只影响之后收到的图。1024 的图 DeepSeek 约 500 token、本地 qwen 约 770 token 一张 |
| `images.inline.stickers` | 开 | 表情包也带原图（它常是语气的一部分） |
| `images.inline.maxBytes` | 2000000 | 一次提示词里原图（副本字节）加起来的上限 |

网页「设置 → QQ（NapCat）」里都能改（清单 `mumu.ui` 写好了标签）。单测：`test/inline-images.test.ts`；模拟器场景 `image-inline`、`image-misread`（`scripts/fake-onebot/image-scenes.ts`）。
