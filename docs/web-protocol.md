# Web 协议 v2

> `plugins/official/surface-web`（服务端）与 `apps/web`（浏览器）之间的**唯一契约**。
> 两边都只认本文；前端不 import `src/`。改协议先改本文，再改两端（[../CLAUDE.md](../CLAUDE.md) §5）。
> 状态：已实施（2026-10-12），`plugins/official/surface-web` 与 `apps/web` 两端对齐。

---

## 0. 立场

- **UI 是日志的纯投影。** 服务端不持有会话状态、不持有用户态；它只做三件事：推日志流、收输入、收回执。
- 服务端把内核的 `log.appended` 原样推出，**不做二次加工**。投影规则全在前端（[periphery.md](periphery.md) §5.3）。
- 未知即忽略：客户端对不认识的事件类型、`part.kind`、marker 词**不报错**；服务端对不认识的路径返回 404。

## 1. 基址与通则

- 默认 `http://127.0.0.1:3939`，由插件 `mumu.defaults` 的 `host` / `port` 决定。
- 所有接口在 `/api/` 下。其余路径服务静态前端（§4）。
- 请求体与响应体都是 JSON，`content-type: application/json; charset=utf-8`。
- 失败返回 4xx / 5xx，体为 `{ "error": "原因" }`。
- 无鉴权（只绑本机回环地址）。要对外暴露是另一个插件的事，不在本协议内。

## 2. 事件流 `GET /api/events[?channel=<id>]`（SSE）

响应 `text/event-stream`，每条 `data: <JSON>\n\n`。

**对话 = 内核频道。** 带 `channel` 时只订阅这一个对话：重放从全量日志里取该频道的事件（`utterance.part`、`action.ended` 这类不带频道的事件按 `started` 映射），
本频道的事件优先（最近 `4 × replay` 条），无频道的事件（beat、model、emotion…）只补这段时间里最近 `replay` 条——
别的频道再忙也挤不掉这个对话的消息。直播同样过滤。不带 `channel` 则是全量（最近 `replay` 条）。
默认对话是 `main`；新对话由客户端生成 id（如 `c:m2f1x9`），发第一句话后才在列表里出现。

**连接时序**

```
retry: 1000
data: <LogEvent>          ← 重放：最近 replay 条（默认 400，插件配置 replay）
data: <LogEvent>
…
data: {"type":"__live__"} ← 重放结束
data: <LogEvent>          ← 此后为直播
data: {"type":"__stream__","data":<ModelStreamEvent>}
…
```

**控制信号**：`type` 以 `__` 开头的不是日志事件。客户端不认识的 `__*` 忽略。

| 信号 | 含义 | 客户端动作 |
|---|---|---|
| `__live__` | 重放结束 | 之后才允许副作用（回执、舞台） |
| `__stream__` | 一个模型 chunk（不落日志，`data` 为 `ModelStreamEvent`） | 调试页画时间轴 |
| `__reset__` | 服务端记忆已清除 | 清空全部投影，回到初始态 |

**重连**：`EventSource` 自动重连；服务端每次连接都重放。客户端在 `onopen` 时清空投影，从头重建。
**回执只在 `__live__` 之后发。**

**服务端行为**：有至少一个 SSE 客户端时，插件才向内核注册为有回执的表现端（`deliveredReport: true`）；
没有浏览器连着时不注册，避免每句话空等送达超时。

## 3. 接口

### `POST /api/input`

```json
{ "text": "你好", "channel": "main" }
```

- `text` 必填，去首尾空白后非空，否则 400。`channel` 可省，默认 `main`。
- 服务端转成感知：`{ kind: 'message', channel, sender: { id: 'web-user' }, text, urgent: true }`。
  `urgent: true` = 直接的用户插话默认打断角色正在说的话。
- 返回 204。**不返回消息本身**：客户端等 `percept.received` 从事件流回来再显示。

### `POST /api/delivered`

```json
{ "uttId": "utt#3", "chars": 17 }
```

- `chars` 是该 utterance **累计**已显示的文本字符数（只算 `part.kind === 'text'` 的 `text`，与内核送达账一致）。
- 每渲染一段文本就发一次；允许乱序，服务端取最大值。
- 返回 204；未知 `uttId` 也返回 204（它可能已结算）。

### `POST /api/clear`

无请求体。语义固定：停掉全部在跑动作 → 日志真源归零（含 SQLite）→ 工作记忆清空 → 向所有客户端广播 `__reset__`。
**配置库不动。** 返回 204。

### `GET /api/meta`

```json
{
  "protocol": 2,
  "character": { "id": "mumu", "name": "沐沐", "stage": { "kind": "live2d", "profile": "live2d/models/hiyori" } },
  "characters": [{ "id": "mumu", "name": "沐沐", "stage": { "kind": "live2d", "profile": "live2d/models/hiyori" } }],
  "skins": [{ "id": "haru", "kind": "live2d", "profile": "live2d/models/haru" }],
  "replay": 400,
  "voice": { "available": true },
  "commands": [{ "name": "plugins", "usage": "plugins", "description": "列出插件" }]
}
```

- `protocol`：本文版本号，不兼容变更时递增。
- `character.name` 默认取插件配置 `name`，再经 waterfall **`web/meta`** 让其他插件（如 persona）覆盖或补字段。
  这是「插件改插件」的既有通道：前端不写死任何角色信息。
- `character.aliases`（可选）：各平台网名 `{ 平台: 网名 }`，由 persona 补入；`name` 是真名。
- `character.stage`（可选）：舞台实现与档案目录，由 `characters` 插件经 `web/meta` 补入（取自 `plugins.surface-web.character`）。
  `kind` 为 `live2d` | `tachie`，不认识的按 `live2d`；`profile` 相对站点根，档案在 `/<profile>/profile.json`。缺省时前端走 Live2D 默认模型。
