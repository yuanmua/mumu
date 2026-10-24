"""
反射层：慢想快做。她（task.agent）几秒一次定策略与目标，这里在本地 20～50 Hz 截窗口 → 按颜色量化成格子 → 按策略按键，
循环到目标达成 / 出事 / 超时。

立场：
- 只看画面、只按键：不读游戏内存、不改游戏。策略、目标、何时调整都是她定的——这算她自己玩（肌肉记忆），和「写脚本代玩」是两回事。
- 不为某个游戏写死：棋盘区域、格子数、颜色各代表什么（蛇头 / 蛇身 / 食物 / 墙）都由她量好传进来（probe / grid 两个接口帮她量）。
- 护栏：只对本会话 apps start 起的 pid 发键；前台窗口一变立刻停；硬时限（默认 120 秒、上限 10 分钟）；截图只取棋盘区域；一次只跑一个回路。

接口（POST /reflex，op 分发）：
  probe {pid}                       → 窗口矩形 + 画面里的主要颜色（带样例坐标），帮她认颜色
  grid  {pid, see}                  → 按 see 量化一次，回字符画 + 各类格子数，帮她核对棋盘参数
  start {pid, see, policy, hz, maxSec, stopWhen} → {id, state}
  state {id?}                       → 当前局面摘要（分数不读，报蛇长 / 吃了几个 / 存活 / 最近几次动作）
  stop  {id?}
see:    { region:[l,t,r,b]（屏幕绝对坐标）, cols, rows, colors:{ head:[r,g,b], body:[r,g,b], food:[r,g,b], wall?:[r,g,b] }, tolerance:50 }
policy: { kind:'chase'|'avoid'|'keys', keys:{up,down,left,right}（默认方向键）, sequence:[…]（keys 用）, gapMs, holdMs, start:'r'（开局先按一下）}
stopWhen: { foodEaten:5, stalledSec:6（蛇头多久不动算结束）, lostSec:4（多久认不出蛇头算结束）}
"""
import ctypes
import threading
import time
import uuid
from collections import deque

import pyautogui

import body_send
import body_ui

user32 = ctypes.windll.user32
MAX_SEC = 600
DIRS = {'up': (0, -1), 'down': (0, 1), 'left': (-1, 0), 'right': (1, 0)}
REVERSE = {'up': 'down', 'down': 'up', 'left': 'right', 'right': 'left'}
LABEL = {'head': 'H', 'body': 'B', 'food': 'F', 'wall': 'W'}

_runs: dict = {}
_lock = threading.Lock()


def _foreground_pid() -> int:
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), ctypes.byref(pid))
    return pid.value


def _rect_of(pid: int) -> tuple[int, int, int, int]:
    w = body_ui.find_window(None, pid)
    r = w.BoundingRectangle
    return (r.left, r.top, r.right, r.bottom)


def _require_mine(pid: int):
    if pid not in body_ui.started_pids:
        raise ValueError(f'pid {pid} 不是本会话 apps start 起的程序，反射层不对它发键（先用 apps start 开游戏）')


