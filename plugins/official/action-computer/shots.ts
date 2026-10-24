/**
 * 每一步的截图落到媒体目录（surface-web 的 `GET /api/media/<name>` 直接提供文件本体）。
 *
 * 立场：
 * - 日志里只记文件名，不记图片：日志要重放给每个浏览器，几十 KB 一张的图塞进去每次连接都要重发。
 * - 文件名 = 前缀 + 时间（base36）+ 内容摘要：按名字排序就是按时间排序，同名即同内容，可以长缓存。
 * - 只保留最近 keep 张（只删本前缀的文件，不碰 action-image 发的图）：一次 150 步的活就是 150 张，不清会一直长。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SHOT_PREFIX = 'cshot-'

export interface Shot {
  bytes: Buffer
  mime: string
}

// 名字里的时间戳要严格递增：同一毫秒存两张（look 的图与紧接着的截图）就会退化成按摘要排序，清理会删错张（测试曾偶发）
let lastStamp = 0
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp.toString(36).padStart(9, '0')
}

/** 存一张，返回媒体文件名（如 cshot-m2f1x9ab-3f9a0c1b.jpg）；之后顺手把最老的清掉 */
export async function saveShot(dir: string, img: Shot, keep: number): Promise<string> {
  await mkdir(dir, { recursive: true })
  const ext = img.mime.includes('png') ? '.png' : '.jpg'
  const digest = createHash('sha256').update(img.bytes).digest('hex').slice(0, 8)
  const name = `${SHOT_PREFIX}${stamp()}-${digest}${ext}`
  await writeFile(join(dir, name), img.bytes)
  await prune(dir, keep)
  return name
}

/** 名字里的时间是定长 base36，按名字排序即按时间排序 */
export async function prune(dir: string, keep: number): Promise<string[]> {
  const names = (await readdir(dir)).filter(n => n.startsWith(SHOT_PREFIX)).sort()
  const old = names.slice(0, Math.max(0, names.length - Math.max(0, keep)))
  for (const n of old) {
    try {
      await unlink(join(dir, n))
    }
    catch {
      // 已经被别人删了或占用中：下次再清，不影响这次截图
    }
  }
  return old
}

export const shotId = (media: string): string => media.replace(/\.[a-z]+$/i, '')
export const shotUrl = (media: string): string => `/api/media/${media}`
