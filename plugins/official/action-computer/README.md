# @mumu/action-computer

**是什么**：`computer` 动作——沐沐在她自己的 Windows 上动手做事（handbook §9.4「工具即动作」）。
真正动手的是跑在那台电脑登录桌面里的身体服务 [`apps/body`](../../../apps/body/README.md)；
本插件跑一个工具循环，由 `task.agent` 角色决定每一步调哪个接口。

**参数**：`{ task: "要做的事，写完整具体", maxSteps?: 数字 }`。导演看动作目录里的 description / paramsHint 自己决定什么时候用。

## 一次任务怎么走

```
导演 start computer {task}            （反射多半已经先应了一声「这就去」，照常聊天）
  └ /health 确认电脑在、跑在登录桌面里
  └ 循环（≤ maxSteps）：
       task.agent 输出一个 JSON：{"say","tool","args"} 或 {"done","ok","result"}
       → 调身体服务 → 结果作为下一轮 user 消息「【结果】…」
       每步 a.note("第 n 步：…")（导演在「正在运行」里看得到）+ 落日志 computer.step（含这一步做完的截图文件名）
  └ 结束：percept computer.result（唤醒导演，她用自己的话说结果）
          + a.remember（发言者在「刚才发生的事」里看到具体结果）
```

**网页上**（docs/web-protocol.md §7，`web.ts`）：状态页一张「电脑身体」卡（探活身体服务：在线 / 离线、用户、登录桌面还是 session 0、
管理员还是普通权限、正在做的任务与第几步）；设置 → 面板里「电脑任务」滚动日志（每次任务的指令、每一步做了什么、截图链接、结果、耗时，
顶部「急停全部」）；设置 → 电脑身体 是配置表单。全部从日志现算（`view.ts`），不另存状态。

- **为什么是 JSON 循环而不是原生 tools**：模型网关的消息只有文本（`ChatMessage.content: string`），没有 tools。
  JSON 约束 + 配平提取 + 校验，解析失败附错误重来，连续两次失败就放弃；不用正则抓模型输出（handbook §9.2）。
- **工具表**在 `body.ts`：`exec` `apps` `windows` `ui_tree` `ui_click` `type` `key` `browser`（含 images / download / reset）`mouse` `reflex` `look` `wait`，
  说明文字直接进提示词。加工具 = 身体服务加接口 + 这里加一行。
- **看一眼（`look`，look.ts）**：截屏（身体服务缩成 JPEG）或取她电脑里的一张图，交给 `vision.read` 角色回答一个问题，
  产出一段文字观察。决定下一步的 `task.agent` 只收文本，所以图不进它的上下文；看视频、游戏局面、判断图片画的是什么时用。
  多模态数组靠 provider 原样转发（与 surface-onebot/vision.ts 同一处类型断言）。`deepseek-chat` 实测能看图。
- **单次步数**：`params.maxSteps`（封顶 150）给玩游戏、看视频这类长活；不给用配置 `maxSteps`。
- **旧观察压缩**：最近 4 条原样，更早的只留开头（控件树一次几千字）。
- **对方中途补充**：导演 `send` 给运行中的 computer，下一步之前以「【对方补充】」插进对话。
- **进度进她的感知**（每一步她都要能感知到）：每步 `a.note` 一句人话；`beat/gather`「手头的活」（任务、第几步、刚做了什么、
  卡在哪、是否在等对方回答，`view.ts` 的 `runningBrief`）；发言者段落 `computer-now` 同一份，被问「怎么样了」能答具体；
  关键节点另发感知 `computer.progress`（`data.phase`：`start` 开始做、`stuck` 连着两步没走通、`ask` 要问对方）唤醒导演在原对话说一句，
  普通步骤只落日志不唤醒。`ask`：模型输出 `{"ask":"…"}` 就停下等（默认 10 分钟），导演把问题转给对方、答复 `send` 回来以「【对方补充】」继续；
  一分钟没回答再发一次 `ask` 感知，材料里同时摆出她在该对话最后说的那句——导演转问的 reply 常被硬闸（reply-running）拦掉而它以为问过了（实测）。
  `computer.step` 日志带 `channel`，网页按对话投影进度小字用。
