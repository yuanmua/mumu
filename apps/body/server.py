"""
沐沐的身体服务：跑在她那台 Windows 的登录桌面会话里，把「命令、控件树、键鼠、程序、浏览器」
暴露成本机 HTTP + JSON，给 action-computer 插件的工具循环调用。

立场：
- 只做薄薄一层翻译，能力全来自公开的常用库（uiautomation / pyautogui / Playwright / PowerShell），
  不自己造自动化轮子。决定「下一步做什么」是沐沐那边的事，这里不做任何策略。
- 必须跑在**交互式桌面会话**里（任务计划「登录时」启动），不能跑在 SSH / 服务的 session 0：
  那里没有桌面，UIA 看不到窗口、键鼠发不出去。/health 报 sessionId 方便排查。
- 默认只绑 127.0.0.1：沐沐经 SSH 隧道访问，不开防火墙端口；可选 token 再挡一层本机其他进程。
- 一步慢了不能拖死整个服务（实测：一步 /exec 等安装器卡在 UAC 提示上，单线程的服务 90 秒连 /health 都不回，
  沐沐那边后面三个任务全报「连不上」）。所以每个请求一个线程，会做事的接口按类分「通道」：
  每条通道一个常驻线程，同类串行、不同类并行——UIA 的 COM 对象和 Playwright 同步 API 都绑定创建它的线程，
  同一条通道里的活永远在同一个线程上跑。/health、/screenshot、/image、/ui/windows 不进通道，永远直接回。
- 进通道的请求是一个 job：等到硬上限（exec 是 timeoutSec + 15 秒，其余 60 秒）还没做完就先回 504 + job 号，
  活继续跑，调用方用 GET /job?id= 取结果；还在排队没开始的直接取消（调用方已经不等了，不该过后再做）。

用法：python server.py [--host 127.0.0.1] [--port 8765] [--token-file 路径]
"""
import argparse
import contextlib
import ctypes
import getpass
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import uiautomation as auto

import body_apps
import body_browser
import body_input
import body_reflex
import body_ui

VERSION = '0.2.1'
LANE_WAIT_SEC = 60  # 非 exec 的通道请求最多等多久就先回 504（apps start 自己 30 秒超时，浏览器操作 30 秒）
EXEC_GRACE_SEC = 15  # exec 超时后杀进程树、收输出的余量
KEEP_JOBS = 64  # 做完的 job 留多少个给 /job 查


def session_id() -> int:
    sid = ctypes.c_ulong()
    ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(sid))
    return sid.value


def is_admin() -> bool:
    """本进程是否以管理员（提升后的令牌）运行。沐沐那边的状态卡据此显示「以什么权限跑」"""
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:  # 查不到就当不是：只影响显示，不影响任何操作
        return False


def run_route(fn, args: dict) -> tuple[int, dict]:
    try:
        return 200, fn(args)
    except (body_ui.UiError, ValueError) as e:  # 找不到控件、参数不对、被护栏拒绝：调用方换个办法，不是服务故障
        return 400, {'error': str(e)}
    except Exception as e:  # 任何未预料的错误都回给调用方，不让服务因一次请求挂掉
        traceback.print_exc()
        return 500, {'error': f'{type(e).__name__}: {e}'}


class Job:
    def __init__(self, jid: str, lane: str, path: str, fn, args: dict):
        self.id, self.lane, self.path, self.fn, self.args = jid, lane, path, fn, args
        self.state = 'queued'  # queued → running → done；排队时调用方不等了 → cancelled
        self.created = time.time()
        self.started = 0.0
        self.ended = 0.0
        self.status = 0
        self.result: dict = {}
        self.done = threading.Event()

    def info(self) -> dict:
        since = self.started or self.created
        sec = (self.ended or time.time()) - since  # 排队中 = 排了多久，开始后 = 做了多久
        out = {'job': self.id, 'lane': self.lane, 'path': self.path, 'state': self.state, 'sec': round(sec, 1)}
        if self.state == 'done':
            out.update(status=self.status, result=self.result)
        return out


_jobs: 'OrderedDict[str, Job]' = OrderedDict()
_jobs_lock = threading.Lock()


