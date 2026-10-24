"""
键鼠与屏幕：截图、按键、打字、鼠标。

- 所有输入都走 body_send（SendInput）：按键带扫描码（游戏也收得到）、文字 Unicode 直输（不碰剪贴板）、鼠标绝对坐标。
  pyautogui 只剩截图。改之前 pyautogui 的 keybd_event 不带扫描码，tkinter 游戏窗口收不到方向键（实测贪吃蛇 120 步 0 分）。
- 打字：给了目标控件就先切前台、聚焦、全选再输；"method":"setValue" 直接写控件值（不需要前台），"paste" 走剪贴板（极个别程序不吃 Unicode 直输时用）。
- 按坐标点是最后的办法：控件树找不到时才用，坐标来自 /ui/tree 给的矩形。
"""
import io
import time

import pyautogui
import uiautomation as auto

import body_send
import body_ui

pyautogui.FAILSAFE = False  # 鼠标甩到角落就抛异常是给人用的急停；她没有手去甩，留着只会误伤


def screen_size() -> dict:
    w, h = pyautogui.size()
    return {'width': w, 'height': h}


def screenshot_png(scale: float = 1.0) -> bytes:
    return screenshot(scale)[0]


def screenshot(scale: float = 1.0, fmt: str = 'png', quality: int = 70) -> tuple[bytes, str]:
    img = pyautogui.screenshot()
    if 0 < scale < 1:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
    return encode(img, fmt, quality)


def image_file(path: str, max_side: int = 1024, quality: int = 75) -> tuple[bytes, str]:
    """本机的一张图缩到长边 max_side 再给出：看图的模型不需要原图，原图塞进请求还会撑大日志"""
    from PIL import Image
    with Image.open(path) as im:
        im.load()
        img = im.convert('RGB')
    if max(img.size) > max_side > 0:
        img.thumbnail((max_side, max_side))
    return encode(img, 'jpeg', quality)


def encode(img, fmt: str, quality: int) -> tuple[bytes, str]:
    # JPEG 比 PNG 小一个数量级：看屏幕的每一张图都会进模型请求、落日志
    buf = io.BytesIO()
    if fmt.lower() in ('jpg', 'jpeg'):
        img.convert('RGB').save(buf, format='JPEG', quality=max(10, min(95, quality)))
        return buf.getvalue(), 'image/jpeg'
    img.save(buf, format='PNG')
    return buf.getvalue(), 'image/png'


def _window_rect(hwnd: int = 0) -> tuple[int, int, int, int] | None:
    """目标窗口（缺省前台）的屏幕矩形；拿不到返回 None"""
    import ctypes
    from ctypes import wintypes
    hwnd = hwnd or ctypes.windll.user32.GetForegroundWindow()
    r = wintypes.RECT()
    if not hwnd or not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    if r.right - r.left < 8 or r.bottom - r.top < 8:
        return None
    return (r.left, r.top, r.right, r.bottom)


def _snap(rect):
    """窗口区域的 64 像素宽灰度缩略图：只用来比「变没变」，几毫秒一张"""
    l, t, r, b = rect
    img = pyautogui.screenshot(region=(max(0, l), max(0, t), max(8, r - l), max(8, b - t))).convert('L')
    w = 160
    return img.resize((w, max(8, int(img.height * w / img.width))))


def screen_change(rect, before) -> dict:
    """发完输入后再抓一次，和之前比：changeRatio 0～1（平均像素差 / 255），screenChanged 是否明显变了。
    模型据此知道按键生效没有，不必每步再 look 一次（实测她按空格切暂停后要花一步看画面判断停没停）"""
    if rect is None or before is None:
        return {}
    try:
        from PIL import ImageChops
        after = _snap(rect)
        if after.size != before.size:
            return {'screenChanged': True, 'changeRatio': 1.0}
        # 截图没有压缩噪声：任何一个像素差超过 16 就是真的变了（记事本打一个字母只动十几个像素，按均值会漏）
        diff = ImageChops.difference(before, after).point(lambda v: 255 if v > 16 else 0)
        changed = diff.histogram()[255]
        # 光标闪一下约 3 个缩略像素，打一个字母约 25 个：6 以上才算真的变了
        return {'screenChanged': changed > 6, 'changeRatio': round(changed / max(1, before.width * before.height), 4)}
    except Exception:  # 窗口没了 / 截图失败：不给这两个字段，不影响输入结果
        return {}


def paste(text: str):
    previous = auto.GetClipboardText()
    auto.SetClipboardText(text)
    body_send.tap(['ctrl', 'v'])
    time.sleep(0.3)  # 目标程序异步读剪贴板，立刻还原会粘成旧内容
    if previous:
        auto.SetClipboardText(previous)


