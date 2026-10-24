# 内核手册

> 内核每个机制怎么用（细节参考）。内核会慢慢长大——新机制加新目录，别往一个文件里塞。
>
> 项目定位、全部约定与决策记忆见 [handbook.md](handbook.md)（接手先读那篇）；
> 上层架构方案见 [mindcore-architecture.md](mindcore-architecture.md)。

## 出口纪律

**内核对外只有 `kernel/index.ts` 一个出口。** 外部（loader / shared / 插件 / 别的 Host）
一律从它导入，不许摸 `kernel/<子目录>/…`，也不许摸 `kernel/mumu.ts` 这类直接文件。

好处：内核内部随便重构、拆分、改目录，外面零感知。加新机制的动作是——
写好实现 → 在 `kernel/index.ts` 补一行导出 → 完事，`src/index.ts` 不用动。

`test/boundary.test.ts` 守着这条线，越界会红。

## 立场

内核提供**机制**，插件提供**策略**。判据一句话：**换一个插件能不能换掉它？** 能 → 插件；不能（它是插件赖以存在的地基）→ 内核。

内核不认识任何：provider、动作、表情、会话形态、模态、存储介质、**任何一句中文渲染**。

## 目录

```
src/kernel/
├─ core/       container（ctx/inject/effect）· bus（emit + waterfall）· registry（贡献集合）
├─ session/    log（append-only 唯一真源 + 持久化 seam）· types（通用会话结构）
├─ llm/        gateway（角色绑定网关）· stream（StreamChunk + marker 解析）
├─ mind/       scheduler（心跳：合流/退避/熔断 + decider 槽位 + 开放材料）
├─ actions/    registry（动作类型/实例/生命周期/频道）
├─ prompt/     assembly（段落 Contribution + 工作记忆）
├─ io/         port（percept/expression/utterance/送达回执 + marker 词汇）
├─ mumu.ts     装配（唯一知道全貌的文件）
└─ index.ts    内核公共 API —— 对外唯一出口
src/shared/    插件可选用的渲染助手（内核自己不用）
src/loader/    Host 装配层：扫描 plugins/、热重载、启停（不属于内核）
```

## 两端对称的开放信封

内核最重要的一条纪律：**输入与输出同样开放**。

```
Percept { kind: string, channel?, sender?, text?, urgent?, data?, ...MediaFields }   ← 进
Part    { kind: string, text?, data?, ...MediaFields }                               ← 出
MediaFields { mime?, ref?, bytes?, durationMs? }   非文本载荷：本体在 BlobStore，这里只记 ref
```

`kind` 两边都是自由字符串，语义由插件定义。内核不认识 message / danmaku / vision / image / card / game.cmd 中的任何一个。
`mime` 也一样：内核不按它分支（不认识模态），只让它随片段原样记账、原样传递。非文本片段在 `text` 里写一句摘要作兜底。

固定的只有**节拍**（这才是机制），两端都是流：

```
进：Perception = 若干 update → end / cancel   io.perceive()（一次性输入用 io.percept()）
出：Utterance  = 若干 part   → end / stop     动作的 a.utter()
```

`Perception.update` 是**修订**（整体覆盖），不是追加。三段都落日志
（`perception.started/part/settled`）——因为在途内容进了 `BeatMaterial.incoming`，
按 I1「模型可见 ⟺ 已记录」必须可重建。被 `cancel` 的不进对话历史。

| 结构位 | 内核唯一用它做什么 |
|---|---|
| `Percept.text` + `sender` | 进对话历史（other 侧） |
| `Percept.channel` | 路由表现端、打断只切本频道 |
| `Percept.urgent` | 默认打断策略的唯一依据（语音 barge-in 同此） |
| `IncomingView` | 在途感知快照：角色据此决定插话还是等对方说完 |
| wake `partial` | 唤醒来自没说完的半句话 |
| `Part.text` | **只有它计入送达账**（文本线性可截断，其余片段原子） |
| `Surface.channels` | 不服务的频道收不到 |
| `Surface.capabilities.deliveredReport` | 决定按回执还是按全量记账（索引签名开放，新能力不改内核） |
| wake `external` | 永不退避、解除空拍熔断；内生唤醒（动作收尾）为 false |

表现端**不认识的 `Part.kind` 直接忽略**——这就是能力降级的全部规则。

## 三条日志不变量

