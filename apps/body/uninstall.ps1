<#
  停掉并删除身体服务的任务计划；-Purge 连 .venv 和 data/（浏览器资料、日志）一起删。
#>
param(
  [string]$TaskName = 'mumu-body',
  [switch]$Purge
)
$dir = $PSScriptRoot
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
# 任务停了 pythonw 有时还挂着（Playwright 起的 Edge 子进程拖着），按命令行精确找本目录的那个
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
  Where-Object { $_.CommandLine -like "*$dir\server.py*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if ($Purge) {
  Remove-Item -Recurse -Force (Join-Path $dir '.venv'), (Join-Path $dir 'data') -ErrorAction SilentlyContinue
}
"已移除任务 $TaskName"
