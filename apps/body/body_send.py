"""
全局键鼠注入：所有按键 / 打字 / 鼠标都从这一处用 Windows SendInput 发出去。

立场：
- 一套机制通吃：游戏（读扫描码）、Tk / Qt / 浏览器 / 记事本（读虚拟键或字符）、UWP。按键同时带虚拟键码和扫描码，
  文字用 KEYEVENTF_UNICODE 逐字符直输——不依赖剪贴板、不依赖输入法、中文英文一样。
- 本服务跑在她的登录桌面会话里，且是提升后的进程，SendInput 对任何前台窗口都有效（UIPI 不会挡）。
- 这里只管「发出去」；要不要先把窗口切到前台由调用方（body_input / body_ui）决定。
"""
import ctypes
import time
from ctypes import wintypes

from pyautogui import _pyautogui_win as _win  # 键名 → 虚拟键码表（与 pyautogui 同一张）

user32 = ctypes.windll.user32

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, KEYEVENTF_SCANCODE = 0x0001, 0x0002, 0x0004, 0x0008
MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE = 0x0001, 0x8000
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP = 0x0020, 0x0040
MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x0800, 0x1000
# 方向键、Home/End/PgUp/PgDn、Ins/Del、Win、小键盘回车等：扫描码要带 E0 前缀
EXTENDED_VKS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5}
BUTTONS = {
    'left': (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    'right': (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    'middle': (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong))]


class _U(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wintypes.DWORD), ('u', _U)]


imm32 = ctypes.windll.imm32
WM_IME_CONTROL = 0x0283
IMC_GETCONVERSIONMODE, IMC_SETCONVERSIONMODE = 0x0001, 0x0002


class ime_english:
    """把目标窗口的输入法切到英文（字母数字）模式，退出时还原。
    中文模式下字母会进拼音候选、方向键在候选里挪（实测 tkinter 贪吃蛇按 r 弹出「1人 2让…」），程序什么都收不到。
    用 with 包住一段发键；窗口没有输入法时什么都不做"""

    def __init__(self, hwnd: int = 0):
        self.hwnd = hwnd or user32.GetForegroundWindow()
        self.ime = imm32.ImmGetDefaultIMEWnd(self.hwnd) if self.hwnd else 0
        self.prev = None

    def __enter__(self):
        if self.ime:
            self.prev = user32.SendMessageW(self.ime, WM_IME_CONTROL, IMC_GETCONVERSIONMODE, 0)
            if self.prev:
                user32.SendMessageW(self.ime, WM_IME_CONTROL, IMC_SETCONVERSIONMODE, 0)
                time.sleep(0.05)
        return self

    def __exit__(self, *_):
        if self.ime and self.prev:
            user32.SendMessageW(self.ime, WM_IME_CONTROL, IMC_SETCONVERSIONMODE, self.prev)
        return False


def _send(*inputs: INPUT) -> int:
    arr = (INPUT * len(inputs))(*inputs)
    n = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    if n != len(inputs):
        raise OSError(f'SendInput 只发出 {n}/{len(inputs)}（错误码 {ctypes.get_last_error()}）')
    return n


def vk_of(name: str) -> int:
    code = _win.keyboardMapping.get(name.lower())
    if code is None:
        raise ValueError(f'不认识的键: {name}')
    return code & 0xFF


def _key_input(vk: int, up: bool) -> INPUT:
    sc = user32.MapVirtualKeyW(vk, 0)
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if vk in EXTENDED_VKS else 0) | (KEYEVENTF_KEYUP if up else 0)
    # 虚拟键码与扫描码都给：带 SCANCODE 标志时系统按扫描码还原 wVk，游戏读扫描码、普通程序读 wVk，两边都对
    return INPUT(type=INPUT_KEYBOARD, u=_U(ki=KEYBDINPUT(vk, sc, flags, 0, None)))


def key_down(name: str):
    _send(_key_input(vk_of(name), False))


