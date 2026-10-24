# @mumu/action-dsh

**是什么**：`dsh` 动作——在她自己的电脑里起 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，会写代码、跑命令的终端 agent）
去干多步工程活：写程序 / 脚本、在一个目录里搭东西、整理项目（handbook §9.4「工具即动作」，路线 §3「工程活交 DSH」）。

**参数**：`{ task: "要做的事，写完整具体", cwd?: "工作目录（它只能写这里）" }`。描述带「（需要主人）」，guard 只放行主人或网页发起的。

## 和 computer 的分工

| 用 | 什么时候 |
|---|---|
| `dsh` | 要写代码、要跑一串命令——多步、以文本为主、在一个工作目录里的工程活 |
| `computer` | 点界面、看屏幕、上网、**打开写好的程序来玩**——要眼睛和手的活 |

接力：dsh 写好并用命令行自测、在总结里写清启动命令 → computer 打开、玩一局、截图 → image 发给对方。
**dsh 自己开的窗口活不下来**：它的命令跑在作业对象里，命令一结束子进程连带被关（实测 Start-Process 起的 tkinter 窗口几秒就没了），
所以 preamble 约定它不启动有界面的程序。

## 一次任务怎么走

```
导演 start dsh {task, cwd?}
  └ 检查：同时在跑的 dsh 没超 concurrency（默认 1）· 找得到 DSH 入口 · 密钥在 · 工作目录可用
     ——任何一条不满足都直接以 dsh.result 回报原因，不排队、不卡住
  └ 起子进程：node <dsh 入口> --profile headless --json -
       任务（配置 preamble + task）从 stdin 进；DEEPSEEK_API_KEY 只进子进程环境（取自 secrets，不落文件）；
       DSH_PERMISSION_MODE = 配置 sandbox（默认 workspace-write）
  └ 读 stdout 的按行 JSON 事件：
       tool_call   → 护栏检查（guard.ts）；一句人话 a.note("第 n 步：写了 snake.py")；第一步发 dsh.progress「动手了」
       tool_result → 落日志 dsh.step（say 人话、工具、参数、状态、结果开头）；出错发 dsh.progress「没成功，在换办法」（限频）
       text        → a.note（它的阶段性说明）
       final       → 结果
  └ 结束：percept dsh.result（唤醒导演，她用自己的话说结果）+ a.remember（发言者看到具体结果）
```

## 进度进她的感知（每一步都要反馈给她，不然她感知不到进度）

| 层 | 做什么 | 来源 |
|---|---|---|
| 每步一句人话 | `a.note` 与日志 `dsh.step.say`：优先用 DSH 自己写的工具 `description`（preamble 要求它用中文写），没有就按工具种类说「写了 x.py」「跑了个命令」，不贴命令原文 | progress.ts `sayOf` |
| 导演的「手头的活」 | `beat/gather` 材料：任务、第几步、用时、最近三步、卡在哪（最近一步出错） | progress.ts `workOf`，从日志现算 |
| 发言者 | 不在本插件：action-computer 的段落「手头的活」（computer-now）从日志一起投影 computer 与 dsh（`dsh.step` 的 say、`dsh.result`），被问「弄得怎么样了」照它答（2026-10-22 合并，免得发言者看到两遍） | action-computer view.ts |
| 关键节点唤醒 | `dsh.progress` 感知（频道 = 发起任务的对话）：动手了（必发）、出错在换办法（`progressGapSec` 限频）；她在同一对话里主动说一句。普通步骤不唤醒 | index.ts `progress()` |
| 完成 / 拦停 | `dsh.result`：做完了 / 没做成 / 超时 / 卡住 / 被叫停 / 要主人点头 | index.ts `report()` |
| 网页 | 她发起这件事的那条消息下一行进度小字（「第 n 步 · 人话」→「做完了（n 步）」），前端从 `action.started` / `dsh.step` / `dsh.result` 投影，无新接口 | apps/web projection |

实测（2026-10-22，「写个小脚本数今天天气真好今天每个字出现几次」，4 步 1 分 48 秒）：动手时她主动说「在找 python 呢，稍等下下」；
问「弄得怎么样了」答「写到第三步啦，脚本已经写出来了，正在拿它跑」；完成后自己报结果。

## 护栏（三道）

1. **DSH 自己的沙箱**：`sandbox` 默认 `workspace-write`——Windows 受限令牌 + Low 完整性，只能写工作目录和私有临时目录，碰不到更高完整性的进程。
   要装软件 / 改系统时才在设置里换 `danger-full-access`（危险）。
