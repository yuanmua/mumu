# 外围方案 v2 —— 插件套件 + Web 前端 + Live2D 对话

> **外围 = 内核之外的一切**：插件套件与浏览器前端是一套东西，一起设计、一起重建、一起验收。
> 终态只有一句话：**打开浏览器，就能和一个 Live2D 角色对话**——打字或说话，她流式回答、有表情有动作、会动嘴，可以被打断。
>
> 状态：**已实施（2026-10-12）**，P0–P5 完成，P6 以实验形态完成。本文 + [web-protocol.md](web-protocol.md) 是外围的全部规格；
> 实施中的发现与改动记在 §10。
> 实施前先读 [../CLAUDE.md](../CLAUDE.md)；内核约定见 [handbook.md](handbook.md)。
> 本文取代 2026-10-12 早些时候的 `web-frontend.md`（已并入 §5）。

---

## 1. 终态与验收

打开 `http://127.0.0.1:3939`：

1. Live2D 角色在舞台上待机（呼吸、眨眼、偶尔看看别处）。
2. 在底部输入框打字回车，角色**流式**回答：字幕逐字出现，嘴随之开合，`<|emo:开心|>` 这类 marker 让她换表情，`<|act:点头|>` 让她做动作。
3. 开了语音，回答会被念出来，口型跟着声音。
4. 她说到一半你再发一句，她**立刻停**，字幕与声音都停在同一处；终端 `/log` 里 `utterance.settled.delivered` 与你实际看到、听到的**逐字一致**（内核不变量 I2）。
5. 刷新页面，对话还在（从日志重放）。
6. `/debug` 页能看到每一条日志、每一次模型调用、每个 chunk 到达时刻。
7. 密钥不在任何文件里；`git status` 干净。

七条全部成立，外围 v2 完成。

---

## 2. 总体结构

```
┌──────────────── 浏览器 apps/web（Vite + Vue 3 + TS）─────────────────┐
│  StageLive2D（pixi-live2d-display）  ·  字幕 / 聊天记录  ·  输入框     │
│  store/projection：日志 → 状态（纯函数）                               │
│  voice/：分句 → /api/tts → Web Audio 播放 → 分析器 → 口型              │
└───────────────────────────── JSON / SSE ─────────────────────────────┘
                     契约：docs/web-protocol.md
   apps/desktop（Electron 桌宠）= 同一个页面装进透明置顶窗口，不另写界面
┌──────────────── plugins/official（插件套件 v2）──────────────────────┐
│  surface-web   零依赖 HTTP + SSE 传输层 · 静态产物 · /api/tts 转发    │
│  surface-cli   终端表现端 + 管理命令（/plugins /config /secret …）    │
│  tts           文本 → 音频（服务 `tts`），P4 起                        │
│  persona · expression-basic   人格段落 · marker 词汇                   │
│  mind-default · action-reply  导演 · 发言                              │
│  provider-openai              OpenAI 兼容适配器，密钥按名字取          │
│  secrets                      密钥服务：只存本地库，永不进文件          │
│  storage-sqlite               日志落盘 · 配置库 · 裸 db 句柄           │
└──────────────────────────────── ctx ─────────────────────────────────┘
                            内核（不动）
```

三条硬规则，继承自内核：

1. **内核不动。** 外围需要什么，先看日志里有没有、水线上能不能拦；真缺，先在汇报里提出。
2. **前端不 import `src/`。** 它只认 web-protocol.md（边界测试第三条）。
3. **UI 是日志的纯投影。** 前端不持第二份状态；重放阶段只建状态不发副作用。

---

## 3. 插件套件 v2

第一版 9 个插件整层删除重建。每个插件有 `package.json`（`mumu` 字段）、`README.md`（是什么 · 暴露什么 · 怎么改它）、`index.ts`。

