# apps/body · 沐沐的身体服务

跑在**她自己那台 Windows**（作者用的是一台 Windows 虚拟机）登录桌面里的常驻小程序：
把「命令、控件树、键鼠、程序、浏览器」暴露成本机 HTTP + JSON，给沐沐这边的
[`action-computer`](../../plugins/official/action-computer/README.md) 插件的工具循环调用。

它只做翻译，不做决定：下一步做什么由沐沐的 `task.agent` 角色决定。不是前端应用，不 import `src/`，
也不是 npm workspace（没有 package.json）。

## 接口

全部 JSON；`POST` 的请求体是 JSON 对象。出错时回 `{"error": "…"}`：400 = 这条路不通（找不到窗口 / 控件、切不到前台），
调用方换办法即可；500 = 意外异常（详情在 `data/body.log`）；504 = 到了硬上限还没做完 / 排队没轮到（见下面「并发」）。

| 接口 | 作用 | 参数 |
|---|---|---|
| `GET /health` | 自检，永远秒回 | → `user` `sessionId` `interactive`（false = 跑在 session 0，界面操作做不了）`admin`（是否以管理员令牌运行）`screen` `busy`（各通道正在做 / 排队的 job：`path` `state` `sec`）`browser`（Playwright 的 Edge：`state` open / closed、`rebuilt` 本次进程里重建过几次、`lastRebuild` 上次为什么重建、`lastError`、`lastUrl`、`sinceSec`；只读缓存） |
| `GET /job?id=` | 查一个 job | → `state`：queued / running / done（带 `status` 与 `result`，即那一步本来要回的结果）/ cancelled；没有这条记录 → 400 |
| `POST /exec` | 跑 PowerShell | `command` `timeoutSec?`(≤600) `cwd?` → `exitCode` `stdout` `stderr` `timedOut`（超时时连同它起的子进程一起结束，带 `note`） |
| `POST /apps` | 程序 | `{op:'start', name｜path｜uri, args?}` · `{op:'close', name｜pid, force?}`（pid 取自 `/ui/windows`；python 可关但身体服务自己除外）· `{op:'list'}` |
| `GET/POST /ui/windows` | 顶层窗口列表 | → 标题、类名、pid、是否前台 |
| `POST /ui/tree` | 控件树（缩进文本） | `window?`（标题的一部分，省略 = 前台）或 `pid?`（优先）`depth?` `maxNodes?` → 可操作的节点带编号 `#n`。标题匹配多个窗口时报歧义（优先本会话 `apps start` 起的） |
| `POST /ui/click` | 点控件 | `ref`（最近一次 tree 的编号）或 `window`｜`pid` + `name` / `automationId` / `controlType` + `index?`；`action?` = click / double / right / select / toggle / expand / collapse / mouse |
| `POST /ui/focus` | 切到前台 | `window`｜`pid` |
| `POST /type` | 打字 | `text` + 目标控件（同 click）、或只给 `window`｜`pid`（切过去打到它的焦点处）、或打到当前焦点；`replace?`(默认 true) `enter?` `method?`：`unicode`（默认，逐字直输）/ `setValue` / `paste` → `valueNow` 回读 |
| `POST /key` | 按键 | `keys`："ctrl+s"、"enter"、"ctrl+a, delete"；`repeat?` 整串重复几遍（总数封顶 300）`delayMs?` `holdMs?`（默认 50）；`window?`｜`pid?` 先切过去 |
| `POST /mouse` | 鼠标 | 点 `x` `y` `button?` `double?`；拖 `toX` `toY` `durationSec?`；滚轮 `scroll`（正上负下）`horizontal?` |