- `character.id`（可选）：当前角色包 id，由 `characters` 插件补入；没切过角色时缺省。
- `characters`（可选）：可切换的角色包 `[{ id, name, stage }]`，由 `characters` 插件补入。
  切换走 `POST /api/command` 发 `/character use <id>`（人设 + 舞台 + 声音整体换）。
- `skins`（可选）：可用的舞台皮肤 `[{ id, kind, profile }]`。surface-web 扫描它服务的静态目录下 `live2d/models/*/profile.json`，
  有档案的模型目录即一项（`kind` 恒为 `live2d`，`profile` 为 `live2d/models/<id>`）。
  换皮肤走 `POST /api/command` 发 `/character skin <profile>`：只改当前角色的舞台（写 `plugins.surface-web.character.stage`），不改人设。
  皮肤写进后端配置而不是浏览器本地：刷新、换设备都还是这身。
- 切换角色 / 皮肤会重载 surface-web：事件流断开，客户端自动重连后重新取 `/api/meta` 即拿到新舞台。
- `pet`（可选）：`{ visible: boolean }`，她电脑桌面上的桌宠（`apps/desktop`）此刻是否显示，由 `desktop-pet` 插件经 `web/meta` 补入
  （取自 `plugins.desktop-pet.visible`，默认 `false`）。开关走 `POST /api/command` 发 `/pet on` / `/pet off`；
  只重载 desktop-pet 插件、不断事件流，所以客户端改完要自己再取一次 `/api/meta`。
  没装插件时缺省，客户端不显示开关。完整设置与「桌宠程序在不在」走插件自带接口 `GET /api/desktop-pet/state`
  （§7 的 `web/route`）：`{ visible, alwaysOnTop, width, height, corner, alive, shown }`；桌宠程序每 3 秒带
  `?from=pet&shown=0|1` 来取（即心跳），网页按钮也轮询它（不带 `from`），所以托盘一改网页几秒内跟上。
- `panels`（可选）：插件经 `web/meta` 追加的通用面板定义，前端的「设置 → 面板」按 `kind` 统一渲染。形状与写法见 §7。
- `voice.available`：`tts` 服务存在且 `ready()`（配置 + 密钥齐）。
- `commands`：后端命令注册表里有什么，供调试页提示。
- 客户端对多出来的字段忽略。

### `GET /api/conversations`

```json
{ "conversations": [
  { "channel": "main", "title": "默认对话", "firstAt": 0, "lastAt": 0, "count": 0, "said": 0, "source": { "platform": "web", "kind": "web" } },
  { "channel": "qq:group:7438300", "title": "摸鱼小分队", "firstAt": 1, "lastAt": 2, "count": 40, "said": 3, "source": { "platform": "qq", "kind": "group", "id": "7438300", "name": "摸鱼小分队" } },
  { "channel": "qq:private:20001", "title": "小林", "firstAt": 1, "lastAt": 2, "count": 8, "said": 5, "source": { "platform": "qq", "kind": "private", "id": "20001", "name": "小林" } }
] }
```

从真源投影：出现过别人消息的频道；按最近活动排序。没有删除接口（清除记忆会清全部）。

- `count`：这个频道里别人说过的句数（客户端记住「看过时的 count」，相减即未读）。`said`：她**今天**（服务端本地日期）在这个频道说出去的条数（`utterance.settled` 且 `delivered` 非空）。
- `source`（来源）：`platform` 为 `web` | `qq` | 以后的平台名；`kind` 为 `web` | `group` | `private`；`id` 为平台里的群号 / 对方号；`name` 为群名 / 对方名字（拿不到就缺省）。
  推导规则（服务端，与平台无关）：频道名按 `<platform>:<kind>:<id>` 约定拆（`qq:group:123`）；`main` 与 `c:<id>` 是网页对话。
  `name` 取该频道最近一条感知的 `data.groupName`（群）或 `sender.name`（私聊）。
- `title`：有 `source.name` 用它，否则（网页对话）取第一句话的前 24 字。

### `GET /api/persona`

```json
{ "name": "沐沐", "prompt": "…", "style": "…", "rules": null, "markers": { "emo": ["脸红"], "act": [] }, "aliases": { "qq": "沐沐小号" } }
```

persona 插件**当前合并后**的配置：清单 `mumu.defaults` 被配置库 `plugins.persona.*` 覆盖（与装配层同一规则）。
- `rules`：`null` = 用 persona 插件内置的「要求」（内置文案不经本接口暴露）；`""` = 不要这一段；其余为整段自定义。
- `markers`：键为 marker 通道（`emo`、`act`…），值为词数组；没有的通道可缺省。
- `aliases`：各平台网名 `{ 平台: 网名 }`（`name` 是真名）。旧后端没有这个字段。
- 没装 persona 插件 → 404。

### `POST /api/persona`

请求体与 `GET` 同形，**字段可缺省**（缺省 = 保持现值）：

```json
{ "name": "沐沐", "prompt": "…", "style": "…", "rules": "", "markers": { "emo": ["脸红", "嘟嘴"], "act": ["歪头"] } }
```

- `name`、`prompt` 若给出必须是非空字符串；`style`、`rules` 是字符串（`rules` 还可为 `null` 回到内置）；
  `markers` 是 `{ 通道: 字符串数组 }`，`aliases` 是 `{ 平台: 网名 }`（平台名小写字母开头；网名空串 = 不要这个平台），两者都**整体替换**
  （客户端要保留没编辑的键就原样带回）。形状不对 → 400 `{ error }`，什么都不写。
