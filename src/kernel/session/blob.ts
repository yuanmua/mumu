/**
 * 二进制存储契约：图片、音频、视频、传感器原始数据不进日志正文，日志与片段只记 ref。
 * 与 LogStore 并列，实现由存储插件 provide 为 BLOB_SERVICE 服务；内核自己不读写二进制。
 *
 * ref 一律是内容哈希（blobRef），同样的字节在任何实现里都得到同一个 ref——
 * 这样不同人采的数据能去重、能互相引用，换存储插件也不用改日志。
 */
import { createHash } from 'node:crypto'

export interface BlobStore {
  put: (bytes: Uint8Array, mime: string) => Promise<string> // 返回 blobRef(bytes)；已存在则直接返回
  get: (ref: string) => Promise<{ bytes: Uint8Array, mime: string } | undefined>
}

/** 二进制存储的服务键 */
export const BLOB_SERVICE = 'blobs'

/** 内容哈希 ref：`sha256:<十六进制>` */
export function blobRef(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
