import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspect } from './guard.ts'

test('碰系统的命令拦下：2026-10-21 贪吃蛇任务里实际出现过的几步', () => {
  const blocked = [
    { command: 'Add-Type @\' using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); } \'@' },
    { command: '$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }' },
    { command: 'schtasks /Create /TN snake /TR $tr /SC ONCE /ST 23:27' },
    { command: 'Get-Process csrss | Select-Object Id' },
    { command: 'Set-ItemProperty -Path HKLM:\\Software\\X -Name a -Value 1' },
    { command: 'Restart-Computer -Force' },
    { command: 'Start-Process pwsh -Verb RunAs' },
    // 蓝屏前一两分钟里实际跑过的：沙箱里拉 explorer、pythonw 起窗口、System.Drawing 截屏
    { command: 'Start-Process explorer.exe -ArgumentList \'"C:\\Users\\me\\Desktop\\snake\\run_game.bat"\'' },
    { command: '$p = Start-Process -FilePath $pyw -ArgumentList \'"C:\\Users\\me\\Desktop\\snake\\snake_game.py"\' -PassThru' },
    { command: '$bmp = New-Object System.Drawing.Bitmap($w, $h); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)' },
    { command: '$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut("$dir\\贪吃蛇.lnk")' },
    { command: 'cmd /c start "" snake.html' },
    { command: 'Invoke-RestMethod http://127.0.0.1:8765/screenshot' },
  ]
  for (const input of blocked)
    assert.ok(inspect('pwsh', input), `应拦下：${input.command}`)
})

test('正常的工程活不误拦', () => {
  const ok = [
    { command: '& "$env:LOCALAPPDATA\\Programs\\Python\\Python312\\python.exe" snake_game.py --self-test', description: '自测贪吃蛇逻辑' },
    { command: 'Get-ChildItem -Force; Get-Command python' },
    { command: 'npm install && npm test' },
    { command: 'Get-Service | Where-Object Status -eq Running' }, // 只读查看服务不拦
  ]
  for (const input of ok)
    assert.equal(inspect('pwsh', input), undefined, `不该拦：${input.command}`)
  // 写代码文件：内容里出现 services / HKLM 很正常，只看路径
  assert.equal(inspect('write', { file_path: 'C:\\Users\\me\\Desktop\\snake\\a.py', content: 'services = []  # HKLM csrss' }), undefined)
  assert.ok(inspect('write', { file_path: 'C:\\Windows\\System32\\x.dll', content: '' }))
})
