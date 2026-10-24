"""
UI Automation：按控件树找控件、点它，而不是靠截图猜像素。

- /ui/tree 把一个窗口的控件树渲染成缩进文本，每个可操作的节点带一个编号 #n；
  之后 /ui/click、/type 可以直接用 {"ref": n} 指它。编号只在最近一次 /ui/tree 内有效，
  这是给工具循环「先看、再点」用的一次性快照，不是持久身份。
- 点击优先走控件模式（Invoke / SelectionItem / Toggle / ExpandCollapse）：不依赖窗口在前台、
  不受遮挡与 DPI 影响；模式不可用或调用失败才退回真实鼠标点击。
- 无名的容器（Pane / Group / Custom）不打印但照样往下钻：它们是布局噪声，打出来模型只会更迷糊。
"""
import ctypes
import time

import uiautomation as auto

import body_send

auto.SetGlobalSearchTimeout(2)

MAX_WALK = 4000  # 单次查找最多访问的节点数：Edge 之类的大窗口控件树上万，全量走一遍要几十秒
NOISE_TYPES = {'PaneControl', 'GroupControl', 'CustomControl', 'TextControl', 'ImageControl'}

_refs: list = []  # 最近一次 /ui/tree 的编号 → 控件


class UiError(Exception):
    """找不到窗口 / 控件这类调用方能换办法解决的错误（HTTP 400）"""


def short_type(ctl) -> str:
    return ctl.ControlTypeName.removesuffix('Control')


def clean_name(ctl) -> str:
    # 图标字体（Segoe Fluent Icons）的字形在 Unicode 私用区，对模型是乱码，去掉
    return ''.join(ch for ch in ctl.Name if not 0xE000 <= ord(ch) <= 0xF8FF).strip()


def describe(ctl) -> str:
    if ctl is None:
        return '无'
    aid = f' id={ctl.AutomationId}' if ctl.AutomationId else ''
    return f'{short_type(ctl)} "{clean_name(ctl)}"{aid}'


PATTERNS = {
    'invoke': auto.PatternId.InvokePattern,
    'select': auto.PatternId.SelectionItemPattern,
    'toggle': auto.PatternId.TogglePattern,
    'expand': auto.PatternId.ExpandCollapsePattern,
    'value': auto.PatternId.ValuePattern,
}
ABILITY_NAMES = {'invoke': '可点', 'select': '可选', 'toggle': '可切换', 'expand': '可展开', 'value': '可输入'}


def pattern(ctl, key: str):
    """控件不支持该模式时返回 None"""
    try:
        return ctl.GetPattern(PATTERNS[key])
    except Exception:  # 个别 UWP 控件查询模式会抛 COM 错误：当作不支持，安全
        return None


def abilities(ctl) -> list[str]:
    return [ABILITY_NAMES[k] for k in PATTERNS if pattern(ctl, k) is not None]


def process_name(pid: int) -> str:
    """进程映像名（小写，不带路径）；查不到返回空"""
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(520)
        size = ctypes.c_ulong(520)
        if not ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return ''
        return buf.value.rsplit('\\', 1)[-1].lower()
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


# 这些进程的窗口不列、不找、不点：系统壳层与安全组件（Explorer 的桌面 / 任务栏除外，她要点开始菜单和任务栏）
HIDDEN_OWNERS = {
    'csrss.exe', 'wininit.exe', 'winlogon.exe', 'lsass.exe', 'services.exe', 'smss.exe', 'dwm.exe',
    'fontdrvhost.exe', 'logonui.exe', 'consent.exe', 'securityhealthsystray.exe', 'msmpeng.exe',
}


def top_windows() -> list:
    out = []
    for w in auto.GetRootControl().GetChildren():
        if not (w.Name or w.ClassName):
            continue
        try:
            if process_name(w.ProcessId) in HIDDEN_OWNERS:
                continue
        except Exception:  # 个别窗口取不到进程：按普通窗口对待，不影响列举
            pass
        out.append(w)
    return out