| id | order | 职责 | inject | 暴露 |
|---|---|---|---|---|
| **storage-sqlite** | -100 | 日志落盘；配置库；裸 `node:sqlite` 句柄给别的插件开表 | — | 服务 `config` `db` |
| **commands** | -95 | 管理命令注册表：插件登记 `/命令`，终端与 Web 调试页共用 | — | 服务 `commands` |
| **secrets** | -90 | 密钥服务。独立表 `secrets(name, value)`，与配置树物理分离，`list()` 只返回名字 | `db` `commands` | 服务 `secrets`；`/secret set\|del\|list` |
| **provider-openai** | -10 | OpenAI 兼容适配器。绑定只有 `apiKeyRef`，请求时向 secrets 取；缺密钥让请求失败并打印修复命令 | `secrets` | provider `openai`，角色 `default` `mind.decide`（JSON 模式）`performer` |
| **mind-default** | 0 | 单级导演：JSON 决策、校验、重试、降级；**新输入或反射开口即作废进行中的思考**；落 `mind.decision` | — | `mind` decider 槽 |
| **reflex** | 0 | 快车道：对话消息合流 350ms 后直接起 reply；`intent/pre-dispatch` 硬闸保证同频道单回复；`beat/gather` 告知导演；广播 `reflex.fired` | — | 日志 `reflex.started` `intent.blocked` |
| **action-reply** | 0 | 流式发言；marker 通道 emo/act/br/tool；引导放 system 尾部；对方没说话时 `[旁白]` 给开口契机 | — | 动作 `reply` |
| **expression-basic** | 0 | 25 个带场景提示的表情/动作词 + 放置教学 + `<\|br\|>` 分段 | — | marker 词汇、段落 |
| **emotion** | 0 | 情绪状态：自表达推动、对方来消息提神、随时间回落；段落 + 材料块 + `emotion.changed` | — | 服务 `emotion` |
| **persona** | 0 | 人格段落（所有受众）+ 说话方式（发言者）+ 专属词 + `web/meta` 报名字 | — | 段落 |
| **clock** | 0 | 时间感：现在几点、对方沉默多久 | — | 段落 |
| **characters** | 0 | 角色包：`characters/<id>/character.json` 把人设、舞台（live2d / tachie）、声音打包；`/character use` 写进 persona / tts / surface-web 的配置，由装配层重载 | `config` `commands` | `/character list\|use`；水线 `web/meta` 补 `character.stage` |
| **tts** | 5 | 文本 → 音频，OpenAI 兼容 `/v1/audio/speech`，密钥走 `apiKeyRef` | `secrets` | 服务 `tts` |
| **surface-cli** | 10 | 终端表现端；登记 `/plugins /plugin /config /log /stream /quit`；无终端时安静 | `loader` `app` `config` `commands` | 水线 `cli/render` |
| **surface-web** | 10 | 传输层：协议全部端点 + 静态产物；有浏览器连着才注册回执端；`tts` 可选 | `config` `commands` | 水线 `web/meta` |

插件之间只 `import type` 契约，运行时协作走服务 / 水线 / 事件。

### 3.1 secrets 为什么是独立表而不是配置树的一个分支

配置树会被 `/config get` 整棵打印、会被调试页展示、将来可能被导出。密钥放在里面迟早被打出来。
独立表 + 独立服务 + `list()` 只返回名字，三道口子都封住；`provider` 侧只存 `apiKeyRef`，`package.json` 里永远是一个名字。

### 3.2 tts 为什么是插件而不是前端自己做

语音服务商要密钥，密钥不能到浏览器。前端只拿 `text` 换 `audio`。
P3 阶段前端可以先用浏览器自带的 `speechSynthesis` 零成本试听，但那条路拿不到音频数据、做不了真口型，所以只是过渡。

---

## 4. 协议

[web-protocol.md](web-protocol.md) v1 是文本对话的契约。外围 v2 在其上**追加**（已写进该文档的「v2 计划」节，实施到对应里程碑时移入正文）：

| 追加 | 用途 | 里程碑 |
|---|---|---|
| `GET /api/meta` 增加 `voice: { available: boolean }` | 前端决定是否显示语音开关 | P4 |
| `POST /api/tts` `{ text }` → `audio/*` 二进制 | 分句合成 | P4 |
| `POST /api/perception/start|update|end` | 浏览器语音识别的流式输入，映射到内核 `io.perceive()` | P6 |