- **频道兜底**：导演常在「reply 刚结束」那拍才启动 computer，那拍没有频道，意图就不带频道；
  这时取日志里最近一条对方消息的频道，否则结果会回到别的对话里（实测）。
- **连不上时感知里不带技术细节**（2026-10-22 全量测试后）：`BodyError` 的地址、探活次数只进 `computer.result` 的 `data.detail`（网页面板看），
  `text` / 工作记忆写「电脑那边连不上，这次没做成」并提醒她别提地址、端口、「身体服务」——之前她在群里原话说「那个身体服务没起来，试了三次都不行」。
- **回报先于结算**：`await ctx.io.percept(computer.result)` 之后才让动作结束。反过来的话，动作结算那次唤醒（不带频道）先开一拍，
  导演在那拍里就起了回报的 reply，频道回落到 main，她在别的对话里说「弄好了」（实测）。
- **说做成了必须先拿证据**：模型第一次输出 `done ok:true` 不收，回一句【核实】逼它用工具（exec 列目录读内容 / browser read / ui_tree / look）拿证据；
  核实步骤跑过（有真实观察）后的 `done` 才收，并把证据摘要附进结果；两次都不肯拿证据就按没做成。实测它只查两次路径就编出「六个文件都建好、每个都核对过」，文件根本不存在。
- **反射回路（`reflex` 工具）**：实时格子游戏交给身体服务本地 20～50 Hz 的回路（`apps/body/body_reflex.py`），她定策略、几秒看一次 state。
- **每步截图（`shots.ts`）**：每一步做完截一张小图（look 看的那张直接留）存进媒体目录 `cshot-<时间>-<摘要>.jpg`，
  日志只记文件名；网页经 surface-web 现成的 `GET /api/media/<name>` 看（`web/route` 只能回 JSON，图不走它）。
  只留最近 `shotsKeep` 张、只删自己的 `cshot-*`。截不到（锁屏、掉线）不影响那一步。
- **一步超时 ≠ 连不上**（`body.ts`）：2026-10-22 一步 exec 等安装器卡在 UAC 上，身体服务当时是单线程、整个不回，
  后面三个任务开头探活就判「连不上」整体失败。现在身体服务按通道多线程、`/health` 永远秒回（见 apps/body README「并发」），这边：
  - 每个请求带 job 号（`X-Body-Job`）。连接被重置 / 拒绝时原样重发 3 遍（同号去重，送到过的不会重做；她电脑上的 AdGuard 会随机 RST 本机回环连接）。
  - 超时、重发也不通、或身体服务回 504 running：先探活 `/health` 3 次，活着就 `a.note`「第 n 步：…还在，等这一步做完」，按 job 号查 `/job` 直到做完
    （拿到的就是那一步真正的结果）或等满 `stepWaitSec`（回「还在电脑上执行，先别重复」当观察）；排队被取消、没有这一步的记录也都当观察交回模型。
    探活全不通才抛 `BodyError` 判连不上。任务开头的探活同样试 3 次，身体那边还有上一件事没做完时写进「电脑现状」。
  - exec 的请求超时按它自己的 `timeoutSec + 30` 秒算，不受 `requestTimeoutSec` 限制；RULES 里教模型「还在执行」时先 windows 看是不是弹了提示框、别重做。
  - 状态卡多一行「身体那边正在做：/exec 在做 32 秒」（`/health` 的 `busy`）。测试：`test/computer-body.test.ts`（假身体服务）。
- **工具坏了就别耗步数**（`broken.ts`，2026-10-22 16:18 computer#14）：身体服务的 browser 上下文早死了，open / read 每次回同一句 `TargetClosedError`，
  她第 2、3、7、11 步都在试，40 步一张图没存下，结果只说「图点不开」。现在同一个工具**连着两次一字不差的错误**（中间夹别的工具不算断，成功一次清零）就标为「暂不可用」：
  那一步的观察后面附【工具暂不可用】提示换路线（browser 坏了 → apps 开浏览器点界面，或 exec 用 PowerShell 下载）；之后再叫它不去身体服务，直接回「已标为暂不可用」；
  任务结束（done / 步数用完 / 被叫停 / 问不到答案）结果末尾都加一句「这次浏览器工具（browser）坏了：每次都报「…」。跟对方说是浏览器工具出了问题，不是找不到或点不开」，
  `computer.result` 与 done 那条 `computer.step` 的 `data.broken` 列出工具名。错误文字不一样（换个控件又没找到）不算坏——那是「这条路不通」。测试：`test/computer-tools.test.ts`（假身体服务 + 剧本模型跑真实循环）。