def windows(_: dict) -> dict:
    fg = auto.GetForegroundControl()
    fg_handle = fg.NativeWindowHandle if fg else 0
    out = []
    for w in top_windows():
        if not w.Name:
            continue
        out.append({
            'name': w.Name,
            'className': w.ClassName,
            'pid': w.ProcessId,
            'handle': w.NativeWindowHandle,
            'foreground': w.NativeWindowHandle == fg_handle,
        })
    return {'windows': out}


started_pids: set[int] = set()  # 本会话 /apps start 起的进程：同名窗口好几个时优先它们（body_apps 填）


def window_args(args: dict):
    """从请求参数取目标窗口：pid 优先，其次 window（标题）；都没有 = 前台"""
    pid = args.get('pid')
    return find_window(args.get('window'), int(pid) if pid else 0)


def find_window(query: str | None, pid: int = 0):
    """pid 给了就取该进程的顶层窗口；否则按标题包含（不分大小写），标题完全相等的优先。
    同一标题匹配到多个窗口时不静默挑：优先本会话 apps start 起的，仍有多个就报出候选（带 pid），让调用方用 pid 指定。
    实测桌面上残留三个同名「贪吃蛇 · Snake」时按标题发键发进了旧窗口，她以为「窗口不理我」"""
    ws = top_windows()
    if pid:
        hits = [w for w in ws if w.ProcessId == pid]
        if not hits:
            raise UiError(f'pid {pid} 没有顶层窗口：进程不在了、窗口还没出来，或它只是个启动器（记事本等商店应用，Start-Process 返回的 pid 很快退出）；'
                          '用 /ui/windows 看标题和真正的 pid 再指定')
        return hits[0]
    if not query:
        fg = auto.GetForegroundControl()
        if fg is None:
            raise UiError('没有前台窗口（锁屏了？或者服务没跑在登录桌面里）')
        return fg.GetTopLevelControl() or fg
    q = query.strip().lower()
    hits = [w for w in ws if w.Name.strip().lower() == q]
    if not hits:
        hits = [w for w in ws if q in w.Name.lower() or q == w.ClassName.lower()]
    if not hits:
        # 新式程序（Win11 记事本等）的「另存为」之类对话框挂在主窗口下，不是顶层窗口
        for w in ws:
            for c in w.GetChildren():
                if c.ControlTypeName == 'WindowControl' and q in c.Name.lower():
                    return c
        names = '、'.join(f'「{w.Name}」' for w in ws if w.Name)[:600]
        raise UiError(f'找不到标题含「{query}」的窗口。现在开着的: {names}')
    if len(hits) > 1:
        mine = [w for w in hits if w.ProcessId in started_pids]
        if len(mine) == 1:
            return mine[0]
        cands = '；'.join(f'pid {w.ProcessId}「{w.Name}」{process_name(w.ProcessId)}' for w in (mine or hits))
        raise UiError(f'标题含「{query}」的窗口有 {len(mine or hits)} 个，不知道你要哪个：{cands}。请改用 pid 指定，或先把旧的关掉（apps close pid）')
    return hits[0]


def foreground_title() -> str:
    # GetWindowText 能读到高权限窗口的标题（UIA 连这个窗口都看不见）
    h = ctypes.windll.user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetWindowTextW(h, buf, 256)
    return buf.value


SHELL_POPUPS = {'startmenuexperiencehost.exe', 'searchhost.exe', 'shellexperiencehost.exe'}


def foreground_process() -> str:
    pid = ctypes.c_ulong()
    ctypes.windll.user32.GetWindowThreadProcessId(ctypes.windll.user32.GetForegroundWindow(), ctypes.byref(pid))
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(520)
        size = ctypes.c_ulong(520)
        ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
        return buf.value.rsplit('\\', 1)[-1].lower()
    finally:
        ctypes.windll.kernel32.CloseHandle(h)


