"""
浏览器：Playwright 驱动本机自带的 Edge（channel='msedge'），不另下载浏览器。

- 用独立的持久化资料目录（本程序旁边的 data/edge-profile）：她登过的网站下次还在，
  也不会碰到电脑上其他人的 Edge 资料。
- 懒启动：第一次用到才开浏览器；她关掉窗口后下次调用自动重开。
- 读页面给的是文字（标题、URL、正文截断、可点的链接和按钮），不是截图：
  沐沐那边的模型目前只收文本。
- **浏览器死了要自己站起来**（2026-10-22 实测）：Edge 被关掉 / 崩掉 / 蓝屏重启之后，Playwright 的上下文一直留着，
  每次调用都回同一句 `TargetClosedError: … has been closed`，从不重建；她两个任务里 browser 全错，只能改走点界面的路，图一张没存下。
  现在：每次操作前先核对上下文还活着（`ctx.pages` 不抛错不等于活着，要看 `browser.is_connected()`），操作中碰到「已关闭」类错误就
  关掉残留、重新 launch 一次，open 直接重做，其他操作先回到上次的页面再重做一次；结果里带 `rebuilt` 说明重建过。
  还给了 `op: 'reset'` 手动重建，`status()` 给 /health 报浏览器状态（只读缓存，不跨线程碰 Playwright）。
- 找图 / 存图走 `images` / `download`（body_images.py），不靠右键「图片另存为」——右键菜单在控件树里经常拿不到。
"""
import json
import os
import sys
import time

import body_images

PROFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'edge-profile')
CHANNEL = 'msedge'  # 自检脚本在 Mac 上改成 'chrome'（机器上已装的 Chrome），同样不下载浏览器
HEADLESS = False
MAX_TEXT = 6000
MAX_PRESS = 300  # 一次 press 最多按多少下：2048 / 贪吃蛇一局几百步，一步一次模型调用玩不完（实测 120 步只合出 64）
# 「浏览器 / 上下文 / 页面已经没了」类错误的特征：Playwright 各版本措辞不完全一样，按类名和几句关键词认
CLOSED_MARKS = ('has been closed', 'Target closed', 'Target crashed', 'Connection closed', 'browser has disconnected',
                'Browser closed', 'Browser has been closed', 'Protocol error', 'Page crashed')

_state: dict = {'rebuilt': 0}


def _log(line: str):
    sys.stderr.write(f'{time.strftime("%m-%d %H:%M:%S")} browser: {line}\n')