---

## 5. 前端 apps/web

### 5.1 选型（已定）

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Vue 3.5，`<script setup lang="ts">` | 日志 → 响应式状态 → 视图；Live2D 生态里 Vue 范例多 |
| 构建 | Vite 6 | dev 代理 `/api` 到 3939 |
| 类型 | TypeScript strict + vue-tsc | 与内核同纪律 |
| 路由 | vue-router 4 | `/` 与 `/debug` |
| 测试 | vitest | 只测纯函数：投影、分句、协议解析 |
| 样式 | 原生 CSS + 变量，`<style scoped>` | 不引入 UI 库 |
| **Live2D** | `pixi.js@6.5.10` + `pixi-live2d-display@0.4.0`（只用 `/cubism4` 入口） | 这是 Cubism 4/5 模型在浏览器里最省事的组合；0.4.0 只兼容 PixiJS 6，**不要升 PixiJS 7/8** |
| Cubism Core | `index.html` 同步 `<script>` 从 Live2D 官方 CDN 加载 | 闭源运行时，不在 npm 上；`pixi-live2d-display` 在 import 时就要求它存在，所以必须同步、必须在模块之前；舞台代码动态 import，Core 缺失只影响舞台 |

允许的依赖只有上面这些。加别的先在 `apps/web/README.md` 写理由。

### 5.2 目录

```
apps/web/
├─ package.json          @mumu/web（无 mumu 字段：不是插件）
├─ vite.config.ts        proxy /api → 3939；outDir dist
├─ index.html            <script src="/live2d/core/live2dcubismcore.min.js">
├─ public/live2d/
│  ├─ core/              live2dcubismcore.min.js（不入库，见 §6）
│  └─ models/<id>/       *.model3.json 等 + profile.json（映射表，入库）
├─ README.md
└─ src/
   ├─ main.ts · App.vue · router.ts
   ├─ protocol/   types.ts · client.ts            网络只在这里
   ├─ store/      projection.ts · projection.test.ts · selectors.ts   状态只在这里改
   ├─ voice/      sentence.ts（分句，纯函数 + 测试）· player.ts（队列播放 + AnalyserNode）· mouth.ts（音量 → 口型）
   ├─ stage/      Stage.vue（按角色包选实现）· StageLive2D.vue · live2d/{loader,profile,driver,gestures}.ts · StageTachie.vue · tachie/{profile,driver,gestures}.ts
   ├─ views/      ChatView.vue · DebugView.vue
   ├─ components/
   │  ├─ chat/    CharacterBar.vue · Subtitle.vue · HistoryDrawer.vue · MessageBubble.vue · Composer.vue
   │  └─ debug/   EventStream.vue · EventRow.vue · ModelCalls.vue · ModelCallDetail.vue · DangerZone.vue
   └─ styles/     tokens.css · base.css
```

分层规则：组件只渲染、只发 UI 事件；网络只在 `protocol/client.ts`；状态只在 `store/projection.ts` 改；
`stage/` 与 `voice/` 是两个独立子系统，各自只读 store，不互相 import；单文件约 200 行以内。

### 5.3 状态模型（投影）

```ts
interface Projection {
  connection: 'connecting' | 'replaying' | 'live' | 'reconnecting'
  meta: { name: string, voice: boolean }
  events: LogEvent[]                      // 环形 2000 条，调试页
  messages: Message[]                     // 聊天记录
  current?: string                        // 正在说的 utterance id（字幕用）
  stage: StageState
  thinking: boolean
  modelCalls: Record<string, ModelCall>
}
interface Message { id: string, side: 'user' | 'character', text: string, at: number, markers: { track: string, value: string }[], streaming: boolean, truncated?: boolean, cause?: string }
interface StageState { speaking: boolean, emotion?: string, action?: string, interruptedAt?: number }
interface ModelCall { reqId: string, role: string, provider: string, model: string, messages: { role: string, content: string }[], startedAt: number, chunks: { at: number, text: string }[], result?: { chars: number, usage?: { prompt: number, completion: number }, aborted: boolean, endedAt: number } }
```