def is_foreground(want: int) -> bool:
    fg = ctypes.windll.user32.GetForegroundWindow()
    # 模态对话框开着时前台是对话框自己的句柄，它的根所有者才是主窗口（GA_ROOTOWNER = 3）
    return fg == want or ctypes.windll.user32.GetAncestor(fg, 3) == want


def force_foreground(hwnd: int) -> bool:
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    body_send.tap(['alt'], 0.02)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.15)
    if is_foreground(hwnd):
        return True
    fg = user32.GetForegroundWindow()
    tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    cur = kernel32.GetCurrentThreadId()
    attached = tid and tid != cur and user32.AttachThreadInput(cur, tid, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(cur, tid, False)
    time.sleep(0.15)
    return is_foreground(hwnd)


def activate(ctl):
    """把控件所在窗口切到前台；切不过去就报错——键盘只会发给前台，发错地方比报错更糟"""
    top = ctl.GetTopLevelControl() or ctl
    want = top.NativeWindowHandle

    def switch():
        set_active = getattr(top, 'SetActive', None)
        if set_active:
            set_active(waitTime=0.3)
        else:
            top.SetFocus()

    switch()
    # 开始菜单 / 搜索 / 通知中心开着时谁也抢不走前台，实测按一下 Esc 关掉它就行
    if want and not is_foreground(want) and foreground_process() in SHELL_POPUPS:
        body_send.tap(['escape'])
        time.sleep(0.3)
        switch()
    # Windows 的前台锁：前台是桌面（Program Manager）或别的进程时 SetForegroundWindow 会被拒（实测关掉一个窗口后就这样）。
    # 标准解法：敲一下 Alt 解锁，再不行就把自己的线程和当前前台线程的输入队列接上再切
    if want and not is_foreground(want):
        force_foreground(want)
    if want and not is_foreground(want):
        raise UiError(
            f'切不到 {describe(top)} 的前台，现在前台是「{foreground_title()}」。'
            '如果那是管理员权限的窗口，Windows 不许普通程序抢它的前台、也不许往里发键盘；'
            '请对方把它关掉，或者改用不需要键盘的办法（ui_click 按钮 / exec 命令）'
        )


def focus(args: dict) -> dict:
    w = window_args(args)
    activate(w)
    return {'ok': True, 'window': describe(w)}


def tree(args: dict) -> dict:
    global _refs
    root = window_args(args)
    depth = min(max(int(args.get('depth', 8)), 1), 20)
    max_nodes = min(max(int(args.get('maxNodes', 200)), 10), 800)
    refs, lines, visited, truncated = [], [], 0, False
    for ctl, d in auto.WalkControl(root, includeTop=True, maxDepth=depth):
        visited += 1
        if visited > MAX_WALK or len(lines) >= max_nodes:
            truncated = True
            break
        if ctl.ControlTypeName in NOISE_TYPES and not clean_name(ctl) and not ctl.AutomationId:
            continue
        if d > 0 and ctl.IsOffscreen and not args.get('offscreen'):
            continue
        can = abilities(ctl)
        tag = ''
        if can or d == 0:
            refs.append(ctl)
            r = ctl.BoundingRectangle
            tag = f'#{len(refs) - 1} '
            extra = f' [{"/".join(can)}] @({(r.left + r.right) // 2},{(r.top + r.bottom) // 2})' if can else ''
        else:
            extra = ''
        lines.append(f'{"  " * d}{tag}{describe(ctl)}{extra}')
    _refs = refs
    return {
        'window': describe(root),
        'text': '\n'.join(lines),
        'count': len(lines),
        'truncated': truncated,
    }


def type_matches(ctl, want: str) -> bool:
    w = want.lower().removesuffix('control')
    return ctl.ControlTypeName.lower().removesuffix('control') == w


def find(args: dict):
    """按 ref，或在窗口里按 name / automationId / controlType 找；同名多个时用 index"""
    if args.get('ref') is not None:
        i = int(args['ref'])
        if not 0 <= i < len(_refs):
            raise UiError(f'编号 #{i} 不在最近一次控件树里（共 {len(_refs)} 个），先重新 /ui/tree')
        ctl = _refs[i]
        if not ctl.Exists(0, 0):
            raise UiError(f'#{i} 已经不在了（界面变了），先重新 /ui/tree')
        return ctl
    root = window_args(args)
    name = str(args.get('name', '')).strip()
    aid = str(args.get('automationId', '')).strip()
    ctype = str(args.get('controlType', '')).strip()
    if not (name or aid or ctype):
        raise UiError('要给 ref，或 name / automationId / controlType 之一')
    exact, partial, visited = [], [], 0
    for ctl, _ in auto.WalkControl(root, includeTop=False, maxDepth=int(args.get('depth', 25))):
        visited += 1
        if visited > MAX_WALK:
            break
        if aid and ctl.AutomationId != aid:
            continue
        if ctype and not type_matches(ctl, ctype):
            continue
        if not name:
            exact.append(ctl)
            continue
        n = clean_name(ctl)
        if n == name:
            exact.append(ctl)
        elif name.lower() in n.lower():
            partial.append(ctl)
    hits = exact or partial
    # 屏幕外的同名控件（滚动区域里没露出来的）排后面
    hits.sort(key=lambda c: bool(c.IsOffscreen))
    if not hits:
        raise UiError(f'在 {describe(root)} 里找不到 name={name!r} automationId={aid!r} controlType={ctype!r} 的控件；先 /ui/tree 看看有什么')
    idx = int(args.get('index', 0))
    if idx >= len(hits):
        raise UiError(f'只找到 {len(hits)} 个匹配，index {idx} 越界')
    return hits[idx]


def click(args: dict) -> dict:
    ctl = find(args)
    what = describe(ctl)  # 先记下：点完对话框可能就关了，控件不复存在
    action = args.get('action', 'click')
    if action == 'double':
        activate(ctl)
        ctl.DoubleClick(simulateMove=False)
        return {'ok': True, 'did': '双击', 'control': what}
    if action == 'right':
        activate(ctl)
        ctl.RightClick(simulateMove=False)
        return {'ok': True, 'did': '右键', 'control': what}
    if action != 'mouse':
        did = try_pattern(ctl, action)
        if did:
            return {'ok': True, 'did': did, 'control': what}
    activate(ctl)
    ctl.Click(simulateMove=False)
    return {'ok': True, 'did': '鼠标点击', 'control': what}


def try_pattern(ctl, action: str) -> str | None:
    """按控件模式操作；不支持或调用失败返回 None，由调用方退回鼠标"""
    order = {
        'click': ['invoke', 'select', 'toggle', 'expand'],
        'invoke': ['invoke'],
        'select': ['select'],
        'toggle': ['toggle'],
        'expand': ['expand'],
        'collapse': ['collapse'],
    }.get(action, [])
    for p in order:
        pat = pattern(ctl, 'expand' if p == 'collapse' else p)
        if pat is None:
            continue
        try:
            if p == 'invoke':
                pat.Invoke()
            elif p == 'select':
                pat.Select()
            elif p == 'toggle':
                pat.Toggle()
            elif p == 'expand':
                pat.Expand()
            else:
                pat.Collapse()
            return p.capitalize()
        except Exception:
            # 点「保存」「确定」这类按钮，对话框在 Invoke 返回前就关了，COM 报错但动作已生效
            if not ctl.Exists(0, 0):
                return f'{p.capitalize()}（控件随即消失，多半是窗口关了）'
            continue  # 模式声明可用但调用失败（UWP 偶发）：换下一个模式或退回鼠标
    return None