def key_up(name: str):
    _send(_key_input(vk_of(name), True))


LONE_TOGGLES = {'win', 'winleft', 'winright', 'alt', 'altleft', 'altright', 'option', 'optionleft', 'optionright'}
VK_DUMMY = 0xE8  # 未分配的虚拟键码：Windows 的 Win / Alt「单击」判定是「按下到抬起之间没别的键」，塞一个无效键进去就不算单击


def tap(names: list[str], hold: float = 0.04):
    """按一个组合：依次按下，按住 hold 秒，逆序抬起。单键就是 names 只有一个。
    含 Win / Alt 时在抬起前塞一个无效键：Win+字母 被输入法或程序吞掉时 Win 抬起会被当成单击 Win 弹出开始菜单（实测「开始菜单莫名弹出」），
    Alt 单击会激活菜单栏；塞了无效键系统就不判单击"""
    for n in names:
        key_down(n)
        time.sleep(0.01)
    time.sleep(hold)
    for n in reversed(names):
        if n.lower() in LONE_TOGGLES:
            _send(_key_input(VK_DUMMY, False), _key_input(VK_DUMMY, True))
        key_up(n)
        time.sleep(0.01)


def type_text(text: str, interval: float = 0.0):
    """逐字符 Unicode 直输（KEYEVENTF_UNICODE）：中文、符号、换行都行，不碰剪贴板和输入法。\n 发成回车"""
    for ch in text:
        if ch == '\r':
            continue
        if ch == '\n':
            tap(['enter'])
            continue
        # 按 UTF-16 码元逐个发（表情等代理对就是两个码元）
        raw = ch.encode('utf-16-le')
        units = [int.from_bytes(raw[i:i + 2], 'little') for i in range(0, len(raw), 2)]
        for cu in units:
            _send(INPUT(type=INPUT_KEYBOARD, u=_U(ki=KEYBDINPUT(0, cu, KEYEVENTF_UNICODE, 0, None))),
                  INPUT(type=INPUT_KEYBOARD, u=_U(ki=KEYBDINPUT(0, cu, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, None))))
        if interval:
            time.sleep(interval)


def _abs(x: int, y: int) -> tuple[int, int]:
    # 绝对坐标按 0..65535 归一化到虚拟屏幕（多显示器也对）
    vx, vy = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
    vw, vh = user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)
    return int((x - vx) * 65535 / max(1, vw - 1)), int((y - vy) * 65535 / max(1, vh - 1))


def move(x: int, y: int):
    ax, ay = _abs(x, y)
    _send(INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, None))))


def click(x: int, y: int, button: str = 'left', clicks: int = 1, hold: float = 0.03):
    down, up = BUTTONS.get(button, BUTTONS['left'])
    move(x, y)
    time.sleep(0.03)
    for i in range(max(1, clicks)):
        _send(INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(0, 0, 0, down, 0, None))))
        time.sleep(hold)
        _send(INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(0, 0, 0, up, 0, None))))
        if i + 1 < clicks:
            time.sleep(0.08)  # 双击间隔要短于系统双击时间（默认 500ms）


def drag(x1: int, y1: int, x2: int, y2: int, button: str = 'left', duration: float = 0.3):
    down, up = BUTTONS.get(button, BUTTONS['left'])
    move(x1, y1)
    time.sleep(0.03)
    _send(INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(0, 0, 0, down, 0, None))))
    steps = max(2, int(duration / 0.02))
    for i in range(1, steps + 1):
        move(int(x1 + (x2 - x1) * i / steps), int(y1 + (y2 - y1) * i / steps))
        time.sleep(duration / steps)
    _send(INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(0, 0, 0, up, 0, None))))


def scroll(x: int, y: int, ticks: int, horizontal: bool = False):
    move(x, y)
    time.sleep(0.02)
    flag = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    _send(INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(0, 0, ctypes.c_uint32(ticks * 120).value, flag, 0, None))))