class Lane:
    """一类操作一条线：一个常驻 daemon 线程按到达顺序做，init 是这个线程一辈子的上下文（UIA 要在本线程初始化 COM）"""

    def __init__(self, name: str, init=None):
        self.name = name
        self.q: queue.Queue = queue.Queue()
        self.current: Job | None = None
        threading.Thread(target=self._run, args=(init,), name=f'lane-{name}', daemon=True).start()

    def _run(self, init):
        with (init() if init else contextlib.nullcontext()):
            while True:
                job = self.q.get()
                with _jobs_lock:
                    if job.state == 'cancelled':
                        continue
                    job.state, job.started, self.current = 'running', time.time(), job
                job.status, job.result = run_route(job.fn, job.args)
                with _jobs_lock:
                    job.state, job.ended, self.current = 'done', time.time(), None
                    job.done.set()

    def queued(self) -> int:
        with _jobs_lock:
            return sum(1 for j in _jobs.values() if j.lane == self.name and j.state == 'queued')


LANES = {
    'exec': Lane('exec'),
    'apps': Lane('apps'),
    'ui': Lane('ui', auto.UIAutomationInitializerInThread),
    'browser': Lane('browser'),  # Playwright 同步 API 只能在启动它的线程里用
}


def submit(lane: str, path: str, fn, args: dict, jid: str) -> Job:
    """同一个 job 号重复提交（调用方重试）不重做，返回原来那个"""
    with _jobs_lock:
        job = _jobs.get(jid)
        if job:
            return job
        job = _jobs[jid] = Job(jid, lane, path, fn, args)
        finished = [k for k, j in _jobs.items() if j.state in ('done', 'cancelled')]
        for k in finished[:max(0, len(finished) - KEEP_JOBS)]:
            del _jobs[k]
    LANES[lane].q.put(job)
    return job


def busy() -> list[dict]:
    with _jobs_lock:
        return [j.info() for j in _jobs.values() if j.state in ('queued', 'running')]


def health(_: dict) -> dict:
    sid = session_id()
    return {
        'ok': True,
        'version': VERSION,
        'user': getpass.getuser(),
        'sessionId': sid,
        # session 0 是服务会话，没有桌面：多半是从 SSH 直接起的，UI 类接口都会失败
        'interactive': sid != 0,
        'admin': is_admin(),
        'screen': body_input.screen_size(),
        'busy': busy(),  # 各通道正在做 / 排队的活：调用方据此判断「那一步还在执行」
        'browser': body_browser.status(),  # Playwright 的 Edge 开着没、重建过几次、上次的错：只读缓存，不碰通道线程
    }


def job_status(query: dict) -> dict:
    with _jobs_lock:
        job = _jobs.get(query.get('id', ''))
        if not job:
            raise ValueError(f'没有这个 job: {query.get("id", "")}（可能请求没送到，或已过期）')
        return job.info()


def windows_here(args: dict) -> dict:
    """窗口列表不排队：在请求线程里初始化 COM 直接列，ui 通道被一步卡住时也能看到桌面上有什么"""
    with auto.UIAutomationInitializerInThread():
        return body_ui.windows(args)


def exec_cap(args: dict) -> float:
    try:
        sec = float(args.get('timeoutSec', 60))
    except (TypeError, ValueError):
        sec = 60
    return min(max(sec, 1), 600) + EXEC_GRACE_SEC


# 路径 → (通道, 函数)；通道 None = 不排队，在请求线程里直接做
POST_ROUTES = {
    '/exec': ('exec', body_apps.exec_powershell),
    '/apps': ('apps', body_apps.apps),
    '/ui/windows': (None, windows_here),
    '/ui/tree': ('ui', body_ui.tree),
    '/ui/click': ('ui', body_ui.click),
    '/ui/focus': ('ui', body_ui.focus),
    '/type': ('ui', body_input.type_text),
    '/key': ('ui', body_input.key),
    '/mouse': ('ui', body_input.mouse),
    '/browser': ('browser', body_browser.browser),
    '/reflex': ('ui', body_reflex.reflex),
}

GET_ROUTES = {
    '/health': health,
    '/job': job_status,
    '/ui/windows': windows_here,
}


