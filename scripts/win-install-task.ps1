# 把沐沐注册成登录时自动运行的任务（以当前登录用户身份、普通权限），并立刻启动。重复运行结果一样。
#   powershell -ExecutionPolicy Bypass -File C:\mumu\scripts\win-install-task.ps1
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\mumu\scripts\win-start.ps1'
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'Mumu' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Mumu'
"任务 Mumu 已注册并启动：" + (Get-ScheduledTask -TaskName Mumu).State