`/key` 与 `/mouse` 点击的返回带 `screenChanged` / `changeRatio`：输入前后各抓一次目标窗口的缩略图（160 像素宽灰度）比对，任一像素差 > 16 即算变了，比例按像素数。
粗判断（光标闪烁也会算一点），给模型省掉「按完再 look 一次确认」那一步。
| `GET /screenshot?scale=0.5` | 截屏 | → `image/png`；`fmt=jpeg&q=60` → `image/jpeg`（小一个数量级，给看图模型用） |
| `GET /image?path=…&max=1024` | 她电脑里的一张图，缩到长边 `max` | → `image/jpeg`；不存在 / 不是图 → 400 |
| `POST /reflex` | 反射回路（实时格子游戏） | `op`：probe(pid) 窗口矩形 + 主要颜色 / grid(pid, see) 量化一次回字符画 / start(pid, see, policy, hz?, maxSec?, stopWhen?) / state(id?) / stop(id?)。见 `body_reflex.py` 文件头 |
| `POST /browser` | 浏览器 | `op`：open(url) / read / click(text｜selector) / fill(selector｜placeholder｜label, value, enter?) / press(key｜keys 逗号或空格分开的一串, repeat?, gapMs?；总数封顶 300) / eval(script：表达式或 `() => {…}`，结果 JSON) / back / **images**(limit?) 列当前页的图片（编号 `index`、显示尺寸、原始尺寸、alt、从必应 / 谷歌结果链接解出的原图 `full`；data: 缩略图只报大小）/ **download**(index｜url｜selector, dir? 默认她的「图片」文件夹, name?, any?) 直接存到她电脑上 → `path` `bytes` `contentType` `width` `height`（index 优先原图 full、不行退回缩略图并在 `note` 说明；不覆盖同名；非图片默认拒绝）/ **reset** 关掉重开 / **status** / close。任何操作碰到浏览器已关闭都会自动重建一次再做（见下节），结果带 `rebuilt` |

### 浏览器死了自己站起来（2026-10-22）

16:18 她两个任务里 `browser open / read` 每次都回同一句 `TargetClosedError: … has been closed`：Edge 被关掉 / 崩掉（当天蓝屏重启、装 AdGuard 之后）后
Playwright 的上下文一直留着，原来的 `context()` 只看 `ctx.pages` 能不能读（缓存，死了也能读）就当它活着，从不重建；她只能改走点界面的路，谷歌图片网格点不开大图、
控件树里没有图片、右键另存做不成，40 步一张没存下。现在（`body_browser.py`）：

- 每次操作前看 `ctx.browser.is_connected()`，不活就关掉残留、重新 launch（驱动进程也死了就连驱动一起重起）。
- 操作中抛出「已关闭」类错误（类名 `TargetClosedError`，或消息含 has been closed / Target closed / Connection closed 等）：重建一次再做本次操作，**只重试一次**；
  `open` 直接重做，其他操作先回到上次打开的页面（`last_url`）再做，没有上次页面就回 400 让她先 open。结果里 `rebuilt: {why, reopened}` + `note` 说明重建过。
- 找图、存图走 `images` / `download`（`body_images.py`），不靠右键。
- 自检：`python test_browser.py`（装了 playwright 的机器都能跑，用机器上已有的浏览器——Windows 上 Edge、Mac 上 Chrome，不下载任何东西，不起整个服务）：
  开本地页 → 列图 → 按 index / url / selector 各存一张 → 杀掉浏览器进程再 open / read 都要自动重建 → reset / status / close。

## 并发：一步慢了不拖死整个服务

起因（2026-10-22 08:39 实测）：原来是单线程 `HTTPServer`，一步 `/exec` 在等安装器（卡在 UAC 提示上）时整个服务 90 秒不响应，
连 `/health` 都超时，沐沐那边后面的步骤全报「连不上身体服务」，三个任务连环失败。现在：

- `ThreadingHTTPServer`，每个请求一个 daemon 线程。`/health`、`/screenshot`、`/image`、`/ui/windows`（GET / POST）**不排队**，
  在请求线程里直接做（`/ui/windows` 在本线程初始化 COM），哪条通道卡住都照常秒回。
