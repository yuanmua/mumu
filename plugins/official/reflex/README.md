# @mumu/reflex —— 脊椎

> 叫法：**脊椎 = 本插件（id 仍是 `reflex`）**，**大脑 = [mind-default](../mind-default/README.md)**。旧称「反射」「导演」。
> 插件 id、事件名 `reflex.*`、模型角色 `performer.reflex`、配置键都没改。

**是什么**：脊椎层。像人一样，脊椎只管不用过脑子的事，话都过大脑：
对方的每条消息都先交给大脑，脊椎**不抢先开口**。大脑在决策里写 `"quick":true`，就是放行一条秒回的短句（「在」「咋了」），
走的还是 `reply`（`reflex:true` → `performer.reflex` 角色、简短模式）。

**为什么从「反射先开口」改成「大脑门控」**（2026-10-22）：
- v1 每句话要等大脑想完、再等发言者开口，4–8 秒才出第一个字，于是有了反射：「不用想」的话 350ms 直接起 reply，大脑据 `reflex.fired` 作废本拍。
- 凡事都反射：真 QQ 私聊 29 条消息 29 次秒回、大脑 0 次出手，复读反问「更多群？」。→ 加了分流。
- 反射抢答吃掉任务：主人在群里 @ 她发一道长题「用电脑试试看」，反射 350ms 照着历史回「电脑碰不到嘛…」，大脑那拍被作废、下一拍又信了这句，computer 没起。
  → 补过 `actionWords` 词表和主人特判，但措辞是追不完的。
- 所以把「谁来回」整个交给大脑：首字多一次决策（`quick` 路径约 1.5–2.5 秒），换来说了就做、做不了说清原因。

**现在做的**

| 事 | 怎么做 |
|---|---|
| 合流 | 私聊 / 网页：对方连着发时压住内核的即时唤醒（`wake=false`），停下再叫醒大脑一次（几句并成一个唤醒原因）。轻的等 `delayMs`、问句长句等 `thinkDelayMs`、连发等 `burstDelayMs`。群频道（`groupPrefixes`）不合流，内核即时唤醒 |
| 给大脑贴提示 | `beat/gather` 的【脊椎】块：对方还在发（这拍别 start reply）/ 刚发的几条还没人回，并注明「像是要你动手做事」（含 `actionWords`）、「是主人说的」（guard / group-policy 的 owners）、「很简单，想应一声就 quick」 |
| 兜底 | 白名单里的招呼——纯表情包，或不超过 `lightMaxChars` 字、没问号、不像要她做事、不是主人说的，且她没在 `lightCooldownMs` 内刚开过口、掷中 `lightReplyChance`——大脑 `fallbackMs`（默认 2500）内既没决定、频道里也没起 reply，脊椎先起一条简短 reply（`reflex.route` path=fallback、`reflex.started`、广播 `reflex.fired`）。别的消息只等大脑 |
| 硬闸 | `intent/pre-dispatch`：同频道已有 reply 在跑（`reply-running`）、**她正在别的频道说话**（`busy-elsewhere`，日志多带 `busy` = 在哪说）、还在合流（`merge-pending`）、大脑取材料时那个频道有 reply 在跑（`stale-running`）、大脑取材料之后脊椎兜底开过口（`spine-answered`），大脑起的 reply 一律拦下并记 `intent.blocked`。上游（guard、group-policy 排队）已拦的不重复记 |
| 一次只在一个会话里 | 「正在说」= reply 动作在跑（它等那句 utterance 结算才结束）。她在 A 说话时大脑想在 B 开口 → `busy-elsewhere` 拦下，念头记着；A 说完（reply 结束会开一拍）材料里提醒「频道 B 你想在这说的话还没说（当时的念头「…」），现在说完了，去不去由你定」，只提醒一次，大脑再 start reply 才说。正在说话的每一拍也提示「这拍别在别处 start reply」。同频道打断自己（append / 作废重说）不归这条，仍按 `reply-running`。脊椎兜底同样不在她别处说话时开口。跨频道串行原来只靠大脑规则自觉，模拟器 phone 场景抓到群里回糖糖的同时私聊也开了口（2026-10-22）。同一套也管汇报：动作结果（`reportKinds`）在她正说着别的时回来，汇报被 `reply-running` 拦下，说完那拍提醒「你刚想汇报「…」的结果还没说」（全量测试 Q-8：原来拦掉就没了，结果一直没报） |
| 快回把关 | 大脑明确写了 `quick` 就以大脑为准，不按字数二次降级——起初按「不轻」（>4 字）降，「你好呀，在干嘛呢」这种招呼也被当正事（全量探针 s1）；字数门槛只管脊椎自己兜底。只有一种还降：这个对话最近一句有人说的话（`quickGuardKinds` 里的感知）像是要她做事（含 `actionWords`）——简短模式一个「好」就把事打发了、动作却没起（真群 #9158「截图看看桌面」）。降成正常回复，大脑的 note 当念头（日志 `reflex.quick-demoted`）。「感觉还得调试一下」这类说正事的短话不用快回，靠大脑规则 |
| 被拦时改念头 | 同一拍里大脑「应一声 + 起动作」、动作被 guard 拦下：给同拍 reply 的 guidance 补一句「没在做，别说这就去，也别说电脑碰不到 / 坏了，说清为什么不做」 |
| 连发提醒 | `reply/prompt`（`burstHint`）：历史末尾对方连着 ≥2 条，告诉发言者看完一起回 |

**不在这里的脊椎级反应**：被打断立刻停嘴在内核（urgent 打断）；表情 / 动作标记在 expression 插件；游戏按键回路在身体服务（`apps/body` 的 body_reflex）。

**主人怎么认**：读配置库 `plugins.guard.owners` ∪ `plugins.group-policy.owners`（认号不认名）。不 `inject` 配置服务——没装存储插件（单测、裸内核）时当作没认主人，只是少一条提示。

**暴露什么**：日志事件 `reflex.route { channel, path: 'think' | 'fallback', why[], count, spine }`（每次交给大脑 / 兜底开口一条）、`reflex.started { channel, actionId }`（兜底开口），调试页可见。

**怎么改它**（网页设置「脊椎（兜底秒回）」里都能调）

- `fallbackMs`：大脑多久没决定就替招呼先应一声；0 = 永不兜底，只等大脑。她正在别处说话时不兜底（那几句留在「还没人回」里等她说完）。
- `delayMs` / `thinkDelayMs` / `burstGapMs` / `burstDelayMs`：合流窗口。首字 ≈ 合流窗口 + 大脑一次决策 + 发言首字。
- `lightMaxChars` / `lightCooldownMs` / `lightReplyChance`：兜底白名单有多宽。
- `actionWords`：「像要她做事」的提示词（也被 guard 拿去认「是谁让她做的」）。只是提示，不决定谁来回。
- `groupPrefixes`：哪些频道不合流。`kinds`：哪些感知 kind 算对话消息。`stickerPrefix`：表现端的表情包占位写法。