**投影规则**（`reduce` 的全部逻辑，每行一个 vitest 用例）：

| 收到 | 规则 |
|---|---|
| `percept.received`，有 `text`、有 `sender`、`channel === 'main'` | push user 消息 |
| `utterance.started`，`channel === 'main'` | 新建 character 消息 `streaming = true`，`current = id`；live 时 `stage.speaking = true` |
| `utterance.part`，`kind === 'text'` | 追加文本；live 时把文本交给 `voice/`（开语音）或直接回执（关语音，见 §5.5） |
| `utterance.part`，`kind === 'marker'` | 追加 marker；live 时 `emo` → `stage.emotion`，`act` → `stage.action` |
| `utterance.settled` | `streaming = false`；`truncated` 时 `text = delivered`、记 `cause`；live 时 `stage.speaking = false`，截断则 `interruptedAt`、`voice/` 立即停止 |
| `beat.opened` / `beat.closed` / `beat.failed` | `thinking` 真 / 假 / 假 |
| `model.request` / `model.response` / `__stream__` | 维护 `modelCalls` |
| `__live__` | `connection = 'live'` |
| `__reset__` | 回到初始态 |
| 其他 | 只进 `events` |

三条纪律：用户发送后**不本地插入气泡**，等 `percept.received`；重放阶段**无副作用**；未知类型 / kind / 词**忽略或降级**，不报错。

### 5.4 页面

**聊天页 `/`：舞台优先。**

- Live2D 铺满视口（桌面与手机同构，模型按高度适配）。
- 左上 CharacterBar：名字 + 状态点（离线 / 在线 / 思考中 / 说话中）+ 语音开关（`meta.voice` 为真才显示）。
- 底部中央 Composer：textarea，Enter 发送、Shift+Enter 换行；`/` 开头不发给角色，就地提示「管理命令在终端」；**发送即打断**；输入框永不禁用。
- Composer 上方 Subtitle：当前这句的流式字幕，marker 显示为小标签，被打断显示 ⏹ 与原因；说完 4 秒淡出。
- 右上按钮展开 HistoryDrawer：完整聊天记录（气泡），贴底自动跟随，上翻则停。
- 空状态一句欢迎；断线顶部一条「重连中…」；Cubism Core 缺失 → 舞台位置显示一段说明（见 §6），聊天照常可用。

**调试页 `/debug`**：左事件流（过滤、展开 JSON、`model.request` 按角色分段），右模型调用（请求折叠、chunk 时间轴 +ms、结果），底部 DangerZone 清除记忆（两次确认）。

**视觉基线**：`tokens.css` 定义颜色 / 圆角 / 间距 / 字体，`prefers-color-scheme` 深浅两套，默认浅色，正文 15px/1.6；不用 emoji 做界面图标。

### 5.5 送达回执：显示的、听到的，都要对账

内核只认 `Part.text` 的字符数。前端按**用户实际感知到的进度**回执：

| 语音 | 回执时机 |
|---|---|
| 关 | 每渲染一段字幕文本，回执累计字符数（与 v1 相同） |
| 开 | 字幕**跟着音频走**：一句话的音频开始播放时才显示这句字幕并回执到这句末尾；音频被打断时，回执停在**已播完的句子**末尾 |

被打断（`utterance.settled.truncated`）时，`voice/player` 立即停止当前音频并清空队列；字幕回退到 `delivered`。
这样 `delivered` 就是用户真听到的部分，I2 在语音下仍然成立。

### 5.6 舞台：Live2D

`Stage.vue` 只定义 `props: { state: StageState }`，按配置选实现。`StageLive2D.vue` 内部三个文件：