- 会做事的接口按类分**通道**，每条一个常驻线程，同类串行、不同类并行：`exec`（/exec）、`apps`（/apps）、
  `ui`（/ui/tree /ui/click /ui/focus /type /key /mouse /reflex，UIA 的 COM 在这个线程里初始化一次）、`browser`（/browser，Playwright 同步 API 只能在启动它的线程用）。
- 进通道的请求是一个 **job**（号取请求头 `X-Body-Job`，没给就现编；同一个号重复提交不重做）。硬上限：`/exec` 是 `timeoutSec + 15` 秒，其余 60 秒。
  到上限还在做 → 回 504 `{state:'running', job, sec}`，活继续跑，做完的结果留在 `GET /job?id=`（最近 64 个）；
  还在排队没开始 → 取消并回 504 `{state:'cancelled'}`（调用方已经不等了，不该过后再做）。
- `/exec` 的硬超时是真的：输出落临时文件而不是管道（起的程序继承了管道句柄的话，杀掉 powershell 之后 `communicate()` 还会一直等它们），
  到点 `taskkill /T /F` 杀整棵进程树，再不退就 `TerminateProcess`，最多再等 5 秒必回。
- 日志每行带时间（`data/body.log`），超上限的 job 会记一行 `… job <号> 超过 N 秒：running / cancelled`。

2026-10-22 虚拟机实测（部署后）：一个 `/exec Start-Sleep 30` 跑着时 `/health` 连打 5 次最慢 0.24 秒、`/ui/windows` 0.99 秒、`/screenshot` 0.22 秒；
第二个 `/exec` 排到上限（18 秒）回 504 cancelled；起了隐藏子 powershell 的 `/exec timeoutSec 3` 4 秒回 `timedOut`，子进程一个不剩。

**她电脑上的 AdGuard 会随机重置本机回环连接**（AdGuard 8.0 当天 08:44 装上；实测连一个最普通的 `python -m http.server` 都约一半请求被 RST，
经 SSH 隧道进来的也一样）。服务端没法绕，所以客户端（action-computer）遇到连接被重置就带同一个 job 号原样重发——同号去重保证送到过的不会做第二遍。
要根治得在 AdGuard 里把 python / node 或 127.0.0.1 排除出过滤，那是主人的设置，本服务不碰。

## 几条经过实测的取舍

- **必须跑在登录桌面会话里**：任务计划「登录时」+ `Interactive` 登录类型。从 SSH 直接起它会落在 session 0，
  那里没有桌面，UIA 看不到窗口、键鼠发不出去。
- **点击优先走控件模式**（Invoke / SelectionItem / Toggle / ExpandCollapse），不依赖前台、不受遮挡和 DPI 影响；
  不支持才退回真实鼠标。点「保存」这类按钮时对话框会在 Invoke 返回前关掉、COM 报错，按「控件已消失 = 成功」处理。
- **键鼠全部走一处 `body_send.py`（SendInput）**：按键同时带虚拟键码与扫描码（游戏、tkinter 读扫描码——之前 pyautogui 的 keybd_event 扫描码为 0，
  贪吃蛇窗口收不到方向键），文字按 UTF-16 码元 `KEYEVENTF_UNICODE` 直输（不碰剪贴板、不依赖输入法），鼠标按虚拟屏幕绝对坐标。pyautogui 只剩截图。
- **发键前把目标窗口的输入法切成英文、发完还原**（`body_send.ime_english`，`ImmGetDefaultIMEWnd` + `WM_IME_CONTROL`）：
  中文模式下字母进拼音候选、方向键在候选条里挪，程序什么都收不到——贪吃蛇「按 r」弹出「1人 2让 3如…」就是这个（实测，这才是 Tk 收不到键的根因）。
- **打字默认「聚焦 → 全选 → 直输」**，`method:'paste'` 才走剪贴板（粘完还原她原来的剪贴板）。`SetValue` 在经典「另存为」对话框的
  文件名框上会返回成功但不生效，所以只作为可选项（`method:'setValue'`，不需要前台）。
