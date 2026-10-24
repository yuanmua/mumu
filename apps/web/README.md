# @mumu/web

沐沐的浏览器前端：Live2D 舞台 + 流式字幕 + 语音 + 思考可视化。**只认 [docs/web-protocol.md](../../docs/web-protocol.md)**，不 import `src/`（边界测试第三条守着）。

## 跑起来

```bash
npm start            # 终端 1：后端（surface-web 在 3939）
npm run dev:web      # 终端 2：Vite 在 http://localhost:5173，/api 代理到 3939
```

正式用：`npm run build:web` 后直接开 http://127.0.0.1:3939 ，产物由 surface-web 插件服务。

检查：`npm run check:web`（vue-tsc）· `npm run test:web`（vitest，只测纯函数）。

## 页面

| 路径 | 内容 |
|---|---|
| `/` | 舞台铺满；左上角色名 + 状态（离线 / 在线 / 在想 / 说话中）+ 心情 + **「＋ 新对话」** + **「人格」**（左侧抽屉改 name / 人设 / 腔调 / 要求 / emo、act 词）+ **「模型」**（左侧抽屉改每个环节用哪个模型）+ 语音开关 + 「内心」开关（显示导演最近一句想法），下一行 **「角色」「皮肤」两个下拉**；右上「记录」抽屉：**对话列表（新建 / 切换）** + 当前对话记录；底部流式字幕（语音关时按阅读速度逐字出）+ 输入框（Enter 发送，发送即打断；🎤 浏览器语音输入） |
| `/`（设置） | 角色栏「设置」：左边全部插件（状态点：绿在跑 / 灰停用 / 红失败）+ 插件报的「面板」+「密钥」；右边按插件合并后的配置**自动生成表单**（布尔→开关、数字→数字框、短字符串→输入框、长的→多行、纯值数组→可增删列表、对象→可折叠分组、其余→JSON 框；清单 `mumu.ui` 有提示就用），每项显示「改过」「恢复默认」，底部保存 / 撤销 / 全部恢复默认；启停开关；人格、模型给专用面板的快捷入口 |
| `/status` | 状态总览：网页连接、插件失败、在跑的动作，以及插件经 `web/status` 报的卡片（模型路由与探活、QQ、guard…）；10 秒一刷，标签页看不见时不刷（卡片可能触发探活） |
| `/debug` | **思考**：按轮次的时间线（你说了什么 → 反射几毫秒开口 → 回复首字多久、说了什么、被打断在哪 → 导演想了什么、为什么不动、硬闸拦了什么 → 心情变化）· **事件**：原始日志流 · **模型**：每次调用的 prompt / chunk 时间轴 / 结果 · **命令**：执行 `/plugins` 等 |

## 结构

```
src/
├─ app/runtime.ts        协议客户端 + 投影 + 发声接在一起；副作用唯一执行点
├─ protocol/             types.ts（与协议文档一一对应）· client.ts（聊天相关网络调用）· admin.ts（设置 / 状态 / 面板的形状与网络调用）
├─ store/                projection.ts（日志 → 状态，纯 reduce）· thinking.ts（日志 → 思考时间线）· *.test.ts
├─ voice/                sentence.ts 分句 · player.ts 播放队列 + 音量 · mouth.ts 口型 · speaker.ts 字幕/语音/回执同步 · listen.ts 语音输入
├─ stage/                Stage.vue（按角色包选实现）· StageLive2D.vue + live2d/{profile,loader,driver,gestures}.ts · StageTachie.vue + tachie/{profile,driver,gestures}.ts + TachieNotice.vue
├─ views/                ChatView · DebugView · StatusView（只组合组件）
├─ components/settings/  SettingsDrawer · PluginConfig · ConfigField（递归）+ configForm.ts · PanelView（通用面板）+ panelData.ts · SecretsBox · settings.test.ts
├─ components/chat/      CharacterBar · CharacterPicker · PersonaPanel + personaForm.ts · ModelPanel + modelsForm.ts · Subtitle · HistoryDrawer · ConversationList + sources.ts · MessageBubble · Composer
├─ components/debug/     Thinking · EventStream · EventRow · ModelCalls · ModelCallDetail · CommandBox · DangerZone
└─ styles/               tokens.css（颜色只在这）· base.css
```