- 写入 `plugins.persona`（经 config 服务，整棵写入后再写一个叶子，persona 恰好重载一次），下一句话起生效。
  其他字段（如 `enabled`）原样保留。
- 返回 200，体为写入后的合并配置（同 `GET`）。
- 不经 `/api/command` 拼 `/config set` 字符串：人设里常有引号与换行，命令行转义不可靠。

### `GET /api/models`

```json
{
  "roles": { "default": { "baseURL": "https://api.deepseek.com", "model": "deepseek-chat", "apiKeyRef": "deepseek" },
             "performer.reflex": { "temperature": 0.9, "maxTokens": 600 } },
  "defaults": { "default": { "…": "…" }, "performer.reflex": { "…": "…" } },
  "keys": ["deepseek", "local"],
  "presets": [{ "name": "本地 4090", "baseURL": "http://127.0.0.1:8091/v1", "model": "qwen3.8-27b", "apiKeyRef": "local", "fallback": "default" }]
}
```

provider-openai 角色绑定（模型路由）。
- `roles`：**当前合并后**的 `plugins.provider-openai.roles`（与装配层同一规则）。每个角色只列它自己写了的项，没写的由 provider 从 `default` 继承。
- `defaults`：清单出厂值，客户端做「恢复默认」与「改过」标记。
- `keys`：已存密钥的**名字**（没装 secrets 插件为空数组），供 `apiKeyRef` 选；永不返回值。
- `presets`：surface-web 配置 `modelPresets` 里的常用端点，客户端做一键填充；不影响后端。
  预设可带 `responseFormat`（本地引擎不支持 JSON 模式就写 `"text"`）：客户端只用它替换原本开着 JSON 模式的角色。
- 绑定字段（白名单）：`baseURL` · `model` · `apiKeyRef` · `fallback` · `temperature` · `maxTokens` · `timeoutMs` · `responseFormat`（`"json" | "text"`）· `provider`。含义见 provider-openai README。
- 没装 provider-openai 插件 → 404。

### `POST /api/models`

```json
{ "roles": { "default": { "…": "…" }, "mind.decide": { "temperature": 0.3, "baseURL": "http://127.0.0.1:8091/v1", "model": "qwen3.8-27b", "apiKeyRef": "local", "fallback": "default" } } }
```

- 请求体是**想要的完整 `roles`**（不是补丁）：没列出的角色、没列出的字段 = 删掉。客户端从 `GET` 的 `roles` 改起，原样带回没动的部分。
- 服务端对照出厂值算出最小补丁写进 `plugins.provider-openai.roles`：改回出厂值的项自动从库里消失；提交 `defaults` 原样 = 恢复出厂。provider-openai 重载一次，下一次模型调用起生效。
- 校验（不过 → 400 `{ error }`，什么都不写）：角色名只含字母数字 `. - _`；只收上面的白名单字段且类型对（`baseURL` 要 `http(s)://`，`temperature` 0～2，`maxTokens` 正整数，`timeoutMs` 非负整数）；
  `default` 必须有 `baseURL` 与 `model`；`fallback` 要指向另一个已有角色；**不收 `apiKey`**（密钥走 `/secret set`）。
- 返回 200，体同 `GET`。

### `POST /api/tts`

```json
{ "text": "一句话" }
```

响应 `audio/*` 二进制（`content-type` 由 tts 插件给，默认 `audio/mpeg`）。`text` 上限 2000 字。
没装 tts 或密钥缺失 → 404 `{ "error": "语音未就绪…" }`。客户端断开连接会取消合成。

### `GET /api/media/<name>`

角色发出的图片（`Part.kind === 'image'`，见 §5 `utterance.part`）的文件本体。
- `name` 只含字母数字与 `. - _`（内容摘要 + 扩展名，如 `3f9a0c1b2d4e5f60.jpg`），否则 400；找不到 → 404。
- 文件在服务端媒体目录（surface-web 配置 `media`，默认后端工作目录下的 `data/media`），由发图的插件（如 `action-image`）写入；
  同名即同内容，响应带长缓存。`content-type` 按扩展名。

### `POST /api/command`

```json
{ "line": "/plugins" }
```

→ `{ "lines": ["…"] }`。不以 `/` 开头 → 400。命令集由 `commands` 插件注册表决定，`/help` 列出全部。
`/secret` 也能跑，但值永不显示；敏感操作建议在终端做。

### 流式感知 `POST /api/perception/*`

浏览器语音识别的中间结果，映射到内核 `io.perceive()`：

| 接口 | 请求 | 说明 |
|---|---|---|
| `/api/perception/start` | `{ "kind"?: "speech", "channel"?: "main", "urgent"?: true }` → `{ "id": "in#3" }` | 开口即打断（默认 urgent） |
| `/api/perception/update` | `{ "id", "text", "wake"?: boolean }` | `text` 是**修订**不是追加；`wake: true` 才开一拍 |
| `/api/perception/end` | `{ "id", "text"? }` | 定稿，进历史，唤醒导演 |
| `/api/perception/cancel` | `{ "id", "reason"? }` | 放弃，不进历史 |

### 设置与状态（所有插件通用）

网页上的「设置」「状态」只用下面这些接口；插件不必为自己的配置单独写接口——写进清单 `mumu.defaults` 就自动有表单。
`:id` 是插件 id（`/plugins` 里那一列）。实现见 `plugins/official/surface-web/admin.ts`。

