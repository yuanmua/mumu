<#
  在她的电脑上把桌宠设成登录后自动出现：任务计划「mumu-desktop」，在她的桌面会话里起 Electron。
  桌宠自成一个目录（默认 C:\Users\me\mumu-desktop，和身体服务 mumu-body 并列），只连后端网页，
  不依赖后端仓库放在哪。前提：本目录里已有 node_modules\electron\dist\electron.exe（见 README）。

  参数：
    -Url http://127.0.0.1:3939/   桌宠加载的网页（后端就在本机时用默认）
    -NoLogonTrigger               只注册不带「登录时」触发器（试用）
  不碰 UAC、自动登录、锁屏或任何安全设置。
#>
param(
  [string]$Url = 'http://127.0.0.1:3939/',
  [switch]$NoLogonTrigger,
  [string]$TaskName = 'mumu-desktop'
)
$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
# 独立安装时在本目录；若是放在仓库里跑，npm workspaces 会把 electron 提升到仓库根
$exe = @("$appDir\node_modules\electron\dist\electron.exe", "$(Split-Path (Split-Path $appDir))\node_modules\electron\dist\electron.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw '没找到 electron.exe：按 README 先在本目录装 Electron' }

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $exe -Argument "`"$appDir`" --url=$Url" -WorkingDirectory $appDir
# Interactive：只在她登录后、在她的桌面上跑——桌宠要画在她的屏幕上
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$params = @{ TaskName = $TaskName; Action = $action; Principal = $principal; Settings = $settings; Force = $true
  Description = '沐沐桌宠（apps/desktop）' }
if (-not $NoLogonTrigger) { $params.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $user }
Register-ScheduledTask @params -ErrorAction Stop | Out-Null

Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
$running = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
if ($running) { "桌宠已起（$($running.Count) 个进程）" } else { "任务已注册但没看到 electron 进程；她没登录桌面时不会跑（Interactive）" }
