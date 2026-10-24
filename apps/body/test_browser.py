"""
浏览器工具的自检：不用起整个服务（server.py 只能在 Windows 上跑），直接调 body_browser.browser()，
走的是和服务里一模一样的通道代码。只要 Python 里装了 playwright 就能跑，用的是机器上已经装着的浏览器
（Windows 上 Edge、Mac 上 Chrome），不下载任何东西。

    python test_browser.py                    # 无头跑
    python test_browser.py --headed           # 看得见窗口
    python test_browser.py --channel msedge   # 指定用哪个浏览器（msedge / chrome）

验的是 2026-10-22 那次事故的修法：
1. open 一个本地页 → images 列出图 → download 按 index / url / selector 各存一张到临时目录；
2. 把浏览器进程杀掉（模拟 Edge 被关 / 崩 / 蓝屏重启后残留的死上下文）→ 再 open 必须自动重建成功，结果带 rebuilt；
3. 再杀一次 → read 这种非 open 操作也要重建并回到上次的页面；
4. reset / status / close。
"""
import http.server
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import body_browser  # noqa: E402

def make_png(w: int = 2, h: int = 2) -> bytes:
    """现造一张 w×h 的红色 PNG，省得放一坨十六进制"""
    import struct
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\xff\x00\x00\xff' * w for _ in range(h))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


PNG = make_png()
HTML = b"""<html><body><h1>images test</h1>
<a href="/imgres?imgurl=http%3A%2F%2F127.0.0.1%3A{port}%2Fbig.png&x=1"><img src="/thumb.png" width="64" height="64" alt="thumb"></a>
<img id="data" width="40" height="40" src="data:image/png;base64,{b64}">
<img src="/icon.png" width="8" height="8">
</body></html>"""


class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/'):
            body, ctype = (PNG, 'image/png') if self.path.endswith('.png') else (self.server.html, 'text/html; charset=utf-8')
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *a):
        pass


def serve() -> int:
    import base64
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Site)
    port = srv.server_address[1]
    srv.html = HTML.replace(b'{port}', str(port).encode()).replace(b'{b64}', base64.b64encode(PNG))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


def kill_browser():
    """按资料目录找到浏览器进程杀掉：Playwright 的 Python 版不暴露进程句柄"""
    if os.name == 'nt':
        subprocess.run(['powershell', '-NoProfile', '-Command',
                        f"Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{body_browser.PROFILE}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"],
                       check=False, capture_output=True)
    else:
        out = subprocess.run(['pgrep', '-f', body_browser.PROFILE], capture_output=True, text=True).stdout.split()
        for pid in out:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
    time.sleep(1.5)


def check(cond, what):
    print(('  ✓ ' if cond else '  ✗ ') + what)
    if not cond:
        raise SystemExit(f'失败：{what}')


def main():
    args = sys.argv[1:]
    body_browser.CHANNEL = args[args.index('--channel') + 1] if '--channel' in args else ('msedge' if os.name == 'nt' else 'chrome')
    body_browser.HEADLESS = '--headed' not in args
    tmp = tempfile.mkdtemp(prefix='mumu-browser-test-')
    body_browser.PROFILE = os.path.join(tmp, 'profile')
    port = serve()
    url = f'http://127.0.0.1:{port}/'
    b = body_browser.browser

    print('1. open / images / download')
    r = b({'op': 'open', 'url': url})
    check(r.get('ok') and r['title'] == '', f'open：{r["url"]}')
    r = b({'op': 'images'})
    check(r['count'] == 2 and r['images'][0]['full'].endswith('/big.png'), f'images 列出 {r["count"]} 张（8px 图标不算），第一张解出原图 {r["images"][0]["full"]}')
    check(r['images'][1]['src'].startswith('data:缩略图'), 'data: 缩略图只报大小')
    d = b({'op': 'download', 'index': r['images'][0]['index'], 'dir': tmp})
    check(d['ok'] and d['path'].endswith('big.png') and d['bytes'] == len(PNG) and d.get('width') == 2, f'按 index 下了原图 {d["path"]}（{d["bytes"]} 字节，{d.get("width")}×{d.get("height")}）')
    d = b({'op': 'download', 'index': r['images'][1]['index'], 'dir': tmp, 'name': 'from-data'})
    check(d['ok'] and d['path'].endswith('from-data.png') and d['bytes'] == len(PNG), f'data: 缩略图按 index 存成 {os.path.basename(d["path"])}')
    d = b({'op': 'download', 'url': url + 'thumb.png', 'dir': tmp})
    check(d['ok'] and os.path.basename(d['path']) == 'thumb.png', f'按 url 下载 {os.path.basename(d["path"])}')
    d = b({'op': 'download', 'selector': 'a img', 'dir': tmp})
    check(d['ok'] and os.path.basename(d['path']) == 'thumb-2.png', f'按 selector 下载，不覆盖同名：{os.path.basename(d["path"])}')
    try:
        b({'op': 'download', 'url': url, 'dir': tmp})
        check(False, '网页不是图片应拒绝')
    except ValueError as e:
        check('不是图片' in str(e), f'网页不是图片被拒绝：{e}')

    print('2. 杀掉浏览器后 open 自动重建')
    kill_browser()
    check(not body_browser.alive(body_browser._state['ctx']), '杀掉后 alive() 判死')
    r = b({'op': 'open', 'url': url + '?again'})
    check(r.get('ok') and r['url'].endswith('?again'), f'open 成功：{r["url"]}')
    st = b({'op': 'status'})
    check(st['state'] == 'open' and st['rebuilt'] >= 1, f'status：{st}')

    print('3. 杀掉浏览器后 read 也能重建并回到上次的页面')
    kill_browser()
    # 操作前的 alive 检查会先发现：这是「检测到已关闭就重建」的路径
    r = b({'op': 'read'})
    check(r['url'].endswith('?again') and 'images test' in r['text'], f'read 回到了 {r["url"]}')
    # 再模拟「检查时还活着、操作中才死」：把 alive 临时骗过去，让 TargetClosedError 真的抛出来走重试路径
    kill_browser()
    real_alive = body_browser.alive
    body_browser.alive = lambda _ctx: True
    try:
        r = b({'op': 'read'})
    finally:
        body_browser.alive = real_alive
    check(r.get('rebuilt') and r['rebuilt']['reopened'].endswith('?again') and 'images test' in r['text'], f'操作中报已关闭 → 重建 → 回到 {r["rebuilt"]["reopened"]} 再读：{r["note"]}')

    print('4. reset / close')
    r = b({'op': 'reset'})
    check(r['reset'] and r['state'] == 'open', f'reset：{r["note"]}')
    r = b({'op': 'close'})
    check(r['state'] == 'closed', 'close 后 status 为 closed')
    print(f'全部通过。临时目录 {tmp}')


if __name__ == '__main__':
    main()