class Handler(BaseHTTPRequestHandler):
    server_version = f'mumu-body/{VERSION}'
    token = ''

    def log_message(self, fmt, *args):  # 只记一行到 stderr，任务计划下无人看控制台；带时间，排查「哪一步卡了多久」要用
        log(f'{self.address_string()} {fmt % args}')

    def _authorized(self) -> bool:
        if not self.token:
            return True
        return self.headers.get('Authorization', '') == f'Bearer {self.token}'

    def _send(self, status: int, body: bytes, ctype: str):
        try:
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError as e:  # 调用方等不及先断了：活已经做完，结果留在 /job 里，记一行就够
            log(f'{self.path} 回结果时连接已断（{type(e).__name__}）')

    def _json(self, status: int, obj: dict):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def _dispatch(self, fn, args: dict):
        self._json(*run_route(fn, args))

    def _run_in_lane(self, lane: str, path: str, fn, args: dict):
        jid = (self.headers.get('X-Body-Job', '') or uuid.uuid4().hex[:12])[:64]
        job = submit(lane, path, fn, args, jid)
        cap = exec_cap(args) if path == '/exec' else LANE_WAIT_SEC
        if job.done.wait(cap):
            return self._json(job.status, job.result)
        with _jobs_lock:
            if job.state == 'queued':  # 调用方不等了：还没开始的不再做；结果记在 job 上，同一个号重发立刻拿到这个 504
                ahead = LANES[lane].current
                what = f'（前面的 {ahead.path} 已经做了 {round(time.time() - ahead.started)} 秒）' if ahead else ''
                job.state, job.ended = 'cancelled', time.time()
                job.status, job.result = 504, {**job.info(), 'error': f'{path} 排队 {round(cap)} 秒还没轮到，这一步没有执行{what}'}
                job.done.set()
            if job.done.is_set():  # 刚取消的，或者恰好在这一刻做完
                reply = (job.status, job.result)
            else:
                info = job.info()
                reply = (504, {**info, 'error': f'{path} 做了 {info["sec"]} 秒还没做完，还在电脑上执行；用 GET /job?id={jid} 取结果'})
            state = job.state
        log(f'{path} job {jid} 超过 {round(cap)} 秒：{state}')
        self._json(*reply)

    def do_GET(self):
        if not self._authorized():
            return self._json(401, {'error': 'token 不对'})
        url = urlparse(self.path)
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        if url.path == '/screenshot':
            try:
                data, ctype = body_input.screenshot(
                    float(query.get('scale', '1')), query.get('fmt', 'png'), int(query.get('q', '70')))
                return self._send(200, data, ctype)
            except Exception as e:  # 锁屏 / 无桌面时截图会失败，回错误而不是断连接
                return self._json(500, {'error': f'{type(e).__name__}: {e}'})
        if url.path == '/image':
            path = query.get('path', '')
            if not path or not os.path.isfile(path):
                return self._json(400, {'error': f'没有这个文件: {path}'})
            try:
                data, ctype = body_input.image_file(path, int(query.get('max', '1024')), int(query.get('q', '75')))
                return self._send(200, data, ctype)
            except Exception as e:  # 不是图片 / 图片坏了：这条路不通，调用方换一张
                return self._json(400, {'error': f'读不了这张图: {type(e).__name__}: {e}'})
        fn = GET_ROUTES.get(url.path)
        if not fn:
            return self._json(404, {'error': f'没有这个接口: {url.path}'})
        self._dispatch(fn, query)

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {'error': 'token 不对'})
        path = urlparse(self.path).path
        route = POST_ROUTES.get(path)
        if not route:
            return self._json(404, {'error': f'没有这个接口: {self.path}'})
        lane, fn = route
        length = int(self.headers.get('Content-Length', '0') or 0)
        raw = self.rfile.read(length) if length else b'{}'
        try:
            args = json.loads(raw.decode('utf-8') or '{}')
        except ValueError as e:
            return self._json(400, {'error': f'请求体不是 JSON: {e}'})
        if not isinstance(args, dict):
            return self._json(400, {'error': '请求体应是 JSON 对象'})
        if lane:
            return self._run_in_lane(lane, path, fn, args)
        self._dispatch(fn, args)


def log(line: str):
    sys.stderr.write(f'{time.strftime("%m-%d %H:%M:%S")} {line}\n')


def main():
    p = argparse.ArgumentParser(description='沐沐的身体服务')
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--token-file', default='', help='文件里放一行 token；不给则不校验（只绑本机时可接受）')
    a = p.parse_args()
    if sys.stderr is None:
        # pythonw（计划任务里无控制台）下没有 stderr，日志落到程序旁边的 data/body.log
        data = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
        os.makedirs(data, exist_ok=True)
        sys.stderr = sys.stdout = open(os.path.join(data, 'body.log'), 'a', encoding='utf-8', buffering=1)
    if a.token_file:
        with open(a.token_file, encoding='utf-8') as f:
            Handler.token = f.read().strip()
    httpd = ThreadingHTTPServer((a.host, a.port), Handler)  # 每个请求一个 daemon 线程
    log(f'mumu-body {VERSION} 监听 {a.host}:{a.port}，session {session_id()}')
    try:
        httpd.serve_forever()
    finally:
        body_reflex.shutdown()
        # 浏览器只能在开它的通道线程里关；通道卡着就不等了，进程退出时 Edge 随 Playwright 驱动一起走
        submit('browser', 'shutdown', lambda _: body_browser.shutdown() or {}, {}, 'shutdown').done.wait(10)


if __name__ == '__main__':
    main()