def type_text(args: dict) -> dict:
    text = str(args.get('text', ''))
    if not text:
        raise ValueError('缺 text')
    method = str(args.get('method', 'unicode'))
    target = None
    if any(k in args for k in ('ref', 'name', 'automationId', 'controlType')):
        target = body_ui.find(args)
    elif args.get('window') or args.get('pid'):
        body_ui.activate(body_ui.window_args(args))  # 只给了窗口：切过去打到它的焦点控件
    how = method
    if target is not None:
        vp = body_ui.pattern(target, 'value')
        if method == 'setValue' and vp is not None and not vp.IsReadOnly:
            vp.SetValue(text)
        else:
            # 像人一样：切前台、聚焦、全选、输入。SetValue 在经典对话框的文件名框上会「返回成功但不生效」（实测）
            body_ui.activate(target)
            target.SetFocus()
            time.sleep(0.05)
            if args.get('replace', True):
                body_send.tap(['ctrl', 'a'])
                time.sleep(0.05)
            how = _emit(text, method)
    else:
        how = _emit(text, method)
    out = {'ok': True, 'how': how, 'target': body_ui.describe(target) if target is not None else '当前焦点',
           'foreground': body_ui.foreground_title()}
    vp = body_ui.pattern(target, 'value') if target is not None else None
    if vp is not None:
        try:
            out['valueNow'] = vp.Value[:300]  # 回读实际内容，调用方据此确认真打进去了
        except Exception:  # 有的控件读值会抛 COM 错误：不影响打字结果，不报
            pass
    if args.get('enter'):
        body_send.tap(['enter'])
    return out


def _emit(text: str, method: str) -> str:
    # Unicode 直输走 VK_PACKET，不经输入法；但 ctrl+a / 回车这类键会，所以同样把输入法切英文
    with body_send.ime_english():
        if method == 'paste':
            paste(text)
            return 'paste'
        body_send.type_text(text, interval=0.005)
        return 'unicode'


def key(args: dict) -> dict:
    """keys: "ctrl+s" / "enter" / 用逗号分隔的一串 "ctrl+a, delete"；repeat 整串重复几遍（总数封顶 300）；
    delayMs 两下之间的间隔；holdMs 按住多久（游戏有时要 ≥50ms 才认）"""
    keys = str(args.get('keys', '')).strip()
    if not keys:
        raise ValueError('缺 keys')
    if args.get('window') or args.get('pid'):
        body_ui.activate(body_ui.window_args(args))
    rect = _window_rect()
    before = _snap(rect) if rect else None
    combos = []
    for combo in [c.strip() for c in keys.split(',') if c.strip()]:
        parts = [p.strip().lower() for p in combo.split('+') if p.strip()]
        for p in parts:
            body_send.vk_of(p)  # 不认识的键在这里就报，别按到一半
        combos.append(parts)
    repeat = max(int(args.get('repeat', 1)), 1)
    total = min(len(combos) * repeat, 300)
    delay = min(max(float(args.get('delayMs', 100)), 0), 2000) / 1000
    hold = min(max(float(args.get('holdMs', 50)), 0), 1000) / 1000
    done = 0
    # 发键期间把前台窗口的输入法切成英文：中文模式下字母进拼音候选、方向键在候选里挪，程序收不到（实测）
    with body_send.ime_english() as ime:
        while done < total:
            body_send.tap(combos[done % len(combos)], hold)
            done += 1
            time.sleep(delay)
    time.sleep(0.15)  # 让程序把这一下画出来再比
    # 没指定窗口时键盘发给了当前前台：告诉调用方是谁，免得以为发进了别的窗口
    return {'ok': True, 'pressed': done, 'keys': ['+'.join(c) for c in combos], 'repeat': repeat,
            'imeWasChinese': bool(ime.prev), 'foreground': body_ui.foreground_title(), **screen_change(rect, before)}


def mouse(args: dict) -> dict:
    """{x,y,button?,double?}；拖拽 {x,y,toX,toY}；滚轮 {x,y,scroll:-3}（负数向下）"""
    x, y = int(args['x']), int(args['y'])
    button = str(args.get('button', 'left'))
    if 'scroll' in args:
        ticks = int(args['scroll'])
        body_send.scroll(x, y, ticks, bool(args.get('horizontal')))
        return {'ok': True, 'at': [x, y], 'scrolled': ticks}
    if 'toX' in args and 'toY' in args:
        x2, y2 = int(args['toX']), int(args['toY'])
        body_send.drag(x, y, x2, y2, button, float(args.get('durationSec', 0.3)))
        return {'ok': True, 'from': [x, y], 'to': [x2, y2], 'button': button}
    clicks = 2 if args.get('double') else 1
    rect = _window_rect()
    before = _snap(rect) if rect else None
    body_send.click(x, y, button, clicks)
    time.sleep(0.2)
    return {'ok': True, 'at': [x, y], 'button': button, 'clicks': clicks, 'foreground': body_ui.foreground_title(),
            **screen_change(rect, before)}