2. **约定**（preamble）：不碰系统进程、不用 WMI / CIM、不 Add-Type 调 Win32、不建计划任务 / 服务、不改 HKLM / 防火墙 / 账户 / 执行策略、不关机重启；需要就停下说明。
3. **每步拦截**（guard.ts）：命中上面几类的命令（跑命令的工具查全部参数，写文件类只查是否写进系统目录）→ 落日志 `dsh.blocked`、立刻停掉整棵进程树，
   以 `dsh.result`（outcome `blocked`）回报「它想做 X，这要主人点头」。是黑名单不是白名单：工程活的命令千变万化，白名单会挡掉正常活。
   单测 `guard.test.ts`（`npx tsx --test plugins/official/action-dsh/guard.test.ts`）用 2026-10-21 蓝屏前那次任务里实际出现过的命令。

> 背景：2026-10-21 23:2x 虚拟机蓝屏（0xEF CRITICAL_PROCESS_DIED，转储里的进程名是 csrss.exe，用户态上下文是一个加载了 WinForms 的 PowerShell）。
> DSH 自己的会话记录（`%USERPROFILE%\.dsh\sessions\…\session-b0f2c695…`）显示：它为了让贪吃蛇窗口「活下来」，在沙箱里
> 先后试了 Add-Type 调 user32、Invoke-CimMethod Win32_Process、schtasks，然后两次 `Start-Process explorer.exe`（23:23:43 拉 run_game.bat、
> 23:24:03 拉 贪吃蛇.lnk）——系统日志恰在 23:23:45、23:24:05 两次记下「explorer.exe 无法正常启动 0xc0000142」；之后反复用 System.Drawing 截屏，
> 最后一张写于 23:25:35，随后 csrss 死、蓝屏。身体服务从 23:05 起没有任何请求。结论（较大把握，未经内核调试器证实）：
> **DSH 在 Low 完整性沙箱里绕路起图形程序 / 截屏触发的**。所以 guard.ts 的头几条规则就是：DSH 不开窗口、不截屏、不直接调身体服务——那是 computer 的活。

## 其他

- **不卡死**：总时限 `timeoutMin`、静默时限 `idleSec`（这么久没有任何新事件就当卡住）、导演 stop / `/dsh stop` / 网页急停 / 护栏拦停，
  都用 `taskkill /T` 杀整棵进程树并照常回报。
- **对方中途补充**：headless 一次只收一个任务，跑着时递不进去；导演 send 来的话在结果里如实带回。
- **退出码 0 且最后一轮 `turn_end` 为 completed 才算做成**（DSH headless 的约定）。
- **热重载不杀活**：`reloadPolicy: 'drain'`。但「清除记忆」（`/api/clear`）会停掉所有动作——实测有任务被这样打断过。
- 这个动作从不 `a.utter()`。

## 网页

| 位置 | 内容 |
|---|---|
| 设置 → DSH 工程活 | 本插件配置（清单 `mumu.ui`，含沙箱下拉） |
| 状态 → DSH | 已安装几版 / 没装、密钥在不在、正在跑什么 |
| 设置 → 面板 → DSH 任务 | 原始日志：开始、每一步（人话 + 工具 + 参数 + 结果开头）、✦ 进度播报、⛔ 护栏拦截、■ 结局；顶部「急停」 |
| 对话里 | 发起那条消息下的进度小字 |

接口（经 `web/route`）：`GET /api/action-dsh/log` → `{ lines }`；`POST /api/action-dsh/stop` → `{ stopped }`。全部从日志与运行表现算。

## 配置（`plugins.action-dsh.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `entry` | `""` | DSH 入口脚本；空 = 找 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` 的 `bin`（每次现找，升级不用重载） |
| `keySecret` | `deepseek` | secrets 里 DeepSeek 密钥的名字 |
| `workDir` | `""` | 任务没给 cwd 时的工作目录；空 = 她主目录下 `dsh-work` |
| `sandbox` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `timeoutMin` | 20 | 总时限 |
| `idleSec` | 300 | 静默时限 |
| `concurrency` | 1 | 同时最多几个 |
| `resultChars` | 1500 | 结果摘要上限 |
| `progressGapSec` | 90 | 「出错在换办法」这类进度播报的最短间隔 |
| `preamble` | 见清单 | 拼在每个任务前的约定（不会有人回答、不碰系统、中文 description、Python 别用商店占位符、不启动 GUI、中文总结） |

## 安装 DSH（在她的 Windows 上）

```powershell
npm i -g @deepseek-ai/dsh --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
```

npm 11 默认拦安装脚本，node-pty / koffi 需要放行。经 SSH 跑要保持会话直到装完（SSH 断开会连带杀掉安装进程）。
`/dsh` 自检；DSH 的会话记录在 `%USERPROFILE%\.dsh\`。

## 依赖

无 npm 依赖（Node 自带 `child_process`）。运行时依赖她电脑上全局安装的 `@deepseek-ai/dsh`。
