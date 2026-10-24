/**
 * 假群友用的图：带字的「表情包」和两张「照片」，第一次用时现画到 data/sim-images/。
 *
 * Windows 用 PowerShell + System.Drawing、macOS 用 swift + AppKit 画（都是系统自带、零依赖）；别的平台没有图，
 * 发图 / 表情包的场景就发不出图片段，只发文字说明。脚本经 -EncodedCommand 传，免得 .ps1 的 BOM 问题。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 表情包：文件名（不带扩展名）就是画上的字；第二项是背景色 */
export const STICKERS: [string, string][] = [
  ['哈哈哈哈', '#FFD54F'],
  ['笑死', '#FFB74D'],
  ['无语', '#90A4AE'],
  ['震惊', '#E1BEE7'],
  ['摸鱼中', '#80DEEA'],
  ['好耶', '#AED581'],
  ['裂开', '#BCAAA4'],
  ['委屈巴巴', '#B3E5FC'],
  ['气死我了', '#FF8A65'],
  ['晚安', '#9FA8DA'],
  ['我不听', '#F48FB1'],
  ['666', '#FFF176'],
  ['问号脸', '#CFD8DC'],
  ['抱抱', '#F8BBD0'],
  ['加油', '#C5E1A5'],
  ['累了毁灭吧', '#B0BEC5'],
  ['冲冲冲', '#FFCC80'],
  ['绝绝子', '#CE93D8'],
  ['社死现场', '#EF9A9A'],
  ['狗头保命', '#D7CCC8'],
]

export const PHOTOS: [string, string][] = [
  ['橘猫趴在键盘上睡觉', '#FFE0B2'],
  ['今晚的红烧肉', '#D7CCC8'],
]

/**
 * 真画了东西的「照片」：蓝天草地上一只黄眼睛的黑猫，顶上一行白字（文件 photo-黑猫-<字>.png）。
 * 原图进上下文的场景用（image-scenes.ts）：画面内容只在图里，文件名之外没有文字线索，她得真看图才答得出猫的颜色和图上的字
 */
export const CATS: string[] = ['煤球', '周五晚上去吃火锅']

export function imageDir(): string {
  return resolve('data/sim-images')
}

/** 缺图就画；返回目录里现有的 png 文件名 */
export function ensureImages(): string[] {
  const dir = imageDir()
  mkdirSync(dir, { recursive: true })
  const want = [...STICKERS.map(([t]) => `sticker-${t}.png`), ...PHOTOS.map(([t]) => `photo-${t}.png`), ...CATS.map(t => `photo-黑猫-${t}.png`)]
  const cats = CATS.map(t => ({ f: `photo-黑猫-${t}.png`, t, c: '#8CCBF2', w: 640, h: 480, size: 44, cat: true }))
  if (process.platform === 'win32' && want.some(f => !existsSync(join(dir, f)))) {
    const items = [
      ...STICKERS.map(([t, c]) => ({ f: `sticker-${t}.png`, t, c, w: 240, h: 240, size: 40, cat: false })),
      ...PHOTOS.map(([t, c]) => ({ f: `photo-${t}.png`, t, c, w: 480, h: 320, size: 28, cat: false })),
      ...cats,
    ]
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      `$dir = '${dir.replace(/'/g, '\'\'')}'`,
      `$items = ConvertFrom-Json '${JSON.stringify(items).replace(/'/g, '\'\'')}'`,
      'foreach ($i in $items) {',
      '  $bmp = New-Object System.Drawing.Bitmap $i.w, $i.h',
      '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
      '  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
      '  $g.Clear([System.Drawing.ColorTranslator]::FromHtml($i.c))',
      '  $font = New-Object System.Drawing.Font \'Microsoft YaHei\', $i.size, ([System.Drawing.FontStyle]::Bold)',
      '  $fmt = New-Object System.Drawing.StringFormat',
      '  $fmt.Alignment = [System.Drawing.StringAlignment]::Center',
      '  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center',
      '  $rect = New-Object System.Drawing.RectangleF 8, 8, ($i.w - 16), ($i.h - 16)',
      '  $ink = [System.Drawing.Brushes]::Black',
      '  if ($i.cat) {',
      '    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias',
      '    $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml(\'#73BF66\'))), 0, 360, 640, 120)',
      '    $g.FillEllipse($ink, 220, 220, 200, 150)',
      '    $g.FillEllipse($ink, 255, 140, 130, 120)',
      '    $g.FillPolygon($ink, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 265, 180), (New-Object System.Drawing.Point 275, 110), (New-Object System.Drawing.Point 310, 155)))',
      '    $g.FillPolygon($ink, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 375, 180), (New-Object System.Drawing.Point 365, 110), (New-Object System.Drawing.Point 330, 155)))',
      '    $tail = New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 18',
      '    $tail.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $tail.EndCap = [System.Drawing.Drawing2D.LineCap]::Round',
      '    $g.DrawBezier($tail, 410, 320, 490, 320, 440, 220, 480, 190)',
      '    $eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Gold)',
      '    $g.FillEllipse($eye, 285, 184, 22, 26); $g.FillEllipse($eye, 333, 184, 22, 26)',
      '    $rect = New-Object System.Drawing.RectangleF 0, 15, $i.w, 70',
      '    $ink = [System.Drawing.Brushes]::White',
      '  }',
      '  $g.DrawString($i.t, $font, $ink, $rect, $fmt)',
      '  $g.Dispose()',
      '  $bmp.Save((Join-Path $dir $i.f), [System.Drawing.Imaging.ImageFormat]::Png)',
      '  $bmp.Dispose()',
      '}',
    ].join('\n')
    const enc = Buffer.from(ps, 'utf16le').toString('base64')
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { stdio: 'inherit' })
  }
  // macOS：系统自带 swift + AppKit 画（之前只有 Windows 一支，Mac 上 0 张图，表情包场景等于没测，2026-10-22 复测补）
  if (process.platform === 'darwin' && want.some(f => !existsSync(join(dir, f)))) {
    const items = [
      ...STICKERS.map(([t, c]) => ({ f: `sticker-${t}.png`, t, c, w: 240, h: 240, size: 40, cat: false })),
      ...PHOTOS.map(([t, c]) => ({ f: `photo-${t}.png`, t, c, w: 480, h: 320, size: 28, cat: false })),
      ...cats,
    ]
    execFileSync('swift',['-', dir, JSON.stringify(items)], { input: SWIFT_DRAW, stdio: ['pipe', 'inherit', 'inherit'] })
  }
  return readdirSync(dir).filter(f => f.endsWith('.png'))
}