- **I1** 模型可见 ⟺ 已记录。
- **I2** 说出去的 ⟺ 记录实际送达的部分（打断记 delivered 前缀，不记生成全文）。
- **I3** `action.started` 必有 `action.ended`；孤儿在挂载存储时补 `interrupted` 并变成角色的「自我察觉」。

## 日志分段与 id（训练素材的硬条件）

- **分段**：每段日志以 `log.opened { boot, kernel, schema, cause }` 开头。启动一次、`reset()` 一次各算一段；
  它在第一条别的事件写入、或冷启动挂上存储时补写，所以总落在这一段的最前面、存量之后。
  `kernel` / `schema` 是 `src/kernel/version.ts` 的 `KERNEL_VERSION` / `LOG_SCHEMA`，旧日志按当时的版本解读。
- **id**：动作实例、发声、流式感知、模型请求的 id 都是「前缀#它的起始事件的序号」（`log.appendNew`）：
  `reply#1834`、`utt#1835`、`in#1840`、`req#1841`。序号随存量续写、`reset()` 也不归零，所以 id 在同一份日志里永不重复；
  多份日志合并时用 `log.opened.boot` 区分。形状仍是「名字#数字」，按 `#` 切动作名的消费方不受影响。
- **模型调用**：`model.request` 记 `messages` 全文与采样参数 `params { temperature, maxTokens }`（不记密钥、不记地址）；
  `model.response` 记 `output`（模型原始输出：相邻文本合并，marker 按到达位置保留）、`chars`、`usage`、`aborted`，
  provider 中途报错时另记 `error`（错误照常抛给调用方）。调用方中途不读了（break）也会记下已吐出的部分。

## 开放的一拍材料

`BeatMaterial` 内核只填自己知道的（reasons / catalog / running / history / notes / sections），然后过 **`beat/gather`** waterfall——插件往 `blocks` 里贡献任意材料：

```
MaterialBlock { from, order, text, data? }
     order = 必填；同号按 from 排（与段落同号按 id 排是同一条规则），不看插件加载先后
     text = 任何 decider 都能渲染的自然语言
     data = 给认识它的 decider 的结构化载荷
```

记忆、情绪、外部状态都走这条路，内核不必认识它们。

## 渲染归消费方

内核只出结构化数据，**一句中文都不拼**：

| 内核给 | 谁渲染 |
|---|---|
| `WakeReason { source, text, data?, channel?, sender? }` | mind-default 的 `reasonLine` |
| `Note { source, text, data?, elapsedMs }` | `shared/renderNotes`（插件可选用，也可自己写） |
| `HistoryTurn { role, kind, sender?, channel }` | mind-default 的 `turnLine` / action-reply 的 `toMessage` |

内核**自己**发的唤醒与工作记忆，`text` 只是短代码，细节在 `data.code` 及其字段，说成人话归 decider：

| 来源 | `source` | `text` | `data` |
|---|---|---|---|
| 动作结束 | `action:<动作名>` | `reply#12 done` | `{ code: 'action-ended', id, action, outcome, error? }` |
| decider 定的等待到点 | `timer` | `wake-after` | `{ code: 'wake-after', afterMs }` |
| 上次运行没收尾的动作（工作记忆） | `kernel` | `interrupted: reply#3, …` | `{ code: 'orphans-interrupted', ids }` |

`Outcome = 'done' | 'stopped' | 'error' | 'interrupted'`（interrupted 只由 I3 孤儿恢复补记）。decider 停动作不给理由时，理由是 `decider-stop`。

**降级必须可见**：决策抛错记 `beat.decide-failed { error }`；意图派发失败记 `intent.dispatch-failed { intent, code, error }`，
`code` 是 `unknown-action`（没有这个动作）、`no-target`（send / stop 找不到运行中的实例，多半是它刚结束）或 `error`。
内核抛的带码错误是 `KernelError { code }`；`message` 只给开发者在控制台看。
`expression/pre-emit` 拦截器抛错记 `expression.route-error` 并按原样送出——发声必须能走到结算。

## waterfall 扩展点

| 水线 | 时机 | terminal（默认行为） |
|---|---|---|
| `percept/pre-beat` | 感知落日志后、唤醒前 | urgent ⇒ 硬停本频道发声；`wake:false` 压制唤醒 |
| `beat/gather` | 一拍材料汇聚后 | 原样返回；插件往 `blocks` 贡献 |
| `intent/pre-dispatch` | 意图落到动作层前 | 执行 start/send/stop；`allow:false` 拦截 |
| `expression/pre-emit` | 输出到表现端前 | 原样放行；`drop:true` 吞掉 |
| `cli/render` | surface-cli 每段输出前 | 默认 ANSI 样式（theme-soft 是拦截示例） |

