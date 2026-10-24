/**
 * 送看图模型之前把图缩小：网关会把请求整条落日志（I1），几 MB 的动图原样塞进去，日志撑大、本地模型也慢。
 *
 * - macOS：系统自带 sips，缩到长边 side 的 JPEG（动图只取第一帧）。
 * - Windows（她的虚拟机）：系统自带 PowerShell + System.Drawing。动图抽 frames 帧、按时间从左到右拼成一张，
 *   模型看得到「动起来」的过程；实测虚拟机上 77/78 张没描述的图都是因为没有缩图、超过上限被跳过。
 *   PowerShell 每起一次要 2～3 秒（大半花在加载 System.Drawing），所以常驻一个、按行接活，挂了下次再起。
 * - 别的平台 / 认不出的格式（个别 webp、坏文件）：原样返回，交给调用方的大小上限把关。
 * 零依赖：都是系统自带的工具；脚本只写 ASCII（PowerShell 5 按 ANSI 读，中文会坏）。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Img { bytes: Buffer, mime: string }
export interface View extends Img { frames: number } // frames > 1 = 几帧拼在一起的动图

/** 每行一个活：in|out|side|frames|quality → 回 ok|帧数 或 err|原因 */
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $a = $line.Split('|')
  try {
    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$a[4])
    $img = [System.Drawing.Image]::FromFile($a[0])
    try {
      $dim = New-Object System.Drawing.Imaging.FrameDimension $img.FrameDimensionsList[0]
      $count = $img.GetFrameCount($dim)
      $want = [Math]::Max(1, [Math]::Min([int]$a[3], $count))
      $side = [double]$a[2]
      $s = [Math]::Min(1.0, [Math]::Min($side / $img.Height, ($side * [Math]::Min($want, 2)) / ($img.Width * $want)))
      $w = [int][Math]::Max(1, $img.Width * $s)
      $h = [int][Math]::Max(1, $img.Height * $s)
      $bmp = New-Object System.Drawing.Bitmap ($w * $want), $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.Clear([System.Drawing.Color]::White)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      for ($k = 0; $k -lt $want; $k++) {
        if ($count -gt 1) { [void]$img.SelectActiveFrame($dim, [int][Math]::Floor($k * $count / $want)) }
        $g.DrawImage($img, $k * $w, 0, $w, $h)
      }
      $bmp.Save($a[1], $codec, $p)
      $g.Dispose(); $bmp.Dispose()
      [Console]::Out.WriteLine("ok|$want")
    }
    finally { $img.Dispose() }
  }
  catch { [Console]::Out.WriteLine('err|' + ($_.Exception.Message -replace '[\\r\\n|]', ' ')) }
  [Console]::Out.Flush()
}
`

/** 常驻的 PowerShell：一次一件，回一行；超时或挂了就杀掉，下次重起 */
class Worker {
  private ps?: ChildProcessWithoutNullStreams
  private buf = ''
  private waiting?: (line: string) => void
  private chain: Promise<unknown> = Promise.resolve()

  do(line: string, timeoutMs: number): Promise<string> {
    const job = this.chain.then(() => this.once(line, timeoutMs))
    this.chain = job.catch(() => {})
    return job
  }

  private once(line: string, timeoutMs: number): Promise<string> {
    const ps = this.ps ?? this.start()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting = undefined
        this.kill()
        reject(new Error('缩图超时'))
      }, timeoutMs)
      this.waiting = (out) => {
        clearTimeout(t)
        resolve(out)
      }
      ps.stdin.write(`${line}\n`)
    })
  }

  private start(): ChildProcessWithoutNullStreams {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], { windowsHide: true })
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let i = this.buf.indexOf('\n')
      while (i >= 0) {
        const out = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        const w = this.waiting
        this.waiting = undefined
        if (out)
          w?.(out)
        i = this.buf.indexOf('\n')
      }
    })
    ps.stderr.resume() // 不读会把管道塞满；内容没用（错误走 err| 行）
    ps.on('exit', () => {
      if (this.ps === ps)
        this.ps = undefined
      this.waiting?.('err|PowerShell 退出了')
      this.waiting = undefined
    })
    ps.unref()
    this.ps = ps
    return ps
  }

  kill(): void {
    this.ps?.kill()
    this.ps = undefined
    this.buf = ''
  }
}

let worker: Worker | undefined

/** 插件卸载时调：常驻的 PowerShell 跟着走，热重载不留一串 */
export function closeShrink(): void {
  worker?.kill()
  worker = undefined
}

/** 长边缩到 side 以内（小图不放大）、转 JPEG（quality 1～100） */
export async function shrink(img: Img, side: number, frames = 4, quality = 70): Promise<View> {
  if (side <= 0 || (process.platform !== 'darwin' && process.platform !== 'win32'))
    return { ...img, frames: 1 }
  const dir = await mkdtemp(join(tmpdir(), 'mumu-img-'))
  try {
    const src = join(dir, 'in')
    const out = join(dir, 'out.jpg')
    await writeFile(src, img.bytes)
    if (process.platform === 'darwin') {
      // sips -Z 会把小图放大（240 的表情包变 1024），先量尺寸，够小就只转格式
      const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src])
      const dims = [...stdout.matchAll(/pixel(?:Width|Height): (\d+)/g)].map(m => Number(m[1]))
      const fit = dims.length === 2 && Math.max(...dims) <= side
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), ...(fit ? [] : ['-Z', String(side)]), src, '--out', out])
      return { bytes: await readFile(out), mime: 'image/jpeg', frames: 1 }
    }
    worker ??= new Worker()
    const r = await worker.do(`${src}|${out}|${side}|${img.mime === 'image/gif' ? frames : 1}|${quality}`, 20_000)
    if (!r.startsWith('ok|'))
      throw new Error(r)
    return { bytes: await readFile(out), mime: 'image/jpeg', frames: Number(r.slice(3)) || 1 }
  }
  catch {
    return { ...img, frames: 1 } // 认不出的格式 / 工具不在 / 超时：原图，交给大小上限把关
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}
