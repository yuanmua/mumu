"""
命令与程序：PowerShell 子进程（L0）+ 启动 / 关闭 / 列出程序。

- 脚本走 -EncodedCommand（UTF-16LE base64）：任意引号、换行、中文路径都不用转义，
  这是 PowerShell 官方给程序化调用的入口。
- 输出强制 UTF-8：Windows PowerShell 5.1 默认按系统代码页（中文系统是 GBK）输出，不改会乱码。
- 子进程跑在本服务所在的登录会话里，所以 Start-Process notepad 会出现在她的桌面上。
"""
import base64
import contextlib
import os
import subprocess
import tempfile
import xml.etree.ElementTree as ET

import body_ui

import re

CREATE_NO_WINDOW = 0x08000000
MAX_OUTPUT = 20000

# 护栏（不是沙箱）：本服务以她的账户、可能是管理员级别在跑，而决定做什么的是模型。
# 系统关键进程与本机的「身体」（本服务、沐沐后端）一律不许关；exec 里会把机器弄死 / 改安全设置的命令直接拒绝。
# 真正的权限边界在 Windows 账户上，这里只挡「模型一时糊涂」。
PROTECTED_PROCESSES = {
    'system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'dwm',
    'fontdrvhost', 'sihost', 'taskhostw', 'ctfmon', 'explorer', 'runtimebroker', 'searchhost',
    'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'audiodg', 'spoolsv', 'wudfhost',
    'msmpeng', 'securityhealthservice', 'conhost', 'memcompression', 'lsaiso', 'dllhost',
    'python', 'pythonw', 'node', 'sshd',  # 身体服务自己、沐沐后端、SSH：关了她就没法动了
}
DENY_EXEC = [
    (r'\b(shutdown|Restart-Computer|Stop-Computer|logoff|bcdedit|bootrec|diskpart|format\s+[a-z]:|vssadmin\s+delete)\b', '关机 / 重启 / 改引导 / 格式化'),
    (r'\b(net\s+user|net\s+localgroup|Add-LocalGroupMember|Set-LocalUser|New-LocalUser|Remove-LocalUser|Enable-LocalUser|Disable-LocalUser)\b', '改账户'),
    (r'\b(Set-MpPreference|netsh\s+advfirewall|Set-NetFirewall\w*|Disable-WindowsOptionalFeature)\b', '改安全 / 防火墙设置'),
    (r'\b(reg\s+(add|delete)|Set-ItemProperty|Remove-ItemProperty|New-ItemProperty)\b[^\n]*\b(HKLM|HKEY_LOCAL_MACHINE|HKCU:?\\?\\?Software\\Microsoft\\Windows\\CurrentVersion\\Policies)', '改系统 / 策略注册表'),
    (r'\b(Remove-Item|rm|del|rmdir|rd)\b[^\n]*\b(C:\\Windows|\$env:SystemRoot|\$env:windir|C:\\Users\\[^\\\s]+\\?\s|C:\\\s)', '删系统目录 / 整个用户目录'),
    (r'\b(wmic\s+\S*\s*(process|os|useraccount)\b)', 'wmic 操作进程 / 系统 / 账户'),
]


def exec_denied(command: str) -> str | None:
    """返回拒绝原因；None = 放行。杀进程类命令只在点名了受保护进程时拒绝"""
    for pat, why in DENY_EXEC:
        if re.search(pat, command, re.IGNORECASE):
            return why
    if re.search(r'\b(Stop-Process|taskkill|kill|Stop-Service|sc\s+stop|Set-Service|Suspend-Process)\b', command, re.IGNORECASE):
        for name in PROTECTED_PROCESSES:
            if re.search(rf'\b{re.escape(name)}(\.exe)?\b', command, re.IGNORECASE):
                return f'动系统关键进程 / 她自己的身体（{name}）'
        if re.search(r'Get-Process\s*\|', command, re.IGNORECASE) or re.search(r'taskkill\s+[^\n]*/(im|pid)\s+\*', command, re.IGNORECASE):
            return '批量杀进程'
    return None

