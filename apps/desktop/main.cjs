/**
 * 沐沐桌宠：她电脑桌面上一个透明、无边框、置顶的窗口，里面就是 apps/web 的聊天页。
 *
 * 立场：
 * - 不另写一套界面：直接加载后端服务的网页（默认本机 http://127.0.0.1:3939），
 *   只注入几行 CSS 把背景变透明、收起顶栏，留下 Live2D、字幕、对话框和「记录」。
 *   网页那边改了什么，桌宠自动跟上；协议仍只认 docs/web-protocol.md。
 * - 设置（显示开关默认关、置顶、宽高、贴哪个角）在后端配置库（desktop-pet 插件）：网页「设置」、角色栏按钮、
 *   本程序托盘菜单、/pet 命令都改那一份。本程序每 3 秒 GET /api/desktop-pet/state 跟上，顺带报自己此刻
 *   显示与否（from=pet，即心跳，状态页据此显示「桌宠程序在不在」）。后端没这个接口时退回读 meta.pet。
 *   关着时只隐藏窗口，进程和托盘图标都在；后端连不上时用本地记住的上次状态。
 * - 大小与位置只在后端设置「变了」时才应用：她手动拖到哪、拉多大就记在哪，不会每 3 秒被拽回去。
 * - 拖她本人就能挪窗口（-webkit-app-region: drag）；右键（她身上或对话框上）或托盘图标出菜单。
 *
 * 用法：electron . [--url http://127.0.0.1:3939/]
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const argUrl = process.argv.find(a => a.startsWith('--url='))
const URL = argUrl ? argUrl.slice('--url='.length) : 'http://127.0.0.1:3939/'
const api = p => new globalThis.URL(p, URL).toString()
const DEFAULTS = { visible: false, alwaysOnTop: true, width: 420, height: 720, corner: 'bottom-right' }
const POLL_MS = 3000

// 桌宠模式的样式：只改外观，不碰网页逻辑。类名来自 apps/web（ChatView / CharacterBar / HistoryDrawer）
const PET_CSS = `
  html, body, #app, .shell, .chat { background: transparent !important; overflow: hidden; }
  .chat .bar { display: none !important; }
  .chat .stage { -webkit-app-region: drag; }
  .chat .bottom, .chat .history-btn, .drawer, .panel, .banner { -webkit-app-region: no-drag; }
  .chat .bottom { padding: 0 8px 10px !important; }
  .chat .history-btn { top: 8px !important; right: 8px !important; opacity: .55; }
  .chat .history-btn:hover { opacity: 1; }
`

if (!app.requestSingleInstanceLock())
  app.quit()

const file = name => path.join(app.getPath('userData'), name)

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'))
  }
  catch {
    return fallback // 第一次运行或文件坏了：用默认
  }
}

function writeJson(name, value) {
  try {
    fs.writeFileSync(file(name), JSON.stringify(value))
  }
  catch { /* 记不住只影响下次启动的初始状态，不影响使用 */ }
}

/** 贴在主显示器工作区（不含任务栏）的某个角 */
function cornerBounds(corner, width, height) {
  const a = screen.getPrimaryDisplay().workArea
  const right = corner.endsWith('right')
  const bottom = corner.startsWith('bottom')
  return {
    width,
    height,
    x: right ? a.x + a.width - width - 16 : a.x + 16,
    y: bottom ? a.y + a.height - height : a.y,
  }
}

function loadBounds(s) {
  const b = readJson('bounds.json', undefined)
  if (!b)
    return cornerBounds(s.corner, s.width, s.height)
  // 显示器换了 / 分辨率变了，存的位置可能已经在屏幕外：那就回设置里的角
  const onScreen = screen.getAllDisplays().some(d =>
    b.x >= d.workArea.x - 50 && b.y >= d.workArea.y - 50
    && b.x + 100 <= d.workArea.x + d.workArea.width && b.y + 100 <= d.workArea.y + d.workArea.height)
  return onScreen ? b : cornerBounds(s.corner, s.width, s.height)
}

/** 托盘图标：16×16 的粉色圆点，现画，不带图片文件 */
function trayIcon() {
  const n = 16
  const buf = Buffer.alloc(n * n * 4)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4
      if (Math.hypot(x - 7.5, y - 7.5) <= 7) {
        buf[i] = 0xC0 // B（Windows 位图是 BGRA）
        buf[i + 1] = 0x8A // G
        buf[i + 2] = 0xF2 // R
        buf[i + 3] = 0xFF
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n })
}

function createWindow(s) {
  const win = new BrowserWindow({
    ...loadBounds(s),
    show: s.visible,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: false, // 显示时留在任务栏：找不到她的时候点一下就回来
    resizable: true,
    title: '沐沐',
    backgroundColor: '#00000000',
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required', // 语音要能自己播
      backgroundThrottling: false, // 没焦点时 Live2D 照样动
    },
  })

  let saveTimer
  const saveBounds = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => writeJson('bounds.json', win.getBounds()), 500)
  }
  win.on('move', saveBounds)
  win.on('resize', saveBounds)

  win.webContents.on('dom-ready', () => { void win.webContents.insertCSS(PET_CSS) })
  win.webContents.on('did-fail-load', (_e, code) => {
    if (code !== -3) // -3 = 被新的导航取代，不是失败
      setTimeout(() => { void win.loadURL(URL) }, POLL_MS)
  })
  // 网页里的链接（「思考」调试页等）交给系统浏览器，别在桌宠窗口里跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  void win.loadURL(URL)
  return win
}