| 接口 | 请求 → 响应 | 说明 |
|---|---|---|
| `GET /api/plugins` | → `{ plugins: [{ id, title, group, description?, enabled, loaded, order, error?, hasConfig }] }` | 全部插件；`error` 是最近一次加载失败的原因（依赖缺失也算）；`title` 取清单 `mumu.title`，没有就是 id |
| `GET /api/plugins/:id/config` | → `{ id, defaults, override, merged, ui }` | `defaults` 清单出厂值；`override` 配置库 `plugins.<id>` 里的补丁（不含 `enabled`）；`merged` = 补丁打在出厂值上（与装配层同一个 `mergePatch`）；`ui` 清单 `mumu.ui` 原样（可选，见 §7） |
| `PUT /api/plugins/:id/config` | `{ config: <想要的完整配置> }` → 同 `GET` 再加 `error?` | 服务端用 `diffPatch(defaults, config)` 算出最小补丁写进 `plugins.<id>`（保留 `enabled`），然后重载该插件；**改回出厂值的项自动从库里消失**，所以「恢复默认」= 把出厂值提交回来。重载失败照样 200，原因在 `error` |
| `POST /api/plugins/:id/enabled` | `{ enabled: boolean }` → 同 `GET /api/plugins` 的单项 | 启停并持久化（同 `/plugin enable\|disable`）。不许在网页上停掉 `surface-web` 自己（400） |
| `GET /api/secrets` | → `{ secrets: [{ name, updatedAt }] }` | 只有名字和时间，**值永不出服务端** |
| `POST /api/secrets` | `{ name, value }` → 204 | 只写不读；`value` 空串 = 删除。没装 secrets 插件 → 404 |
| `GET /api/status` | → `{ cards: [{ id, title, level, text, items? }] }` | 总览卡片；`level` 为 `ok` \| `warn` \| `err` \| `info`。内置：网页连接、插件失败、正在跑的动作；其余（模型路由与探活由 provider-openai 报）由插件经水线 `web/status` 追加（§7）。卡片可能触发探活，客户端别刷太勤（网页 10 秒一刷、标签页不可见时不刷） |

**敏感字段**：名字以 `key` / `token` / `secret` / `password` 结尾（不分大小写）或 `ui` 里标了 `"secret": true` 的字符串，
`GET` 一律返回 `"••••••"`；`PUT` 时该处仍是 `"••••••"` 表示「不改」。真正的密钥应放 secrets（配置里只写名字，如 `apiKeyRef`）。

**插件自己的接口**：上表与本节之前列出的路径都不匹配的 `/api/*` 请求，交给水线 **`web/route`**，由插件认领（§7）；没人认领 → 404。
插件一般回 JSON；回 `Buffer`（如缩略图）时原样回字节，`content-type` 由插件给（§7）。

## 4. 静态前端

- 非 `/api/` 路径 → 服务 `apps/web/dist`（路径由插件配置 `dist` 决定，默认相对插件目录的 `../../../apps/web/dist`）。
- 找不到文件但不是资源请求（无扩展名）→ 回 `index.html`（SPA 路由 `/debug` 刷新可用）。
- `dist` 不存在 → 503，纯文本说明「先 `npm run build:web`，或开发时用 `npm run dev:web`（5173 代理到本端口）」。

## 5. 日志事件参考

事件信封（内核 `LogEvent`）：

```ts
{ seq: number, at: number /* ms 时间戳 */, type: string, data: object }
```

前端会用到的 `type` 与 `data`（字段来自内核实现，不在此改；新事件类型随时可能出现，客户端忽略即可）：