PRELUDE = (
    "$ProgressPreference='SilentlyContinue';"
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
    "$OutputEncoding=[Console]::OutputEncoding;"
)


KILL_WAIT_SEC = 5  # 杀进程树之后最多再等几秒


def ps_argv(script: str) -> list[str]:
    encoded = base64.b64encode((PRELUDE + script).encode('utf-16-le')).decode('ascii')
    return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]


def kill_tree(pid: int):
    """连同它起的子进程一起杀：只杀 powershell 本身会留下孤儿（被 UAC 卡住的安装器之类）"""
    try:
        subprocess.run(['taskkill', '/T', '/F', '/PID', str(pid)], capture_output=True,
                       creationflags=CREATE_NO_WINDOW, timeout=KILL_WAIT_SEC * 2)
    except subprocess.TimeoutExpired:  # taskkill 自己卡住：下面还有 proc.kill() 兜底
        pass


def run_ps(script: str, timeout: float = 60, cwd: str | None = None) -> dict:
    # 输出落临时文件而不是管道：起的程序继承了管道句柄的话，管道要等它们全退出才到头，
    # 超时杀掉 powershell 后 communicate() 还会一直干等（硬上限形同虚设）；文件随时能读
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        # 默认在她的主目录里跑：否则起的程序（记事本的「另存为」等）默认落在本服务的安装目录
        proc = subprocess.Popen(
            ps_argv(script), stdout=out, stderr=err, stdin=subprocess.DEVNULL,
            cwd=cwd or os.path.expanduser('~'), creationflags=CREATE_NO_WINDOW,
        )
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_tree(proc.pid)
            try:
                proc.wait(timeout=KILL_WAIT_SEC)
            except subprocess.TimeoutExpired:
                proc.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):  # 还不退就不等了：结果里 exitCode 为 null
                    proc.wait(timeout=KILL_WAIT_SEC)
        out.seek(0)
        err.seek(0)
        stdout, stderr = out.read(), err.read()
    result = {
        'exitCode': proc.returncode,
        'timedOut': timed_out,
        'stdout': clip(stdout.decode('utf-8', errors='replace')),
        'stderr': clip(decode_clixml(stderr.decode('utf-8', errors='replace'))),
    }
    if timed_out:
        result['note'] = f'{round(timeout)} 秒到了还没结束，已连同它起的子进程一起结束（多半在等界面上的提示 / 输入）'
    return result


def decode_clixml(s: str) -> str:
    """stderr 被重定向时 PowerShell 把错误流写成 CLIXML；还原成人读的文字（verbose / warning 一并保留）"""
    head = '#< CLIXML'
    if not s.lstrip().startswith(head):
        return s
    try:
        root = ET.fromstring(s.lstrip()[len(head):].strip())
    except ET.ParseError:  # 不是完整 XML（被截断等）：原样返回，至少信息还在
        return s
    lines = []
    for el in root.iter():
        if el.tag.endswith('}S') and el.text:
            kind = el.get('S', '')
            text = el.text.replace('_x000D__x000A_', '\n').replace('_x000A_', '\n')
            lines.append(text if kind == 'Error' else f'[{kind}] {text}')
    return ''.join(lines)


def clip(s: str) -> str:
    s = s.strip()
    return s if len(s) <= MAX_OUTPUT else s[:MAX_OUTPUT] + f'\n…（截断，共 {len(s)} 字）'