- **找图、存图走 browser images / download**，不右键另存：谷歌 / 必应的图片网格是画出来的，控件树里没有图片元素，点缩略图也不出大图（实测）。
  工具说明与 RULES 都教成「open 必应图片搜索 → images 列图 → download 按编号存到 dir → exec 核实」；身体服务那边浏览器死了会自动重建（结果带 `rebuilt`），`op:"reset"` 可手动重开。
  状态卡多一行「浏览器 开着 / 没开 · 重建过 n 次 · 上次的错」（`/health` 的 `browser`）。
- **热重载不杀活**：`reloadPolicy: 'drain'`，改配置 / 改文件时正在做的任务用旧闭包做完。急停用 `/body stop`。
- 这个动作从不 `a.utter()`：开口永远是 reply 的事。

## 教学段落与材料

不教的话，发言者以为自己「住在屏幕里、碰不到电脑」，反射一开口就把事推掉；或者嘴上先说「开好了」，
导演被骗以为做过了（都实测过）。所以本插件和 expression-basic 教表情一样，自己教自己的能力：

| 贡献 | 受众 | 内容 |
|---|---|---|
| 段落 `computer-teaching` | performer | 你有一台电脑；被要求时只说「这就去」，没有结果前绝不说「弄好了」 |
| 段落 `computer-teaching-mind` | mind | 什么时候 start computer；做没做只看运行表和 computer.result，reply 嘴上说的不算 |
| `beat/gather` 材料块 | mind | 「你的电脑」现状：正在做的 computer 及进度、最近一次结果（从运行表与日志现算，不另存） |

## 配置（`plugins.action-computer.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `url` | `http://127.0.0.1:8765` | 身体服务地址（经 SSH 隧道接到 VM，见 apps/body README） |
| `tokenSecret` | `""` | secrets 里 token 的名字；身体服务没开 token 时留空 |
| `maxSteps` | 25 | 一次任务最多几步 |
| `requestTimeoutSec` | 90 | 单个接口请求超时（exec 按它的 `timeoutSec + 30` 另算） |
| `stepWaitSec` | 300 | 一步超时但身体服务还活着时，按「还在执行」再等它多久 |
| `observationChars` | 3000 | 一条观察最多给模型多少字 |
| `shots` | `true` | 每步保存截图 |
| `shotScale` | 0.5 | 截图相对屏幕的缩放 |
| `shotsDir` | `data/media` | 截图目录（要与 surface-web 的 `media` 一致） |
| `shotsKeep` | 400 | 最多保留几张截图 |
| `panelTasks` | 30 | 「电脑任务」面板显示最近几次 |

网页「设置 → 电脑身体」就是这张表的表单（清单 `mumu.ui` 给了中文标签与滑块）。

模型角色 `task.agent` 在 provider-openai 的 `roles` 里绑（默认 temperature 0.2、maxTokens 4000）。

## 命令

- `/body`：身体服务自检（用户、session、是否在登录桌面、屏幕尺寸）。
- `/body stop`：急停所有正在做的电脑任务（面板上的「急停全部」= `POST /api/action-computer/stop`）。

## 自带接口

- `GET /api/action-computer/tasks` → `{ lines }`：「电脑任务」面板的行。
- `GET /api/action-computer/shots` → `{ items: [{ id, media, url, at, actionId, step, say }] }`；`GET …/shots/<id>` 单张的元数据，`url` 是 `/api/media/<media>`。
- `POST /api/action-computer/stop` → `{ stopped: [id] }`。

## 怎么改它

- 换决定下一步的模型：provider 配置里 `roles.task.agent`。
- 改做事的规矩（先命令还是先界面、不许做什么）：`agent.ts` 的 `RULES`。
- 看她做过什么：日志里的 `computer.step`（每步的工具、参数、观察开头、截图文件名）与 `model.request`（完整对话）；网页「电脑任务」面板是它的投影。

## 依赖

无新依赖（用 Node 自带的 `fetch`）。
