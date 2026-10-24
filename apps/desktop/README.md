# @mumu/desktop · 沐沐桌宠

她电脑（虚拟机）桌面上的一个透明、无边框、置顶的小窗口：Live2D 的她 + 字幕 + 对话框 + 「记录」。
登录后自动出现，拖她本人就能挪位置，右键出菜单。

## 怎么做的

不另写界面：Electron 窗口直接加载后端的网页（默认本机 `http://127.0.0.1:3939/`，即 `apps/web` 的构建产物），
只注入几行 CSS——背景透明、收起顶栏、她身上可拖动（`main.cjs` 的 `PET_CSS`）。
网页改了什么桌宠自动跟上；它和浏览器一样只认 [docs/web-protocol.md](../../docs/web-protocol.md)。

| 行为 | 说明 |
|---|---|
| **显示开关（默认关）** | 关着时只隐藏窗口，进程和托盘图标都在。能开关的地方：网页角色栏「桌宠 开/关」按钮、网页「设置」里的「桌宠」表单、托盘图标（粉色圆点，常在「显示隐藏的图标」里）菜单的「显示桌宠」、命令 `/pet on\|off` |
| **设置** | 显示开关、置顶、宽、高、位置（四个角）都在后端配置库（[desktop-pet](../../plugins/official/desktop-pet/README.md) 插件）。本程序每 3 秒 `GET /api/desktop-pet/state?from=pet&shown=…` 跟上——这也是心跳，网页「状态」页的「桌宠」卡据此显示她此刻显示与否、程序在不在。宽高与位置只在设置**变了**时应用，手动拖动、拉伸不会被拽回去。本地也记一份在 `%APPDATA%\@mumu\desktop\settings.json`，后端连不上时用它；后端没有这个接口（旧版）时退回读 `meta.pet.visible` |
| 关窗口 | 从任务栏关掉窗口 = 隐藏桌宠（记进开关），不是退出；真退出用托盘菜单「退出桌宠程序」 |
| 再启动一次 | 已经在跑时再启动 = 显示她 |
| 位置 | 默认右下角；挪过之后记在 `%APPDATA%\@mumu\desktop\bounds.json`，换了显示器跑到屏幕外会自动回到设置的角 |
| 右键菜单（她身上 / 对话框 / 托盘图标） | 显示桌宠 · 置顶（写进后端设置）· 重新加载 · 打开完整网页 · 回到设置的位置 · 退出桌宠程序 |
| 后端没起来 | 每 3 秒重试，不弹错误（开机时后端和桌宠谁先起不一定） |
| 语音 | 允许自动播放；没焦点时 Live2D 照样动 |
| 网页里的链接 | 交给系统浏览器打开，不在桌宠窗口里跳走 |

## 装在她的电脑上

桌宠自成一个目录 `C:\Users\me\mumu-desktop`（和身体服务 `mumu-body` 并列），只连后端网页，
不依赖后端仓库（`C:\mumu`）放在哪、怎么起。现状（2026-10-21）就是这么装的。

1. 把本目录的 `main.cjs` `package.json` `install.ps1` `README.md` 拷过去（Mac 上）：
   ```bash
   cd apps/desktop && COPYFILE_DISABLE=1 tar -czf - main.cjs package.json install.ps1 README.md | ssh mumu-vm "tar -xzf - -C C:/Users/me/mumu-desktop"
   ```
2. 装 Electron 二进制：`electron` npm 包装进 `node_modules\electron` 后，把
   `electron-v<版本>-win32-x64.zip`（npmmirror 镜像 `https://npmmirror.com/mirrors/electron/<版本>/`）
   对照包里的 `checksums.json` 校验 sha256，解压到 `node_modules\electron\dist\`，再写一个内容为 `electron.exe` 的
   `path.txt`——这正是 electron 安装脚本自己做的事。VM 上 Node 的 fetch 下大文件会被中途断开，用系统自带的
   `curl.exe -L --retry 5 -C -` 下载稳定（实测约 5 MB/s）。
3. 在 VM 上（SSH 进去）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\me\mumu-desktop\install.ps1
   ```

注册任务计划「mumu-desktop」：她登录时在她的桌面会话里启动（Interactive，和身体服务一样）。
`-NoLogonTrigger` 只试用不自启；`-Url` 换后端地址。卸载：`Unregister-ScheduledTask mumu-desktop`，再删目录。
不碰 UAC、自动登录、锁屏或任何安全设置。

## 依赖

- `electron`（devDependency，钉死版本）：透明 + 无边框 + 置顶的窗口只有它稳；WebView2 / Edge 应用模式做不了透明背景。
  本目录在仓库里是 npm workspace 的一员（根 `workspaces: apps/*`），所以 Mac 上 `npm install` 也会装它；
  不想下载二进制可设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。VM 上桌宠是独立目录安装，不经仓库。

## 还没做

- 透明区域点击穿透：现在窗口矩形内的空白处会挡住后面的桌面点击（420×720，右下角）。要做需按像素透明度切
  `setIgnoreMouseEvents`，等用起来觉得碍事再加。
- 语音输入：Electron 里没有浏览器的语音识别服务，麦克风按钮会自动隐藏；要语音得走后端的流式感知接口。