| type | data | 前端用途 |
|---|---|---|
| `percept.received` | `{ kind, channel, sender?: {id, name?}, text?, urgent?, data? }` | 有 `text` 且有 `sender` 且是当前频道 → 一条「别人说的」消息（`sender.id === 'web-user'` 是网页上的你，其余显示 `sender.name`）。`data` 见下表 |
| `group.policy` | `{ channel, sender, p, why: string[], wake, factors }`（group-policy：这句群消息要不要唤醒她） | 挂到同频道、同发言人的上一条消息下，作「读空气」小字（可开关） |
| `surface.media` | `{ utt, uttId, channel, platform, kind: 'sticker' \| 'image', media, url, mime, alt }`（平台表现端**真正发出**一张图 / 表情包之后记；发言片段早已落日志，只能事后另记。网页对话里她发的表情包由 stickers 插件记，`platform: 'web'`） | 有 `url` 就作为图片挂到 `utt`（或 `uttId`）那条发言；没给 utt = 该频道她最近一条；给了 utt 却找不到（只有表情包没有字的那条结算时当空气泡删了——表情包常是找完才到）= 单独补一条只有图的消息。`sticker.*`（`decided` / `search` / `rejected` / `added` / `sent` / `missed`，stickers 插件的账）网页不用 |
| `perception.started` / `.part` / `.settled` | `{ id, kind, channel, sender? }` / `{ id, text }` / `{ id, …, text, cancelled?, reason? }` | 流式输入（语音等），v2 只进事件流 |
| `utterance.started` | `{ id, action, channel }` | 新建角色消息 |
| `utterance.part` | `{ id, part: { kind, text?, data? } }`；marker 时 `kind:'marker', data:{ track, value }`；图片时 `kind:'image', data:{ media, mime?, alt? }` | 追加文本 / marker；图片按 `/api/media/<media>` 显示在这条消息里（图片不计入送达账：只有图没有字的消息结算时 `delivered` 为空，也要保留） |
| `utterance.settled` | `{ id, channel, delivered, truncated, cause? }` | 收尾；`truncated` 时显示 `delivered` |
| `model.request` | `{ reqId, role, provider, model, messages: [{ role, content, images? }] }`。`images` = 这一轮带的原图 `[{ media, bytes, mime?, alt?, label? }]`（provider-openai 的附件：`media` 是媒体目录里的文件名，`/api/media/<media>` 看得到；发请求时才转 base64，日志里没有图本体；`label` 是大脑那种一整段里给图编的号，如「[图片1]」） | 调试页；行摘要带「N 图 xxKB」 |
| `model.response` | `{ reqId, role, model, chars, usage?: { prompt, completion }, aborted }` | 调试页 |
| `model.fallback` | `{ from: { model, baseURL }, to: { role, model, baseURL }, reason }`（provider-openai：本绑定没出字就失败，改用另一角色重试） | 调试页事件流 |
| `provider.dsml-dropped` | `{ role, model, chars, sample }`（provider-openai：正文里漏出的 DeepSeek 工具调用标记已吞掉，每个请求至多一条） | 调试页事件流 |
| `provider.images-refused` | `{ role, model, error }`（provider-openai：带原图的请求被端点拒了（4xx），已去掉原图、换回文字描述重试一次） | 调试页事件流 |
| `beat.opened` | `{ reasons: [{ source, text, channel? }] }` | 「思考中」开始 |
| `beat.closed` | `{ note?, intents: number }` | 「思考中」结束 |
| `beat.failed` / `beat.fused` | `{ reasons, error }` / `{ emptyStreak }` | 「思考中」结束 / 只进事件流 |
| `action.started` / `action.ended` | `{ id, type, params, channel }` / `{ id, outcome, error? }` | 思考时间线（params.reflex / guidance / append）；`type` 为 `computer` / `dsh` 时在同频道她最近一条消息下挂进度小字，被停掉（outcome ≠ done）时收尾 |
| `computer.step` / `dsh.step` | `{ actionId, step, say?, tool, … }`（action-computer / action-dsh 每步一条；`say` 是一句人话） | 进度小字更新为「第 n 步 · say」 |
| `percept.received` 的 `kind` 为 `computer.result` / `dsh.result` | `data: { actionId, ok, steps, … }` | 进度小字收尾为「做完了 / 没做成（n 步）」；没有 sender，不是一条消息 |
| `reflex.started` | `{ channel, actionId }` | 思考时间线：脊椎（reflex 插件）兜底开口——大脑 `fallbackMs` 内没决定、对方只是打个招呼 |
| `reflex.route` | `{ channel, path: 'think' \| 'fallback', why: string[], count, spine }` | 思考时间线：对方这几句交给大脑（`think`，`spine` = 在兜底白名单里）、或脊椎兜底开口（`fallback`）、为什么。2026-10-22 之前的旧日志里还有 `path: 'reflex'`（反射先开口） |
| `image.degraded` | `{ query, error }`（action-image） | 原尺寸截图 / 大图从身体服务没拿到，改发了小图；前端暂不用 |
| `percept.received` 的 `kind` 为 `search.result` | `text`：给她读的结果摘要；`data: { actionId, ok, kind: 'web' \| 'news' \| 'image', query, provider, elapsedMs, error?, hits?: [{ title, url, site?, date? }], images?: [{ path, url, page?, site?, title?, desc?, checked, fit? }], dropped?, unfit? }`（action-search；`unfit` = 图看过都跟要找的对不上；`provider` 搜图时是 `bing+so360` 这样几家连起来） | 没有 sender，不是一条消息；前端暂不用（调试页事件流照常显示 `kind text`） |
| `mind.decision` | `{ note?, intents, wakeAfterSec?, aborted, tookMs, lean?, reasons: [{ source, text, channel?, carried? }] }` | 思考时间线：大脑（mind-default）想了什么、多久、为什么作废；`lean` = 走了精简材料，`carried` = 上一拍被打断带过来的原因。大脑放行的快回是 intents 里一条 `start reply`，`params: { reflex: true, quick: true }` |
| `intent.blocked` | `{ intent, channel, why: 'reply-running' \| 'merge-pending' \| 'stale-running' \| 'spine-answered' \| 'busy-elsewhere', busy? }` | 思考时间线：硬闸拦了什么（`merge-pending` = 对方还在连发，合流没结束；`stale-running` = 大脑取材料时那个频道有 reply 在跑，等它想完那条已经说完了，再起就是重复；`spine-answered` = 大脑取材料之后脊椎已兜底应过一声；`busy-elsewhere` = 她正在别的会话说话，一次只在一个会话里——脊椎对所有频道都拦，`busy` 是她当时在哪说；group-policy 的排队对群频道也记这个值，说完由它起队首）。旧日志里还有 `reflex-pending` |
| `emotion.changed` | `{ valence, arousal, last?, label }` | 舞台心情基线；时间线 |
| `life.changed` | `{ activity, detail, from, until, by: 'rhythm' \| 'self' \| 'user', seed?, how?: 'chose' \| 'drew', thought?, slot?, cause? }`（life 插件：她此刻在干嘛换了。`by` = 作息到点 / 她在聊天里改 / 用户设；`how` = 到点时她自己选的还是抽签；`thought` 是她选时心里那句；`seed` 是这次抽签的种子） | 前端暂不用（面板「在干嘛」走自己的接口） |
| `life.cleared` / `life.quiet` / `life.failed` | `{ by: 'user' }` / `{ channel, activity }` / `{ error }`（用户清掉状态 / 睡着时她自己想找话被拦下 / 她自己选没选出来、退回抽签） | 前端不用 |
| `computer.step` | `{ actionId, channel?, step, say?, tool?, observation?, shot?, done?, ok?, result? }`（action-computer 插件） | 她电脑任务的每一步：对话里那条「这就去弄」下面的实时进度小字（`say`），`shot` 是截图文件名（`/api/media/<shot>`），`done` 为收尾 |
| `percept.received`（`kind: 'computer.progress' \| 'computer.result'`） | `data: { actionId, task, phase?: 'start' \| 'stuck' \| 'ask', step?, question?, ok?, result? }` | 电脑任务的关键节点（开始 / 卡住 / 要问对方）与结果；带 `channel`，可当该对话的进度提示 |

