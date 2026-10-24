/**
 * image / screenshot 动作：把她电脑里的一张图、或她桌面此刻的样子发进对话（工具即动作，handbook §9.4）。
 *
 * 立场：
 * - 图片是一条发声里的一个 Part：`{ kind: 'image', data: { media, mime, alt } }`。内核不认识 image，
 *   哪个表现端认识就显示（网页经 /api/media/<media>，QQ 由 surface-onebot 发成图片消息），不认识的忽略——能力降级的唯一规则。
 * - 日志里只记文件名，不记图片本身：文件拷进媒体目录、按内容摘要命名（同一张图发两次不占两份，名字也不会变）。
 * - 先读后端本机路径（2026-10-21 起后端与她的电脑同机，C:\mumu 在 VM 上）；本机没有这个文件就经身体服务 `/image?path=` 取
 *   （后端在别处跑时，比如 Mac 上的测试实例），取回来的是身体服务缩过的 JPEG。
 * - screenshot 单列一个动作并标「需要主人」：截桌面发群里等于把主人的屏幕给群里看，guard 按动作描述里的标记拦非主人。
 *   image 不标：它发的是 computer 存下的文件，而 computer 本身就只听主人的；标了反而会误拦——
 *   网上找图常要两三分钟，guard 往回找「是谁让做的」只看最近两分钟，computer.result 那拍已经找不到主人那句了。
 * - 只发图、不说话：为什么发、觉得怎么样，交给随后的 reply（发完会唤醒导演）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { ActionRun, LogEvent, Plugin } from '../../../src/index.ts'
import { PROMPT_ORDER } from '../../../src/index.ts'
import type { SecretsService } from '../secrets/index.ts'

interface ImageConfig {
  dir?: string
  maxMB?: number
  bodyUrl?: string // 身体服务：截桌面、取本机没有的文件
  bodyTokenSecret?: string // secrets 里身体服务 token 的名字；没开 token 留空
  imageMax?: number // 经身体服务取图时长边缩到多少像素
  shotScale?: number // 截桌面的缩放（1 = 原尺寸）
  shotQuality?: number // 截桌面 JPEG 质量
}

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

interface Failed { error: string, notImage?: string }

/**
 * 不是图片就抛错（结局 error，原因作为「动作出错」回大脑），文案直接指路。
 * 2026-10-23 真群：她下好的 mp3 交给了 image，这边只记了一句「不是图片」、结局 done，大脑不知道该换 qq.send file，她让主人自己去电脑上拿
 */
function notImage(kind: string): never {
  throw new Error(`这不是图片（${kind}）；发文件用 qq.send {"op":"file","path":…}，发语音用 qq.send {"op":"voice","path":…}`)
}