规则：组件只渲染；网络只在 `protocol/`（`client.ts` / `admin.ts`）；**不为任何具体插件写设置界面**——插件的配置走通用表单、自己的数据走通用面板（协议 §7），专用面板（人格、模型）只是快捷入口；状态只在 `store/projection.ts` 改；`stage/` 与 `voice/` 互不 import。

## 对话

对话 = 内核频道。默认 `main`；「新对话」（角色栏和记录抽屉各一个按钮，同一个 `runtime.newConversation()`）生成 `c:<id>`，发第一句后出现在列表里。每个对话历史独立、打断独立；角色的心情和工作记忆跨对话共享（她是同一个人）。切换对话 = 用 `?channel=` 重连事件流，服务端只重放那个对话。

**来源适配**（QQ 等平台的会话也在同一个列表里）：

- 列表每项标来源（🌐 网页 / 👥 QQ 群 / 💬 QQ 私聊，`sources.ts` 按 `source.kind` 给图标、前面加平台名，新平台不用改），可按来源筛选；
  标题是群名 / 对方名（`/api/conversations` 的 `source.name`，群名没报上来时显示「群 <号>」）；红点是未读（`count` − 这个浏览器看过时的 `count`，存 `localStorage.mumu.seen`），另显示「她今天说了几条」（`said`）。
- 平台会话里按她的视角排：别人在左、她在右，各带名字与首字头像（感知 `data.avatar` 有图就用图）；@ 她的那句高亮；
  `percept.data.images` 有图就出图，正文里的 `[表情包：…]` 占位随之去掉；她发的表情包来自 `surface.media`（平台真正发出后记，按 `utt` 挂到那条发言）。
- 群里「读空气」开关：每句下面一行小字，`group.policy` 的结论（叫醒她 / 没接 · 理由 · p）。
- 平台会话**只看不发**：输入框给说明、不发出去——在网页上发，她会在真群里接「网页上的你」。

## 送达回执怎么对账

| 语音 | 字幕 | 回执（`POST /api/delivered`） |
|---|---|---|
| 关 | 打字机按阅读速度逐字呈现（32ms/字，句末、分段有停顿） | 跟着呈现进度回执（每 200ms 一次，结束时补最后一次） |
| 开 | 一句音频**开始播**时显示到该句末尾 | 一句音频**播完**时回执到该句末尾 |

被打断：音频立停、队列清空，字幕回退到 `delivered`。内核记的 delivered = 你真听到的。

## 舞台实现

`Stage.vue` 只定义 `props: { state, mouth, stage? }`，按 `/api/meta` 里 `character.stage.kind` 选实现；取不到 meta（后端没起、没装 characters 插件）走 Live2D 默认。
两种实现接同一份 `StageState`，同一套词汇；词怎么演由各自目录下的 `profile.json` 决定（词汇归插件，映射归角色）。

| kind | 实现 | 档案 | 能演什么 |
|---|---|---|---|
| `live2d` | `StageLive2D.vue` + `live2d/` | `public/live2d/models/<id>/profile.json` | 表情文件、参数姿态、程序化手势、动作文件、眼神跟随、真口型 |
| `tachie` | `StageTachie.vue` + `tachie/` | `public/characters/<id>/profile.json` | 整图切换表情（200ms 淡入淡出）+ CSS transform 程序化动画，零依赖 |

**立绘（tachie）怎么动**：全部程序化，不依赖图的数量——呼吸（1–2% 缩放与起伏）、待机轻微摆动、眨眼（随机 2–6 秒，有闭眼图才闭 120ms）、口型（有张嘴图按口型值交叉淡入，没有就轻微点头）、手势（与 `live2d/gestures.ts` 同名同时长，另加 `lookDown` `lift` `lookUp`）、被打断 `flinch`。`tachie/driver.ts` 不碰 DOM、时钟可注入，vitest 测时间线；组件只把每帧结果写到元素上。

立绘档案 `profile.json`：

```json
{
  "base": "base.png",                      // 必需：全身、闭嘴、平静
  "eyesClosed": "eyes-closed.png",         // 可选：整图或只画眼睛
  "mouthOpen": "mouth-open.png",           // 可选：整图或只画嘴
  "fit": { "height": 1.02, "y": -0.02 },   // 立绘高 = 视口高 × height；底边抬高 = 视口高 × y
  "blink": { "minSec": 2, "maxSec": 6, "holdMs": 120 },
  "moods": { "happy": "开心", "neutral": "平静" },        // 心情基线 → 表情词或图文件
  "expressions": { "开心": "open.png", "大笑": { "image": "laugh.png", "gesture": "bounce" }, "好奇": { "gesture": "tilt" } },
  "actions": { "点头": "nod", "捂脸": { "image": "blush.png", "gesture": "flinch" } },
  "interrupted": { "image": "surprised.png", "gesture": "flinch" }
}
```