`ModelStreamEvent`（随 `__stream__`）：`{ reqId, at, chunk }`，其中 `chunk.type === 'text'` 时有 `chunk.text`；其他 `chunk.type` 忽略。

**平台感知的 `data`**（surface-onebot 等平台插件填，全部可选；网页对话一个都没有）。前端据此标来源、画发言人、出图：

| 字段 | 含义 | 网页怎么用 |
|---|---|---|
| `platform` | `qq` 等 | 对话列表的来源图标 |
| `chat` | `group` \| `private` | 同上（缺省时按频道名第二段推） |
| `groupId` / `groupName` | 群号 / 群名 | 列表标题用群名 |
| `avatar` | 发言人头像地址（可省；没有就画名字首字的占位头像） | 消息左边的头像 |
| `mentioned` | 这句 @ 了她 | 气泡高亮 |
| `images` | `[{ url, alt?, sticker? }]`：这句里的图片 / 表情包。文件存进 surface-web 的媒体目录（`data/media`），`url` 即现成的 `/api/media/<文件名>`（`web/route` 只能回 JSON，传不了图） | 渲染成图；正文里的 `[表情包：…]` `[图片：…]` 占位就不再单独显示。没有 `images` 时退回文字描述 |
| `source` | `{ chatId, chatTitle, senderId, senderName, senderAvatar, … }`（surface-onebot 额外给的汇总，与上面各字段重复） | 网页暂不读 |
| `media` | `[{ kind: 'image' \| 'sticker', media, url, mime, alt?, what?, shown?, inline?: { media, bytes } }]`（surface-onebot：`images` 的完整版。`inline` 是给模型看的副本（长边 `images.inline.maxSide` 的 JPEG），有它这张才可能以原图进发言者 / 大脑的上下文；`shown` 是正文里这张图的原文「[图片：…]」，原图进上下文时换成「[what]」） | 网页暂不读 |


## 6. 版本