def ps_quote(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def exec_powershell(args: dict) -> dict:
    command = str(args.get('command', '')).strip()
    if not command:
        raise ValueError('缺 command')
    timeout = min(max(float(args.get('timeoutSec', 60)), 1), 600)
    why = exec_denied(command)
    if why:
        raise ValueError(f'这条命令不让跑（{why}）：这类事由主人自己在电脑上做，换别的办法或结束并说明')
    return run_ps(command, timeout, args.get('cwd'))


def apps(args: dict) -> dict:
    op = args.get('op', 'list')
    if op == 'list':
        r = run_ps(
            "Get-Process | Where-Object { $_.MainWindowTitle } | "
            "Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress",
            timeout=20,
        )
        return {'windows': r['stdout'] or '[]', 'stderr': r['stderr']}
    if op == 'start':
        # Start-Process 能解析「App Paths」里的名字（notepad / msedge）、完整路径和 URI（ms-settings:display）
        target = str(args.get('name') or args.get('path') or args.get('uri') or '').strip()
        if not target:
            raise ValueError('start 需要 name / path / uri')
        argv = args.get('args')
        arg_part = ''
        if isinstance(argv, list) and argv:
            arg_part = ' -ArgumentList ' + ','.join(ps_quote(a) for a in argv)
        elif isinstance(argv, str) and argv.strip():
            arg_part = ' -ArgumentList ' + ps_quote(argv)
        # URI（ms-settings:display、https://…）交给协议处理程序，没有进程对象可返回，配 -PassThru 会报错
        scheme = target.split(':', 1)[0]
        is_uri = ':' in target and len(scheme) > 1 and scheme.replace('-', '').replace('+', '').replace('.', '').isalnum()
        passthru = '' if is_uri else ' -PassThru'
        r = run_ps(f"$p = Start-Process -FilePath {ps_quote(target)}{arg_part}{passthru}; if ($p) {{ $p.Id }}", timeout=30)
        if r['exitCode'] != 0:
            return {'ok': False, **r}
        pid = r['stdout'].strip()
        if pid.isdigit():
            body_ui.started_pids.add(int(pid))  # 同名窗口好几个时优先这次起的；后续 /key /type /ui/* 都可直接用这个 pid
        return {'ok': True, 'pid': pid or None, 'hint': '之后用 "pid" 指定这个程序的窗口最稳；同名旧窗口先 apps close pid 关掉' if pid else None}
    if op == 'close':
        name = str(args.get('name', '')).strip()
        pid = int(args.get('pid') or 0)  # windows 列表里的 pid：同名进程开了好几个（三个卡住的贪吃蛇）时只关那一个
        if not name and not pid:
            raise ValueError('close 需要 name（进程名，如 notepad）或 pid')
        name = name[:-4] if name.lower().endswith('.exe') else name
        if '*' in name or '?' in name:
            raise ValueError('close 不收通配符')
        # python / pythonw 既是她的身体也是她自己开的程序（tkinter 游戏）：按名字关时把身体服务本身和它的启动器排除，其余照关
        own = {os.getpid(), os.getppid()}
        if name.lower() in PROTECTED_PROCESSES - {'python', 'pythonw'}:
            raise ValueError(f'不关 {name}：系统关键进程、她自己的身体，一律不关')
        if pid in own:
            raise ValueError('不关：那是她自己的身体服务')
        # 只碰她自己会话里的进程（SessionId 相同）：服务会话 / 其他用户的同名进程不动
        own_list = ','.join(str(p) for p in own)
        if pid:
            # 按 pid 关也要过一遍名字黑名单：pid 是她从 windows 列表里看来的，可能指到系统进程
            mine = (f"Get-Process -Id {pid} -ErrorAction SilentlyContinue | Where-Object {{ $_.SessionId -eq (Get-Process -Id $PID).SessionId"
                    f" -and ($_.ProcessName.ToLower() -notin @({','.join(ps_quote(n) for n in sorted(PROTECTED_PROCESSES - {'python', 'pythonw'}))})) }}")
        else:
            mine = (f"Get-Process -Name {ps_quote(name)} -ErrorAction SilentlyContinue | Where-Object {{ $_.SessionId -eq (Get-Process -Id $PID).SessionId"
                    f" -and ($_.Id -notin @({own_list})) }}")
        # 默认温和关闭（相当于点右上角 ×，程序有机会提示保存）；force 才强杀
        if args.get('force'):
            script = f"{mine} | Stop-Process -Force -PassThru | Measure-Object | % Count"
        else:
            script = f"{mine} | % {{ [void]$_.CloseMainWindow() }}; ({mine} | Measure-Object).Count"
        r = run_ps(script, timeout=20)
        return {'ok': r['exitCode'] == 0, **r}
    raise ValueError(f'未知 op: {op}（list / start / close）')