/** 发一条后端命令；后端暂时不在就算了（本地已生效，等它回来以它为准） */
function command(line) {
  fetch(api('/api/command'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line }),
  }).catch(() => {})
}

app.whenReady().then(() => {
  // 本地只记「上次的设置」和「上次应用过的大小 / 角」，真正的设置在后端
  const local = readJson('settings.json', {})
  let s = { ...DEFAULTS, ...local.settings, visible: local.visible === true }
  let applied = local.applied ?? {} // 上次应用过的 { width, height, corner }：设置变了才再应用
  const save = () => writeJson('settings.json', { visible: s.visible, settings: s, applied })

  const win = createWindow(s)
  const tray = new Tray(trayIcon())
  tray.setToolTip('沐沐桌宠')

  function show(v) {
    s.visible = v
    if (v) {
      win.showInactive() // 出现但不抢她正在用的窗口的焦点
      win.setAlwaysOnTop(s.alwaysOnTop)
    }
    else {
      win.hide()
    }
  }

  /** 把后端给的设置落到窗口上 */
  function applySettings(next) {
    const before = s
    s = { ...s, ...next }
    if (s.visible !== before.visible)
      show(s.visible)
    if (win.isAlwaysOnTop() !== s.alwaysOnTop)
      win.setAlwaysOnTop(s.alwaysOnTop)
    const sizeChanged = s.width !== applied.width || s.height !== applied.height
    const cornerChanged = s.corner !== applied.corner
    if (sizeChanged || cornerChanged) {
      if (cornerChanged)
        win.setBounds(cornerBounds(s.corner, s.width, s.height))
      else
        win.setSize(s.width, s.height)
      applied = { width: s.width, height: s.height, corner: s.corner }
    }
    save()
    tray.setContextMenu(menu())
  }

  /** 用户在这边开关：先本地生效，再告诉后端（网页按钮、状态页据此同步） */
  function setVisible(v) {
    applySettings({ visible: v })
    command(v ? '/pet on' : '/pet off')
  }

  async function poll() {
    try {
      const shown = win.isVisible() ? '1' : '0'
      const res = await fetch(api(`/api/desktop-pet/state?from=pet&shown=${shown}`), { signal: AbortSignal.timeout(2500) })
      if (res.ok) {
        const st = await res.json()
        applySettings({
          visible: st.visible === true,
          alwaysOnTop: st.alwaysOnTop !== false,
          width: st.width,
          height: st.height,
          corner: st.corner,
        })
        return
      }
      // 旧后端没有这个接口：只认 meta.pet.visible
      const meta = await (await fetch(api('/api/meta'), { signal: AbortSignal.timeout(2500) })).json()
      if (meta && meta.pet && typeof meta.pet.visible === 'boolean')
        applySettings({ visible: meta.pet.visible })
    }
    catch { /* 后端不在：保持本地状态 */ }
  }

  const menu = () => Menu.buildFromTemplate([
    { label: '显示桌宠', type: 'checkbox', checked: s.visible, click: m => setVisible(m.checked) },
    {
      label: '置顶',
      type: 'checkbox',
      checked: s.alwaysOnTop,
      click: (m) => {
        applySettings({ alwaysOnTop: m.checked })
        command(`/config set plugins.desktop-pet.alwaysOnTop ${m.checked}`)
      },
    },
    { label: '重新加载', click: () => { void win.loadURL(URL) } },
    { label: '打开完整网页', click: () => { void shell.openExternal(URL) } },
    { label: '回到设置的位置', click: () => win.setBounds(cornerBounds(s.corner, s.width, s.height)) },
    { type: 'separator' },
    { label: '退出桌宠程序', click: () => app.quit() },
  ])
  tray.setContextMenu(menu())
  tray.on('click', () => tray.popUpContextMenu())
  win.webContents.on('context-menu', () => menu().popup({ window: win }))
  // 在可拖动区域（她身上）右键，Windows 给的是系统窗口菜单而不是 context-menu
  win.on('system-context-menu', (e) => {
    e.preventDefault()
    menu().popup({ window: win })
  })

  // 从任务栏关窗口 = 隐藏桌宠（记进开关），不是退出程序；真退出走托盘菜单
  let quitting = false
  app.on('before-quit', () => { quitting = true })
  win.on('close', (e) => {
    if (quitting)
      return
    e.preventDefault()
    setVisible(false)
  })

  app.on('second-instance', () => setVisible(true)) // 再启动一次 = 想看见她
  void poll()
  setInterval(poll, POLL_MS)
})

// 隐藏时窗口还在，不会触发；只有退出菜单或系统关闭会走到这里
app.on('window-all-closed', () => app.quit())
