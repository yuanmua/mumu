# 沐沐项目手册

> **这是交接文档**：接手这个项目先读这一篇。
> 它承载全部约定、设计决策与其理由——包括**否决过什么、为什么否决**。
>
> 分工：本篇 = 项目是什么 · 为什么这样 · 所有约定 · 决策记忆。
> [architecture-paper.md](architecture-paper.md) = 内核论文（机制论述与设计论证，**契约定档清单在第 9 节**）。
> [kernel.md](kernel.md) = 内核每个机制怎么用（细节参考）。
> [mindcore-architecture.md](mindcore-architecture.md) = 上层架构方案（含尚未实现的部分）。
>
> 测试以 `npm test` 为准（全绿）· 协作规则见 [../CLAUDE.md](../CLAUDE.md)

> **本分支（main）只含内核与装配层。** 文中提到的官方插件、`apps/`、`scripts/`、periphery.md、web-protocol.md 都在 `bridge` 分支（靠 API 接入的完整产品）。

---

## 1. 项目是什么

一个 **AI 数字角色内核**。同一个角色通过统一的输入输出接口，接入聊天软件、网页、Live2D、3D、语音、游戏等各种表现端；有动作、会用工具、能被打断。

TypeScript + Node 22.15+，ESM，**零运行时依赖**（存储用 Node 内置 `node:sqlite`）。单进程可多实例。

### 三条底色

| 底色 | 含义 |
|---|---|
| **一切即插件** | 内核只有机制，策略全在插件；插件还能改插件 |
| **流式可打断** | 日志记录对方**实际听到的前缀**，不是模型生成的全文 |
| **主大脑不说话** | 它只编排动作；说话的是 reply 动作实例 |

---

## 2. 最高立场：机制 vs 策略

> **判据只有一句：换一个插件能不能换掉它？**
> 能 → 它是插件。不能（它是插件赖以存在的地基）→ 它是内核。

内核**不认识**任何：provider、动作、表情、会话形态、模态、存储介质、**任何一句中文渲染**。

这条立场是所有后续决定的源头。每次想往内核加东西，先问这一句。

---

## 3. 全局结构

```
mumu/
├─ src/
│  ├─ kernel/          内核：机制，零策略
│  │  ├─ core/         container · bus · registry
│  │  ├─ session/      log（唯一真源）· types
│  │  ├─ llm/          gateway（角色绑定）· stream（marker 解析）
│  │  ├─ mind/         scheduler（心跳 + decider 槽位）
│  │  ├─ actions/      registry（动作类型/实例）
│  │  ├─ prompt/       assembly（段落 + 工作记忆）
│  │  ├─ io/           port（感知/表现/发声/回执）
│  │  ├─ mumu.ts       装配（唯一知道全貌的文件）
│  │  └─ index.ts      内核公共 API（内核对外唯一出口）
│  ├─ shared/          插件可选用的渲染助手（内核自己不用）
│  ├─ loader/          Host 装配层：扫描 plugins/、热重载、启停
│  ├─ index.ts         公共 API 单一入口（插件只从这里导入）
│  └─ main.ts          入口（薄，不写死任何插件）
├─ plugins/            可任意分层归类，层数不限（有 package.json 的目录即插件）
│  ├─ official/        官方插件
│  └─ user/…/          用户插件，随便怎么组织
├─ apps/               独立应用，不是插件（loader 不扫这里）
│  └─ web/             Web 前端（Vite + Vue + Live2D），只认 docs/web-protocol.md，不 import src/
├─ docs/               handbook（本篇）· kernel · architecture-paper · mindcore-* · periphery · web-protocol
├─ scripts/            probe.ts：对话探针（打断场景 + 不变量）
├─ test/               node:test
├─ CLAUDE.md           协作规则：改代码前先读
                       （没有全局配置文件：内核裸启动，配置各归各插件）
```

**依赖方向**：`plugins → src/index.ts → kernel/index.ts → 内核内部`；`apps/* → 只有 HTTP 协议`。
内核不依赖 loader、不依赖 shared、不依赖任何插件。

**三道边界，由 [test/boundary.test.ts](../test/boundary.test.ts) 守着**：

1. **内核之外不许 import 内核内部路径** —— 只认 `kernel/index.ts`。
   内核是独立的一块：内部怎么分目录、怎么重构都不外溢。
   往内核加机制时在 `kernel/index.ts` 补一行导出即可，`src/index.ts` 不用动。
2. **插件只从 `src/index.ts` 导入** —— 不许绕到 `src` 内部任何文件。
3. **`apps/` 不许 import `src/`** —— 浏览器端只认 [web-protocol.md](web-protocol.md)。

三条都有测试兜底，越界会红。

---

## 4. 内核九机制一句话

| 机制 | 一句话 | ctx 键 |
|---|---|---|
| container | 服务容器 + inject 依赖 + **注册即可撤销 effect** | — |
| bus | `emit`（通知）+ `waterfall`（环绕中间件，可短路） | `bus` |
| registry | 通用贡献集合（三处复用，插件也能开自己的） | — |
| log | append-only 唯一真源 + 持久化 seam + 三不变量 | `log` |
| gateway | 插件声明**角色**，配置绑模型，用量记账 | `model` |
| stream | StreamChunk 词汇 + `<\|track:值\|>` 流式安全解析 | — |
| scheduler | 心跳：合流/退避/熔断 + decider 槽位 + **开放材料** | `mind` |
| actions | 动作类型/实例多开/生命周期/频道流转 | `actions` |
| prompt | 段落 Contribution + 工作记忆（双重衰减） | `prompt` |
| io | 感知进/表现出/发声流/送达回执 + marker 词汇 | `io` |

---

## 5. 核心约定（改代码前必读）

### 5.1 两端对称的开放信封 ★

内核最重要的纪律：**输入与输出同样开放**。

```
Percept { kind: string, channel?, sender?, text?, urgent?, data? }   ← 进
Part    { kind: string, text?, data? }                               ← 出
```

`kind` 两边都是**自由字符串**，语义由插件定义。内核不认识 message / danmaku / vision / image / card / game.cmd 中的任何一个。

固定的只有**节拍**（这才是机制），而且**两端都是流**：

```
进：Perception = 若干 update → end，或中途 cancel   （语音逐字、边打边改）
出：Utterance  = 若干 part   → end，或中途 stop     （发言被打断）
```

一次性输入用 `io.percept()`，不必开流；流式输入用 `io.perceive()` 拿句柄。
**`update` 是修订不是追加**（ASR partial 后一次覆盖前一次）——修订能表达追加，反之不能。
音频/视频帧不进内核：表现端做完 ASR 再流文本进来，与「内核流文本、TTS 在表现端」同一层分工。

**表现端不认识的 `Part.kind` 直接忽略** —— 这就是能力降级的全部规则，没有第二条。

### 5.2 结构位：内核唯一允许"认识"的东西

内核只看这些结构位，绝不解析 `kind` 字符串：

| 结构位 | 内核用它做什么 |
|---|---|
| `Percept.text` + `sender` | 进对话历史（other 侧） |
| `Percept.channel` | 路由表现端；打断只切本频道 |
| `Percept.urgent` | 默认打断策略的唯一依据（语音 barge-in 也走它） |
| `Perception` 在途内容 | 进 `BeatMaterial.incoming`——角色据此决定**插话还是等他说完** |
| wake `partial` | 这次唤醒来自没说完的半句话 |
| `Part.text` | **只有它计入送达账**（文本线性可截断，其余片段原子） |
| `Surface.channels` | 不服务的频道收不到 |
| `capabilities.deliveredReport` | 按回执还是按全量记账 |
| wake `external` | 永不退避、解除熔断；内生唤醒为 false |

### 5.3 双向打断

| 方向 | 机制 |
|---|---|
| **对方打断角色** | `urgent`（开口即打断，或 VAD 确认后再打断）→ 硬停本频道发声 → delivered 记实际听到的前缀 |
| **角色打断对方** | 在途感知进 `incoming`，decider 看得见「说了多久、说到哪」，可直接 `start reply` 插话 |

流式输入的唤醒**按需**：`update(text, { wake: true })` 才开一拍，默认不唤醒——
否则每个字一拍会烧钱。什么时候值得唤醒（停顿、关键词、说太久）是表现端/插件的策略。

### 5.3 三条日志不变量

- **I1** 模型可见 ⟺ 已记录（进模型请求的东西必须能从日志重建）
- **I2** 说出去的 ⟺ 记录**实际送达的部分**（打断记 delivered 前缀，不记生成全文）
- **I3** `action.started` 必有 `action.ended`（孤儿恢复为 interrupted，并变成角色的"自我察觉"）

### 5.4 渲染归消费方

内核**一句中文都不拼**，只出结构化数据：

| 内核给 | 谁渲染 |
|---|---|
| `WakeReason { source, text, channel?, sender? }` | mind-default 的 `reasonLine` |
| `Note { source, text, elapsedMs }` | `shared/renderNotes`（可选用，也可自己写） |
| `HistoryTurn { role, kind, sender?, channel }` | mind-default `turnLine` / action-reply `toMessage` |

### 5.5 命名

- **channel** = 会话频道（`main` / `group:123` / `danmaku`）
- **track** = marker 通道（`emo` / `act` / `tool`）

