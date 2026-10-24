/**
 * 舞台皮肤清单：扫本插件服务的静态目录下 live2d/models/<id>/profile.json，报成 meta.skins。
 *
 * 立场：皮肤 = 前端产物里真有的模型目录。扫产物而不是扫源码 public/，
 * 因为浏览器能取到的只有产物；没 build 进去的模型列出来也加载不了。
 * 有 profile.json 才算：没档案的模型前端不知道怎么演（词汇映射归模型，见 apps/web/README.md）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface Skin {
  id: string
  kind: 'live2d'
  profile: string // 相对站点根，与 meta.character.stage.profile 同义
}

const MODELS = 'live2d/models'

export function scanSkins(distDir: string): Skin[] {
  const root = join(distDir, MODELS)
  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  }
  catch {
    return [] // 没 build 或产物里没有 Live2D 模型：没有可选皮肤，不是错误
  }
  return dirs
    .filter(id => existsSync(join(root, id, 'profile.json')))
    .sort()
    .map(id => ({ id, kind: 'live2d', profile: `${MODELS}/${id}` }))
}
