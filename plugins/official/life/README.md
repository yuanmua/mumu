# @mumu/life · 在干嘛

**是什么**：她「此刻在干嘛」——吃饭、犯困、刷视频、打游戏、听歌、写作业、发呆、睡觉、出门……
一个附加小系统：给她一点外部生活，被问「在干嘛」有真东西可答，有人找她时是边吃饭边回还是被手机吵醒。
不改内核、不改别的插件，只经段落 / 水线 / 动作 / 面板接进来；没装它一切照旧，它崩了只缺这一块（总线隔离）。

## 设计

**状态** = 一件活动 + 一句细节（「在吃火锅」「刷到一只猫」）+ 开始时间 + 到什么时候（`until`）+ 谁定的。
只落日志 `life.changed`（`life.cleared` = 用户清掉），装上 / 重载 / 重启时从日志投影回来（`state.ts`），不另存一份。

**作息与随机**（`rhythm.ts`，纯函数）：
- 一天切成几个时段（`rhythm`：深夜、该睡了、起床、午饭、午后、下午、晚饭、晚上、夜里），每段一组「活动 → 权重」，周末另给一组（`weekend`）。人设晚睡：工作日 1:30 起多半去睡、9:30 起床犯困，周末起床时段多半接着睡。
- **什么时候换**：手上这件到了 `until`；或进了新时段、而手上这件不在新时段的候选里（打着游戏到 11:30 → 该吃饭了；睡到 9:30 工作日 → 起床）。在新时段里也有的事就接着做到 `until`。
- **衔接**（写在每个活动身上）：不连着做同一件（`repeat: true` 的除外，睡觉）；`gapMin` 做完多少分钟内不再做（刚吃完不会又吃）；`notAfter` 紧跟在哪些事后面不做（刚吃完饭不洗澡）。全被筛光了退一步。
- **随机可复现**：一次抽签只用一个种子（mulberry32），活动、细节、时长都从它出，种子写进 `life.changed.seed`。

**她自己选**（`choose.ts`）：到点时候选不止一个，就用一次很短的模型调用（默认角色 `mind.decide`，绑在 4090 本地模型上，便宜）让她自己挑：
给她人设（`'*'` 段落）、时段、候选活动 + 几条平时的样子（碰到她兴趣的标「你喜欢的」，问的是 interests 的水线 `interests/score`）、刚才在干嘛、心情（emotion 服务，没装就不写）、最近做过 / 吃过什么、最近几句对话。
她回 `{"activity","detail","minutes","thought"}`；选的不在候选里、坏 JSON 重试一次，再不行、超时（`chooseTimeoutSec`）、模型挂了都退回抽签结果（`how: 'drew'`，另记 `life.failed`）。
`thought` 是她当时心里那句（「下雨不想出门，叫个麻辣烫吧」），记在日志和面板里。选的过程中别人改了状态（用户设、她 life.set）就作废这次选择。

**她在聊天里改**：大脑动作 `life.set`（`{"activity","detail","minutes"}`）。比如被问「出来玩吗」她说「我去吃饭了」，大脑同拍起 `life.set` 记一下。
文字里认得出是哪个活动（活动名或 `words`，「那我去睡了」→ 睡觉）就归过去，认不出就是一件表里没有的新事（不忙、醒着）。

**用户设的优先**：网页面板 / `/life set` 设的状态管到下一个时段（离下个时段不到 15 分钟就管到再下一个）或指定分钟数，
期间作息不换、她的 `life.set` 也不改（工作记忆里留一句「定好的，到几点前不改」）；「清掉」后按作息马上重定。

**进提示词**：
- 发言者段落 `life-now`（`PROMPT_ORDER.state`，和心情同槽，id 排在 `emotion-now` 后）：「【你此刻在干嘛】吃饭：叫了麻辣烫外卖（12:10 起）。被问在干嘛就照这个说，一句就够；没人问别主动提，也别另编」。睡着时换成「本来在睡觉，手机响了迷迷糊糊拿起来看：回得短、带点困」。
- 大脑材料 `beat/gather`（order 21，心情后、兴趣前）：「【你在干嘛】…这是她此刻真在做的事，不算编来历：被问在干嘛就照这个答」+ 怎么用 `life.set`；睡着时「没人找她就别主动开口」。
  persona 的「别编自己刚才在干什么」和大脑的「别替她编来历」仍然成立：这里给的是真的状态，不是编的。