约定：**插件自己的可改点也用 waterfall 暴露**（如 cli/render），别人改你不需要 import 你。
插件自己的水线（`web/meta`、`web/route`、`web/status`、`reply/prompt`、`persona/names`…）全表在 handbook §6。

## 观察事件（emit）

| 事件 | 载荷 | 用途 |
|---|---|---|
| `log.appended` | 每条新写入的 `LogEvent` | 真源的观察口：UI、遥测、记忆写入等**纯投影**消费方监听它，不必轮询 `log.events`。存储重放不触发（重放不是新事实）；I3 补的 `action.ended` 会触发（那是新事实） |

观察者抛错被隔离，不会污染真源写入。要**改**行为用 waterfall，要**看**事实用 emit。

## 贡献集合

`Registry<T>` 是「插件往集合里放东西」的统一机制，内核三处复用（段落 / 动作类型 / marker 词汇）。**插件也能开自己的集合**：`ctx.provide('myThing', new Registry(...))` 就是一个新扩展点。

- 给 `keyOf` ⇒ 键唯一，重复注册大声失败（段落、动作）
- 不给 ⇒ 允许重复（marker 词汇：多个插件贡献同名表情是常态）

段落组装 `prompt.assemble(audience, extras?)`：按受众过滤、按 `order` 排序、单段出错只缺那一段。`extras` 是调用方**本次**才有的一次性段落（如发言动作的大脑引导），与注册段落同一套排序、不留在集合里——没有它调用方只能把临时内容拼在整段前后，顺序就乱了。槽位数字怎么分是外围约定（`src/shared/order.ts` 的 `PROMPT_ORDER`），内核只认数字。

## 命名约定

- **channel** = 会话频道（'main' / 'group:123' / 'danmaku'）
- **track** = marker 通道（emo / act / tool），与 channel 是两个概念，别混

## 可配置项

部署可变的数值全是 `KernelOptions`，不是硬编码常量：
`historyLimit` · `cooldownMs` · `backoffBaseMs` · `backoffMaxMs` · `emptyFuse` · `settleTimeoutMs`

它们走 `Mumu.create(options)` 的**编程参数**（供嵌入式 Host 调），默认值对常规场景够用，
所以 `main.ts` 一个参数都不传——**内核裸启动，没有配置文件**。

## 服务表

内核固定：`bus` `log` `model` `mind` `actions` `prompt` `io`。
装配层：`loader`（插件启停/重载）、`app`（shutdown）。
内核定契约、插件提供：`blobs`（`BLOB_SERVICE`，见下节）。
插件惯例：`config`（storage-sqlite 提供）……新服务随插件出现。

## 只定形状的契约（内核自己不用）

开源后各家插件会各自采数据、传图、接设备。这几样不先定形状，第三方会各写各的约定，事后收不回来，所以内核先给出类型，机制一行不写：

| 契约 | 形状 | 约定 |
|---|---|---|
| `BlobStore` | `put(bytes, mime) → ref` · `get(ref) → { bytes, mime }` | 存储插件 `provide(BLOB_SERVICE, …)`；ref 一律 `blobRef(bytes)` = `sha256:<hex>`，同样的字节在任何实现里同一个 ref |
| `ChatMessage.parts?` | `Part[]` | 多模态输入给模型；`content` 保留为文字摘要，provider 不认识 parts 就只用 content。别再 `as unknown as ChatMessage[]` 绕契约 |
| `Feedback` | `{ target: { seq?, id? }, score: -1～1, by: { kind, id? }, reason?, data? }` | 写成日志事件 `feedback`（`FEEDBACK_EVENT`）；主人纠正、对方反应、bench 打分都用这一个形状 |

## 启动次序

```
main：Mumu.create() → 注册 app 服务 → loader.start()        无参数、无配置文件
loader：递归扫描 plugins/ 下带 package.json 的目录
  → 引导段（mumu.order < 0，如 storage-sqlite；配置 = 自己的 mumu.defaults）
  → 配置库就绪：订阅变更（配置改动 → 精确重载对应插件）
  → 常规段（配置 = 自己的 mumu.defaults ⊂ 配置库 plugins.<id>）
  → watch 插件目录（文件真的变了才热重载）
运行中：loader.scan()（命令 /plugin scan）重扫目录，新插件按 order 装上，装失败过的再试一次
```