class See:
    def __init__(self, s: dict):
        l, t, r, b = [int(v) for v in s['region']]
        self.region = (l, t, r, b)
        self.cols, self.rows = max(2, int(s['cols'])), max(2, int(s['rows']))
        self.colors = {k: tuple(int(c) for c in v) for k, v in dict(s.get('colors') or {}).items() if k in LABEL}
        if not self.colors:
            raise ValueError('see.colors 至少要给 body（蛇身）或 head（蛇头）的颜色')
        self.tol = int(s.get('tolerance', 50))

    def classify(self, px) -> str:
        best, bd = '.', 10 ** 9
        for role, c in self.colors.items():
            d = max(abs(px[0] - c[0]), abs(px[1] - c[1]), abs(px[2] - c[2]))
            if d <= self.tol and d < bd:
                best, bd = LABEL[role], d
        return best

    def grab(self):
        """截棋盘区域，量化成 rows×cols 的字符矩阵（每格取中心附近 5 点的平均色）"""
        l, t, r, b = self.region
        img = pyautogui.screenshot(region=(l, t, r - l, b - t)).convert('RGB')
        cw, ch = (r - l) / self.cols, (b - t) / self.rows
        px = img.load()
        grid = []
        for y in range(self.rows):
            row = []
            for x in range(self.cols):
                cx, cy = int((x + 0.5) * cw), int((y + 0.5) * ch)
                pts = [(cx, cy), (cx - 2, cy), (cx + 2, cy), (cx, cy - 2), (cx, cy + 2)]
                s = [0, 0, 0]
                n = 0
                for (a, bq) in pts:
                    if 0 <= a < img.width and 0 <= bq < img.height:
                        p = px[a, bq]
                        s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; n += 1
                row.append(self.classify((s[0] // n, s[1] // n, s[2] // n)) if n else '.')
            grid.append(row)
        return grid


def _cells(grid, ch):
    return [(x, y) for y, row in enumerate(grid) for x, c in enumerate(row) if c == ch]


def _free(grid, x, y) -> bool:
    return 0 <= y < len(grid) and 0 <= x < len(grid[0]) and grid[y][x] in ('.', 'F')


def _bfs(grid, start, goal):
    """从 start 到 goal 的最短路第一步方向；不通返回 None"""
    q = deque([start])
    prev = {start: None}
    while q:
        cur = q.popleft()
        if cur == goal:
            break
        for d, (dx, dy) in DIRS.items():
            nxt = (cur[0] + dx, cur[1] + dy)
            if nxt not in prev and _free(grid, *nxt):
                prev[nxt] = (cur, d)
                q.append(nxt)
    if goal not in prev:
        return None
    node = goal
    first = None
    while prev[node] is not None:
        node, d = prev[node]
        first = d
    return first


def _space(grid, start) -> int:
    """从 start 出发能到的空格数（求生用）"""
    seen = {start}
    q = deque([start])
    while q:
        cur = q.popleft()
        for dx, dy in DIRS.values():
            nxt = (cur[0] + dx, cur[1] + dy)
            if nxt not in seen and _free(grid, *nxt):
                seen.add(nxt)
                q.append(nxt)
    return len(seen) - 1


class Reflex(threading.Thread):
    def __init__(self, args: dict):
        super().__init__(daemon=True)
        self.id = uuid.uuid4().hex[:8]
        self.pid = int(args['pid'])
        _require_mine(self.pid)
        self.hwnd = body_ui.find_window(None, self.pid).NativeWindowHandle
        self.see = See(args['see'])
        p = dict(args.get('policy') or {})
        self.kind = p.get('kind', 'chase')
        if self.kind not in ('chase', 'avoid', 'keys'):
            raise ValueError('policy.kind 要是 chase / avoid / keys')
        self.keys = {**{'up': 'up', 'down': 'down', 'left': 'left', 'right': 'right'}, **dict(p.get('keys') or {})}
        self.sequence = [str(k) for k in (p.get('sequence') or [])]
        self.hold = min(max(float(p.get('holdMs', 50)), 10), 500) / 1000
        self.gap = min(max(float(p.get('gapMs', 0)), 0), 5000) / 1000
        self.start_key = p.get('start')
        self.hz = min(max(float(args.get('hz', 20)), 5), 50)
        self.max_sec = min(max(float(args.get('maxSec', 120)), 5), MAX_SEC)
        sw = dict(args.get('stopWhen') or {})
        self.goal_food = int(sw.get('foodEaten', 0) or 0)
        self.stalled_sec = float(sw.get('stalledSec', 6))
        self.lost_sec = float(sw.get('lostSec', 4))
        self.stop_flag = False
        self.state = {
            'id': self.id, 'running': True, 'pid': self.pid, 'kind': self.kind, 'startedAt': time.time(), 'ticks': 0,
            'head': None, 'food': None, 'length': 0, 'foodEaten': 0, 'dir': None, 'lastKeys': [], 'stopReason': None, 'error': None,
        }

    # ---- 主循环 ----
    def run(self):
        try:
            self._loop()
        except Exception as e:  # 任何异常都只结束这个回路，不影响服务
            self.state['error'] = f'{type(e).__name__}: {e}'
            self._finish('error')

    def _finish(self, why: str):
        self.state['running'] = False
        self.state['stopReason'] = self.state['stopReason'] or why
        self.state['elapsedSec'] = round(time.time() - self.state['startedAt'], 1)

    def _press(self, key: str):
        body_send.tap([key], self.hold)
        lk = self.state['lastKeys']
        lk.append([round(time.time() - self.state['startedAt'], 2), key])
        del lk[:-12]

    def _loop(self):
        body_ui.activate(body_ui.find_window(None, self.pid))
        ime = body_send.ime_english(self.hwnd)
        ime.__enter__()
        try:
            if self.start_key:
                self._press(str(self.start_key))
                time.sleep(0.3)
            prev_snake, prev_head, prev_food = set(), None, None
            base_len = None
            last_move = time.time()
            last_seen = time.time()
            seq_i = 0
            last_sent = (None, 0.0)
            period = 1.0 / self.hz
            while not self.stop_flag:
                t0 = time.time()
                if t0 - self.state['startedAt'] > self.max_sec:
                    return self._finish('timeout')
                if _foreground_pid() != self.pid:
                    return self._finish('foreground-changed')
                grid = self.see.grab()
                heads = _cells(grid, 'H')
                bodies = _cells(grid, 'B')
                foods = _cells(grid, 'F')
                snake = set(heads) | set(bodies)
                head = heads[0] if len(heads) == 1 else None
                if head is None and snake:
                    # 没给蛇头颜色 / 认不出：新出现的那格就是头
                    new = list(snake - prev_snake)
                    head = new[0] if len(new) == 1 else (prev_head if prev_head in snake else (heads[0] if heads else None))
                food = foods[0] if foods else None
                self.state['ticks'] += 1
                self.state['head'], self.state['food'], self.state['length'] = head, food, len(snake)
                if base_len is None and snake:
                    base_len = len(snake)
                if head is not None:
                    last_seen = t0
                    if head != prev_head:
                        if prev_head is not None:
                            dx, dy = head[0] - prev_head[0], head[1] - prev_head[1]
                            for d, v in DIRS.items():
                                if v == (dx, dy):
                                    self.state['dir'] = d
                        last_move = t0
                    prev_head = head
                if prev_food is not None and food != prev_food and (food is not None):
                    self.state['foodEaten'] += 1
                if base_len is not None:
                    self.state['foodEaten'] = max(self.state['foodEaten'], len(snake) - base_len)
                prev_food = food if food is not None else prev_food
                prev_snake = snake
                if self.goal_food and self.state['foodEaten'] >= self.goal_food:
                    return self._finish('goal')
                if t0 - last_seen > self.lost_sec:
                    return self._finish('head-lost')
                if t0 - last_move > self.stalled_sec:
                    return self._finish('stalled')

                # ---- 决定按什么 ----
                if self.kind == 'keys':
                    if self.sequence and t0 - last_sent[1] >= self.gap:
                        k = self.sequence[seq_i % len(self.sequence)]
                        seq_i += 1
                        self._press(k)
                        last_sent = (k, t0)
                elif head is not None:
                    cur = self.state['dir']
                    want = None
                    if self.kind == 'chase' and food is not None:
                        want = _bfs(grid, head, food)
                    if want is None:
                        # 求生：往能到的空格最多的方向走
                        best = -1
                        for d, (dx, dy) in DIRS.items():
                            if cur and d == REVERSE[cur]:
                                continue
                            nxt = (head[0] + dx, head[1] + dy)
                            if _free(grid, *nxt):
                                sp = _space(grid, nxt)
                                if sp > best:
                                    best, want = sp, d
                    if want and want != cur and not (cur and want == REVERSE[cur]):
                        # 同一方向 0.25 秒内不重发：游戏一格一格走，连发会把下一步的转向也吞掉
                        if not (last_sent[0] == want and t0 - last_sent[1] < 0.25):
                            self._press(self.keys[want])
                            last_sent = (want, t0)
                dt = time.time() - t0
                if dt < period:
                    time.sleep(period - dt)
            self._finish('stopped')
        finally:
            ime.__exit__(None, None, None)


def _current():
    with _lock:
        live = [r for r in _runs.values() if r.state['running']]
        return live[-1] if live else (list(_runs.values())[-1] if _runs else None)


def reflex(args: dict) -> dict:
    op = str(args.get('op', 'state'))
    if op == 'probe':
        pid = int(args.get('pid') or 0)
        rect = _rect_of(pid)
        l, t, r, b = rect
        img = pyautogui.screenshot(region=(l, t, r - l, b - t)).convert('RGB')
        small = img.resize((max(1, img.width // 4), max(1, img.height // 4)))
        counts: dict = {}
        px = small.load()
        for y in range(small.height):
            for x in range(small.width):
                p = px[x, y]
                key = (p[0] // 16 * 16, p[1] // 16 * 16, p[2] // 16 * 16)
                c = counts.setdefault(key, [0, (x * 4 + l, y * 4 + t)])
                c[0] += 1
        total = small.width * small.height
        top = sorted(counts.items(), key=lambda kv: -kv[1][0])[:10]
        return {
            'window': list(rect), 'size': [r - l, b - t],
            'colors': [{'rgb': list(k), 'share': round(v[0] / total, 3), 'sampleAt': list(v[1])} for k, v in top],
            'hint': '占比最大的多半是背景；蛇身 / 食物是占比小但集中的颜色。棋盘 region 用窗口矩形减掉标题栏 / 记分栏，再用 grid 核对',
        }
    if op == 'grid':
        pid = int(args.get('pid') or 0)
        _rect_of(pid)
        see = See(args['see'])
        grid = see.grab()
        return {
            'rows': len(grid), 'cols': len(grid[0]),
            'text': '\n'.join(''.join(r) for r in grid),
            'counts': {LABEL[k]: len(_cells(grid, LABEL[k])) for k in see.colors},
            'hint': 'H 蛇头 B 蛇身 F 食物 W 墙 . 空。蛇身只有一两格、食物恰好一格、没有大片误判，参数就对了',
        }
    if op == 'start':
        with _lock:
            for r in _runs.values():
                if r.state['running']:
                    r.stop_flag = True
        rx = Reflex(args)
        with _lock:
            _runs[rx.id] = rx
            for k in list(_runs)[:-5]:
                del _runs[k]
        rx.start()
        time.sleep(0.4)
        return {'ok': True, 'id': rx.id, 'state': rx.state}
    if op == 'state':
        rx = _runs.get(str(args.get('id', ''))) or _current()
        if not rx:
            return {'running': False, 'error': '没有跑过反射回路'}
        rx.state['elapsedSec'] = round(time.time() - rx.state['startedAt'], 1)
        return rx.state
    if op == 'stop':
        rx = _runs.get(str(args.get('id', ''))) or _current()
        if not rx:
            return {'ok': True, 'stopped': False}
        rx.stop_flag = True
        rx.join(timeout=2)
        return {'ok': True, 'stopped': True, 'state': rx.state}
    raise ValueError(f'未知 op: {op}（probe / grid / start / state / stop）')


def shutdown():
    with _lock:
        for r in _runs.values():
            r.stop_flag = True
