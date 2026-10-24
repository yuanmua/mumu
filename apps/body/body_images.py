"""
网页上的图：列出当前页的图片（images）、把一张图直接下载到她电脑上（download）。

为什么不靠右键「图片另存为」：谷歌 / 必应图片的网格是画出来的，控件树里没有图片元素，右键菜单也拿不到，
她两次任务 40 步都耗在点缩略图上，一张没存下（2026-10-22 实测）。页面里的 <img> 用 JS 一口气能列全，
下载用浏览器上下文自带的 request（带着页面的 cookie 与 Referer），比模拟右键稳得多。

- images：按显示面积从大到小，带 src（data: 缩略图只给大小不给内容）、显示尺寸、原始尺寸、alt、
  以及能从搜索结果链接里解出来的原图地址 full（必应 a[m].murl、谷歌 /imgres?imgurl=）。列表留在 state 里，download 按 index 取。
- download：index（上次 images 的编号，优先原图 full、不行退回 src）/ url / selector 三选一；dir 默认她的「图片」文件夹；
  不覆盖同名文件；非图片内容默认拒绝（any:true 才收）。回路径、字节数、类型、宽高。
"""
import base64
import io
import os
import re
import time
from urllib.parse import unquote, urlsplit

MAX_LIST = 40
MAX_BYTES = 50 * 1024 * 1024
EXT_BY_TYPE = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
               'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/avif': '.avif', 'image/x-icon': '.ico'}
MAGIC = ((b'\xff\xd8\xff', 'image/jpeg'), (b'\x89PNG', 'image/png'), (b'GIF8', 'image/gif'), (b'BM', 'image/bmp'))

LIST_JS = """() => {
  const abs = u => { try { return new URL(u, location.href).href } catch { return u } }
  const full = a => {
    if (!a) return ''
    const m = a.getAttribute('m')
    if (m) { try { const j = JSON.parse(m); if (j.murl) return j.murl } catch {} }
    const h = a.getAttribute('href') || ''
    const q = h.match(/[?&]imgurl=([^&]+)/)
    if (q) { try { return decodeURIComponent(q[1]) } catch { return q[1] } }
    return ''
  }
  const out = []
  Array.from(document.images).forEach((e, i) => {
    const r = e.getBoundingClientRect()
    if (r.width < 24 || r.height < 24) return
    const src = e.currentSrc || e.src || ''
    if (!src) return
    const a = e.closest('a')
    const f = full(a)
    out.push({ index: i, src, width: Math.round(r.width), height: Math.round(r.height),
      natural: [e.naturalWidth, e.naturalHeight], alt: (e.alt || e.title || '').slice(0, 80),
      full: f, link: (!f && a) ? abs(a.getAttribute('href') || '') : '' })
  })
  return out
}"""


def images(p, args: dict, state: dict) -> dict:
    """列当前页的图，按显示面积从大到小；data: 缩略图只报大小，不把几十 KB 的 base64 塞给模型"""
    limit = min(max(int(args.get('limit', MAX_LIST)), 1), 200)
    items = p.evaluate(LIST_JS)
    items.sort(key=lambda it: it['width'] * it['height'], reverse=True)
    state['images'] = {it['index']: it for it in items}
    shown = []
    for it in items[:limit]:
        row = dict(it)
        if row['src'].startswith('data:'):
            row['src'] = f'data:缩略图（约 {len(row["src"]) * 3 // 4 // 1024} KB，用 index 下载）'
        shown.append({k: v for k, v in row.items() if v not in ('', [0, 0])})
    return {'ok': True, 'url': p.url, 'count': len(items), 'images': shown,
            'hint': '下载：{"op":"download","index":编号}（有 full 原图就下原图，不行退回缩略图）或 {"op":"download","url":"…"}；dir 不给就存到她的「图片」文件夹'}


def download(p, args: dict, state: dict, timeout: int) -> dict:
    candidates, label = _candidates(p, args, state)
    folder = _folder(args)
    tried = []
    for u in candidates:
        try:
            data, ctype = _fetch(p, u, timeout, bool(args.get('any')))
            break
        except ValueError as e:
            tried.append(f'{u[:100]}: {e}')
    else:
        raise ValueError('没下成：' + '；'.join(tried))
    path = _unique(os.path.join(folder, _filename(args.get('name'), u, ctype)))
    with open(path, 'wb') as f:
        f.write(data)
    out = {'ok': True, 'path': path, 'bytes': len(data), 'contentType': ctype, 'from': label(u)}
    out.update(_dimensions(data))
    if tried:
        out['note'] = '原图没下成，退回缩略图：' + '；'.join(tried)
    return out