两者**绝不混用**。曾经撞名过，改掉了。

### 5.6 无全局可变态

频道随意图流转：`Intent.channel` → `ActionRun.channel` → `utter()`。
解析链纯结构：**显式 > 动作自己的 > 缺省 main**。

曾经有过 `IO.activeChannel` 全局单值，多频道并发会串台，已删除。**不要再引入这类"最近一次…"的全局态。**

### 5.7 无硬编码可调参数

部署可变的数值全在 `KernelOptions`（`Mumu.create(options)` 的编程参数）：
`historyLimit` · `cooldownMs` · `backoffBaseMs` · `backoffMaxMs` · `emptyFuse` · `settleTimeoutMs`

（`DEFAULT_*` 常量不算可配置性。）

### 5.8 降级永远比崩溃好，且降级必须可见

| 出错位置 | 处理 |
|---|---|
| 段落渲染抛错 | 缺那一段，`console.error`，其余照常 |
| 事件监听器抛错 | 隔离，不影响其他监听器与发射方 |
| 表现端抛错 | 隔离，其他端照常收 |
| 动作崩溃 | 实例进 error → **作为感知回报主大脑** |
| decider 输出不合形态 | 重试一次 → 再失败空意图 + 日志 |
| 落盘失败 | 不打断角色，但 `console.error` |

---

## 6. 扩展点全表

### waterfall（改一切 / 插件改插件的落点）

| 水线 | 时机 | terminal（默认行为） |
|---|---|---|
| `percept/pre-beat` | 感知落日志后、唤醒前 | urgent ⇒ 硬停本频道发声；`wake:false` 压制唤醒 |
| `beat/gather` | 一拍材料汇聚后 | 原样返回；插件往 `blocks` 贡献材料 |
| `intent/pre-dispatch` | 意图落到动作层前 | 执行 start/send/stop；`allow:false` 拦截 |
| `expression/pre-emit` | 输出到表现端前 | 原样放行；`drop:true` 吞掉 |
| `cli/render` | surface-cli 每段输出前 | 默认 ANSI 样式 |
| `web/meta` | surface-web 响应 `/api/meta` 前 | 原样返回；persona 补 `character.name` / `aliases`，其他插件可补字段（含 `panels` 面板定义） |
| `web/route` | surface-web 收到自己不认识的 `/api/*` 时 | 没人认领 → 404；插件填 `response` 认领（web-protocol.md §7）；`body` 是 `Buffer` 时原样回字节（缩略图） |
| `web/status` | surface-web 响应 `/api/status` 前 | 原样返回；插件往 `cards` 推状态卡片 |
| `persona/names` | 任何插件要判断「是不是在叫她」时现调（`{ platform?, names: [] }`） | 原样返回；persona 补真名 + 各平台网名（`aliases`）。surface-onebot、group-policy 读它，不各自硬编码 |
| `reply/prompt` | action-reply 组装发言提示词前 | 原样返回（最近 `historyLimit` 条）；group-policy 换群聊阅读窗口，memory 往 `extras` 补召回 |
| `interests/score` | 任何插件想知道「这段话她感不感兴趣」时现调（`{ text, score: 0, hits: [] }`） | 原样返回（0 分）；interests 填 0～1 的感兴趣程度（语义相近度 × 兴趣分，不是关键词命中）与相近的兴趣 `{ name, near, score }`。group-policy 的话题吸引力拿它去乘 |
| `life/now` | 任何插件想知道「她此刻在干嘛、忙不忙」时现调（`{ busy: 1, asleep: false }`） | 原样返回（不忙、醒着）；life 填 `activity` / `detail` / `until`，`busy` 乘上活动的忙碌系数（吃饭 / 打游戏 / 睡觉 < 1）。给接话意愿乘用，接法见 life 的 README（group-policy 目前没接） |

### emit（观察）

| 事件 | 载荷 |
|---|---|
| `log.appended` | 每条新日志事件（重放不触发）。UI / 遥测类插件做纯投影用这个 |
| `model.stream` | 每个模型 chunk（不落日志，内容已被请求/响应覆盖）。调试页实时看流用 |
| `reflex.fired` | 脊椎兜底刚起了一条 reply（插件事件；group-policy 起排队的回复时也发）。2026-10-22 起大脑不再据此作废进行中的决定，重复的 reply 由脊椎的硬闸拦 |
| `web/clients` | `{ count }` 浏览器连接数（surface-web 发）。surface-cli 据此让位 |

### 服务

内核固定：`bus` `log` `model` `mind` `actions` `prompt` `io`
装配层：`loader`（启停/重载）· `app`（shutdown）
插件惯例：`config` `db`（storage-sqlite）· `commands` · `secrets` · `emotion` · `tts` · `bots`（group-policy：这人是不是群里的机器人）· `stickers`（表情包：表现端问它要不要配图、发出后回调、交群友的表情包）· `images`（surface-onebot：这段历史里哪几张图以原图进上下文）……新服务随插件出现。
消费方对提供方的契约只 `import type`（CLAUDE.md §2 第 6 条）。

### 贡献集合（Registry）

段落 · 动作类型 · marker 词汇。**插件也能开自己的**：`ctx.provide('myThing', new Registry(...))` 即是一个新扩展点。

- 给 `keyOf` ⇒ 键唯一，冲突大声失败（段落、动作）
- 不给 ⇒ 允许重复（marker：多插件贡献同名表情是常态）

---

## 7. 插件约定

