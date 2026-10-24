<#
  安装 / 启动沐沐的身体服务。在她的 Windows 上、以她的账户运行（SSH 进去跑即可）。

  做的事：
    1. 在本目录建 .venv，装 requirements.txt
    2. 注册任务计划「mumu-body」：她登录时在她的桌面会话里起 pythonw server.py，崩了自动重启
    3. 立即启动一次

  不做的事：不碰 UAC、自动登录、锁屏、防火墙、任何账户或系统安全设置。

  参数：
    -Proxy http://127.0.0.1:7897   pip 走代理
    -IndexUrl https://pypi.tuna.tsinghua.edu.cn/simple   pip 镜像（连不上 pypi.org 时）
    -Python C:\…\python.exe        指定解释器；不给则找 py 启动器或按用户安装的 Python
    -NoLogonTrigger                只注册不带「登录时」触发器的任务并启动一次（测试机用，测完跑 uninstall.ps1）
    -TaskName mumu-body            任务名
    -Port 8765
#>
param(
  [string]$Proxy = '',
  [string]$IndexUrl = '',
  [string]$Python = '',
  [switch]$NoLogonTrigger,
  [string]$TaskName = 'mumu-body',
  [int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$venv = Join-Path $dir '.venv'

if (-not (Test-Path "$venv\Scripts\python.exe")) {
  if (-not $Python) {
    # WindowsApps 里的 python.exe 是商店占位符，不是解释器，跳过它
    $found = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { $Python = $found.FullName }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { $Python = (& py -3 -c 'import sys; print(sys.executable)') }
    else { throw '找不到 Python 3：先按用户安装一个（README 有命令），或用 -Python 指定' }
  }
  & $Python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "建 venv 失败：$Python" }
}
$pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', (Join-Path $dir 'requirements.txt'))
if ($Proxy) { $pipArgs += @('--proxy', $Proxy) }
if ($IndexUrl) { $pipArgs += @('-i', $IndexUrl) }
& "$venv\Scripts\python.exe" @pipArgs
if ($LASTEXITCODE -ne 0) { throw 'pip 安装失败' }

# SSH 会话里 $env:USERDOMAIN 可能不是本机名，账户映射会失败（0x80070534）；用当前令牌的账户名
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$venv\Scripts\pythonw.exe" -Argument "`"$dir\server.py`" --port $Port" -WorkingDirectory $dir
# Interactive：只在她已登录时、在她的桌面会话里跑——UIA 和键鼠必须在有桌面的会话里
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$params = @{ TaskName = $TaskName; Action = $action; Principal = $principal; Settings = $settings; Force = $true
  Description = '沐沐的身体服务（apps/body）：本机 HTTP 127.0.0.1:' + $Port }
if (-not $NoLogonTrigger) { $params.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $user }
Register-ScheduledTask @params -ErrorAction Stop | Out-Null

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
# 首次启动要导入 uiautomation / comtypes 生成 COM 包装，慢的机器要十几秒
$h = $null
foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3; break } catch { continue }  # 还没起来：再等
}
if ($h) { "身体服务已起：用户 $($h.user)，session $($h.sessionId)，interactive=$($h.interactive)" }
else { "任务已注册但 /health 没响应：看 $dir\data\body.log。她没登录桌面时任务不会跑（Interactive）。" }