字符串简写：带图片后缀的是图，否则是手势名。查不到的表情词 → 回底图并歪头；查不到的动作词 → 小幅点头；显式表情 10 秒后回到心情基线。
缺图的降级：底图缺 → 舞台整个是说明卡（要哪些文件、放哪、尺寸、姿势要求）；表情图缺一两张 → 照常演，那个词停在上一张，顶上一枚小标签可展开清单。聊天都不受影响。
原木的图清单与生成提示词在 `public/characters/yuanmu/README.md`。

## 角色包、皮肤、人格

角色（人设 + 舞台 + 声音）由 `plugins/official/characters` 的角色包定义，前端不写死任何角色：`/character use <id>` 后 surface-web 重载、事件流重连、`loadMeta()` 重新取到 `character.stage`，`Stage.vue` 据此换实现（key 用解析后的目录，同一个模型不重建）。

- **角色下拉**列 `meta.characters`，选中发 `/character use <id>`；**皮肤下拉**列 `meta.skins`（产物里有 `profile.json` 的 Live2D 模型），选中发 `/character skin <profile>`，只换舞台不换人设。
  两个下拉的值只认 meta：后端重载、重连、重新取到 meta 才算换好，中间显示「切换中」。皮肤写在后端配置里，所以刷新不弹回。
- **人格抽屉**每次打开重新 `GET /api/persona`，保存 `POST /api/persona`（字段语义见协议文档；「要求」三态：用内置 / 自定义 / 不要）。表单只编辑 emo、act 两组词，别的 marker 通道原样带回。表单换算在 `personaForm.ts`（vitest 测）。
- **舞台等第一次 meta 有结果再挂**（`meta.ready`，取不到也算）：否则先按默认模型加载、meta 到了又换，两个 Live2D 画布同时活着会弄坏 Cubism 共享的着色器，舞台全空。`StageLive2D` 另外在加载途中被卸载时立刻拆掉自己。
`?model=<id>` 查询串仍最优先（调试用），其次角色包，再次 `localStorage.mumu.model`。

## Live2D 资产

| 资产 | 来源 | 放哪 | 入库 |
|---|---|---|---|
| Cubism Core | `index.html` 先试本地 `public/live2d/core/live2dcubismcore.min.js`，没有就用 Live2D 官方 CDN | 可不放 | 否 |
| 模型 | [Live2D/CubismWebSamples](https://github.com/Live2D/CubismWebSamples) 的 `Samples/Resources/`（Natori / Haru / Hiyori，免费素材许可，开发可用；对外发布前确认条款） | `public/live2d/models/<id>/` | 否 |
| `profile.json` | 自己写：词 → 表情文件 / 参数姿态 / 程序化动作 / 动作文件 | 模型目录 | **是** |

默认模型 `hiyori`（沐沐暂用的皮肤，无表情文件、全靠参数姿态），由角色包 `mumu` 指定，取不到 meta 时前端也回落到它。临时换模型：`?model=haru`（女性，8 个表情文件）或 `?model=natori`（男性管家，命名表情）或 `localStorage.setItem('mumu.model','haru')`；正式换皮肤用角色栏的「皮肤」下拉（`/character skin`），换角色用「角色」下拉（`/character use <id>`）。自己的模型：放进目录，写一份 profile.json（抄 natori 的改）。没有表情文件的模型（如 Hiyori）全靠 `pose` 参数偏移 + `gesture` 程序化动作，任何标准参数的模型都能演。

## 依赖理由

| 包 | 为什么 |
|---|---|
| vue / vue-router | 框架与两条路由 |
| pixi.js 6.5.10 + pixi-live2d-display 0.4.0 | Cubism 4/5 模型在浏览器里最省事的组合；0.4.0 只兼容 PixiJS 6，**不要升** |
| vite / @vitejs/plugin-vue / vue-tsc / vitest / typescript | 构建、类型、测试 |

没有别的。要加先在这里写一行。
