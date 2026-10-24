# 在她的电脑上起沐沐并守着：任务计划程序「Mumu」登录时运行本脚本。崩了 5 秒后拉起，日志在 data\logs。
# 手动起：powershell -ExecutionPolicy Bypass -File C:\mumu\scripts\win-start.ps1
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location C:\mumu
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:PATH"
$log = 'C:\mumu\data\logs'
New-Item -ItemType Directory -Force -Path $log | Out-Null
while ($true) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  & npm.cmd start *>> "$log\mumu-$stamp.log"
  Start-Sleep 5
}