/** 参数：目录、items 的 JSON（同上面 PowerShell 那份）；居中画黑字，cat 的画一只黑猫、白字放顶上，PNG 落盘 */
const SWIFT_DRAW = `
import AppKit
struct Item: Decodable { let f: String; let t: String; let c: String; let w: Int; let h: Int; let size: Int; let cat: Bool }
func drawCat() {
  NSColor(srgbRed: 0.45, green: 0.75, blue: 0.4, alpha: 1).setFill()
  NSRect(x: 0, y: 0, width: 640, height: 120).fill()
  NSColor.black.setFill()
  NSBezierPath(ovalIn: NSRect(x: 220, y: 110, width: 200, height: 150)).fill()
  NSBezierPath(ovalIn: NSRect(x: 255, y: 220, width: 130, height: 120)).fill()
  let ears = NSBezierPath()
  ears.move(to: NSPoint(x: 265, y: 300)); ears.line(to: NSPoint(x: 275, y: 370)); ears.line(to: NSPoint(x: 310, y: 325)); ears.close()
  ears.move(to: NSPoint(x: 375, y: 300)); ears.line(to: NSPoint(x: 365, y: 370)); ears.line(to: NSPoint(x: 330, y: 325)); ears.close()
  ears.fill()
  let tail = NSBezierPath()
  tail.lineWidth = 18; tail.lineCapStyle = .round
  tail.move(to: NSPoint(x: 410, y: 160)); tail.curve(to: NSPoint(x: 480, y: 290), controlPoint1: NSPoint(x: 490, y: 160), controlPoint2: NSPoint(x: 440, y: 260))
  NSColor.black.setStroke(); tail.stroke()
  NSColor(srgbRed: 1, green: 0.85, blue: 0.1, alpha: 1).setFill()
  NSBezierPath(ovalIn: NSRect(x: 285, y: 270, width: 22, height: 26)).fill()
  NSBezierPath(ovalIn: NSRect(x: 333, y: 270, width: 22, height: 26)).fill()
}
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let items = try! JSONDecoder().decode([Item].self, from: CommandLine.arguments[2].data(using: .utf8)!)
for i in items {
  let v = Int(i.c.dropFirst(), radix: 16)!
  let bg = NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: i.w, pixelsHigh: i.h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  bg.setFill()
  NSRect(x: 0, y: 0, width: i.w, height: i.h).fill()
  let font = NSFont(name: "PingFangSC-Semibold", size: CGFloat(i.size)) ?? NSFont.boldSystemFont(ofSize: CGFloat(i.size))
  let para = NSMutableParagraphStyle()
  para.alignment = .center
  if i.cat {
    drawCat()
    let s = NSAttributedString(string: i.t, attributes: [.font: font, .foregroundColor: NSColor.white, .strokeColor: NSColor.black, .strokeWidth: -3, .paragraphStyle: para])
    s.draw(in: NSRect(x: 0, y: 395, width: i.w, height: 70))
  } else {
    let s = NSAttributedString(string: i.t, attributes: [.font: font, .foregroundColor: NSColor.black, .paragraphStyle: para])
    let box = NSSize(width: i.w - 16, height: i.h - 16)
    let need = s.boundingRect(with: box, options: [.usesLineFragmentOrigin])
    s.draw(with: NSRect(x: 8, y: 8 + (box.height - need.height) / 2, width: box.width, height: need.height), options: [.usesLineFragmentOrigin])
  }
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: dir.appendingPathComponent(i.f))
}
`