| 版本 | 日期 | 变更 |
|---|---|---|
| 1 | 2026-10-12 | 初版。相对 v1 前端的隐式协议：路径加 `/api/` 前缀；新增 `/api/meta` 与 `web/meta` 水线；静态产物由插件服务 |
| 2 | 2026-10-12 | `meta.voice` / `meta.commands`、`/api/tts`、`/api/command`、`/api/perception/*`；新增日志事件 `reflex.started` `mind.decision` `intent.blocked` `emotion.changed`；多对话：`/api/events?channel=`、`/api/conversations`、`/api/input.channel`；总线事件 `web/clients` 供终端让位 |
| 2（追加） | 2026-10-12 | `meta.character.stage`（可选，兼容追加，版本号不变）：角色包切换舞台实现（live2d / tachie） |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：`meta.character.id`、`meta.characters`（角色包列表）、`meta.skins`（静态目录里的 Live2D 模型）；`GET` / `POST /api/persona`（读写人格配置）；切换角色 / 皮肤仍走 `/api/command`（新命令 `/character skin <profile>`） |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：`GET` / `POST /api/models`（读写 provider-openai 角色绑定，即模型路由）；日志事件 `model.fallback` |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：`meta.pet`（桌宠是否显示）；开关命令 `/pet on\|off` |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：通用设置 `GET /api/plugins`、`GET`/`PUT /api/plugins/:id/config`、`POST /api/plugins/:id/enabled`；`GET`/`POST /api/secrets`（只写不读）；`GET /api/status`；`meta.panels`；水线 `web/route`（插件自带接口）与 `web/status`（状态卡片）；清单可选字段 `mumu.title`、`mumu.ui`（§7） |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：来源适配——`/api/conversations` 每项加 `source`（platform / kind / id / name）与 `said`（她今天在这说了几条），标题优先用群名 / 对方名；平台感知 `data` 约定 `platform` `chat` `groupName` `avatar` `mentioned` `images`；前端消费日志事件 `group.policy`（读空气小字）与 `surface.media`（平台真正发出的图 / 表情包，按 `utt` 挂到那条发言）；平台收到的图存媒体目录、走 `/api/media` |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：日志事件 `reflex.route`（反射分流）、`intent.blocked.why` 多两个值 `merge-pending`、`stale-running`；bench 插件接口 `GET /api/bench/thread`、`POST /api/bench/judge-thread`（测试工具，前端不用） |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：各平台网名——`/api/persona` 的 `aliases`、`meta.character.aliases`；插件判断「是不是在叫她」改读水线 `persona/names`（handbook §6） |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：表情包——stickers 插件接口 `GET /api/stickers/items`、`GET /api/stickers/img/<文件名>`（缩略图）、`POST /api/stickers/items/{disable,enable,delete,recheck}`、`POST /api/stickers/recheck-all`、`POST /api/stickers/find`；`web/status` 的「表情包」卡片；网页对话里她发的表情包记 `surface.media`（`platform:'web'`），`utt` 找不到时前端单独补一条只有图的消息。通用面板：列 `format: 'image'`（画缩略图）、按钮 `input`（旁边带输入框，请求体多 `input`）、按钮响应里的 `message` 显示在面板上；`web/route` 可回 `Buffer`（`contentType`、`cache`） |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：她自己的兴趣——interests 插件接口 `GET /api/interests/items`、`GET /api/interests/score?text=`（`{ text, score, hits: [{ name, score }] }`）、`POST /api/interests/{add,set}`（`input`：「名字=分」）、`POST /api/interests/{up,down,delete}`（`item`）；`web/status`「兴趣」卡片；日志事件 `interests.read` / `interests.changed` / `interests.removed` / `interests.failed`（前端不用）。通用面板加可选字段 `near`（`'persona'` = 也挂在人格抽屉底下） |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：群聊脾气——group-policy 接口 `GET /api/group-policy/temper`（面板「脾气（按人）」的行）、`POST /api/group-policy/temper/forgive`（`item`）；日志事件 `temper.ignored { key, name, channel?, mode: 'ignore' \| 'block', minutes, until, why }`、`temper.forgiven { key, name, why }`（她决定不理 / 拉黑 / 原谅了谁，前端暂不用）；`group.policy` 的 `why` 不再出现「不接 / 不理」的硬判，带低俗词 / 机器人 / 连问只是材料，`bot: true` 的行 `p` 不再恒为 0，新增 `ignored: 'ignore' \| 'block'`（被她不理的人的话） |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：大脑门控——`reflex.route.path` 改为 `'think' \| 'fallback'` 并加 `spine`；`intent.blocked.why` 加 `spine-answered`、不再出现 `reflex-pending`；`mind.decision` 加 `lean`、`reasons[].channel` / `carried`；reply 的 `params.quick`（大脑放行的快回，另带 `note`）；日志事件 `reflex.quick-demoted { channel, intent }`（快回被降成正常回复，前端暂不用）。旧日志里的旧值前端照常显示原文 |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：搜索——action-search 插件的感知 `search.result`（前端暂不用）、`web/status`「搜索」卡片（已配置 / 没密钥、今天搜了几次） |
| 2（追加） | 2026-10-22 | 兼容追加，版本号不变：`intent.blocked.why` 的 `busy-elsewhere` 由脊椎对所有频道硬闸（原来只有 group-policy 排队对群记），并多带可选字段 `busy`（她当时在哪个频道说话） |
| 2（追加） | 2026-10-23 | 兼容追加，版本号不变：她此刻在干嘛——life 插件接口 `GET /api/life/items`（面板「在干嘛」的行：`{ time, activity, by, thought, from, until }`，`time` 是「HH:MM–HH:MM」，第一行以「现在」开头的是现在这件）、`GET /api/life/now`（`{ state: LifeState \| null, slot, slotEndsAt, due }`）、`POST /api/life/set`（`input`：「在吃火锅」「拼乐高 40」，结尾数字 = 管多少分钟，不带就管到下一个时段）、`POST /api/life/next`（换一个；可带 `{ at: 'HH:MM', weekend? }` 假装是那个时间抽，调试用）、`POST /api/life/clear`（清掉，按作息马上重定）；面板 `near: 'persona'`；`web/status`「在干嘛」卡片；日志事件 `life.changed` / `life.cleared` / `life.quiet` / `life.failed`（§5，前端暂不用） |
| 2（追加） | 2026-10-23 | 兼容追加，版本号不变：兴趣改成语义打分——`GET /api/interests/score?text=` 的 `score` 是感兴趣程度（相近度 × 兴趣分，取最相近的那条），`hits` 每项多 `near`（相近度 0～1）：`{ text, score, hits: [{ name, near, score }] }`；日志 `interests.failed` 多一种 `{ stage: 'score', via, error }`；`group.policy.factors` 可多一个 `interest`（乘上去的兴趣系数），`why` 里写「聊到她感兴趣的（航天，相近 0.72）×1.6」（前端照常按字符串显示）；`GET /api/interests/items` 每行多 `desc`（这条兴趣的一句描述，面板不占列、搜索可搜） |
| 2（追加） | 2026-10-23 | 兼容追加，版本号不变：原图进上下文——`model.request.messages[].images`（原图附件：文件名 + 字节数，调试页行摘要显示「N 图 xxKB」）、日志事件 `provider.images-refused`、平台感知 `data.media[].inline` / `shown` / `what`；配置 surface-onebot `images.inline.{count, withinMin, maxSide, quality, stickers, maxBytes}`、provider-openai `mediaDir`（通用设置表单自动出现） |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：图片消息 `Part { kind: 'image', data: { media, mime?, alt? } }`（旧客户端照常忽略）；`GET /api/media/<name>` 提供图片文件 |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：desktop-pet 插件接口 `GET /api/desktop-pet/state`（桌宠设置 + 心跳）、`web/status` 的「桌宠」卡片 |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：action-computer 插件接口 `GET /api/action-computer/tasks`（「电脑任务」log 面板的行）、`GET /api/action-computer/shots[/<id>]`（每步截图的元数据，文件本体走 `GET /api/media/cshot-*`）、`POST /api/action-computer/stop`（急停）；`web/status` 的「电脑身体」卡片 |
| 2（追加） | 2026-10-21 | 兼容追加，版本号不变：前端消费已有日志事件 `computer.step` / `dsh.step` / `*.result` 感知，在发起电脑上的活的那条消息下显示一行实时进度小字；action-dsh 插件接口 `GET /api/action-dsh/log`（「DSH 任务」log 面板）、`POST /api/action-dsh/stop`，`web/status`「DSH」卡片 |

## 7. 插件如何上网页

