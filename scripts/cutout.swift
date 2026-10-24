// 用 macOS 自带 Vision 的前景实例分割把人物从背景里抠出来，输出带透明通道的 PNG。
// 只取面积最大的那个前景实例（人物 + 法杖是一体的），文字块之类的小实例被排除。
// 用法: swift cutout.swift <输入.png> <输出.png>
import Foundation
import Vision
import CoreImage
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else { fputs("用法: cutout <in> <out>\n", stderr); exit(1) }
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
guard let ci = CIImage(contentsOf: inURL) else { fputs("读不了输入图\n", stderr); exit(1) }

let handler = VNImageRequestHandler(ciImage: ci, options: [:])
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let result = request.results?.first else { fputs("没有找到前景\n", stderr); exit(2) }
fputs("前景实例数: \(result.allInstances.count)\n", stderr)

let ctx = CIContext()
func coverage(_ mask: CIImage) -> Double {
  let f = CIFilter(name: "CIAreaAverage")!
  f.setValue(mask, forKey: kCIInputImageKey)
  f.setValue(CIVector(cgRect: mask.extent), forKey: kCIInputExtentKey)
  var px = [UInt8](repeating: 0, count: 4)
  ctx.render(f.outputImage!, toBitmap: &px, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
  return Double(px[0]) / 255.0
}

var best: (idx: Int, cov: Double, mask: CIImage)? = nil
for i in result.allInstances {
  let buf = try result.generateScaledMaskForImage(forInstances: IndexSet(integer: i), from: handler)
  let m = CIImage(cvPixelBuffer: buf)
  let c = coverage(m)
  fputs("  实例 \(i): 覆盖 \(String(format: "%.1f", c * 100))%\n", stderr)
  if best == nil || c > best!.cov { best = (i, c, m) }
}
guard let chosen = best else { exit(2) }

let filter = CIFilter(name: "CIBlendWithMask")!
filter.setValue(ci, forKey: kCIInputImageKey)
filter.setValue(CIImage(color: .clear).cropped(to: ci.extent), forKey: kCIInputBackgroundImageKey)
filter.setValue(chosen.mask, forKey: kCIInputMaskImageKey)
guard let out = filter.outputImage else { fputs("合成失败\n", stderr); exit(3) }
guard let png = ctx.pngRepresentation(of: out, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) else { fputs("编码失败\n", stderr); exit(4) }
try png.write(to: outURL)
fputs("写入 \(outURL.path)（实例 \(chosen.idx)）\n", stderr)