const plugin: Plugin<ImageConfig> = {
  name: 'action-image',
  inject: ['secrets'],
  apply(ctx, cfg = {}) {
    const dir = resolve(cfg.dir ?? 'data/media')
    const maxBytes = (cfg.maxMB ?? 15) * 1024 * 1024
    const bodyUrl = (cfg.bodyUrl ?? 'http://127.0.0.1:8765').replace(/\/+$/, '')
    const token = cfg.bodyTokenSecret ? ctx.use<SecretsService>('secrets').get(cfg.bodyTokenSecret) : undefined

    /** 从身体服务取一张图；失败返回原因，回的不是图片另带上它的类型 */
    const fromBody = async (query: string, signal: AbortSignal, timeoutMs = 30_000): Promise<{ bytes: Buffer, mime: string } | Failed> => {
      try {
        const res = await fetch(`${bodyUrl}${query}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        })
        if (!res.ok)
          return { error: `身体服务回 ${res.status}：${(await res.text()).slice(0, 120)}` }
        const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim()
        if (!EXT[mime])
          return { error: `身体服务回的不是图片（${mime || '没有类型'}）`, notImage: mime || '没有类型' }
        return { bytes: Buffer.from(await res.arrayBuffer()), mime }
      }
      catch (e) {
        return { error: `连不上身体服务（${e instanceof Error ? e.message : String(e)}）` }
      }
    }

    /**
     * 先要大图，拿不到再要一张小的：2026-10-22 她电脑上装了 AdGuard，本机回环上超过 64KB 的响应传到一半就卡死
     * （VM 本机 curl 也一样），原尺寸截图次次超时。小图（半尺寸 JPEG，五十来 KB）过得去。降级比发不出去好，但要记一笔。
     */
    const fromBodyOrSmaller = async (big: string, small: string, signal: AbortSignal): Promise<{ bytes: Buffer, mime: string, smaller?: string } | Failed> => {
      const first = await fromBody(big, signal, 12_000)
      if (!('error' in first) || first.notImage || signal.aborted)
        return first
      const second = await fromBody(small, signal)
      if ('error' in second)
        return { error: `${first.error}；换小图也没拿到：${second.error}` }
      console.warn(`[action-image] ${big} 没拿到（${first.error}），改发小图`)
      ctx.log.append('image.degraded', { query: big, error: first.error })
      return { ...second, smaller: first.error }
    }

    /** 存进媒体目录、发出去、记一笔；两个动作共用 */
    const send = async (a: ActionRun, img: { bytes: Buffer, mime: string }, what: string, alt?: string): Promise<void> => {
      a.note('在发图')
      const name = `${createHash('sha256').update(img.bytes).digest('hex').slice(0, 16)}${EXT[img.mime]}`
      mkdirSync(dir, { recursive: true })
      const target = join(dir, name)
      if (!existsSync(target))
        await writeFile(target, img.bytes)
      // 同 computer：导演在没频道的那拍启动时意图不带频道，取最近一条对方消息所在的对话
      const channel = a.channel
        ?? ctx.log.history({ limit: 20 }).filter(t => t.role === 'other').at(-1)?.channel
      // 导演连着两拍各起一个 image 发同一张图（实测）：同一对话两分钟内发过就不再发。从日志现算，不另存状态
      if (sentRecently(ctx.log.events, name, channel ?? 'main')) {
        a.note('这张刚发过')
        a.remember(`${what}刚才已经发给对方了，没再发一遍。`, { beats: 4 })
        return
      }
      const u = a.utter(channel ? { channel } : {})
      await u.emit({ kind: 'image', data: { media: name, mime: img.mime, ...(alt ? { alt } : {}) } })
      await u.end()
      a.note('发出去了')
      a.remember(`刚把${what}发给对方了${alt ? `（${alt}）` : ''}，对方已经看到。`, { beats: 6 })
    }

    const failer = (a: ActionRun, what: string) => (why: string): void => {
      a.note('没发出去')
      // 技术原因只进日志：她会把工作记忆里的话原样说给对方听（全量测试 2026-10-22 她在群里说「截图没发出去，连不上身体服务」）
      const plain = why.includes('身体服务') ? '电脑那边连不上（跟对方就说电脑连不上，别提「身体服务」）' : why
      if (plain !== why)
        ctx.log.append('image.failed', { what, why })
      a.remember(`想把${what}发给对方，但没发出去：${plain}。还没说的话，告诉对方一声。`, { beats: 4 })
    }

    ctx.effect(() => ctx.actions.register({
      name: 'image',
      description: '把你电脑里的一张图片发到当前对话里，对方能直接看到。对方要你发图、你想给对方看你存下的图时用；'
        + '图要先存好：网上的图用 search（kind:image）搜，结果里有存好的路径；电脑里的图给它的完整路径。发完会回来，那时再 reply 说两句（为什么发、你觉得怎么样）。',
      paramsHint: '{"path":"图片在她电脑上的完整路径，如 C:\\\\Users\\\\me\\\\Pictures\\\\a.jpg","alt":"可选，一句话说图里是什么"}',
      run: async (a) => {
        const path = String(a.params.path ?? '').trim()
        const alt = typeof a.params.alt === 'string' ? a.params.alt.slice(0, 200) : undefined
        const fail = failer(a, `图片「${path || '（没给路径）'}」`)
        if (!path)
          return fail('没给图片路径')
        const ext = extname(path).toLowerCase()
        const mime = TYPES[ext]
        if (!mime)
          notImage(ext || '没有扩展名')
        let img: { bytes: Buffer, mime: string }
        if (existsSync(path)) {
          const size = (await stat(path)).size
          if (size > maxBytes)
            return fail(`图片太大（${(size / 1024 / 1024).toFixed(1)} MB）`)
          img = { bytes: await readFile(path), mime }
        }
        else {
          // 后端不在她电脑上（测试实例）：经身体服务取，那边没有这个文件会回 400
          const q = (max: number): string => `/image?max=${max}&path=${encodeURIComponent(path)}`
          const got = await fromBodyOrSmaller(q(cfg.imageMax ?? 2048), q(640), a.signal)
          if ('error' in got && got.notImage)
            notImage(got.notImage)
          if ('error' in got)
            return fail(got.error.includes('400') ? '电脑上没有这个文件' : got.error)
          img = got
        }
        await send(a, img, `图片（${path}）`, alt)
      },
    }))

    ctx.effect(() => ctx.actions.register({
      name: 'screenshot',
      description: '截一张你电脑桌面此刻的样子，直接发到当前对话里（对方要看你桌面、让你截图发过来时用；不用先 computer）。（需要主人）',
      paramsHint: '{"alt":"可选，一句话说截的是什么"}',
      run: async (a) => {
        const alt = typeof a.params.alt === 'string' ? a.params.alt.slice(0, 200) : '电脑桌面截图'
        const fail = failer(a, '桌面截图')
        a.note('在截图')
        const got = await fromBodyOrSmaller(`/screenshot?scale=${cfg.shotScale ?? 1}&fmt=jpeg&q=${cfg.shotQuality ?? 85}`, '/screenshot?scale=0.5&fmt=jpeg&q=60', a.signal)
        if ('error' in got)
          return fail(got.error)
        if (got.bytes.length > maxBytes)
          return fail(`截图太大（${(got.bytes.length / 1024 / 1024).toFixed(1)} MB）`)
        await send(a, got, '桌面截图', alt)
      },
    }))

    ctx.effect(() => ctx.prompt.section({
      id: 'image-teaching-mind',
      audience: 'mind',
      order: PROMPT_ORDER.teaching,
      render: () => '【发图片 / 文件】你能把图发到对话里：'
        + '对方要看你桌面 / 让你截图发过来 → start screenshot（直接截、直接发，不用先 computer）；'
        + '要网上的图 → 先 start search（kind:"image"），search.result 回来列着存好的路径和图里是什么，挑一张 start image（params.path 写那个路径）；'
        + '要电脑里某张图（不知道在哪）→ 先 start computer 找到它的完整路径，再 start image。'
        + 'image 只发图片（png / jpg / webp / gif）；mp3、zip、pdf 这类文件用 qq.send {"op":"file"}，语音用 qq.send {"op":"voice"}，别塞给 image。'
        + '图发出去之前别让 reply 说「发了」；image / screenshot 做完会唤醒你，那时 start reply 说两句。',
    }))
    ctx.effect(() => ctx.prompt.section({
      id: 'image-teaching',
      audience: 'performer',
      order: PROMPT_ORDER.teaching,
      render: () => '【发图片】你能截自己电脑桌面、把电脑里的图片发到对话里给对方看。「刚才发生的事」里写着已经发了，才算发了；没发之前别说「发给你了」，只说「这就去弄」。',
    }))
  },
}

export default plugin

const RESEND_MS = 120_000

function sentRecently(events: readonly LogEvent[], media: string, channel: string): boolean {
  const since = Date.now() - RESEND_MS
  const utts = new Set<string>()
  for (let i = events.length - 1; i >= 0 && events[i].at >= since; i--) {
    const e = events[i]
    if (e.type === 'utterance.part' && e.data.part?.kind === 'image' && e.data.part.data?.media === media)
      utts.add(e.data.id)
    else if (e.type === 'utterance.started' && utts.has(e.data.id) && (e.data.channel ?? 'main') === channel)
      return true
  }
  return false
}