原则：**插件不改 surface-web、不改前端**，只在自己的目录里声明，网页自动出现。三件事各管一层：

**① 配置表单——什么都不用写。** 清单 `mumu.defaults` 里的每个字段，「设置」里自动有一个控件：布尔 → 开关，数字 → 数字框，
字符串 → 输入框（长的或带换行的 → 多行），数组 → 可增删的列表，对象 → 可折叠的一组，形状太杂的 → JSON 编辑框。
每项显示出厂值、「改过」标记和「恢复默认」。想好看一点，在清单里加可选的 `mumu.ui`（键是点路径，数组元素不单独标）：

```json
"mumu": {
  "title": "群聊策略",
  "defaults": { "replyRate": 0.3, "mode": "mention", "prompt": "…", "token": "" },
  "ui": {
    "replyRate": { "label": "插话概率", "hint": "没被 @ 时主动接话的概率", "widget": "slider", "min": 0, "max": 1, "step": 0.05 },
    "mode": { "label": "触发方式", "widget": "select", "options": ["mention", "name", "always"] },
    "prompt": { "widget": "textarea" },
    "token": { "secret": true },
    "internal": { "hidden": true }
  }
}
```

`widget` 可选 `slider` `select` `textarea` `password` `json`；`options` 也可以是 `[{ "value": "…", "label": "…" }]`。改了 `mumu.ui` 不用重启（每次打开表单现读）。

**键名里带点**（如 provider 的 `roles` 下 `mind.decide`）：`ui` 的键里把这个点写成 `\.`，JSON 里即 `"roles.mind\\.decide": { "label": "导演" }`；
不转义的 `"roles.mind.decide"` 也认（兼容）。表单内部按键名数组逐级走，带点的键名始终是一个键，不会被拆成两层写坏。

**② 自带接口——认领 `web/route` 水线。** surface-web 把自己不认识的 `/api/*` 请求交给它；路径建议用 `/api/<插件id>/…`：

```ts
import type { WebRoute } from '../surface-web/index.ts'

ctx.intercept<WebRoute>('web/route', async (r, next) => {
  if (r.method === 'GET' && r.path === '/api/memory/items') {
    r.response = { body: { items: store.list(r.query.q) } } // status 缺省 200
    return r
  }
  return next() // 不是我的，交给下一个
})
```

`r` 是 `{ method, path, query: Record<string,string>, body }`（`body` 已按 JSON 解析，GET 为 `undefined`）。
要回图片之类的字节：`r.response = { body: buf, contentType: 'image/png', cache: true }`（`body` 是 `Buffer` 就原样回；`cache` 带长缓存，只给「名字即内容」的地址用）。用水线而不是服务：
surface-web 换皮肤等会重载，服务一消失注入它的插件就要连带重载；水线挂在各插件自己身上，互不牵连。

**③ 面板——经 `web/meta` 报一个定义。** 前端「设置 → 面板」按 `kind` 统一渲染，自带搜索与分页：

```ts
ctx.intercept<{ panels?: WebPanel[] }>('web/meta', async (meta, next) => {
  meta.panels = [...(meta.panels ?? []), {
    id: 'memory', title: '记忆', kind: 'table', endpoint: '/api/memory/items',
    columns: [{ key: 'text', label: '内容' }, { key: 'at', label: '时间', format: 'time' }],
    actions: [{ label: '整理一次', endpoint: '/api/memory/compact', method: 'POST', confirm: '确定？' }],
    rowActions: [{ label: '删除', endpoint: '/api/memory/delete', method: 'POST', confirm: '删掉这条？' }],
  }]
  return next()
})
```

| 字段 | 说明 |
|---|---|
| `kind` | `table`（表格）· `cards`（卡片，每项显示全部字段）· `json`（原样）· `log`（滚动日志，最新在下） |
| `endpoint` | `GET` 它取数据。`table` / `cards` 认数组或 `{ items: [] }`；`log` 认字符串数组或 `{ lines: [] }`；`json` 任意 |
| `columns` | 可选，`[{ key, label?, format?: 'time' \| 'image' }]`；`time` 把毫秒时间戳显示成本地时间；`image` 的值是图片地址（站内 `/api/…` 或 http(s)），表格里画小缩略图、卡片里画在卡片顶上。缺省取第一项的全部键 |
| `actions` | 面板顶部的按钮：`{ label, endpoint, method?: 'POST', confirm?, input? }`，请求体 `{}`，做完自动刷新。有 `input`（占位提示）就在按钮旁放一个输入框，请求体是 `{ input: <输入的文字> }`，空着不发；回车也算点。响应里有字符串 `message` 就显示在面板上（如「入库：…」），失败显示 `error` |
| `rowActions` | 每行的按钮：同上，请求体 `{ item: <这一行> }`（`input` 只对顶部按钮有效） |
| `refreshSec` | 可选，自动刷新间隔（`log` 默认 3 秒，其余不自动刷新） |
| `near` | 可选，也挂在哪个专用面板底下：目前认 `'persona'`（人格抽屉底部，同一个通用面板组件画）。「设置 → 面板」里照常有 |

**④ 状态卡片——认领 `web/status` 水线**（「状态」页）：

```ts
import type { StatusCard } from '../surface-web/index.ts'

ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
  s.cards.push({ id: 'qq', title: 'QQ', level: connected ? 'ok' : 'err', text: connected ? '已连上 NapCat' : '连不上 NapCat', items: [`ws: ${url}`] })
  return next()
})
```

类型 `WebRoute` / `WebPanel` / `StatusCard` 随 surface-web 的 `index.ts` 导出，按 CLAUDE.md §2.6 只许 `import type`。