- **键盘只发给前台**。切前台失败会明确报错并说出挡着的是谁：开始菜单 / 搜索 / 通知中心挡着时自动按一下 Esc 再切；
  桌面（Program Manager）或别的进程占着前台时 Windows 会拒掉 `SetForegroundWindow`（实测关掉一个窗口后就这样），
  `force_foreground` 用标准解法：敲一下 Alt 解锁，再不行就 `AttachThreadInput` 接上前台线程再切；
  **管理员权限的窗口**挡着时没有办法——Windows 的 UIPI 不许普通权限程序抢它的前台、也不许往里发键盘。
  所以别在她桌面上留管理员窗口（身体服务本身以普通权限运行）。
- **实时游戏靠反射回路（`body_reflex.py`）**：慢的想（她几秒一次定策略）、快的做（本地 20～50 Hz 截棋盘区域 → 按颜色量化成格子 → BFS 追食物 / 求生 / 固定键序 → 按键）。
  只对本会话 `apps start` 起的 pid 发键，前台一变就停，硬时限上限 10 分钟，一次只跑一个。不读游戏内存、不改游戏。实测 tkinter 贪吃蛇 12 秒吃 5 个果子。
- **玩游戏靠一步按一串**：`press` / `/key` 带 `repeat`，一步几十上百下，再用 `eval` 读棋盘 / 分数（文字比看图准）。
  一步一键时模型每步要几秒，实测 2048 120 步只合出 64。
- **Edge 的「翻译此页？」弹窗关掉**（启动参数 + 资料里的 `translate.enabled`）：它会一直挡着页面上的分数（实测）。
- PowerShell 的错误流在重定向时是 CLIXML，服务端还原成文字再回给模型。
- 子进程在她的主目录里跑：否则起的程序（记事本「另存为」）默认落在本服务的安装目录。
- 线程模型见上面「并发」：UIA 的 COM 对象和 Playwright 同步 API 都绑定创建它的线程，所以同类操作固定在一条通道线程上，而不是全局单线程。

## 依赖（requirements.txt）

| 包 | 理由 |
|---|---|
| `uiautomation` | Windows 自带 UI Automation 的 Python 封装：按控件树找控件、走控件模式 |
| `pyautogui` | 截图、键盘快捷键、按坐标点 |
| `pillow` | pyautogui 截图与缩放需要 |
| `playwright` | 驱动本机自带的 Edge（`channel='msedge'`），不另下载浏览器 |

## 安装（在她的 Windows 上，以她的账户，SSH 进去跑即可）

1. 需要 Python 3.10+。**WindowsApps 里的 `python.exe` 是商店占位符，不算**。虚拟机上是按用户装的 3.12
   （不要管理员、不弹 UAC、不改 PATH）：

   ```powershell
   Invoke-WebRequest https://registry.npmmirror.com/-/binary/python/3.12.10/python-3.12.10-amd64.exe -OutFile $env:TEMP\py.exe
   Start-Process $env:TEMP\py.exe -ArgumentList '/quiet','InstallAllUsers=0','PrependPath=0','Include_launcher=0','Shortcuts=0' -Wait
   ```

2. 把本目录拷到她的机器（虚拟机上是 `C:\Users\me\mumu-body`）。从 Mac：

   ```bash
   cd apps/body && COPYFILE_DISABLE=1 tar -czf - *.py *.ps1 *.txt | ssh mumu-vm 'tar -xzf - -C C:/Users/me/mumu-body'
   ```

3. 安装并注册常驻（VM 连不上 pypi.org，用清华镜像）：

   ```powershell
   C:\Users\me\mumu-body\install.ps1 -IndexUrl https://pypi.tuna.tsinghua.edu.cn/simple
   ```

   它会建 `.venv`、装依赖、注册任务计划 `mumu-body`（她登录时在她的桌面会话里起 `pythonw server.py`，
   崩了每分钟重启），并立即启动一次。参数：`-Proxy`、`-Python`、`-Port`、`-NoLogonTrigger`（测试机用，不随登录自启）。