- `live2d/loader.ts`：创建 PixiJS Application，`Live2DFactory.setupLive2DModel(model, { url })` 加载 `public/live2d/models/<id>/*.model3.json`，按视口缩放居中，`autoInteract: false`。
- `live2d/profile.ts`：读该模型目录下的 `profile.json`，把**内核词汇**映射到**这个模型的资源**：

  ```json
  {
    "idle": "Idle",
    "emotions": { "开心": { "expression": "F01" }, "害羞": { "expression": "F03" }, "难过": { "expression": "F05" } },
    "actions":  { "点头": { "motion": "TapBody", "index": 0 }, "挥手": { "motion": "TapBody", "index": 2 } },
    "mouth":    { "param": "ParamMouthOpenY", "max": 0.8 }
  }
  ```

  查不到的词：表情 → 不变并在字幕里保留标签；动作 → 播一次 idle 组里随机一段。**词汇表归插件，映射表归模型**，两边互不认识。
- `live2d/driver.ts`：每帧在 motionManager 更新**之后**写参数（否则会被动作覆盖，做法是包一层 `motionManager.update`）：
  `ParamMouthOpenY ← mouth.value`；`state.emotion` 变化 → `model.expression(name)`；`state.action` 变化 → `model.motion(group, index, MotionPriority.NORMAL)`；`interruptedAt` → 播 profile 里的 `interrupted`（可选），否则眨眼两下。

**口型三档，按里程碑递进：**

| 档 | 来源 | 里程碑 |
|---|---|---|
| 文本节奏 | 没有音频时，字幕每到一个新字符给嘴一个 0.3–0.7 的随机目标值，80ms 衰减到 0 | P3 |
| 浏览器 TTS | `speechSynthesis` 念字幕，`boundary` 事件触发同上的节奏口型 | P3（可选过渡） |
| 真口型 | `/api/tts` 音频经 `AudioContext` → `AnalyserNode`，RMS 音量映射到 `mouth`（指数 0.7、上限 profile.mouth.max、120ms 平滑） | P4 |

### 5.7 舞台：立绘（tachie）

Live2D 模型需要专业建模（切分图层、绑定网格、做物理），AI 画不出来；但一张设定图能产出一组「同一姿势只变脸」的整图。
`StageTachie.vue` 用这组图给角色一个不将就的舞台，**零依赖**：`<img>` 叠层 + CSS transform。

- 档案 `public/characters/<id>/profile.json`：`base`（必需）· `eyesClosed` / `mouthOpen`（可选，整图或局部）· `fit` · `blink` · `moods` · `expressions`（emo 词 → 图 / 手势）· `actions`（act 词 → 手势 / 图）· `interrupted`。
  字符串简写：带图片后缀是图，否则是手势名。格式细节在 `apps/web/README.md`「舞台实现」。
- `tachie/gestures.ts`：手势与 `live2d/gestures.ts` **同名同时长**（nod / shake / tilt / bounce / sway / think / sigh / shrug / wave / flinch），另加 lookDown / lift / lookUp；偏移单位是立绘高度百分比 / 角度 / 缩放增量，可叠加。
- `tachie/driver.ts`：每帧合成呼吸 + 待机摆动 + 手势 + 说话微动，决定当前图、眼睛闭没闭、口型图透明度。不碰 DOM、时钟与随机可注入，vitest 测时间线。
  语义与 Live2D 驱动对齐：显式表情 10 秒后回心情基线；查不到的表情词回底图并歪头、动作词小幅点头；被打断演 `interrupted`。
- 口型：有 `mouthOpen` 图按口型值交叉淡入；没有就用轻微点头代替。眨眼：有 `eyesClosed` 图才闭，随机 2–6 秒闭 120ms。
- 降级：底图缺 → 舞台是说明卡（文件清单、路径、尺寸、姿势要求、每张对应哪个词）；表情图缺 → 照常演，那个词停在上一张；聊天不受影响。
- 选实现：`Stage.vue` 按 `meta.character.stage.kind`（characters 插件经 `web/meta` 补）；取不到 meta 走 Live2D 默认。

