/**
 * `GET /api/media/<name>`：角色发出的图片（Part kind 'image'）的文件本体，见 docs/web-protocol.md §3。
 *
 * 立场：
 * - 日志里只记文件名（内容摘要 + 扩展名），不记图片本身：日志要重放给每个浏览器，几 MB 的图塞进去每次连接都要重发。
 * - 只认一个目录、只认「摘要式」文件名：这个接口不能变成读后端任意文件的口子。
 * - 写这个目录的是发图的插件（action-image），本模块只读。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, join } from 'node:path'

const NAME = /^[\w.-]+$/

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 认领了返回 true（已回应）；不是本接口返回 false */
export function serveMedia(res: ServerResponse, path: string, dir: string): boolean {
  if (!path.startsWith('/api/media/'))
    return false
  const name = decodeURIComponent(path.slice('/api/media/'.length))
  const type = TYPES[extname(name).toLowerCase()]
  if (!NAME.test(name) || name.startsWith('.') || !type) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: '文件名不对' }))
    return true
  }
  const file = join(dir, name)
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: '没有这张图' }))
    return true
  }
  // 名字就是内容摘要：同名不会变，可以长缓存
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' })
  createReadStream(file).pipe(res)
  return true
}