**失败隔离**：单个插件加载失败（import 报错、apply 抛错）只跳过它，`console.error` 大声说、原因记进 `loader.list()` 的 `error`，
不拖垮启动；它的目录照样被监视，改好文件即重试。依赖的服务不存在时插件留在容器的等待队列，`scan()` 把这一条报成失败原因。

**默认在插件、覆盖在库**：空库即全默认，无需播种；`/config set` 写库并立即重载该插件。
装配层不认识任何具体配置键（连模型 `roles` 都归 provider 插件自己绑）。

## 插件规范

```
plugins/                     任意分层归类，层数不限
├─ official/<id>/            有 package.json 的目录即插件，不再往下钻
└─ user/…/<id>/
    ├─ package.json   name/main/dependencies + mumu: { enabled, order, description, defaults }
    ├─ README.md      这个插件是什么、暴露什么、怎么改它
    ├─ index.ts       default 导出 Plugin：{ name, inject?, apply(ctx, config) }
    └─ node_modules/  自己的依赖（npm workspaces，根 workspaces 配 `plugins/**`）
```

**目录是组织，不是身份**：id 由 package.json 决定，与路径无关；挪窝不丢配置。
id 冲突大声失败；加载次序只看 `order`，与层级无关。

- 一切注册走 `ctx.effect(() => disposer)`；卸载逆序回滚，不留渣。
- 依赖别的服务写 `inject: ['config', ...]`，加载顺序自动推导。
- 想被别的插件修改：把可改的决定放到自己的 waterfall 上。
- 热重载范围：入口带序号 import 绕开 ESM 缓存，序号经 `node:module` 的同步 resolve 钩子（`src/loader/fresh.ts`）
  沿相对 import 传给**插件目录之内**的子模块，所以改深层文件也会生效；出了插件目录的（`src/`、别的插件、插件自己的 `node_modules`）
  一律不带序号、不重复实例化。前提：插件是 ESM（`"type": "module"`，官方插件都是），Node 22.15+（有 `module.registerHooks`，
  package.json engines 写死）。没有就加载时直接报错，不退回「只刷新入口」——换台机器热重载范围就变，这种不固定比报错更难查。
  新增插件目录不用重启：`/plugin scan`（`loader.scan()`）。
- 监视事件先比文件指纹（`src/loader/watch.ts`：mtime + 大小；点开头的文件、`node_modules`、目录自身不算）：
  Windows 的递归 fs.watch 在文件只是被访问时也报事件——SMB 挂载那一刻曾让全部插件连环重载。
- 重载服务提供者时，`inject` 了它的服务的插件一并卸下、等它装好再装回（否则它们手里是旧服务，如关掉的 db 句柄）。
  装配层自己的「配置变更 → 重载」订阅也一样：存储插件重载后配置服务换了实例，订阅跟到新实例上。
- 配置变更触发重载的路径：`plugins.<id>.<键>`（改一个键）和 `plugins.<id>`（整份覆盖）都算；只有 `.enabled` 例外（归 `setEnabled`）。

## 已知取舍（改之前先看）

- 打字机呈现中被打断：settle 用打断瞬间的回执快照，终端可能多显示 1 个字符——误差一个 write，不值得为它加锁。
- 多个表现端服务同一频道、能力不一致时，delivered 以「有回执的那个」为准。
- 平行历史合并（存储晚挂载）：重编内存段序号接续存量并告警；正常次序（storage order -100）不会发生。
  这种情形下挂载前发出的 id 取自旧序号，可能与存量里的 id 重复——所以存储插件必须在引导段装上。
- 判断「热重载（内存以存量为前缀）」比对最后一条存量的序号、时间与类型，不只比序号。
- `LogEvent<T = any>`、`Plugin<C = any>` 两处公开类型仍留 `any` 缺省：现有插件直接读 `e.data.<字段>` / config，改成 `unknown`
  会让全部插件类型检查变红。插件重做时一起收紧。总线内部已没有 `any`，`WaterfallMw` 缺省是 `unknown`。
- `mind` 的 decider 是独占槽位：装第二个 mind 插件会大声失败，先卸旧的。
- `history()` 是**便利投影**（结构规则写死两个事件类型），不是机制；要更丰富的投影，插件直接读 `log.events` 自己做。
