/**
 * Web 传输层：零依赖 HTTP + SSE。契约见 docs/web-protocol.md，本文件不含任何界面逻辑。
 *
 * 立场：
 * - UI 是日志的纯投影：log.appended 原样推 SSE，连接先重放存量再直播；
 *   页面渲染后回报送达（/api/delivered），delivered 即页面实际显示（或播放）的前缀。
 * - 只在有浏览器连着时才注册为「有回执的表现端」，否则空标签页会拖住每句话等超时。
 * - 可选服务（tts）不存在时功能降级而不是启动失败。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigService, Disposer, LogEvent, ModelStreamEvent, Perception, Plugin } from '../../../src/index.ts'
import { MAIN_CHANNEL } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { BackupService } from '../storage-sqlite/index.ts'
import type { TtsService } from '../tts/index.ts'
import { adminApi } from './admin.ts'
import { listConversations, replayWindow } from './conversations.ts'
import { routeToPlugins } from './extend.ts'
import { modelsApi } from './models.ts'
import type { Preset } from './models.ts'
import { parsePersonaPatch, readPersona, writePersona } from './persona.ts'
import { serveMedia } from './media.ts'
import { scanSkins } from './skins.ts'

interface WebConfig {
  port?: number
  host?: string
  replay?: number // SSE 连接时重放的存量事件条数
  dist?: string // 前端构建产物目录，相对本插件目录
  name?: string // 角色名兜底；persona 经 web/meta 覆盖
  modelPresets?: Preset[] // 模型面板的一键填充（常用端点），见 models.ts
  media?: string // 图片消息的文件目录，相对后端工作目录（与 action-image 的 dir 一致）
}

const PROTOCOL = 2

// 插件上网页的扩展点（web/route、meta.panels、web/status）的形状，别的插件 import type 用
export type { PanelAction, StatusCard, WebPanel, WebRoute } from './extend.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.moc3': 'application/octet-stream',
}

const plugin: Plugin<WebConfig> = {
  name: 'surface-web',
  inject: ['config', 'commands'],
  apply(ctx, cfg = {}) {
    const port = cfg.port ?? 3939
    const host = cfg.host ?? '127.0.0.1'
    const replayN = cfg.replay ?? 400
    const here = dirname(fileURLToPath(import.meta.url))
    const distDir = resolve(here, cfg.dist ?? '../../../apps/web/dist')
    const commands = ctx.use<CommandService>('commands')
    const config = ctx.use<ConfigService>('config')
    const tts = optional<TtsService>(ctx, 'tts')

    const clients = new Set<ServerResponse>()
    const admin = adminApi(ctx, { self: 'surface-web', clients: () => clients.size })
    const perceptions = new Map<string, Perception>()
    let surfaceDispose: Disposer | undefined

    const syncSurface = (): void => {
      if (clients.size > 0 && !surfaceDispose) {
        surfaceDispose = ctx.io.connect({
          name: 'web',
          // 不限频道：每个浏览器里的「对话」是一个频道（c:<id>），main 是默认对话
          capabilities: { deliveredReport: true },
          onExpression: () => {}, // UI 从日志投影，part 与 stop 均经 log.appended 到达页面
        })
      }
      else if (clients.size === 0 && surfaceDispose) {
        surfaceDispose()
        surfaceDispose = undefined
      }
      // 告诉别的表现端有没有浏览器在看（surface-cli 据此让位，避免两个回执端打架）
      ctx.bus.emit('web/clients', { count: clients.size })
    }

    const sse = (res: ServerResponse, payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    // utterance.part / perception.part / action.ended 不带频道，按 started 事件把 id 映射到频道
    const channelOf = new Map<string, string>()
    const eventChannel = (e: LogEvent): string | undefined => {
      const d = e.data ?? {}
      if (e.type === 'utterance.started' || e.type === 'perception.started' || (e.type === 'action.started' && typeof d.channel === 'string')) {
        channelOf.set(d.id, d.channel ?? MAIN_CHANNEL)
        return d.channel ?? MAIN_CHANNEL
      }
      if (typeof d.channel === 'string')
        return d.channel
      if (typeof d.id === 'string' && channelOf.has(d.id))
        return channelOf.get(d.id)
      return undefined // 无频道的事件（beat、model、emotion…）对所有对话可见
    }
    for (const e of ctx.log.events) eventChannel(e)
    const wants = (filter: string | undefined, e: LogEvent): boolean => {
      if (!filter)
        return true
      const ch = eventChannel(e)
      return ch === undefined || ch === filter
    }
    const clientFilter = new Map<ServerResponse, string | undefined>()
    ctx.on<LogEvent>('log.appended', (e) => {
      for (const c of clients) {
        if (wants(clientFilter.get(c), e))
          sse(c, e)
      }
    })
    ctx.on<ModelStreamEvent>('model.stream', (e) => {
      for (const c of clients) sse(c, { type: '__stream__', data: e })
    })

    const json = (res: ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const fail = (res: ServerResponse, status: number, error: string): void => json(res, status, { error })
    const noContent = (res: ServerResponse): void => { res.writeHead(204).end() }

    const api = async (req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> => {
      const method = req.method ?? 'GET'

      // 角色发的图片（action-image 写进媒体目录），见 media.ts
      if (method === 'GET' && serveMedia(res, path, resolve(cfg.media ?? 'data/media')))
        return

      if (method === 'GET' && path === '/api/events') {
        const filter = url.searchParams.get('channel') ?? undefined
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        })
        res.write('retry: 1000\n\n')
        // 指定频道时只重放该对话：本频道事件优先，无频道事件只补那段时间的（conversations.ts）
        const n = Math.max(replayN, 400)
        const source = filter ? replayWindow(ctx.log.events, eventChannel, filter, n * 4, n) : ctx.log.events.slice(-replayN)
        for (const e of source)
          sse(res, e)
        sse(res, { type: '__live__' })
        clients.add(res)
        clientFilter.set(res, filter)
        syncSurface()
        req.on('close', () => {
          clients.delete(res)
          clientFilter.delete(res)
          syncSurface()
        })
        return
      }

      if (method === 'GET' && path === '/api/conversations') // 对话列表从真源投影，带来源（conversations.ts）
        return json(res, 200, { conversations: listConversations(ctx.log.events) })

      if (method === 'GET' && path === '/api/meta') {
        const base = {
          protocol: PROTOCOL,
          character: { name: cfg.name ?? '沐沐' },
          skins: scanSkins(distDir), // 每次现扫：重新 build 加了模型不用重启
          replay: replayN,
          voice: { available: tts?.ready() ?? false },
          commands: commands.list().map(c => ({ name: c.name, usage: c.usage, description: c.description })),
        }
        const meta = await ctx.bus.waterfall('web/meta', base, async m => m)
        return json(res, 200, meta)
      }

      if (method === 'GET' && path === '/api/persona') {
        const persona = await readPersona(config)
        return persona ? json(res, 200, persona) : fail(res, 404, '没装 persona 插件')
      }

      if (path === '/api/models') {
        const r = await modelsApi(ctx, cfg.modelPresets)(method, method === 'POST' ? await readBody(req) : undefined)
        return json(res, r.status, r.body)
      }

      const handled = await admin(method, path, () => readBody(req))
      if (handled) {
        if (handled.status === 204)
          noContent(res)
        else json(res, handled.status, handled.body)
        handled.after?.()
        return
      }

      // 本插件不认识的 /api/* 交给插件认领（web/route 水线，docs/web-protocol.md §7）
      const toPlugins = async (body?: Record<string, unknown>): Promise<void> => {
        const readable = method !== 'GET' && method !== 'HEAD'
        const r = await routeToPlugins(ctx, { method, path, query: Object.fromEntries(url.searchParams), body: readable ? body ?? await readBody(req) : undefined })
        if (!r)
          return fail(res, 404, '没有这个接口')
        if (Buffer.isBuffer(r.body)) {
          res.writeHead(r.status ?? 200, {
            'content-type': r.contentType ?? 'application/octet-stream',
            ...(r.cache ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}),
          })
          return void res.end(r.body)
        }
        return r.status === 204 ? noContent(res) : json(res, r.status ?? 200, r.body ?? null)
      }

      if (method !== 'POST')
        return toPlugins()
      const body = await readBody(req)

      if (path === '/api/persona') {
        const current = await readPersona(config)
        if (!current)
          return fail(res, 404, '没装 persona 插件')
        let patch
        try {
          patch = parsePersonaPatch(body)
        }
        catch (e) {
          return fail(res, 400, e instanceof Error ? e.message : String(e))
        }
        writePersona(config, patch, current)
        return json(res, 200, await readPersona(config))
      }

      if (path === '/api/input') {
        const text = String(body.text ?? '').trim()
        if (!text)
          return fail(res, 400, 'text 不能为空')
        void ctx.io.percept({
          kind: 'message',
          channel: typeof body.channel === 'string' ? body.channel : MAIN_CHANNEL,
          sender: { id: 'web-user' },
          text,
          urgent: true, // 直接的用户插话：默认打断正在说的话
        })
        return noContent(res)
      }

      if (path === '/api/delivered') {
        if (typeof body.uttId === 'string' && typeof body.chars === 'number')
          ctx.io.reportDelivered(body.uttId, body.chars)
        return noContent(res)
      }

      if (path === '/api/clear') {
        // 清之前先拍整库快照（规矩：任何清理前自动备份）；拍不了就不清
        let backupFile = ''
        try {
          backupFile = ctx.use<BackupService>('backup').snapshot('api-clear')
        }
        catch (e) {
          return fail(res, 500, `清除前备份失败，没有清：${e instanceof Error ? e.message : String(e)}`)
        }
        console.log(`[surface-web] /api/clear：已备份到 ${backupFile}`)
        // 先停止进行中的一切，再将真源归零，含持久层与工作记忆；配置库不动
        await ctx.actions.stopAll('memory-clear')
        ctx.io.disposeAll('memory-clear')
        perceptions.clear()
        ctx.log.reset()
        for (const c of clients) sse(c, { type: '__reset__' })
        return noContent(res)
      }

      if (path === '/api/tts') {
        if (!tts?.ready())
          return fail(res, 404, '语音未就绪：没装 tts 插件或没设密钥')
        const text = String(body.text ?? '').trim().slice(0, 2000)
        if (!text)
          return fail(res, 400, 'text 不能为空')
        const controller = new AbortController()
        req.on('close', () => controller.abort())
        const audio = await tts.synthesize(text, { signal: controller.signal })
        res.writeHead(200, { 'content-type': audio.mime, 'cache-control': 'no-store' })
        res.end(Buffer.from(audio.bytes))
        return
      }

      if (path === '/api/command') {
        const line = String(body.line ?? '').trim()
        const lines: string[] = []
        const handled = await commands.run(line, { print: l => lines.push(stripAnsi(l)) })
        return json(res, handled ? 200 : 400, handled ? { lines } : { error: '不是命令（要以 / 开头）' })
      }

      // 流式感知：浏览器语音识别的中间结果
      if (path === '/api/perception/start') {
        const p = ctx.io.perceive({
          kind: typeof body.kind === 'string' ? body.kind : 'speech',
          channel: typeof body.channel === 'string' ? body.channel : MAIN_CHANNEL,
          sender: { id: 'web-user' },
          urgent: body.urgent !== false, // 一开口就打断角色正在说的话
        })
        perceptions.set(p.id, p)
        return json(res, 200, { id: p.id })
      }
      if (path.startsWith('/api/perception/')) {
        const p = typeof body.id === 'string' ? perceptions.get(body.id) : undefined
        if (!p)
          return fail(res, 404, '没有这条在途感知')
        const op = path.slice('/api/perception/'.length)
        if (op === 'update') {
          await p.update(String(body.text ?? ''), { wake: body.wake === true })
        }
        else if (op === 'end') {
          perceptions.delete(p.id)
          await p.end(typeof body.text === 'string' ? { text: body.text } : {})
        }
        else if (op === 'cancel') {
          perceptions.delete(p.id)
          await p.cancel({ reason: typeof body.reason === 'string' ? body.reason : 'web-cancel' })
        }
        else {
          return fail(res, 404, '没有这个接口')
        }
        return noContent(res)
      }

      return toPlugins(body)
    }

    /** 静态产物：找不到且无扩展名 → index.html（SPA 路由）；dist 不存在 → 503 说明 */
    const serveStatic = (res: ServerResponse, path: string): void => {
      if (!existsSync(join(distDir, 'index.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`前端还没构建。\n开发时：npm run dev:web（Vite 在 5173，/api 代理到本端口）\n正式用：npm run build:web 后刷新本页\n期望目录：${distDir}`)
        return
      }
      const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
      let file = join(distDir, safe)
      if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory())
        file = extname(safe) ? '' : join(distDir, 'index.html')
      if (!file) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      })
      createReadStream(file).pipe(res)
    }

    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        if (url.pathname.startsWith('/api/'))
          await api(req, res, url.pathname, url)
        else serveStatic(res, url.pathname)
      }
      catch (e) {
        console.error('[surface-web] 请求处理出错:', e)
        if (!res.headersSent)
          fail(res, 500, e instanceof Error ? e.message : String(e))
        else res.end()
      }
    })

    // 追踪原始连接以便关停时立即断开，SSE 长连接不会自行结束
    const sockets = new Set<Socket>()
    server.on('connection', (s) => {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
    })
    server.on('error', e => console.error('[surface-web] 服务器错误:', e))
    server.listen(port, host, () => {
      console.log(`[surface-web] http://${host}:${port}`)
    })

    ctx.effect(() => () => {
      for (const c of clients) c.end()
      clients.clear()
      surfaceDispose?.()
      surfaceDispose = undefined
      for (const p of perceptions.values()) void p.cancel({ reason: 'plugin-unload' })
      perceptions.clear()
      for (const s of sockets) s.destroy()
      server.close()
    })
  },
}

export default plugin

/** 可选服务：没装就降级，不让表现端起不来 */
function optional<T>(ctx: { use: <U>(key: string) => U }, key: string): T | undefined {
  try {
    return ctx.use<T>(key)
  }
  catch {
    return undefined // 服务不存在是正常情况（插件停用或未安装）
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length)
    return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    return {} // 非 JSON 请求体按空处理，各接口自己校验必填字段
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}