**不做的事**：不碰 UAC、自动登录、锁屏、防火墙、任何账户或系统安全设置——这些由用户自己调。
任务以普通权限（`RunLevel Limited`）运行。

## 护栏（不是沙箱）

决定做什么的是模型，所以服务自己挡住「一时糊涂」的几类操作（`body_apps.py` 的 `PROTECTED_PROCESSES` / `DENY_EXEC`，`body_ui.py` 的 `HIDDEN_OWNERS`）：

- `/apps close` 不关系统关键进程（csrss / winlogon / wininit / lsass / services / svchost / dwm / explorer…）、不关她自己的身体（python / pythonw / node / sshd）、不收通配符，且只碰她自己登录会话里的进程。
- `/exec` 直接拒绝：关机 / 重启 / 改引导 / 格式化、改账户、改安全与防火墙设置、改 HKLM 与策略注册表、删系统目录或整个用户目录、wmic 动进程 / 账户；
  杀进程类命令（Stop-Process / taskkill / Stop-Service…）点名了受保护进程或批量杀（`Get-Process | Stop-Process`）也拒绝。拒绝时回 400，模型换办法或结束说明。
- `/ui/windows`、`/ui/tree`、`/ui/click`：系统壳层与安全组件（csrss / winlogon / lsass / dwm / LogonUI / consent / Defender）的窗口不列、不找、不点。

真正的权限边界仍在 Windows 账户：想彻底限制，把任务计划改回普通权限（`RunLevel Limited`）。
2026-10-21 的蓝屏（0xEF csrss）发生时本服务空闲（日志里 20 分钟没有请求），前 2 分钟是 explorer.exe 两次「无法正常启动 0xc0000142」，不是本服务触发的；护栏仍照加。

卸载：`uninstall.ps1`（`-Purge` 连 `.venv` 和 `data/` 一起删）。日志：`data\body.log`。
更新代码后重启（只拷文件 + 重启任务；**别重跑 install.ps1**，它会按 `-RunLevel Limited` 重新注册任务，作者那台现在是 Highest）：
`Stop-ScheduledTask mumu-body; Start-ScheduledTask mumu-body`。重启会把 Playwright 开着的 Edge 一起带走，先看网页状态卡没有 computer# 在跑。
依赖没变（playwright 包不用重装，Edge 是系统自带的）；0.2.1 起 `/health` 的 `browser` 字段能看出 Edge 有没有被重建过。
（venv 的 pythonw 是个启动器，真正的进程是它起的子进程；停不干净时按命令行找 `mumu-body\server.py` 结束）。

## 沐沐怎么连到它

服务只绑 `127.0.0.1:8765`，不开防火墙端口。沐沐所在的 Mac 用 SSH 隧道把它接到本机同一端口：

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -L 8765:127.0.0.1:8765 mumu-vm
```

`action-computer` 默认就连 `http://127.0.0.1:8765`。隧道需要常开（断线自动重连可以用 `autossh`，或一个 launchd
用户代理；目前还没装，见下一步）。想再加一层，可以 `--token-file` 给服务配 token，再在沐沐这边
`/secret set body.token <值>` + `/config set plugins.action-computer.tokenSecret body.token`。

## 下一步

- **复杂的工程活交给 DSH**（DeepSeek Harness，4090 上已装、已接本地模型）：在她的电脑里装好后，
  `exec` 跑 `dsh -p "任务"`，沐沐只收结果。简单动作自己点，工程活交 DSH，两条路都留着。
- **看图兜底（L3）**：`/screenshot` 已经有了，但沐沐的模型网关目前只收文本，图传不进 `vision.read`；
  要让网关的消息内容支持图片才行（动内核公共类型，先在 handbook 立项）。
- Mac 上的隧道做成常驻（launchd 用户代理或 autossh）。
- 应用内适配（微信 / QQ 客户端等）挂在本服务下，每个应用一个小模块。