**睡着时不主动找话**：活动标了 `asleep`（睡觉）时，她要起的 `reply` 在 `intent/pre-dispatch` 上看一眼那个会话：
最近 `quietSec`（600）秒内有人冲她说过话（私聊、网页、群里 @ / 叫名字），或她已经在那开过口（被叫醒后接着聊的那几句）→ 照常回，像手机响了；
否则（timer 到了想找话、群里没 @ 她的闲聊）拦下，记 `life.quiet`。`quietSec: 0` = 不拦。

## 暴露什么

| 落点 | 说明 |
|---|---|
| 段落 `life-now`（performer） | 见上 |
| `beat/gather` 块 `from: 'life'` | 见上；`data` 是当前状态 |
| 动作 `life.set` | 她在聊天里改状态 |
| 水线 `life/now` | `{ busy: 1, asleep: false }` 进，填 `activity` / `detail` / `until`，`busy` 乘上活动的系数 |
| 日志 | `life.changed` `{ activity, detail, from, until, by: 'rhythm' \| 'self' \| 'user', seed?, how?, thought?, slot?, cause? }` · `life.cleared` · `life.quiet` · `life.failed` |
| 网页 | 面板「在干嘛」（人格抽屉底下）、状态卡「在干嘛」、接口见 [web-protocol.md](../../../docs/web-protocol.md) §6 2026-10-23 那行 |
| 命令 | `/life` 看现在和最近换过的 · `/life set <在做什么> [分钟]` · `/life next [HH:MM] [周末\|平时]`（换一个，可假装是某个时间，调试她饭点怎么选）· `/life clear` |

## 怎么接到接话意愿（group-policy 现在没接）

想让「忙不忙」影响群里接话，只要在算意愿的地方现调一次水线、乘上 `busy`，**不用 import 本插件**（只 `import type { LifeNow }`）：

```ts
import type { LifeNow } from '../life/index.ts'

const life = await ctx.bus.waterfall<LifeNow, LifeNow>('life/now', { busy: 1, asleep: false }, async p => p).catch(() => undefined)
const busy = life?.busy ?? 1 // 没装 life：1，不影响
// group-policy 里最顺的落点是心情系数旁边：judge 的 factors.mood 那一项乘上它（或另记 factors.life），@ 她的冷 @ 概率同理
```

默认系数温和：睡觉 / 洗澡 0.5，打游戏 / 出门 0.6，吃饭 0.7，写作业 0.8，犯困 / 看书 0.9，刷视频 / 听歌 / 发呆 / 吃零食 1。
`asleep` 可以给「没在聊」的那条 base 再打折；被 @ 照常叫醒（像手机响了），别把 @ 也压到 0。

## 怎么改它

全在设置「在干嘛」里（清单 `mumu.defaults`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `activities` | 12 个 | 活动表：`name`、`details` 细节候选、`minutes` [最短, 最长]、`busy`、`asleep`、`repeat`、`gapMin`、`notAfter`、`words`（认「在吃火锅」这种说法）。增删随意，作息表里引用不存在的名字会被跳过 |
| `rhythm` | 10 个时段 | `from` 'HH:MM'、`label`、`pick` 权重、`weekend` 周末换的那组 |
| `choose` | true | 到点让她自己选；关掉就纯抽签 |
| `role` | `mind.decide` | 她自己选用的模型角色（provider-openai 的 roles 里绑） |
| `chooseTimeoutSec` | 30 | 多久没选出来就退回抽签 |
| `quietSec` | 600 | 睡着时多少秒内有人叫过她才开口；0 = 不拦 |
| `timeZone` / `weekendDays` | Asia/Shanghai / [0, 6] | 作息按哪个时区的钟、周末是哪几天 |

改了设置插件会重载：状态从日志投影回来，不会重抽（手上这件没到点就接着做）。