def _disable_translate_pref():
    """Edge 的「翻译此页？」弹窗会一直挡着游戏分数（实测）；命令行开关之外把资料里的偏好也关掉（浏览器没开时改才生效）"""
    pref = os.path.join(PROFILE, 'Default', 'Preferences')
    if not os.path.isfile(pref):
        return
    try:
        with open(pref, encoding='utf-8') as f:
            data = json.load(f)
        data.setdefault('translate', {})['enabled'] = False
        with open(pref, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:  # 偏好文件坏了或被占用：只是少关一个弹窗，不影响开浏览器
        pass


def closed_error(e: BaseException) -> bool:
    """这个异常是不是「浏览器 / 上下文 / 页面已经没了」：是的话重建一次就能好，不该当成普通失败回给模型"""
    if type(e).__name__ == 'TargetClosedError':
        return True
    msg = str(e)
    return any(m in msg for m in CLOSED_MARKS)


def alive(ctx) -> bool:
    """上下文还能用吗。必须真的问一下浏览器：Edge 整个被杀掉后 `ctx.pages`、`browser.is_connected()` 都还答「活着」
    （同步 API 只在下一次调用时才处理断线事件，实测杀掉 1.5 秒后 is_connected 仍为 True），
    而 `cookies()` 这种要走到浏览器的调用会立刻抛 TargetClosedError"""
    try:
        ctx.cookies('about:blank')  # 只取这个地址的 cookie（没有），要的只是这一趟往返
        return True
    except Exception:  # 问一句就抛错：死了
        return False


def _launch():
    if 'pw' not in _state:
        from playwright.sync_api import sync_playwright
        _state['pw'] = sync_playwright().start()
    os.makedirs(PROFILE, exist_ok=True)
    _disable_translate_pref()
    # 不带 Playwright 默认的 --enable-automation、关掉 AutomationControlled：带着它 YouTube 播几十秒就报
    # 「出了点问题，请刷新或稍后重试」（实测），她看不了视频。这台 Edge 本来就是她自己用的浏览器
    return _state['pw'].chromium.launch_persistent_context(
        PROFILE, channel=CHANNEL, headless=HEADLESS, no_viewport=True,
        ignore_default_args=['--enable-automation'],
        args=['--disable-blink-features=AutomationControlled', '--disable-features=Translate,TranslateUI', '--lang=zh-CN'],
    )


def context():
    """现有的上下文（活没活由 browser() 入口先核对过），没有就开一个"""
    ctx = _state.get('ctx')
    if ctx is not None:
        return ctx
    try:
        ctx = _launch()
    except Exception as e:
        # 驱动进程（Playwright 的 node）也可能跟着死了：整个重来一遍，再不行就把错误抛出去
        _log(f'launch 失败（{type(e).__name__}: {e}），重启驱动再试一次')
        _stop_driver()
        ctx = _launch()
    _state['ctx'] = ctx
    _state['opened_at'] = time.time()
    return ctx


def page():
    ctx = context()
    pages = [p for p in ctx.pages if not p.is_closed()]
    return pages[-1] if pages else ctx.new_page()


def summary(p, with_text: bool = True) -> dict:
    out = {'title': p.title(), 'url': p.url}
    if with_text:
        text = p.inner_text('body') if p.query_selector('body') else ''
        out['text'] = text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + f'\n…（截断，共 {len(text)} 字）'
    return out


def clickables(p) -> list[str]:
    # 只给可见的链接 / 按钮的文字，模型据此选 click 的 text
    items = p.eval_on_selector_all(
        'a, button, [role=button], input[type=submit]',
        "els => els.filter(e => e.offsetParent !== null).slice(0, 80).map(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim()).filter(Boolean)",
    )
    return list(dict.fromkeys(items))


def inputs(p) -> list[dict]:
    # 可见的输入框及其可用来定位的属性，模型据此选 fill 的 selector / placeholder / label
    return p.eval_on_selector_all(
        'input:not([type=hidden]), textarea, [contenteditable=true]',
        """els => els.filter(e => e.offsetParent !== null).slice(0, 30).map(e => ({
          selector: e.id ? '#' + e.id : (e.name ? `[name="${e.name}"]` : e.tagName.toLowerCase()),
          placeholder: e.placeholder || '', label: e.getAttribute('aria-label') || '', type: e.type || ''
        }))""",
    )


def locate(p, args: dict):
    if args.get('selector'):
        return p.locator(args['selector']).first
    if args.get('label'):
        return p.get_by_label(args['label']).first
    if args.get('placeholder'):
        return p.get_by_placeholder(args['placeholder']).first
    if args.get('text'):
        t = args['text']
        # clickables 给的可能是图标按钮的 aria-label（如 YouTube 的「播放 (k)」），它没有可见文字：一并按无障碍名字找
        return (p.get_by_text(t).or_(p.get_by_role('button', name=t))
                .or_(p.get_by_role('link', name=t)).or_(p.get_by_label(t))).first
    raise ValueError('要给 selector / label / placeholder / text 之一')


OPS = 'open / read / images / download / click / fill / press / eval / back / reset / status / close'


def browser(args: dict) -> dict:
    """入口：做一次操作；碰到「浏览器已关闭」类错误就重建一次再做（只重试一次），结果里带 rebuilt"""
    op = args.get('op', 'read')
    if op == 'close':
        shutdown()
        return {'ok': True, **status()}
    if op == 'status':
        return status()
    if op == 'reset':
        _teardown('手动 reset')
        _state['rebuilt'] += 1
        context()
        return {'ok': True, 'reset': True, **status(), 'note': '浏览器已关掉重开，之前的页面没了，要用先 open'}
    ctx = _state.get('ctx')
    if ctx is not None and not alive(ctx):
        _log('操作前发现浏览器已关闭（被关掉或崩了），重开')
        return _rebuild_and_do(op, args, '操作前发现浏览器已关闭')
    try:
        out = _do(op, args)
    except Exception as e:
        if not closed_error(e):
            _state['last_error'] = f'{type(e).__name__}: {str(e)[:200]}'
            raise
        why = f'{type(e).__name__}: {str(e)[:160]}'
        _log(f'{op} 碰到浏览器已关闭（{why}），重建后再做一次')
        return _rebuild_and_do(op, args, why)
    _state['last_error'] = None
    return out


def _rebuild_and_do(op: str, args: dict, why: str) -> dict:
    """关掉残留、重开浏览器，再做一次这一步（只这一次）：open 直接重做；其他操作先回到上次的页面——她看到的还是同一个页面，只是浏览器换了一个"""
    _teardown(why)
    _state['rebuilt'] += 1
    last = _state.get('last_url')
    if op != 'open':
        if not last:
            raise ValueError(f'浏览器之前已经关掉了（{why}），刚重开了一个空的；之前的页面没了，先 browser open 再继续')
        p = context().new_page()
        p.goto(last, timeout=int(float(args.get('timeoutSec', 20)) * 1000), wait_until='domcontentloaded')
    out = _do(op, args)
    out['rebuilt'] = {'why': why, 'reopened': last if op != 'open' else None}
    out['note'] = f'浏览器之前已经关掉（{why}），这次重开了一个再做的' + ('' if op == 'open' else f'，先回到了 {last}')
    _state['last_error'] = None
    return out


def _do(op: str, args: dict) -> dict:
    timeout = int(float(args.get('timeoutSec', 20)) * 1000)
    if op == 'open':
        url = str(args.get('url', '')).strip()
        if not url:
            raise ValueError('open 需要 url')
        p = context().new_page() if args.get('newTab') else page()
        p.goto(url, timeout=timeout, wait_until='domcontentloaded')
        p.bring_to_front()
        _state['last_url'] = p.url
        return {'ok': True, **summary(p, with_text=False), 'clickables': clickables(p), 'inputs': inputs(p)}
    p = page()
    if op == 'read':
        return {**summary(p), 'clickables': clickables(p), 'inputs': inputs(p)}
    if op == 'images':
        return body_images.images(p, args, _state)
    if op == 'download':
        return body_images.download(p, args, _state, timeout)
    if op == 'click':
        locate(p, args).click(timeout=timeout)
        p.wait_for_load_state('domcontentloaded', timeout=timeout)
        _state['last_url'] = p.url
        return {'ok': True, **summary(p, with_text=False)}
    if op == 'fill':
        locate(p, args).fill(str(args.get('value', '')), timeout=timeout)
        if args.get('enter'):
            p.keyboard.press('Enter')
            p.wait_for_load_state('domcontentloaded', timeout=timeout)
            _state['last_url'] = p.url
        return {'ok': True, **summary(p, with_text=False)}
    if op == 'press':
        return press(p, args)
    if op == 'eval':
        return evaluate(p, args)
    if op == 'back':
        p.go_back(timeout=timeout)
        _state['last_url'] = p.url
        return {'ok': True, **summary(p, with_text=False)}
    raise ValueError(f'未知 op: {op}（{OPS}）')


def press(p, args: dict) -> dict:
    """按一串键：key / keys 是列表或用逗号 / 空格分开的串，repeat 整串重复几遍（总数封顶 MAX_PRESS），gapMs 键间隔。
    玩键盘游戏一步按几十下再看局面，不然步数不够"""
    raw = args.get('keys') or args.get('key') or 'Enter'
    keys = [str(k).strip() for k in (raw if isinstance(raw, list) else str(raw).replace(',', ' ').split())]
    keys = [k for k in keys if k]
    if not keys:
        raise ValueError('press 需要 key / keys')
    repeat = max(int(args.get('repeat', 1)), 1)
    total = min(len(keys) * repeat, MAX_PRESS)
    gap = min(max(int(args.get('gapMs', args.get('delayMs', 150))), 0), 2000)
    if args.get('selector'):
        p.locator(args['selector']).first.focus()
    n = 0
    while n < total:
        if n:
            p.wait_for_timeout(gap)
        p.keyboard.press(keys[n % len(keys)])
        n += 1
    return {'ok': True, 'pressed': n, 'keys': keys, 'repeat': repeat, **summary(p, with_text=False)}


def evaluate(p, args: dict) -> dict:
    """在页面里跑一段 JS，结果以 JSON 回来：读游戏棋盘 / 分数、取某个元素的文字，比截图看图准得多"""
    script = str(args.get('script', '')).strip()
    if not script:
        raise ValueError('eval 需要 script（一个表达式，或 () => {…} 函数）')
    result = p.evaluate(script)
    text = json.dumps(result, ensure_ascii=False, default=str)
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + f'…（截断，共 {len(text)} 字）'
    return {'ok': True, 'result': text, 'url': p.url}


def status() -> dict:
    """浏览器状态，给 /health 与 op status 用。只读 _state 里的缓存：/health 在请求线程里跑，不能碰 Playwright 对象（绑定通道线程）"""
    ctx = _state.get('ctx')
    out = {
        'state': 'open' if ctx is not None else 'closed',
        'rebuilt': _state['rebuilt'],  # 本次进程里自动 / 手动重建过几次：不为 0 说明 Edge 被关过或崩过
        'lastRebuild': _state.get('last_rebuild'),  # 上一次为什么重建
        'lastError': _state.get('last_error'),
        'lastUrl': _state.get('last_url'),
    }
    if ctx is not None and _state.get('opened_at'):
        out['sinceSec'] = round(time.time() - _state['opened_at'])
    return out


def _teardown(why: str):
    """关掉残留的上下文（浏览器已死时 close 会抛错或已无事可做），驱动留着下次复用"""
    ctx = _state.pop('ctx', None)
    _state['last_error'] = why
    if why != '关闭':
        _state['last_rebuild'] = f'{time.strftime("%m-%d %H:%M")} {why}'
    if ctx is None:
        return
    try:
        ctx.close()
    except Exception as e:  # 浏览器已经没了，关不关一样；记一行便于排查
        _log(f'关残留上下文时报错（{type(e).__name__}），忽略')


def _stop_driver():
    pw = _state.pop('pw', None)
    if pw is None:
        return
    try:
        pw.stop()
    except Exception as e:  # 驱动已经死了：停不停一样
        _log(f'停驱动时报错（{type(e).__name__}），忽略')


def shutdown():
    _teardown('关闭')
    _stop_driver()
    _state['last_error'] = None
