# @mumu/mind-default —— 大脑

> 叫法：**大脑 = 本插件（id 仍是 `mind-default`）**，**脊椎 = [reflex](../reflex/README.md)**。旧称「导演」「反射」。
> 插件 id、模型角色 `mind.decide`、日志 `mind.decision` 都没改。

**是什么**：默认心流。单级大脑：每拍一次模型调用（角色 `mind.decide`，JSON 模式），输出意图列表；校验、重试一次、再失败降级为空意图。

**大脑门控**（2026-10-22）：对方的每条消息都先到大脑，脊椎不抢先开口。大脑可以——
- 写 `"quick":true`：放行脊椎秒回一条短的（翻成一条 `start reply {reflex:true, quick:true}`，`performer.reflex` 角色、简短模式；内核不认识 quick）。
  默认回本拍最近一个有人说话的对话，`"quickChannel"` 可改；本拍没人说话（reply 结束、timer）时 quick 不生效，同一对话里已 start reply 就以那条为准。
- `start reply` 带 guidance（自己的想法），或同一拍「应一声 + 起动作」；
- 什么都不做。
大脑想太久时，脊椎只替白名单里的招呼先应一声（见 reflex README）。为什么这样改见 handbook §9.2「大脑门控」。

**相对 v1 的改动**

| 问题 | 改法 |
|---|---|
| 思考途中对方再说一句，大脑会把过时的决定执行完再回头 | 任何会唤醒的感知到达 → 当前模型调用立即 `abort` → 本拍交空 → 内核 rethink 带新原因重开；被作废那拍的原因**全部**带到下一拍，【本次唤醒】里标「（上一拍想到一半被打断，还没处理）」，`mind.decision.reasons[].carried` 记下 |
| 反射抢先开口、作废大脑那拍，对方要她做的事就此丢了（真群「用电脑试试看」） | 不再监听 `reflex.fired`；脊椎不抢先，兜底之后大脑那拍照常派发，重复的 reply 由脊椎硬闸拦 |
| 带结果感知的动作（search / computer / dsh）结果那拍起了后续动作，动作结束那拍又起一遍（模拟器 2026-10-22：搜到图那拍起了 image，search 结束那拍又起一个，群里发了两张） | `reported.ts`：动作结束的唤醒原因，若它的结果感知（`data.actionId` 指回它）已在之前某拍处理过，就从本拍原因里拿掉；拿光了本拍不调模型，记一条 `mind.decision`「只是动作结束，结果那拍已经处理过」。结果那拍被作废、原因带过来时照常留着；没有结果感知的动作（reply、image）不受影响 |
| 主动说话太机械 | `wakeAfterSec` 的指导改成按情境定（聊得热 60–120 秒，对方要走 300+ 秒），到点只催一次 |

**这一拍要快**（它就是她开口前的等待；`material.ts`）

- system = 规则 + 动作目录（不变，放最前命中模型前缀缓存）+ mind 受众段落（有【现在】这种每拍都变的，放后面）。
  原来段落在前、规则在后，第十来行的【现在】带秒数，后面的规则一次也缓存不上。
- 【最近对话】每拍都带全：内核给的全频道历史（条数是内核的 `historyLimit`），群里的那几条由 group-policy 在 `beat/gather` 里换成它的阅读窗口（和发言者同一个）。
  门控上线时曾有「精简拍」——只因刚到的消息而开的拍只带本频道最近 `leanHistory` 条、跳过 `leanSkip` 几块——虚拟机实测只比完整拍快 12ms，
  却让她在私聊里答不上「今天加的群感觉怎么样」（材料里一条群里的事都没有）。越像人越好，精简拍不要了：同日整套删掉、不留开关（handbook §9.3）。
- `note` 限 20 字（输出越短越快）。

**暴露什么**：占内核 `mind` 的 decider 槽（独占；装第二个 mind 插件要先停这个）。日志 `mind.decision { note, intents, wakeAfterSec, aborted, tookMs, reasons[{ source, text, channel, carried }] }`，调试页「思考时间线」据此画；脊椎据 `reasons[].channel` 判断大脑已经对这个对话有了决定、不再兜底。

**材料从哪来**：内核给 reasons / catalog / running / incoming / history / notes / sections；其他插件经 `beat/gather` 贡献的 `blocks`（如 emotion 的心情、脊椎的提示）按顺序原样列出。

**最近几张图看原图**（2026-10-23，`material.ts` 的 `withImages`）：每拍问服务 `images`（surface-onebot 提供，现取不注入；没装就全用文字）
【最近对话】里哪几张带原图（每个会话最近 3 张、15 分钟内、总共 ≤2MB，规则在 surface-onebot 的 `images.inline`）。
【最近对话】是一整段文字，图没法逐条跟在消息后面，所以占位编号：那几张的描述换成「[图片1]」「[表情包2]」，整段一起换（【本次唤醒】里引着同一句的也换，免得描述和原图打架），
末尾一句「上面的 [图片1]… 是原图，按编号附在下面」，原图作为这条 user 消息的插件层字段 `images`（每张带同样的标签）交给 provider-openai。
看错的描述不再带偏她的判断（比如描述说「白狗」而图里是黑猫）。

**怎么改它**

- 改决策风格：改 `RULES` 常量。
- 大脑看多少历史：内核 `historyLimit`（全频道）；群里的窗口在 group-policy 的 `reading.*`。
- 分级思考（便宜模型守门 → 贵模型深想）：在 `decide()` 里先调一个 `mind.gate` 角色；角色绑定去 provider 配置里加。
- 整个换脑：写另一个插件 `setDecider`，停用本插件。
- 意图没写 `channel` 时落到哪：`parse()` 里的 `fallbackChannel`——先取最近一次带频道的唤醒原因，取不到（动作结算那拍）再取最近一条历史的频道，都没有才是 main。几个对话同时活跃时最近一条历史未必是刚结束那个动作的频道，要更准就让动作结算的唤醒带上频道。