```
plugins/                        任意分层归类，层数不限
├─ official/storage-sqlite/     ← 插件（有 package.json 即插件）
├─ official/theme/soft/         ← 再套一层也行
└─ user/我的实验/xxx/
    ├─ package.json   name/main/dependencies + mumu: { enabled, order, description, defaults }
    ├─ README.md      是什么 · 暴露什么 · 怎么改它
    ├─ index.ts       default 导出 Plugin: { name, inject?, apply(ctx, config) }
    └─ node_modules/  自己的依赖（npm workspaces，根 workspaces 配 `plugins/**`）
```

**目录是组织，不是身份。** id 只由 `package.json`（`mumu.id` > 包名去 scope > 目录名）决定，
与所在路径无关——所以插件挪窝**不丢配置、不断 `/plugin` 命令**，这是敢分层的前提。
扫描到重复 id 会**大声失败**（否则两个插件的配置会静默串台）。

扫描规则：**有 `package.json` 的目录即插件，且不再往下钻**（里面的子目录是它自己的源码/资源/依赖）；
`node_modules` 与 `.` 开头的目录跳过；深度上限 8 层兜住软链环。
加载次序**只看 `order`，与目录层级无关**——组织不影响行为。

移动插件时唯一要改的是 `import` 里 `../` 的层数（落点仍是 `src/index.ts`，边界测试不限层数）。

| 约定 | 说明 |
|---|---|
| 一切注册走 `ctx.effect(() => disposer)` | 卸载逆序回滚，不留渣。热重载靠这条 |
| 依赖写 `inject: ['config', …]` | 加载顺序自动推导，不手写启动序列 |
| 只从 `src/index.ts` 导入 | 内核内部重构不破插件；boundary 测试守着 |
| 想被别人改 → 暴露自己的 waterfall | 别人改你不需要 import 你 |
| 默认配置写进自己的 `mumu.defaults` | 装上即可用；配置库只存覆盖 |
| 段落顺序只从 `PROMPT_ORDER` 取槽位 | `src/shared/order.ts`：identity 0 · voice 10 · state 20 · teaching 30 · memory 40 · thought 50 · time 80 · rules 100。人设最前、底线最后、常变的靠后；调用方本次才有的段落用 `assemble(audience, extras)` 走同一套排序，不许拼在整段前后 |
| `mumu.order < 0` = 引导期 | 配置库存在之前加载（如 storage-sqlite），配置只来自自己的 defaults |
| 配置改动自动重载 | `/config set plugins.<id>.…` → 装配层精确重载该插件（`.enabled` 除外） |
| 热重载范围 | 入口与插件目录内的子模块一起刷新（`src/loader/fresh.ts` 的 resolve 钩子，需 ESM 插件 + Node 22.15+）；`src/` 与别的插件不重复实例化；新增插件目录 `/plugin scan` 即装上；文件指纹没变的监视事件不算；重载服务提供者连带重载注入它的插件；单个插件装不上只跳过它（`/plugins` 显示原因） |

### 官方插件（都在 `plugins/official/` 下，2026-10-12 第二版）

> 叫法（2026-10-22 起）：**大脑 = `mind-default` 插件**（旧称「导演」），**脊椎 = `reflex` 插件**（旧称「反射」）。
> 只改叫法：插件 id、事件名（`reflex.*`）、模型角色（`mind.decide`、`performer.reflex`）、配置键一律不动。下文 2026-10-22 之前的记录保留当时的叫法。

| 插件 | order | 职责 |
|---|---|---|
| storage-sqlite | -100 | 日志落盘 + 配置库（`config`）+ 裸句柄（`db`） |
| commands | -95 | 管理命令注册表（`commands`）：插件登记 `/命令`，终端与 Web 调试页共用 |
| secrets | -90 | 密钥服务（`secrets`）：独立表，`/secret set|del|list`，值永不显示 |
| provider-openai | -10 | OpenAI 兼容适配器；绑定只存 `apiKeyRef`，请求时向 secrets 取；消息上的插件层附件 `images`（媒体目录里的原图文件名）发请求时才转成多模态 content（日志里只有文件名和字节数），端点拒收图就去图重试一次（`provider.images-refused`） |
| mind-default | 0 | **大脑**（旧称导演）：单级决策，每条消息都先到这里（大脑门控）：`quick:true` 放行脊椎秒回一条短的、start reply 带想法、应一声并起动作，或不回；思考可被新输入作废，被作废那拍的原因全部带到下一拍并标「想到一半被打断」；规则与动作目录放 system 最前（前缀缓存），每拍都带全频道的最近对话（「精简拍」同日撤销，见 §9.3）；结果感知已经处理过的动作，它结束的那次唤醒不再单独想（`reported.ts`，免得把后续动作再做一遍）；最近几张图看原图（服务 `images`，占位编号「[图片1]」、原图附在末尾）；落 `mind.decision` |
| reflex | 0 | **脊椎**（旧称反射）：不抢先开口。私聊合流（对方停下再叫醒大脑）；`beat/gather`【脊椎】给大脑贴提示（还在发 / 像要她做事 / 主人说的 / 很简单可 quick）；兜底：白名单里的招呼（纯表情包或 ≤4 字无问号、不像要她做事、不是主人说的）大脑 `fallbackMs` 内没决定就先起一条简短 reply（`reflex.route` path=fallback）；`intent/pre-dispatch` 硬闸保证同频道单回复、她在别处说话时不开口（`busy-elsewhere`，一次只在一个会话里；被拦的念头说完那拍提醒大脑）、合流中不回、兜底之后不再说一遍，同拍动作被 guard 拦下时改 reply 的念头（别说这就去、别说电脑坏了） |
| action-reply | 0 | 流式发言；marker 通道 emo/act/br/tool；引导放 system 尾部，旁白给开口契机；水线 `reply/prompt`；分段写法归一化（`br.ts`：`<br>`、残缺的 `<\|br>` 之类、换行 → `<\|br\|>`，`newline` 可配；她的历史从 `utterance.part` 找回分段位置插回 `<\|br\|>`）；工作记忆按会话过滤；最近几张图的原图跟着发的那条 user 轮次（服务 `images`，快回不带） |
| action-computer | 0 | `computer` 动作：`task.agent` 跑 JSON 工具循环，驱动她 Windows 上的身体服务 [`apps/body`](../apps/body/README.md)（PowerShell / UI Automation / 键鼠 / Edge）；每步 `a.note` + 落 `computer.step`，结果以 `computer.result` 感知回报大脑；教发言者与大脑「你有一台电脑」+ `beat/gather`「电脑现状」；`/body`、`/body stop` |
| expression-basic | 0 | 带提示的表情/动作词汇 + 放置教学 + `<\|br\|>` 分段 |
| emotion | 0 | 情绪状态（`emotion`）：自表达推动、随时间回落；段落 + 材料块 + `emotion.changed` |
| persona | 0 | 人格段落（所有受众，**最前**；有网名 `aliases` 时末尾一句网名与真名）+ 腔调 + **说话的底线**（发言者，**最后**；短；`rules` 可整段替换）+ `web/meta` 报名字与网名 + 水线 `persona/names`（真名 + 网名，给「是不是在叫她」的判定用） |
| clock | 0 | 时间感段落（order 90，放后面：开头留给人格，且它每分钟变、放前面破坏前缀缓存）：现在几点、对方沉默多久 |
| characters | 0 | 角色包（`/character list\|use`）：人设 + 舞台（live2d / tachie）+ 声音打包成 `characters/<id>/character.json`，切换时写进 persona / tts / surface-web 的配置；`web/meta` 报舞台 |
| tts | 5 | 语音合成（`tts`）：OpenAI 兼容 `/v1/audio/speech` |
| surface-cli | 10 | 终端表现端 + `/plugins /plugin /config /log /stream /quit`；有浏览器连着时让位（只留命令），stdin 非 TTY 时不呈现 |
| surface-web | 10 | Web 传输层：实现 [web-protocol.md](web-protocol.md)，服务全部频道（对话 = 频道），服务 `apps/web/dist`；广播 `web/clients` |
| surface-onebot | 10 | QQ 表现端（OneBot v11 正向 WS 连 NapCat，零依赖）：私聊 → `message`，群聊 → `group.message`（@ / 叫名字 → `message` + urgent），戳她 / 撤回 / 进出群 / 加好友 → `qq.*`；按打字节奏分条发、每条发出才回执；`<\|quote\|>` `<\|at:名字\|>`；`vision.read` 看图、语音转文字；最近几张图另存副本、以原图进发言者 / 大脑上下文（`images.inline`：每会话 3 张、15 分钟内、≤2MB，服务 `images` 选图，描述照旧给记忆 / 阅读窗口 / 日志）；动作 `qq.send` `qq.manage` `qq.query` `qq.call`（NapCat 任意接口）；`segments.ts` 是给模拟器的稳定层；表情包经 `stickers` 服务（现取不注入；还在找的表情包在发件箱里占一格）；`/onebot` |
| stickers | 5 | 表情包：库（群里收 / 网上找 / 主人放，`data/stickers`）、`vision.read` 审核打标（规则可配，看不了就不发）；发不发——对方要就发，平时按心情 × 热度 × 对方刚发没，认真话题和刚发过不发，一条发言最多一张；库里没有按描述联网找（360 图片搜索 / 发表情网，限流，审核过才入库），对方要却找不到给大脑 `sticker.missing`；服务 `stickers` 给 QQ，网页频道自己挂 `surface.media`；发言者 / 大脑材料里有「刚发过什么」「对方在要」；面板「表情包库」（缩略图、禁用 / 删除 / 重审、按描述补库）、状态卡、`/stickers` |
| group-policy | 0 | 群聊读空气 + 多会话调度：`percept/pre-beat` 给群消息打接话概率（先分「在聊 / 没在聊」两种状态：在聊多聊几句、没在聊偶尔看一眼；再 × 时段表 × 每群覆盖，问句 / 相关 / 接话往上，刷屏 / 表情 / 对聊往下，是她喜欢的话题再 × (1 + `interest.k` × 感兴趣程度)（语义相近度 × 兴趣分，interests 插件给）；带低俗词、机器人说的、同人连问只打折不归零，忙时只回必答）；和她聊上的人接着说不用 @ 也按「在聊」打分（`convo.ts` 正在对话，起点 `followUp`、按她接过几句衰减，在聊 ≠ 每句都接）、没 @ 她的话一律打分没有直通（主人不特殊）、她参与的话题里可以主动接；机器人的话在大脑与发言者的历史里标出来；**内容类的「不接」一条都不写死**：词表、机器人名单只用来给大脑写一行提示（`beat/gather`【读空气】），接不接她自己定；按人累积的脾气（`temper.ts`：反复 @、低俗话冲她说、骂她、让她自证 AI 攒骚扰度，半衰期消气）给大脑形容词、给发言者态度，大脑用动作 `group.ignore` 决定不理 / 拉黑 / 原谅（日志 `temper.ignored`，到期自动恢复，主人不适用，拉黑由 memory 记进印象）；她正在别处说话时群里找她的先排队、说完再回；`beat/gather`「手机上现在的情况」（各会话未读、@、她在哪）；`reply/prompt` 群聊阅读窗口；`/freq`；认群里的其他机器人（名单 + 自动打分）并标上，服务 `bots`（`isBot` / `ignored`）、动作 `group.bot`、`/bot`；面板「脾气（按人）」 |
| memory | 0 | 长期记忆（按人组织）：听 `log.appended` 按会话攒，攒够一段 / 安静下来用 `memory.summarize` 压成中期摘要 + 人物印象 / 事实 + 群印象（`mem_*` 表，日志清空也留着）；群里只给跟她打过交道的人建档；`reply/prompt` 召回「你记得的」（一对一全可见并标来源，群里只见本群来源）、新开对话带上一个对话的话头；`beat/gather` 给大脑一句话印象；`/memory` |
| interests | 0 | 她自己的兴趣表（`int_*` 表，0～1 分 + 最近触发 + 来源）：人设种下；她投入地聊（接 ≥2 轮 / 追问 / 开心好奇的表情 / 说喜欢）的段用一次 `interests.read` 认话题，新话题投入满 3 次进表、说喜欢直接进表、说不感兴趣压到底、聊到了大脑醒了却连着不接就降；大脑动作 `interest` 标有意思 / 没意思；按半衰期淡，人设的淡不到 0。「这句是不是她感兴趣的」用语义打分（`semantic.ts`：默认本机 CPU 上 transformers.js 跑句向量模型、按文本缓存、装上即预热兴趣表、限时 300 毫秒，退路是让聊天模型打分），不做关键词包含匹配。水线 `interests/score`（group-policy 话题吸引力拿它乘接话概率）、`beat/gather`「你最近感兴趣的」、发言者「你最近在意的事」；面板「兴趣」（人格抽屉底下也有）、状态卡、`/interests` |
| life | 0 | 生活状态「此刻在干嘛」（吃饭 / 犯困 / 刷视频 / 打游戏 / 睡觉……，附加小系统）：作息时段 × 权重抽签（种子进日志，衔接规则：不连着做、`gapMin`、`notAfter`），候选不止一个就让她自己选一件并补一句细节（默认角色 `mind.decide`，失败退回抽签）；大脑动作 `life.set`（她在聊天里改）；网页面板「在干嘛」（人格抽屉底下，「设成」覆盖到下一个时段或指定分钟、换一个、清掉）、状态卡、`/life`；发言者段落「你此刻在干嘛」（state 槽，排在心情后）、`beat/gather`「你在干嘛」；水线 `life/now` 报忙不忙系数；睡着时她自己想找话在 `intent/pre-dispatch` 拦下（`life.quiet`），被 @ / 私聊照常回；日志 `life.changed` 是唯一真源 |
| action-extend | 0 | `extend` 动作（需要主人）：她给自己加简单功能——`task.agent` 按插件契约写 `plugins/user/<name>/`，护栏（只写 user、只 import `src/index.ts`、不加依赖）→ `npm run check` → `loader.scan()` 装上，出错把报错喂回去改；`extend.result` 唤醒大脑；`/extend` |
| action-image | 0 | `image` 动作：把她电脑里的一张图片发进对话（本机没有这个文件就经身体服务 `/image` 取）；`screenshot` 动作：截她桌面直接发（「需要主人」，guard 拦非主人）。拷进 `data/media/<内容摘要>.<扩展名>`，发一个 `Part { kind: 'image', data: { media } }`（日志只记文件名），网页经 surface-web 的 `GET /api/media/<name>` 显示、QQ 发成图片消息；发完唤醒大脑再 reply；教大脑「看桌面 screenshot，网上的图先 search 搜好、再 image 发」 |
| action-search | 0 | `search` 动作（谁都能用，不标需要主人）：查资料、看新闻、找图直接调搜索 API，不开电脑浏览器。`kind` web / news 走 DeepSeek 官方 Search API（与对话共用 `deepseek` 密钥，`apiKeyRef` 可换），news 补 `after:` 只要最近几天；image 必应 + 360 并行、同时网页搜一次词义，下载到 `data/search`、`vision.read` 看一眼（图里是什么、对不对得上、能不能发群里），只留对得上的、全对不上叫她换词再搜，给本地路径接 `image` 发出；结果以 `search.result` 感知唤醒大脑并进工作记忆（action-reply 把它算「动作结果」，下一次发言就是汇报）；超时 / 没密钥 / 服务报错都写成她能说的原因；来源表 `providers.ts` 可换一家；状态卡「搜索」、`/search` |
| action-dsh | 0 | `dsh` 动作（需要主人）：在她电脑里非交互起 DeepSeek Harness（`dsh --profile headless --json -`）干多步工程活，密钥只进子进程环境，默认 workspace-write 沙箱；每步一句人话进 `a.note` / `dsh.step`，`beat/gather`「手头的活」（发言者那边由 action-computer 的 computer-now 一并投影），动手 / 出错发 `dsh.progress`、完成发 `dsh.result` 唤醒大脑；护栏 guard.ts 每步拦截碰系统的命令（停下要主人点头）；总时限 / 静默时限 / 急停杀整棵进程树，同时只跑一个；和 computer 分工（写代码跑命令 vs 点界面看屏幕、打开写好的程序）；网页状态卡 + 「DSH 任务」面板 + 消息下进度小字；`/dsh`、`/dsh stop` |
| guard | 0 | 权限与群聊风险：`intent/pre-dispatch` 拦危险动作（`computer` / `dsh` / `extend` / 描述标了「（需要主人）」的），认号不认名，只有主人或网页发起才放行（导演晚几拍才起动作时，看这个频道 10 分钟内最后一条任务请求是谁的，再核对导演写的 `requestedBy`）；主人在群里让她做影响别人的事先确认，主人让发文件 / 图 / 语音直接做、别人让发先问主人（`askOwner`）；要主人点头的意图整个登记，主人在群里回「发吧」guard 直接起、回「别」作废；群消息像提示注入时提醒导演与发言者；`/guard` |
| bench | 0 | 压测用：`/api/bench/usage` 按模型角色统计调用 / 打断 / token / 估缓存命中 / 耗时，`/api/bench/judge` 用 `bench.judge` 角色给发言样本打「像不像人」分；`/bench`。平时可停用 |

第一版（2026-08）的 9 个插件已整体删除重建；界面在 `apps/web`（Vite + Vue + Live2D），不是插件。
对话行为改动后必须跑 `npx tsx scripts/probe.ts`（六个打断场景 + 不变量）。

> Web 表现端 v1（单文件 HTML）已于 2026-10-12 删除（状态写了两份、回执不准）。
> v2 保留它验证过的两条纪律：**UI 从真源投影、不持第二份状态**（先重放存量再直播，页面渲染完回报送达，
> I2 的 delivered 就是页面实际显示或播放的前缀）；**只在有浏览器连着时才注册为有回执的表现端**。

---

## 8. 配置

**没有配置文件，也没有环境变量。** 内核裸启动（`Mumu.create()` + `new PluginLoader(mumu)`），
配置只有两个来源：

```
插件自己的 package.json  →  mumu.defaults      默认值，随插件走
配置库 data/mumu.db      →  plugins.<id>.*     覆盖值，/config set 写入
```

**默认在插件、覆盖在库**：库里的 `plugins.<id>` 是打在清单 defaults 上的一份 **JSON Merge Patch**（RFC 7386，`src/loader/merge.ts` 的 `mergePatch`）——
对象按键递归合并，数组与标量整块替换，值为 `null` 即删掉该键（连同默认）。所以：

- 装一个插件即带来它全部的默认配置——包括模型绑定（`provider-openai` 自带 `roles`，含 baseURL/apiKey/model）。
- 空库 = 全默认，不需要任何播种；删库重来即回到出厂状态。
- 改配置：`/config set plugins.<id>.<路径> <值>` → 写库 → **装配层自动重载那一个插件**，即时生效。
  只改一个深层键（`roles.performer.model`）不会冲掉同层其余默认（`roles.default`）。
- 要展示「她此刻实际拿到的配置」的地方（如网页人格面板）也调 `mergePatch`，别自己再写一遍合并。

装配层不认识 `roles`，内核也不为哪家模型开特例：**模型配置是 provider 插件的私事**。

> `KernelOptions`（cooldownMs 等）走 `Mumu.create(options)` 的编程参数，供嵌入式 Host 调；
> 默认值对 CLI 场景够用，所以 `main.ts` 一个参数都不传。

---

## 9. 决策记忆（为什么这样，否决了什么）

> 这一节是本文档存在的主要理由。**改设计前先看有没有踩过。**

### 9.1 刻意没做的

| 没做 | 为什么 |
|---|---|
| 把现成的插件框架整个搬进来当内核 | 等于引入一个不受控的内核 |
| turn / step 式的节拍 | 那是「写代码的 agent」的节拍，不是「活着的角色」的节拍 |
| 多段式配置协商 | 单进程里过重 |
| 按区域细分的权限模型 | 装第三方插件那天再说（§9.4） |
| 正则解析决策、非流式回复、固定超时收尾、`wait` 当动作 | 早期原型踩过，见 §9.2 |

### 9.2 关键设计决定

| 决定 | 理由 |
|---|---|
| **主大脑不说话** | Director 输出短（几十 token）可用贵模型且延迟可控；Performer 被硬打断不影响 Director 状态机；「说话中并行做事」自然成立 |
| **Delivered Prefix 必须有** | 没有它，日志记的是模型生成全文，但用户只听到前缀 → 下一轮模型以为自己说过了 → 接话必错。纯文字场景下打断粒度粗、不易暴露，语音与打字机字幕下必然发生 |
| **wait 不是动作** | 早期原型里曾经是。导致占动作槽位、要特判"打断 wait"、"连续 wait"要专门计数。改为**空意图 + wakeAfterMs 定时器**后全部消失 |
| **结构化输出不用正则** | 早期原型用正则抓 `START reply {...}`，模型换代/多语言/带 markdown 时必碎。改为 JSON 约束 + 校验 + 重试一次 + 降级空意图 |
| **配置进 SQLite 不用环境变量** | 密钥、人格、插件配置统一一处；`/config set` 即时改；换存储 = 换插件 |
| **内核裸启动，删掉全局配置文件** | 曾有 `mumu.config.json` 管 dataDir/pluginsDir/seed/kernel。既然「一切即插件」，这些就该各归各插件：dataDir 归 storage、模型绑定归 provider、人格归 persona。**默认在插件、覆盖在库**，比「种子文件」更少一层——不再有「改了 seed 却不生效」的坑 |
| **库是 merge patch，不是浅覆盖**（2026-10-21） | 原来 `{...defaults, ...库}` 只合一层：`/config set …roles.performer.model` 会把整个 `roles`（含 `default`）冲掉，provider-openai 只好要求「第一次整块写」。改用 RFC 7386：标准、一个函数、装配层与面板共用。否决「插件自己读清单再合并」（每个插件各写一遍）与「空数组表示删除」（只对数组成立，不统一）；代价是删默认键要写 `null` |
| **装配层不认识 roles** | 曾在 loader 里 `bindRoles()` 读配置库的 `roles`——那是给某一类插件开的特例。改为 provider 插件自己绑，loader 只剩通用的「配置变更→重载对应插件」，所有插件同等受益 |
| **大脑门控：话都过脑子，脊椎只管动作**（2026-10-22） | 原来「反射先开口、导演（现称大脑）事后补」：首字快，但真群里反射抢答把任务吃掉——主人 @ 她一道长题「用电脑试试看」，反射 350ms 回「电脑碰不到嘛…」，导演那拍被 `reflex.fired` 作废，下一拍又信了这句，computer 没起；还会复读历史里的错话、给自己编来历。打补丁（`actionWords` 词表、主人特判）追不上措辞。改成每条消息先到大脑，它决定 `quick`（脊椎秒回一条短的）/ 带想法回 / 应一声并起动作 / 不回；脊椎只做不用过脑子的：合流、硬闸、表情标记、游戏按键回路，以及大脑想太久（默认 2.5s）时替白名单里的招呼先应一声。代价是首字多一次决策（`quick` 约 1.5–2.5s），换来「说了就做、做不了说清原因」。延迟靠规则与动作目录前置命中前缀缓存来压（刚到消息的拍只带本频道近几条的「精简拍」一度也算一招，同日撤销，见 §9.3）。**否决**：内核加 `Decision.quick` 字段——一条 `start reply {reflex:true}` 就能表达，内核不该认识「快回」 |
| **内核变长 125 行是对的** | 重构后 1593 → 1718。多出来的是 Registry + 配置化 + 开放信封类型。用它换掉"加一种输出模态就要改内核""装记忆插件却喂不进主大脑"，划算。**不要为了行数少而牺牲通用性** |

### 9.3 曾经犯过、已修正的错误

| 错误 | 症状 | 修正 |
|---|---|---|
| 会话形态写进内核 | 有 `ChatTurn{role:'user'\|'assistant'}`、`kind:'user.text'`、`format.ts` 里的群聊渲染规则 | 全部通用化：`kind` 不透明，只认结构位 |
| **输入开放但输出封闭** | `Percept.kind` 自由，`Expression` 却是 `speech.chunk\|marker\|stop` 封闭联合。加图片/音频/游戏指令必改内核 | `Part { kind }` 开放信封，节拍固定 |
| 主大脑材料封闭 | `BeatMaterial` 内核写死七个字段，记忆/情绪插件无处可放 | `beat/gather` waterfall + `blocks` |
| 受众封闭枚举 | `Audience = 'mind' \| 'performer'`，第三个模型角色没法有段落集 | 自由字符串，与 `role` 对齐 |
| 全局可变态 | `IO.activeChannel` 单值，多频道并发串台 | 频道随意图流转 |
| 中文渲染进内核 | wakeText 拼 `「：」`、renderTemps 拼「距今 3秒」 | 内核只出结构化数据 |
| 三处手写注册表 | 段落/动作/marker 各写一遍 | 抽 `Registry<T>`（顺带让插件能开自己的集合） |
| channel 撞名 | 会话频道与 marker 通道都叫 channel | 后者改 `track` |
| 人格段落写 `audience: 'both'` | 受众只认角色名或 `'*'`，人格从未进过任何一次模型调用（v1「人机味」的直接原因） | 改 `'*'` |
| 导演指示伪装成对方说的话 | `[导演指示] …` 放在 user 轮次，模型当成对方在下命令，语气变客服 | 引导放 system 尾部；对方没说话时用 `[旁白]` 给开口契机 |
| 每句话等两次模型调用才开口 | 导演决策 + 发言各一次，首字 4–8 秒 | reflex 快车道 350ms 开口；导演只做补充、并行做事、主动找话 |
| 导演基于过时材料再起 reply | 它在 T 取材料、T+1s 决定，反射 T+350ms 已开口，两条并行 | reflex 在 `intent/pre-dispatch` 硬闸 + `reflex.fired` 作废进行中的决定；探针 s3/s4 守着 |
| 只说不做（2026-10-22） | 真群里主人 @ 她「截图桌面发群里」，反射 350ms 嘴上应了，导演那拍被 `reflex.fired` 作废且不留原因，computer / image 从没起过 | 要她做事的话（reflex `actionWords`）私聊群聊都不反射，导演同一拍「reply 应一声 + 起动作」；作废的拍也留唤醒原因；同拍 reply 排在动作后派发，动作被 guard 拦下时 reflex 改 reply 的念头（不然会先答应「这就去」）；新增 `screenshot` 动作。否决「反射照常应、导演不作废」：两条并行时谁先说、说什么更难控 |
| 凡事都反射（2026-10-22） | 真 QQ 私聊 29 条消息 29 次反射秒回，导演 44 次决策 0 次出手：对方连发 6 张表情包回 6 句、「更多群？」「给我的？」式复读反问，显得傻 | reflex 分流：只有纯表情包 / 很短又不带问号的走反射，问句、长句、连发合流后交给导演带着想法回（或不回）；首字慢一两秒。否决「全部交给导演」（简单的话也等 2–3 秒，又回到排队办事）与「反射照旧、事后让导演纠正」（说出去的收不回） |
| 陪群里的机器人演（2026-10-22） | 真群 51 条消息里 21 条来自另一个机器人 DeepSeek酱，她回了 13 条、大半在跟它斗嘴，还说「剩我们几个数字生命开会」「主人钱包在滴血」：太活跃、跟机器人对聊、自认机器人、漏系统层的词 | group-policy 认机器人（名单 + 自动打分，`bots.*`），标上后它的话不唤醒导演、@ 她也不算（surface-onebot 不按 urgent 打断）、不进话题 / 好感 / 阅读窗口，主人说「跟它聊两句」才解锁；接话默认值按真群重放调低一半多；mind-default 与 persona 写明被说是机器人就岔开、不说 token / 模型 / 钱包。否决「用正则把她说出口的系统词滤掉」（§9.2 不解析模型输出，且治标）与「机器人也照常打分、只是降权」（被 @ 时反射照样秒回，斗嘴还是停不下） |
| 把开口频率当节拍器（2026-10-22） | 为了压频率先后加过「目标每 10～15 / 20～30 条开口一次」「每群每小时最多主动开口 6 次」，原有「冷场后第一句高概率」。真群里主人说「用电脑算算」被每小时上限压掉。问题不在频率：话题不像聊就不聊，该去掉的是「必须主动开口」的设计 | 删掉每小时上限（每分钟上限默认也是 0）；冷场加分默认关；开不开口看「话题吸引力」（兴趣分由 interests 插件给，她自己维护）× 她此刻的状态，base 0.01，灌水 / 复读 / 低俗 / 机器人接近 0；主人在群里说的话一律叫醒导演；导演规则改成「不像聊就不聊、不用找话，timer 到点不是必须说」。否决「保留上限、只把数调大」（任何硬配额都会在主人真有事时挡路，也违背「话题有意思可以连着聊」） |
| 群里要人 @ 好多遍、主人被特殊化（2026-10-22） | 真群里聊一个问题不连贯，要 @ 好多遍；话题进来后只被动回复、不主动接；主人也该和其他人一样，他在跟别人聊时不用理他。原来只有 @ 才算冲她说，对方不 @ 的追问按普通一句打分；同一话题只主动接 1 轮；主人每句话都叫醒大脑，他跟别人聊、发张表情包她也冒一句碎话。真群日志重放：她回过某人后 120 秒内对方接着说的 145 句里，107 句要么带了 @、要么没人理 | group-policy 加「正在对话」（convo.ts，按群 + 对方：她回了谁 / 谁 @ 了她就聊上，对方接着说一律叫醒大脑；收尾 / 连续 2 句跟别人说 / 120 秒没人续 / 连说 3 句她没接就结束；她说话时对方又说的，说完再叫一次）；话题内主动由话题吸引力 × 轮数衰减决定，轮数只留作安全上限；撤掉「主人一律叫醒」和「主人刚在群里说」块，改成「像要她做事的话谁说都叫醒」（能不能做由 guard 认号）；机器人的话与群友只冲机器人说的话在大脑和发言者的历史里标「（机器人）」「（在跟机器人说）」（一度剔掉，后来改成留着标清楚：她可以回机器人，但要明白那是套话）。同一份日志重放，改后只剩 10 句因对话已断还得 @。否决「把一律叫醒扩到所有人」（群里多半不是冲她说的）和「只把话题轮数调大」（硬配额不看话题还在不在） |
| 在聊 ≠ 每句都接（2026-10-22 傍晚） | 「正在对话」上线后真群甲 17:50–17:58：她回过灰灰子一句后，他的「为什么」「多押韵」和两个旁人的插话全被 convo 直通 p=1 叫醒（旁人是「她开口前别人那句」的兜底猜出来的），大脑十二秒里三次「接住梗」，八分钟开口 14 次；名单里的机器人一句「搜的就是不太对」命中任务词也 p=1 叫醒 | 删掉 convo 直通与 index.ts 的 `direct` 分支，正在和她聊的人接着说并进 judge 的「在聊」分支（起点就是 `followUp`、按她在这段里接过几句衰减——当晚定的口径是「不是大都接，但要比一句不接多一点，有话题还是可以聊」，所以不另设更高的起点、不加新键，并把在聊的起点整体收到 `followUp` / `related` 0.4、`topic.inTopic` 0.3、`interestInTopic` 0.6；她说话时到的那句「说完补叫」也改成按同一套分掷骰子，不再一律叫醒）；「她回了谁」不再猜，按叫醒那拍大脑的原因里说话的人认（`mind.decision` 带 sender → reply → utterance → `Entry.to`）；机器人（名单或表现端标的 `data.bot`）的话不走「要她做事」直通，只走带机器人系数的打分；大脑【群聊】加一句「在聊也不是每句都接：一拍只接一个人，连着接了两三句就停一停」；同一处顺带修复测 R-1「同一件事说两三遍」——她每开一次口，这个群里正在聊的人在那之前说的话都算看过了（原来只给她这段在回的人销账，被算成回别人时「还没接」挂着，`convo.pending` 又补叫一次），材料也不再写「漏了要紧的话一定要补」。否决「再加一个『在聊刚接过就打折』的开关」（又叠一层）与「只改提示词」（p=1 每句叫醒，提示词挡不住三次「接住梗」）。模拟器 `real-convo-spam` |
| 说了对方没接还追着说（2026-10-22 深夜） | 真群乙 23:21–23:29（虚拟机当时还是直通版）：她回了青山一句，青山接着跟群里聊他的火箭项目、群友都在 @ 他，他一次没回她，可「正在和她聊」只认「她回过谁」、只靠 120 秒没人续才结束，他每句白话都叫醒她，她八分钟对他开口七次，把他冲另一个群友说的「倭寇」当成说自己；话题线也把她回头接的旧话题重新开成「她参与的话题」 | 对话的结束条件补上「她说了对方没接」：她开口后对方的第一句正经话没接上她（没有共有词、或接的是旁人的词；长问句不算数），或对方没吭声、旁人已说了 `topic.switchAfter` 句和她无关的，就放下；她说话时对方冲别人说的不挂「还没接」；在聊分支里她说的比对方回的多就多衰减一次；话题参与者按她真在回谁认，群里换走的话题她回头接不另开，「参与者紧接着的回话」要中间没隔无关的话；大脑材料多「你说了对方没接」、【群聊】一句「说了对方没接就放下，别追着说」。没加新键、新开关。否决「把 `idleSec` 缩短」（真在聊的人打字慢也会被断）。模拟器 `real-ignored` |
| 任务词直通叫醒闲聊（2026-10-23） | 「正在和她聊」直通删掉后，群里剩下的唯一直通 p=1 是「像是要她做事」：任务词子串匹配（「运行」「搜」「帮我」「打开」…），谁说都叫醒。真群乙 23:29 Novas「我的日语模块已经分成三份独立运行了」p=1 叫醒，她把它当冲自己说的；当天主群 11–18 点这条 p=1 叫醒 7 次。该看的是「是不是她喜欢的话题」，是就乘上唤醒概率，而不是子串匹配 | 删掉 group-policy 的做事直通（`looksLikeTask`、`task.words / except / chatterSec` 默认值与设置项）和冷 @ 里「@ 她让她做事」的豁免；没 @ 她的群消息一律走两态打分，是她喜欢的话题就乘上去（同日兴趣也从关键词抬底改成语义相近度乘法，见「兴趣靠关键词包含抬底」那行）；真要她做事会 @ 她（冷 @ 叫醒大脑）。guard 认「谁让她做的」与 reflex 的 `actionWords` 提示不动（那是给大脑的材料，不决定叫不叫醒）。代价：主人不 @、随口一句「用电脑算算」不一定叫得醒她，模拟器 `guard-late` / `spine-owner-noat` 的核对标准随之改。否决「把任务词表收紧 / 加例外词」（子串匹配本身就是傻的，补词表补不完） |
| 主人让发文件也要先确认、确认还不算数（2026-10-23） | 真群甲 16:12 主人让她把下好的 mp3 发群里：guard 的 `confirm` 含 `qq.send`，主人在群里下令也先拦一次要她问；她记着上次被拦，只嘴上问「要我发群里吗」、没起 qq.send，guard 只在拦下时登记一个键、等大脑再起，这回没东西可登记，主人回「确认，发吧」不算数；那句还被 group-policy 按「在聊」打分 p=0.407 没叫醒她，120 秒后才醒，过后起 qq.send 又被拦一次 | guard：`askOwner`（发文件 / 图 / 语音）主人要就直接做，别人要先问主人；被拦的意图整个登记，主人在那个频道回肯定的短话 guard 直接起、否定作废，10 分钟过期；只嘴上问过的，主人答了之后大脑再起也认；一句答复只算一件事，用过即销（复测抓到：第一首点过头，路人再要第二首，旧答复被又算一遍、没问就发了）。group-policy：她问了谁（在回的人或点名的人），那人接着接得上她的第一句标 `asked`，judge 直接 p=1。否决「主人的话一律叫醒」（主人跟别人聊也不理，见上「主人被特殊化」那行）与「确认词出现就放行最近一次被拦的动作」（要登记的是哪件事、在哪个群答，不然主人随口一句「好的」就替路人发了文件） |
| 主人的事晚一拍就不认（2026-10-22） | 真群里主人没 @ 她说「用电脑算算」，导演第一拍只回话，补拍（唤醒原因是 timer / 动作完成，没有 sender）才起 computer，guard 只看本拍 sender，判「（没人），不是主人」拦下，她说「这台电脑我碰不了啦」，像坏了 | guard 在 percept 进来时给每个频道记任务类请求（带任务词的话：谁、何时、原文；词表并上 reflex 的 actionWords），本拍里没人要她做事时看这个频道 10 分钟内最后一条任务请求是不是主人的；导演在 params 写 `requestedBy`（guard 给它一块带号的「要你做事的」），对不上就拦；拒绝的说法改成「这个得我主人叫我才动」。否决「主人说过话后一段时间内一律放行」（路人接一句「顺便帮我也算」就成了替路人做）与「靠导演自报 requestedBy 定权限」（导演会被说服，自报只用来核对，不用来放行） |
| 反射抢答把任务吃掉（2026-10-22） | 真群 11:15 主人说「跑一下」被 guard 误判拦下，她说「这台电脑我碰不了啦」；11:19 / 11:26 主人 @ 她发长题「用电脑试试看」，反射 350ms 照着历史复读「电脑真碰不了嘛」「电脑碰不到嘛…」，导演那拍被作废，carry 过来的下一拍看到这句就信了（「可电脑连不上」），动作没起 | 大脑门控（§9.2）：反射降为脊椎、不再先开口，`reflex.fired` 不再作废大脑；被作废的拍的原因全部带到下一拍并标「想到一半被打断、还没处理」；被拦时改 reply 念头「别说电脑碰不到 / 坏了，说清原因」；大脑规则加「她说过做不了 ≠ 现在做不了，以运行中的动作、动作结果和拦截记录为准，对方再要就再起」；模拟器 `spine-*` 场景守着（`spine-retry`：群友被拒之后主人再要，照样起 computer） |
| 汇报没报出结果、快回回成碎句（2026-10-22） | 大脑门控上线后真群：DSH 跑完水杯题，大脑两拍 guidance 都写了「n=8 k=3 最坏 5 次」，发言者两次去怼群里最后那条挑衅，结果一字没提；主人说「感觉还得调试一下」，大脑走 quick，回出「嗯，边界啊搜索空间」 | action-reply 认出本对话还没汇报的动作结果，加一段排在【要求】前的【这次开口是汇报】（带结果摘录）；大脑规则：quick 只用于寒暄 / 一两个字的应答、汇报的 guidance 写结果要点；脊椎把关：对方最近一句不轻就把 quick 降成正常回复（`reflex.quick-demoted`）；模拟器 `spine-report` / `spine-quick-misuse` |
| 群聊把「不接」写死（2026-10-22） | 真群日志「读空气：没接 · 低俗 / 骂战 / 政治话题（几把），不接 · p=0.00」「DeepSeek酱 是机器人（名单），不理 · p=0.00」；一句「这几把天气真热」被词表硬判 0，同一个人两分钟内第二次 @ 她 wake=false 连想都不想。真人不是完全不接：被强 @、点名多了会烦、会生气、会拉黑或视而不见——这该由她自己判断，不该写死；她本性纯洁善良；机器人的话可以回，但要明白那是套话 | **群聊不写死不接规则，判断权在她**：group-policy 里凡是对「这句话内容」的硬 0 / wake=false 全改掉——低俗词 × `tabooFactor`、机器人 × `bots.attraction`（@ 她按冷 @ 以 `bots.atWake` 叫醒）、同人连问 × `sameSenderFactor`、刚 @ 过 / 刚敷衍过一律叫醒；词表与名单只用来给大脑写一行提示（`beat/gather`【读空气】：这句带什么词、机器人说的、这人今天第几次 @、她对他多烦）；mind-default / persona 的「一律不接」改成人设倾向（纯洁善良，一般不接也不接梗，但是她自己的选择）。保留的硬 0 只有她的处境（正在这个群说话、倍率设 0、忙着做事）。新增按人累积的脾气 `temper.ts`：骚扰度按「群 + 人」从日志投影、半衰期消气（全量测试里一次 ignore 曾泄漏到所有群，改成按群；拉黑是对人、跨群），阈值只产出「有点烦 / 很烦 / 忍无可忍」这种形容词，**不直接执行**；「不理他了」是大脑的决定（动作 `group.ignore`：ignore / block / forgive，写 `temper.ignored`），group-policy 只执行、到期自动恢复，拉黑由 memory 听日志记进印象与事实；主人不适用。**否决**「阈值到了自动不理」（又是写死的规则，且她该先委屈、岔开、不耐烦再到不理）、「机器人照旧完全不理」（她该看得到、知道那是套话）、「用 at.perPersonSec 连想都不想」（烦不烦该由累积的材料和她自己定）。模拟器 `temper-harass` / `temper-dirty` / `temper-bot` + 真群回放 `real-ccb` / `real-ml` / `real-bot-chat`（她当时每次接「又ccb我」、逐句评论 ml、跟 DeepSeek酱 斗嘴说「我是数字生命」） |
| 用一个很低的固定概率压群聊频率（2026-10-22） | 为了「少说话」把 group-policy 的意愿压成一组很低的固定数（`base` 0.01、问句 0.15 且要 ≥6 字、接话 0.15 / 0.18）。结果模拟器 flood 场景 24 句闲聊大脑一次没醒，真群里她几乎只在被 @、被点名时醒，和她聊着的人不 @ 就断。本意是像人一样：没在聊的时候少回，看一眼就过去；在聊的时候接着多聊几句，而不是机械地用一个概率 | **意愿按状态分，不再是一个数**：judge.ts 先判「在聊」（她参与的话题还开着、这句在接它 / 接她刚才的话 / 和她的话题线对得上）还是「没在聊」。在聊 = 多聊几句（0.4～0.7，取最高后按她在这个话题里主动接过的轮数衰减）；没在聊 = 像人刷群，`base` 0.08 偶尔让大脑看一眼（插不插话由大脑的【群聊】规则定，策略层不替它决定），有人在问 0.3、碰到兴趣 0.6；灌水 / 复读 / 纯表情 / 指令 / @ 别人 / 两人对聊照旧接近 0；问句 6 字门槛去掉，认不认真交给大脑。好感、脾气、机器人系数、限频不动。大脑材料多一块「这次为什么叫醒你」（在聊 / 没在聊）：叫醒 ≠ 开口，没在聊时它多数时候该看一眼就过。**否决**：再调一组固定数（无论高低，都没有「状态」）；把「偶尔看一眼」做成每 N 句 / 每 N 分钟必看（又是节拍器，见上）；再叠一层「刚叫醒过看了一眼就打折 90 秒」（做了又删：又一个机制，改得越多越傻，能删的判定就删、简单为先——没在聊就是一个 base，够了）。测试 `test/group-state.test.ts` 守住两种状态分得开 |
| 嘴上答应却没做、没做却编进度（2026-10-22） | 门控上线前真群：「@沐沐 截图看看桌面」反射答「好，我这就去弄」，大脑被作废，一分钟后「截图呢？」又是「这就去截」，始终没起动作（#9158/#9327）；群友让做主页，她只嘴上应了，被问「实时汇报项目进度」时编「刚建了个文件夹」，被戳后大脑又写「在弄呢」（#4968/#5082） | 门控后「截图」先到大脑、同拍起动作；action-reply 在这个对话没有在跑的动作时给每次发言加【手头】（没开始的别承诺、被问进度老实说没在做）；大脑规则：问进度先看正在运行和工作记忆，guidance 不许写没有的进度；模拟器 `spine-shot-ask` / `spine-fake-progress` |
| 大脑的「精简拍」（2026-10-22） | 大脑门控上线时为追「决策 p50 ≤ 1s」，只因刚到的消息而开的拍只带唤醒原因所在频道最后 `leanHistory`（10）条、别的频道一条不带。虚拟机实测完整拍 p50 1099ms、精简拍 1087ms，只快 12ms（瓶颈是远端模型首包）；真 QQ 15:04 主人私聊问「今天给你加了几个群，感觉怎么样」，那拍 `lean:true`，材料里看不到任何群里的事，她答「我都还没进去看过呢」——门控上线前同类提问的材料里网页、群、私聊混着，她答得上 | **撤销精简拍**，每一拍都带全频道的最近对话（越像人越好）：`isLean` / `leanHistory` / `leanSkip` 整套删掉，不留开关；配套把内核默认 `historyLimit`、群里的阅读窗口放大，群频道那几条由 group-policy 在 `beat/gather` 换成阅读窗口（和发言者同一个）。**否决**「保留开关默认关」（「以后可能用」的抽象）与「按频道各带几条」（真人回想的就是混在一起的近况） |
| 兴趣靠关键词包含抬底（2026-10-23） | 兴趣分是关键词子串匹配（interests 的 `store.match`，没装时退回 group-policy 的 `interest.words`），读空气把 p **抬到** 0.6 × 分。「火箭队今晚比赛」「房价涨得跟坐火箭似的」算航天，「猎鹰九号回收了」「马斯克的筷子夹住了一级」反而不算；表里混进「紧张」「图片」这类泛词后无关的话也成了兴趣。该看的是语义上是不是她喜欢的话题，是就乘上唤醒概率，不靠代码匹配 | interests 改成语义打分（`semantic.ts`）：每条兴趣（名字 + 关键词）与每条消息各一个句向量，余弦减去这条兴趣对日常闲话的平均相似度，过阈值线性成相近度，× 兴趣分 = 感兴趣程度；默认本机 CPU 上 transformers.js 跑 bge-base-zh（不依赖 4090 与网络，按文本缓存、限时 300 毫秒、失败回 0），退路是让聊天模型打分。group-policy 的兴趣从「抬到」改成乘法：两态算完 `p × (1 + k × 感兴趣程度)`（k 3，上限 1，同日下午改成没 @ / 没叫名字的封在 `capNonDirect` 0.9、p=1 只留给被叫到——在聊 × 兴趣不该乘成每句必接；起初 1.5，真群回放乘得太轻调上来，见 group-policy README 第六轮），删掉 `interestIn` / `interest.words` / `interest.value`；日志投影「提到兴趣没接」、大脑材料「这句聊到了你感兴趣的」用同一个分。关键词只留给向量文本、展示和认同一话题。**代价**：本地小模型仍有噪声——有的兴趣话只认出一点、闲话偶尔沾上带泛词的兴趣（同日下午按 40 句对照集压过：进向量前剥掉图片 / 转发 / 回复的占位壳，兴趣文本加一句描述，闲话基线扩到 60 句，「平时」两头都减——这句话也减它离最近 5 句闲话有多近，「吃了吗」「狗修金」这种贴着某类闲话的短句不再乘上去，阈值 0.16 / 0.26；对照集 AUC 0.70 → 0.98，见 interests README；只抬阈值、只扩闲话都试过，单用分不开，bge-large 不比 base 好）；没在聊时兴趣话题的意愿比原来低（原来直接抬到 0.3 上下，现在 base 0.08 × 至多 4）；每条群消息多一次本地向量计算；后端多一个依赖和约 100MB 模型文件。**否决**：补关键词表 / 加例外词（子串匹配本身就是傻的）；向量模型挑大的（bge-large / Qwen3-Embedding-0.6B 在同一批句子上不比 bge-base 好多少，内存和下载大几倍）；默认让 4090 打分（同一批句子全对，但一句 0.6～1.9 秒、引擎按需启动，留作配置项 `semantic.via: model`） |
| 兴趣被「没接」扣光、大脑二次把关（2026-10-23） | 真群回放：主群 7 小时她自己开口只占别人消息的 0.7%。两个原因互相喂：① 没在聊时读空气那一掷（p 中位数约 0.03）本身就是「偶尔看一眼」，大脑材料（group-policy `wakes.ts`、mind-default【群聊】、judge 兜底 why）又写「默认不插话、看一眼就过」「不回是常态」，没被 @ 的叫醒大脑只说 11%，note 照抄「看一眼就过」；② interests 的「没接」只要这期间大脑因为那个会话醒过一次就算她看到了，扣分还直接扣穿人设下限：线上一天把猫从 0.65 扣到 0、航天 0.63 → 0.38，语义打分 = 相近度 × 兴趣分，「星舰」「火箭发射」乘出 0，兴趣不再抬 p，她开口更少、更多「没接」 | ① 三处措辞只写状态：「你没在这个群聊着，刷到这一眼；有想说的就说，没有就过」，去掉默认不说的倾向（概率那关已经是看一眼，大脑不再二次把关）；② 「没接」只算叫醒大脑的就是那句（`beat.opened` 原因是这句原文）而她没开口的；扣分夹在 floor（人设 `personaFloor` 0.3）上。回放同一段：叫醒后大脑开口 26% → 41%，自己开口翻倍，机器人那头没涨。否决「把 base 调高补频率」（大脑照样九成不说，白叫醒）与「去掉没接降分」（真看到了不接，兴趣是该淡） |
| 图只给转译后的一句话（2026-10-23） | 群友发的图先经 `vision.read` 转成「[图片：…]」再进发言者 / 大脑，描述看错颜色、漏了图上的字、把梗看成字面时，她照着转述接话，和群友看到的对不上。模型本身已是多模态，聊天里最近那几张重要的图应直接进上下文，避免转译带来偏移 | 实测 DeepSeek `deepseek-chat` 与 4090 `qwen3.8-27b` 都直接收图（1024 的图约 500 / 770 token，时延在抖动内）。surface-onebot 收图时另存 1024 / q80 副本、记进感知 data；服务 `images` 挑每会话最近 3 张、15 分钟内、总共 ≤2MB 的，发言者（快回除外）与大脑把那几条描述换成「[图片]」并附原图；描述照旧生成给记忆 / 阅读窗口 / 搜索 / 日志。**不改内核**：`ChatMessage.content` 仍是字符串（冻结契约 `ProviderAdapter` 用它），原图作为消息上的插件层字段 `images`（文件名 + 字节数）经网关原样转发、原样落日志，provider-openai 发请求时才读文件转 base64——否决「content 改成多段数组」（要动冻结契约，且 base64 每拍落进 `model.request`，日志一天几百 MB；文件名 + 按内容命名的媒体目录已够还原 I1） |
| 无终端时 CLI 表现端杀进程 | stdin 关闭后 readline 已 close，再 `prompt()` 抛错 | 关闭后变安静，不退出 |
| **开源前内核审查（2026-10-24，内核 1.1）** | 下面几行是同一轮：开源后第三方照内核写插件、采数据，契约晚改就是破坏性变更，所以开源前一次改定 | 判据：要改现有语义的、不定形状生态会分叉的、晚了数据补不回来的，开源前做；其余按 architecture-paper §9「新增可选字段」以后加 |
| 插件在 `percept/pre-beat` 的改写被丢 | terminal 与唤醒用闭包里的原感知 / 频道，`group-policy` 把 kind 改成 `message.queued` 无效 | 打断与唤醒一律按水线最终 payload |
| 内核里有中文进模型材料 | 动作结束「动作 X 完成」、定时唤醒、孤儿提示、停止理由、实例初始 note | `text` 只给短代码，细节进 `WakeInput.data` / `Note.data`（带 `code`）；说成人话归 decider |
| 清日志不清工作记忆 | `Mumu` 构造 `SessionLog` 没传 `onReset` | 接上 `prompt.clearNotes()` |
| 降级只打控制台 | 决策抛错、派发未知动作、send/stop 找不到目标只 `console.error` 或悄悄返回 false | 记 `beat.decide-failed`、`intent.dispatch-failed { code }`；内核带码错误 `KernelError` |
| 轨迹当不了训练素材 | `model.response` 不记模型原始输出；id 是进程内计数，重启后 `reply#1` 重复；日志不知道是哪个版本写的 | 记 `output` / 采样参数 / provider 错误；id = 前缀#起始事件序号（清空也不归零）；每段以 `log.opened { boot, kernel, schema }` 开头 |
| 动作 `run` 同步抛错实例永不结束 | 还没返回 Promise 就炸，`.then` 挂不上，实例永远「正在运行」、I3 不收尾 | 同步异常转成 rejected Promise 照常结算；`Outcome` 补上孤儿恢复早就在写的 `interrupted` |
| 发声的小泄漏与悬挂 | 每句话在动作信号上挂一个 abort 监听从不摘；`expression/pre-emit` 拦截器抛错，`end()` 卡住、`settled` 永远悬着 | 结算时摘监听；拦截器出错记 `expression.route-error` 并按原样送出 |
| 容器并发 flush 误删插件 | 两个 load 的 flush 快照里有同一个插件，后到的 `splice(indexOf=-1)` 删掉队尾别的插件、还装两次 | 处理前确认它还在队列里；卸载也撤掉还在等依赖的插件 |
| 材料块顺序不固定 | `MaterialBlock.order` 可选缺省 0，同号按插件加载先后，热重载后会变；段落却按 id 决胜 | `order` 必填，同号按 `from` 排 |
| 热重载行为随 Node 版本变 | engines 写 22.5，`registerHooks` 要 22.15，版本不够悄悄退回只刷新入口 | engines 22.15，没有就报错 |
| 多模态各插件自己绕 | 模型消息只有 `content: string`，`look.ts`、`vision.ts` 用 `as unknown as ChatMessage[]` 传图 | 只定形状：`MediaFields`（mime/ref/bytes/durationMs）进 `Part` / `Percept`，`ChatMessage.parts?`，`BlobStore` + `blobRef` 内容哈希，`Feedback` 事件形状；内核不写机制 |
| 「热重载 / 平行历史」误判 | 只比最后一条存量的序号，内存与存量条数相同就当成热重载，存量被跳过 | 序号、时间、类型一起比 |

### 9.4 明确推迟的（每一项都验证过"回来时内核不动"）

| 推迟项 | 回来时的形态 |
|---|---|
| 情绪状态演化 | 插件：听 `log.appended` + 自有状态 + `beat/gather` 贡献 block |
| 记忆 | 插件：`ctx.memory` 服务 + 惰性段落 + 听日志写入 |
| 分级思考 / 内省 / 卡住提示 | mind 插件内部演化（或换一个 decider 插件） |
| 语音 / VAD / 端点判断 | surface 插件 + `percept/pre-beat` 拦截 |
| Live2D / 3D / 游戏 | surface 插件（跨进程时才引入 Kit + 独立 protocol 包） |
| 群聊 / 弹幕平台 | surface 插件，自己的 kind/channel/sender |
| 工具注册表（函数式） | 目前「工具即动作」；真需要再开 `ctx.tools` |
| 权限 / 沙箱 | 容器加能力裁剪，装第三方插件那天再说 |
| 多实例 / 跨实例通讯 | `Mumu.create()` 已支持多棵树；Spark 类信号等真需要再加 |
| 密钥管理 | 外围插件：密钥只存本地库，provider 按名字取；`mumu.defaults` 只放密钥的名字（已由 `secrets` 插件实现） |

### 9.5 曾被当作"待拍板"、后来判定为**插件内部事务**的问题

这些**不是架构问题**，不要再拿到内核层讨论：

Gate 层要不要 · marker 词汇有哪些 · 情绪维度全局还是按对象 · 日志归档策略 · 多人格是否共享记忆 · 内省默认开关 · 并发工具上限

---

## 10. 代码风格约定

| 约定 | 说明 |
|---|---|
| 注释写**为什么**，不写代码在干嘛 | 尤其：这个分支为何存在、这个顺序为何重要、这个降级为何安全 |
| 文件头 JSDoc 说清该模块的**契约与立场** | 内核每个文件都有，照着写 |
| 中文注释 | 项目是中文的，保持一致 |
| 早返回，少嵌套 | 但不为减少缩进而抽壳函数 |
| 空 catch 必须写清吞了什么、为什么安全 | 见 `provider-openai` 的坏帧跳过 |
| 不为"以后可能用"预留抽象 | 推迟表里的东西都验证过内核不动，就别提前建 |

---

## 11. 命令

```bash
npm start          # 起沐沐（CLI）
npm run check      # tsc 严格模式
npm test           # node:test
```

运行时命令：`/plugins` · `/plugin enable|disable|reload <id>` · `/config get|set <路径> [值]` · `/log [n]` · `/quit`

开发时改插件文件**自动热重载**（watch 默认开）。

---

## 12. 当前状态与下一步

**已有**：
- 内核九机制，契约冻结（[architecture-paper.md](architecture-paper.md) §9）。
- 官方插件（§7 表）：大脑 `mind-default` + 脊椎 `reflex`、发言 `action-reply`、人设 `persona` / 角色包 `characters`、记忆、情绪、时间感、生活状态、兴趣、表情包、搜索、电脑身体 `action-computer`、守门 `guard`、密钥 `secrets`、模型路由 `provider-openai`（含本地模型分级与失败改用）。
- 表现端：终端 `surface-cli`、网页 `surface-web` + `apps/web`（Vue + Live2D / 立绘舞台、字幕、语音、思考可视化、可视化设置）、QQ `surface-onebot`（NapCat / OneBot v11）+ 群聊读空气 `group-policy`、桌宠 `apps/desktop`、Windows 身体服务 `apps/body`。
- 测试工具：对话探针 `scripts/probe.ts`、假 NapCat 模拟器 `scripts/fake-onebot.ts`（剧本场景带自动核对）、回放与压测脚本（见 `scripts/README.md`）。测试以 `npm test` 为准。

**每条改动的来龙去脉**在 §9（决策记忆）与各插件 README；群聊相关的反复调整集中在 `plugins/official/group-policy/README.md`。

**下一步**（都**不应该需要改内核**；发现必须改，先回到 §2 的判据重新想一遍，真要改，改完回来更新 §9.3）：
1. 口型升级：从音量映射到元音，profile 加 `mouthForm`。
2. 语音输入与打断（surface 插件 + `percept/pre-beat` 拦截）。
3. 多平台接入（Satori 等），仍是 surface 插件。

> 开发提示：跑冒烟测试后确认进程真的退了（`pgrep -f 'tsx src/main.ts'`）。
> 残留进程会占住端口，下次启动时表现端插件报 EADDRINUSE——
> 它会优雅降级（记错误、其余照常），所以容易被忽略。