def _candidates(p, args: dict, state: dict):
    """按 index / selector / url 决定去哪儿取；index 的原图不行再退回缩略图"""
    if args.get('index') is not None:
        it = (state.get('images') or {}).get(int(args['index']))
        if not it:
            raise ValueError(f'没有编号 {args["index"]} 的图：先 {{"op":"images"}} 列一遍（换页后编号会变）')
        urls = [u for u in (it.get('full'), it.get('src')) if u]
        if args.get('thumb'):
            urls = [it['src']]
        return urls, (lambda u: '原图' if u == it.get('full') else '页面上的图')
    if args.get('selector'):
        src = p.locator(str(args['selector'])).first.evaluate('e => e.currentSrc || e.src || e.getAttribute("href") || ""')
        if not src:
            raise ValueError(f'选择器 {args["selector"]} 对应的元素没有 src / href')
        return [src], (lambda _u: f'selector {args["selector"]}')
    url = str(args.get('url', '')).strip()
    if url:
        return [url], (lambda u: u[:200])
    raise ValueError('download 需要 index（images 的编号）、url 或 selector 之一')


def _fetch(p, u: str, timeout: int, any_type: bool) -> tuple[bytes, str]:
    if u.startswith('data:'):
        head, _, body = u.partition(',')
        ctype = head[5:].split(';')[0] or 'application/octet-stream'
        data = base64.b64decode(body) if ';base64' in head else unquote(body).encode('utf-8')
    else:
        # 上下文自带的 request 带着页面的 cookie；Referer 给当前页，防盗链的站点才肯给
        resp = p.context.request.get(u, headers={'Referer': p.url}, timeout=timeout, max_redirects=5)
        if not resp.ok:
            raise ValueError(f'HTTP {resp.status}')
        ctype = resp.headers.get('content-type', '').split(';')[0].strip().lower()
        data = resp.body()
    if len(data) > MAX_BYTES:
        raise ValueError(f'太大了（{len(data) // 1024 // 1024} MB，上限 {MAX_BYTES // 1024 // 1024} MB）')
    if not ctype.startswith('image/'):
        sniffed = next((t for magic, t in MAGIC if data.startswith(magic)), None)
        if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
            sniffed = 'image/webp'
        if sniffed:
            ctype = sniffed
        elif not any_type:
            raise ValueError(f'不是图片（{ctype or "类型不明"}，{len(data)} 字节）；真要存加 "any":true')
    return data, ctype


def _folder(args: dict) -> str:
    folder = str(args.get('dir', '')).strip() or pictures_dir()
    folder = os.path.abspath(os.path.expanduser(os.path.expandvars(folder)))
    low = folder.lower()
    for bad in (os.environ.get('SystemRoot', ''), os.environ.get('ProgramFiles', ''), os.environ.get('ProgramFiles(x86)', '')):
        if bad and low.startswith(bad.lower()):
            raise ValueError(f'不往系统目录里存图：{folder}')
    os.makedirs(folder, exist_ok=True)
    return folder


def pictures_dir() -> str:
    """她的「图片」文件夹：Windows 问壳层（可能被 OneDrive 挪到 OneDrive\\Pictures），其他系统 ~/Pictures"""
    if os.name == 'nt':
        try:
            import ctypes
            from ctypes import wintypes
            guid = (ctypes.c_byte * 16)(*bytes.fromhex('30 81 E2 33 BE 44 C6 4C 9D D2 55 D7 12 9D C0 D4'.replace(' ', '')))  # FOLDERID_Pictures
            out = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(guid, 0, None, ctypes.byref(out)) == 0:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                if path:
                    return path
        except Exception:  # 问不到就按默认位置：只影响默认目录
            pass
    return os.path.join(os.path.expanduser('~'), 'Pictures')


def _filename(name, u: str, ctype: str) -> str:
    ext = EXT_BY_TYPE.get(ctype, '')
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(name or '')).strip().strip('.')
    if not base and not u.startswith('data:'):
        base = unquote(os.path.basename(urlsplit(u).path))
        base = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', base).strip('.')
        if base.lower().endswith(tuple(EXT_BY_TYPE.values())) and ext and not base.lower().endswith(ext):
            base = os.path.splitext(base)[0]  # 链接上的扩展名和实际类型不符：按实际类型来
    if not base or '.' not in base:
        base = (base or f'image-{time.strftime("%Y%m%d-%H%M%S")}') + ext
    elif ext and not base.lower().endswith(ext) and os.path.splitext(base)[1].lower() not in EXT_BY_TYPE.values():
        base += ext
    return base[:120]


def _unique(path: str) -> str:
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    for n in range(2, 1000):
        cand = f'{stem}-{n}{ext}'
        if not os.path.exists(cand):
            return cand
    raise ValueError(f'同名文件太多了：{path}')


def _dimensions(data: bytes) -> dict:
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            return {'width': im.width, 'height': im.height}
    except Exception:  # SVG / 坏图读不出尺寸：少两个字段，不影响文件已存好
        return {}
