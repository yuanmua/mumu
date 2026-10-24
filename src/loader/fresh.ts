/**
 * 热重载的 ESM 缓存穿透：让插件目录里的相对 import 跟着入口一起换新。
 *
 * 入口带 ?mumu-v=<序号> 能绕开缓存，但它 import 的同插件子模块 URL 不变，仍拿缓存里的旧代码；
 * 子模块新增导出时入口直接加载失败、插件掉线。这里用 node:module 的同步 resolve 钩子
 * 把版本号沿相对 import 往下传，**只传到插件目录之内**：越界到 src/（内核与公共 API）、
 * 别的插件或 node_modules 的一律不带——否则会重复实例化内核，instanceof 与单例全乱。
 *
 * 无状态：插件根目录不登记在全局表里，而是随 URL 带「本模块比插件根深几层」（mumu-d），
 * 子模块据此推出根，再带上自己的深度。所以多个 PluginLoader（测试里常见）共用同一个钩子互不干扰。
 *
 * 需要 Node 22.15+（package.json engines）。没有 registerHooks 就直接报错，不悄悄退回「只刷新入口」：
 * 同一份代码换台机器热重载的范围就不一样，这种不固定的行为比启动失败更难查。
 */
import * as nodeModule from 'node:module'
import { pathToFileURL } from 'node:url'

const VERSION = 'mumu-v'
const DEPTH = 'mumu-d'

interface ResolveContext { parentURL?: string }
interface ResolveResult { url: string }
type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult
type RegisterHooks = (hooks: {
  resolve: (specifier: string, context: ResolveContext, next: NextResolve) => ResolveResult
}) => unknown

// 钩子是进程级的，装一次就够；这是「装没装」的开关，不是会话状态
let installed = false

/** 装上 resolve 钩子；Node 不支持就抛错 */
export function installFreshHooks(): void {
  if (installed)
    return
  // @types/node 的版本可能还没收录 registerHooks，按运行时实际有没有来
  const register = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks
  if (typeof register !== 'function')
    throw new Error(`热重载需要 Node 22.15+（module.registerHooks），当前 ${process.version}`)
  installed = true
  register({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context)
      if (!context.parentURL || !(specifier.startsWith('./') || specifier.startsWith('../')))
        return resolved
      const url = withVersion(context.parentURL, resolved.url)
      return url ? { ...resolved, url } : resolved
    },
  })
}

/** 插件入口的 URL：带版本号，深度 0（入口所在目录即插件根） */
export function versionedEntry(entryPath: string, seq: number): string {
  const u = pathToFileURL(entryPath)
  u.searchParams.set(VERSION, String(seq))
  u.searchParams.set(DEPTH, '0')
  return u.href
}

const dirSegments = (u: URL): string[] => u.pathname.split('/').slice(0, -1)

/**
 * 父模块带版本、子模块落在同一插件根之内 → 返回子模块带同一版本与自身深度的 URL；否则 undefined（照常走缓存）。
 * 纯函数，测试直接调。
 */
export function withVersion(parentUrl: string, childUrl: string): string | undefined {
  const parent = new URL(parentUrl)
  const version = parent.searchParams.get(VERSION)
  const depth = Number(parent.searchParams.get(DEPTH))
  if (!version || !Number.isInteger(depth) || depth < 0)
    return undefined
  const child = new URL(childUrl)
  if (child.protocol !== 'file:' || child.search) // 已带查询串的（如别的工具加的）不碰
    return undefined
  const parentDir = dirSegments(parent)
  if (depth >= parentDir.length)
    return undefined
  const root = parentDir.slice(0, parentDir.length - depth)
  const childDir = dirSegments(child)
  if (childDir.length < root.length || root.some((s, i) => childDir[i] !== s))
    return undefined // 出了插件目录：内核、别的插件
  const below = childDir.slice(root.length)
  if (below.includes('node_modules'))
    return undefined // 插件自己的依赖：不归热重载管，重复实例化只会漏内存
  child.searchParams.set(VERSION, version)
  child.searchParams.set(DEPTH, String(below.length))
  return child.href
}