第一个立绘角色是原木（`plugins/official/characters/characters/yuanmu`），图按 `apps/web/public/characters/yuanmu/README.md` 自己画。

---

## 6. Live2D 资产与许可

| 资产 | 来源 | 放哪 | 入库？ |
|---|---|---|---|
| Cubism Core（`live2dcubismcore.min.js`） | [Live2D Cubism SDK for Web](https://www.live2d.com/sdk/download/web/) 下载包里的 `Core/` | `apps/web/public/live2d/core/` | **否**（`.gitignore`）。Live2D 专有许可，不得随仓库分发；README 写获取步骤 |
| 示例模型 Hiyori | 同一个下载包 `Samples/Resources/Hiyori/` | `apps/web/public/live2d/models/hiyori/` | **否**。Live2D 免费素材许可允许开发使用；对外发布前确认条款 |
| `profile.json` | 我们自己写 | 模型目录 | 是 |
| 自己的模型 | 任意 Cubism 4/5 模型（`.model3.json` + `.moc3` + 贴图 + 可选 `.exp3.json` / `.motion3.json`） | 同上 | 看来源许可 |

`apps/web/README.md` 必须有「三步放资产」：下载 SDK → 复制 Core → 复制模型；缺哪一步页面都会在舞台位置说明缺什么。

---

## 7. 里程碑

一个里程碑 = 若干个小提交。完成标准全部打勾才算完；每完成一个，更新 §7.8 进度表与 handbook §12。

### P0 清场与脚手架

- [ ] 建 storage-sqlite v2（含 `db` 服务）与 secrets；终端 `/secret set deepseek <key>`，`/secret list` 可见
- [ ] 删除第一版 `plugins/official/*` 全部 8 个目录
- [ ] 根 `package.json`：`workspaces` 加 `apps/*`；脚本 `dev:web` `build:web` `check:web` `test:web`
- [ ] `apps/web` 骨架：Vite + Vue + 路由 + `tokens.css`；`index.html` 引 Cubism Core
- [ ] `test/boundary.test.ts` 第三条：`apps/` 不 import `src/`
- [ ] `.gitignore` 加 `apps/web/public/live2d/core/` 与 `apps/web/public/live2d/models/*/`（`profile.json` 除外）

验收：`npm run check && npm test` 绿；`grep -r "sk-" --exclude-dir=node_modules .` 无结果。

### P1 终端对话

- [ ] provider-openai（`apiKeyRef`）· mind-default · action-reply · expression-basic · persona · surface-cli（含 `/secret`）
- [ ] 每个插件有 README；`npm start` 终端能对话、能打断、`/plugins` 列出 7 个

验收：说话中回车打断，`/log 3` 的 `delivered` 与终端已打印内容一致；仓库无密钥。

### P2 Web 文本对话

- [ ] surface-web 传输层（web-protocol v1 全部端点 + 静态产物 + `web/meta`）
- [ ] `store/projection.ts` + 测试（§5.3 每条规则，另加重放不回执、重连清空、未知事件）
- [ ] CharacterBar · Subtitle · HistoryDrawer · MessageBubble · Composer；舞台位置先放占位
- [ ] 刷新后对话还在

验收：说话中发送 → 字幕截断 ⏹ → `/log 3` 的 `delivered` 与页面显示逐字相同。

### P3 Live2D 舞台

- [ ] loader · profile · driver；Hiyori 加载、待机、随视口缩放
- [ ] `profile.json`：Hiyori 的表情 / 动作映射齐 expression-basic + persona 的全部词汇
- [ ] 文本节奏口型；`emo` 换表情；`act` 播动作；打断反应
- [ ] Core 或模型缺失时的说明界面

验收：说话时嘴在动；`<|emo:开心|>` 到达时表情变化；给 persona 加一个新词，舞台降级不报错。

### P4 语音

- [ ] tts 插件（OpenAI 兼容 `/v1/audio/speech`，`apiKeyRef`）；surface-web 的 `/api/tts`；`meta.voice`
- [ ] `voice/sentence.ts`（中英标点分句，纯函数 + 测试）· `player.ts`（队列、AnalyserNode）· `mouth.ts`
- [ ] 字幕跟音频走；按已播完句子回执（§5.5）
- [ ] 打断：音频立停，队列清空

验收：打断后 `delivered` 等于已播完的句子；语音关掉后回到 P2 的行为。

### P5 调试页与打磨

- [ ] EventStream · ModelCalls · ModelCallDetail（chunk 时间轴）· DangerZone
- [ ] 深浅色、键盘可达、错误状态（后端未起、端口占用、断线）
- [ ] `npm run build:web` 后不开 Vite 直接访问 3939 可用

验收：清除记忆后页面空、SQLite 归零、`/config get plugins.persona` 仍有值、`/secret list` 仍有名字。

### P6（可选）语音输入

- [ ] 浏览器 `SpeechRecognition` → `/api/perception/*` → 内核 `io.perceive()`（内核已支持流式感知与「角色插话」）
- [ ] 开口即打断（`urgent`），停顿时 `wake`

验收：对着麦克风说一半，角色能等你说完或礼貌插话。

### 7.8 进度

| 里程碑 | 状态 | 日期 |
|---|---|---|
| P0 清场与脚手架 | 完成 | 2026-10-12 |
| P1 终端对话 | 完成（14 个插件，探针六场景通过） | 2026-10-12 |
| P2 Web 文本对话 | 完成 | 2026-10-12 |
| P3 Live2D 舞台 | 完成（Haru 默认，Natori / Hiyori 备选） | 2026-10-12 |
| P4 语音 | 完成（硅基流动 CosyVoice2，`/api/tts` 验证 200 audio/mpeg） | 2026-10-12 |
| P5 调试页与打磨 | 完成（思考时间线 / 事件 / 模型 / 命令 / 清除记忆；深浅色） | 2026-10-12 |
| P6 语音输入 | 实验：Chrome `SpeechRecognition` → `/api/perception/*`，未做真人验证 | 2026-10-12 |
| 桌宠 `apps/desktop` | 完成：她电脑（虚拟机）桌面上的透明置顶 Electron 窗口，加载本机 3939 的网页，注入 CSS 留下 Live2D + 字幕 + 对话框；任务计划「登录时」自启 | 2026-10-21 |

---

## 8. 实施规则

1. 开工前读 [../CLAUDE.md](../CLAUDE.md)、本文、[web-protocol.md](web-protocol.md)、handbook §5–§7。一次只做一个里程碑。
2. **不改内核。** 真缺机制，先写清缺什么、为什么现有水线不够，讨论定了再动。
3. **协议先行**：改端点 / 事件 / 字段，先改 web-protocol.md，再改两端。
4. 插件侧：一切注册走 `ctx.effect`；依赖写 `inject`；只从 `src/index.ts` 导入；可改的决定用 waterfall 暴露；默认配置写 `mumu.defaults`；**密钥只有 `apiKeyRef`**。
5. 前端侧：不用 `any`；不写内联样式；颜色只用 `tokens.css`；不引入 §5.1 之外的依赖；`stage/` 与 `voice/` 不互相 import。
6. 每个里程碑结束跑：`npm run check && npm test && npm run check:web && npm run test:web && npm run build:web`，结果原样贴进说明。
7. 中文注释写**为什么**；每个插件 README 三段：是什么 · 暴露什么 · 怎么改它。
8. 不复刻第一版任何代码。

---

## 9. 已拍板

| 问题 | 结论 |
|---|---|
| 框架 | Vue 3.5 |
| TTS 服务商 | 硅基流动（OpenAI 兼容），密钥名 `tts`；换服务商改配置 |
| 首个模型 | Haru（女性、8 个表情文件）；Natori、Hiyori 作备选，各有 profile.json |
| CLI 与 Web | 并存；`/secret` 在终端敲 |
| 默认色 | 浅色，跟随系统 |

## 10. 实施记录（2026-10-12）

针对复盘提出的三个问题，做了什么、怎么验证的：

**思考与思考打断**
- 症状：每句话等两次模型调用才开口（4–8 秒）；思考途中再说一句，导演把过时的决定执行完再回头。
- 做法：reflex 快车道（350ms 合流后直接起 reply）；导演在新输入或反射开口时 `abort` 进行中的决策；
  reflex 在 `intent/pre-dispatch` 硬闸拦下导演基于旧材料起的 reply；`mind.decision` 落日志。
- 验证：`scripts/probe.ts` 六个场景带时间戳 + 七条不变量（同频道不并行、delivered 是前缀、最后一句之后恰一条完整回复、反射 300–900ms、无失败、首字 < 3s、硬闸计数）。修前 s3/s4 并行回复，修后全部通过；首字 0.9–1.3s。

**表情**
- 症状：十个词无提示，模型只在开头放一个「开心」；emoji 桌宠无法扩展。
- 做法：25 个词带「什么时候用」，教学讲放置位置与数量；舞台 profile.json 把词映射到表情文件 / 参数姿态 / 程序化动作 / 动作文件，查不到降级；显式表情 10 秒后回到 emotion 插件给的心情基线。

**灵动**
- 发现 v1 人格段落 `audience: 'both'` 从未进过模型；导演指示伪装成对方的话。
- 做法：persona `'*'` + 说话方式；引导放 system 尾部，`[旁白]` 给开口契机；emotion 状态演化；clock 时间感；
  被打断后的记忆改为「先回应对方现在说的」（探针 s3 验证：打断后角色说「你刚才说累，怎么啦」而不是接着讲歌）。

**顺手修的**：无终端时 readline 关闭后 `prompt()` 杀进程；Cubism Core 必须同步加载且在模块之前（否则整个应用崩）；
Natori 是男性角色，默认改 Haru。

**试用后追加（同日）**
- **字幕按阅读速度呈现**（语音关时）：模型两秒吐两百字，瞬间全显会让「打断」永远发生在她说完之后，delivered 也不是用户真看到的。
  前端打字机 32ms/字、句末 320ms、分段 520ms，回执跟着呈现进度；打断停在当前字。
- **终端让位**：终端与网页同时开着时两个回执端打架（终端打字机更快，内核按它记 delivered）。surface-web 广播 `web/clients`，
  surface-cli 在有浏览器时不呈现、不回执，只留命令；stdin 不是 TTY 时根本不注册为表现端。
- **多对话**：对话 = 内核频道（`main` 默认，新对话 `c:<id>`）。每个对话历史独立、打断独立；工作记忆与心情是角色本身的，跨对话共享。
  `GET /api/events?channel=` 按对话重放，`GET /api/conversations` 从真源投影列表，网页抽屉里切换 / 新建。
- 「反射回复多」是设计：每句都由反射先开口，导演只做补充、主动找话、并行做事。想让她更沉得住气调 `plugins.reflex.delayMs`。
- **回执尾巴**（探针在浏览器连着时抓到）：前端回执有 200ms 节流，打字机打完最后一个字时若距上次回执不到 200ms，
  最后一次回执被吞掉，之后没有新字再触发它；内核要等「全部送达」才结算，只能等 60s 超时。修法：打字机追平已到文本时无条件补一次回执。
  页面隐藏时（浏览器把定时器节流到每分钟一次）直接全显并回执，与内核超时记账一致。
  **探针以后固定在浏览器连着的条件下跑**：那才是真实的回执端。
- **新角色「原木」**（子代理完成）：characters 插件（角色包 = 人设 + 舞台 + 声音，`/character use <id>`）；立绘舞台 `tachie`
  （整图 + CSS transform 程序化动画，与 Live2D 舞台同一接口）；Live2D 建模明确做不了（需要分层原画 + Cubism Editor 绑骨）。
  底图用 `scripts/cutout.swift`（macOS Vision 前景分割）从设定图抠出；表情 / 眨眼 / 口型图需要用画图工具按 `apps/web/public/characters/yuanmu/README.md` 产出。
