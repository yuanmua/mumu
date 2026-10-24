/**
 * DSH 的保底护栏：它每调一个工具，先看这一步碰没碰「不该碰的」，碰了就立刻停掉整次任务，回报「需要主人确认」。
 *
 * 立场：
 * - 第一道防线是 DSH 自己的沙箱（`DSH_PERMISSION_MODE`，默认 workspace-write：受限令牌 + Low 完整性，只能写工作区与临时目录）；
 *   第二道是交给它的约定（preamble 里写明不许做什么）；这里是第三道——事后拦截。tool_call 事件先于执行到达，
 *   但停进程有延迟，所以只能「尽量拦住、拦不住也立刻停」，不是硬保证。
 * - 这是一张黑名单，不是白名单：DSH 是写代码的助手，正常活要跑的命令千变万化，白名单会把正常活全挡掉。
 *   名单只收「她的工程活不需要、碰了就可能伤系统」的几类：系统关键进程、WMI 起停进程、计划任务 / 服务 / 注册表 HKLM /
 *   防火墙 / 杀软 / 账户 / 启动项、关机重启、直接调 Win32 API。
 * - 用正则匹配的是要执行的命令文本（安全检查），不是从模型输出里抠结构（handbook §9.2 说的是后者）。
 * - 2026-10-21 实测：一次贪吃蛇任务里它为了让窗口活下来，接连试了 Add-Type 调 user32、Invoke-CimMethod Win32_Process、
 *   schtasks，又在沙箱里两次 Start-Process explorer.exe（同一秒系统日志两次 explorer 0xc0000142）、反复 System.Drawing 截屏，
 *   随后虚拟机蓝屏（0xEF，csrss.exe）。所以第一条规则就是：DSH 不开窗口、不截屏——那是 computer 的活。
 */

export interface Verdict { why: string, hit: string }

const RULES: { why: string, re: RegExp }[] = [
  // 2026-10-21 蓝屏的直接前因：它在沙箱里两次 Start-Process explorer.exe（23:23:43 / 23:24:03），系统日志同一秒两次
  // 「explorer.exe 无法正常启动 0xc0000142」，随后反复 System.Drawing 截屏，csrss 死、0xEF。开窗口、看屏幕一律交给 computer
  { why: '起图形程序 / 窗口（这是 computer 的活）', re: /\b(Start-Process|Invoke-Item|explorer(\.exe)?|pythonw(\.exe)?|mshta|rundll32|WScript\.Shell|Shell\.Application)\b|\bcmd(\.exe)?\s+\/c\s+"?start\b|\bii\s+["'\w]|\.(pyw|lnk)\b/i },
  { why: '用 .NET 图形库 / 截屏（截图交给 computer）', re: /\b(System\.Windows\.Forms|System\.Drawing|PresentationFramework|CopyFromScreen)\b/i },
  { why: '绕过 computer 直接调身体服务', re: /\b(127\.0\.0\.1|localhost):8765\b/i },
  { why: '碰系统关键进程', re: /\b(csrss|wininit|winlogon|lsass|smss|services|svchost|dwm|fontdrvhost|sihost)(\.exe)?\b/i },
  { why: '用 WMI / CIM 起停进程或改系统', re: /\b(Invoke-CimMethod|Invoke-WmiMethod|wmic(\.exe)?)\b/i },
  { why: '直接调 Win32 API', re: /\[DllImport|Add-Type\b[\s\S]*\b(user32|kernel32|ntdll|advapi32)\b/i },
  { why: '计划任务 / 服务 / 启动项', re: /\b(schtasks(\.exe)?\s+\/(create|change|delete|run)|Register-ScheduledTask|Set-ScheduledTask|New-Service|Set-Service|Stop-Service|Remove-Service|sc(\.exe)?\s+(config|stop|delete|create))\b|CurrentVersion\\Run\b/i },
  { why: '改系统注册表', re: /\b(HKLM|HKEY_LOCAL_MACHINE)\b|\breg(\.exe)?\s+(add|delete|import)\b/i },
  { why: '改防火墙 / 杀软 / 网络设置', re: /\b(netsh|Set-NetFirewall\w*|New-NetFirewallRule|Set-MpPreference|Add-MpPreference|Set-NetIPAddress|Set-DnsClient\w*)\b/i },
  { why: '改账户 / 权限 / 执行策略', re: /\b(net\s+(user|localgroup)|New-LocalUser|Add-LocalGroupMember|Set-ExecutionPolicy|takeown|icacls)\b|-Verb\s+RunAs\b/i },
  { why: '关机 / 重启 / 改启动配置', re: /\b(shutdown(\.exe)?\s|Restart-Computer|Stop-Computer|bcdedit|diskpart|format(\.com)?\s+[a-z]:)/i },
  { why: '删系统目录', re: /\b(Remove-Item|rm|del|rd|rmdir)\b[^\n]*\b[A-Z]:\\(Windows|Program Files|ProgramData)\b/i },
]

const SYSTEM_PATH = /\b[A-Z]:\\(Windows|Program Files( \(x86\))?|ProgramData)\\/i

/**
 * 跑命令的工具（pwsh / bash / 后台任务）查全部参数；写文件、读文件这类只查路径——
 * 代码文件里出现 services、HKLM 之类的词很正常，查内容会误报
 */
export function inspect(tool: string, input: unknown): Verdict | undefined {
  if (!/pwsh|powershell|bash|shell|cmd|exec|job|task/i.test(tool)) {
    const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const path = [o.file_path, o.path, o.target].filter(x => typeof x === 'string').join('\n')
    const m = SYSTEM_PATH.exec(path)
    return m && /write|edit|patch|move|delete|remove/i.test(tool) ? { why: '往系统目录里写', hit: m[0] } : undefined
  }
  const text = strings(input).join('\n')
  for (const r of RULES) {
    const m = r.re.exec(text)
    if (m)
      return { why: r.why, hit: m[0].slice(0, 60) }
  }
  return undefined
}

function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6)
    return out
  if (typeof v === 'string')
    out.push(v)
  else if (Array.isArray(v))
    v.forEach(x => strings(x, out, depth + 1))
  else if (v && typeof v === 'object')
    Object.values(v).forEach(x => strings(x, out, depth + 1))
  return out
}
