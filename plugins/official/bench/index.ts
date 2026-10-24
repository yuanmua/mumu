/**
 * 压测工具（scripts/replay.ts 用；平时可停用，不影响她）。
 *
 * - GET /api/bench/usage?since=&until=：从真源里的 model.request / model.response 按模型角色统计
 *   调用次数、被打断的次数、输入 / 输出 token、耗时；另估一个「缓存命中」的输入 token 数——provider 的用量里没有命中数，
 *   DeepSeek 的缓存按请求前缀命中，所以拿每个请求与最近 30 个请求的最长公共前缀占比来估。
 * - POST /api/bench/judge {items:[{id, scene, context[], reply}]}：bench.judge 角色当「老群友」给每条发言打 1～5 分、列翻车点。
 * - GET /api/bench/thread?channel=&since=&until=：一个频道一段时间的对话行，她每句标上是谁起的，附反射占比、补充紧跟反射几次等数（thread.ts）。
 * - POST /api/bench/judge-thread {threads:[{id, transcript}]}：整段读，打「像不像过了脑子的人」并数逐条回、抢答、复读反问……
 * 只读真源、不改任何东西；裁判的请求本身也落日志（I1），统计时按角色名区分开。
 */
import type { ChatMessage, LogEvent, Plugin } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { WebRoute } from '../surface-web/index.ts'
import { JUDGE_THREAD, renderThread, thread } from './thread.ts'

interface BenchConfig {
  judgeRole?: string
  charsPerToken?: number
}

interface RoleUsage {
  role: string
  calls: number
  aborted: number
  promptTokens: number
  completionTokens: number
  estCachedTokens: number
  totalMs: number
  models: string[]
}

interface JudgeItem { id: string, scene: string, context: string[], reply: string }

const JUDGE = `你是一个在 QQ 群里混了很多年的老群友。下面是群友「沐沐」在几个群里的发言，每条前面是她开口前群里的几句话。
请评判她每一条发言像不像一个真人群友（不是客服、不是 AI 助手）。

打分 1～5：5 = 完全像真人群友，自然、有个性、接得上；3 = 能看，但有点刻意或者平淡；1 = 一看就是机器人 / 客服 / 答非所问。
problems 从这些里选（没有就空数组）：复读、客服腔、答非所问、太长太有条理、刷屏、不该插话、该说的没说、该收尾没收尾、话题结束后还追问、编造、人设崩、语气不对、其他。
（「该收尾没收尾」：对方已经在收（好的 / 哈哈 / 晚安 / 换话题了），她还硬接一句；「话题结束后还追问」：话题明显聊完了她还在问「还有呢」「然后呢」之类。）
note 一句话说为什么（不超过 30 字）。

只输出一个 JSON 数组，每条一个对象，不要别的文字：
[{"id":"…","score":4,"problems":[],"note":"…"}]`

const plugin: Plugin<BenchConfig> = {
  name: 'bench',
  inject: ['commands'],
  apply(ctx, cfg = {}) {
    const cpt = cfg.charsPerToken ?? 1.6

    const usage = (since: number, until: number): RoleUsage[] => {
      const req = new Map<string, LogEvent>()
      const recent: string[] = [] // 最近请求的序列化文本，估缓存命中用
      const est = new Map<string, number>() // reqId → 估计命中的字符比例
      const out = new Map<string, RoleUsage>()
      for (const e of ctx.log.events) {
        if (e.type === 'model.request') {
          const text = JSON.stringify(e.data.messages ?? [])
          let best = 0
          for (const prev of recent) best = Math.max(best, commonPrefix(prev, text))
          recent.push(text)
          if (recent.length > 30)
            recent.shift()
          est.set(e.data.reqId, text.length ? best / text.length : 0)
          req.set(e.data.reqId, e)
          continue
        }
        if (e.type !== 'model.response' || e.at < since || e.at > until)
          continue
        const r = req.get(e.data.reqId)
        const role = String(e.data.role ?? r?.data.role ?? '?')
        const u = out.get(role) ?? { role, calls: 0, aborted: 0, promptTokens: 0, completionTokens: 0, estCachedTokens: 0, totalMs: 0, models: [] }
        u.calls++
        if (e.data.aborted)
          u.aborted++
        // 被打断的流式请求常拿不到用量：按字数粗估（输入按请求文本，输出按已生成字数）
        const prompt = e.data.usage?.prompt ?? Math.round(JSON.stringify(r?.data.messages ?? []).length / cpt)
        const completion = e.data.usage?.completion ?? Math.round(Number(e.data.chars ?? 0) / cpt)
        u.promptTokens += prompt
        u.completionTokens += completion
        u.estCachedTokens += Math.floor(prompt * (est.get(e.data.reqId) ?? 0))
        if (r)
          u.totalMs += e.at - r.at
        const model = String(e.data.model ?? '')
        if (model && !u.models.includes(model))
          u.models.push(model)
        out.set(role, u)
      }
      return [...out.values()].sort((a, b) => b.promptTokens - a.promptTokens)
    }

    const judge = async (items: JudgeItem[]): Promise<unknown[]> => {
      const results: unknown[] = []
      for (let i = 0; i < items.length; i += 10) {
        const batch = items.slice(i, i + 10)
        const body = batch.map(x => `### ${x.id}（${x.scene}）\n${x.context.map(c => `  ${c}`).join('\n')}\n  → 沐沐：${x.reply}`).join('\n\n')
        const messages: ChatMessage[] = [{ role: 'system', content: JUDGE }, { role: 'user', content: body }]
        const text = await ctx.model.complete({ role: cfg.judgeRole ?? 'bench.judge', messages })
        const start = text.indexOf('[')
        const end = text.lastIndexOf(']')
        try {
          const arr = JSON.parse(text.slice(start, end + 1)) as unknown[]
          results.push(...arr)
        }
        catch {
          // 裁判没按 JSON 回：这一批记成没评上，统计时剔除
          results.push(...batch.map(x => ({ id: x.id, score: null, problems: ['裁判输出不成形'], note: '' })))
        }
      }
      return results
    }

    ctx.intercept<WebRoute>('web/route', async (r, next) => {
      if (r.method === 'GET' && r.path === '/api/bench/usage') {
        const since = Number(r.query.since ?? 0)
        const until = Number(r.query.until ?? Date.now())
        r.response = { body: { since, until, roles: usage(since, until) } }
        return r
      }
      if (r.method === 'POST' && r.path === '/api/bench/judge') {
        const items = ((r.body as { items?: JudgeItem[] } | undefined)?.items ?? []).slice(0, 200)
        r.response = { body: { results: await judge(items) } }
        return r
      }
      if (r.method === 'GET' && r.path === '/api/bench/thread') {
        const channel = String(r.query.channel ?? '')
        const t = thread(ctx.log.events, channel, Number(r.query.since ?? 0), Number(r.query.until ?? Date.now()))
        r.response = { body: { channel, ...t, transcript: renderThread(t.lines) } }
        return r
      }
      if (r.method === 'POST' && r.path === '/api/bench/judge-thread') {
        const threads = ((r.body as { threads?: { id: string, transcript: string }[] } | undefined)?.threads ?? []).slice(0, 20)
        const results: unknown[] = []
        for (const t of threads) {
          const messages: ChatMessage[] = [{ role: 'system', content: JUDGE_THREAD }, { role: 'user', content: t.transcript }]
          const text = await ctx.model.complete({ role: cfg.judgeRole ?? 'bench.judge', messages })
          try {
            results.push({ id: t.id, ...JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as object })
          }
          catch {
            // 裁判没按 JSON 回：记成没评上
            results.push({ id: t.id, score: null, note: '裁判输出不成形' })
          }
        }
        r.response = { body: { results } }
        return r
      }
      return next()
    })

    const commands = ctx.use<CommandService>('commands')
    ctx.effect(() => commands.register({
      name: 'bench',
      usage: 'bench [分钟]',
      description: '最近 N 分钟（默认 60）各模型角色的调用次数与 token',
      run(args, io) {
        const min = Number(args[0] ?? 60)
        for (const u of usage(Date.now() - min * 60_000, Date.now()))
          io.print(`  ${u.role.padEnd(18)} ${u.calls} 次（打断 ${u.aborted}）· 入 ${u.promptTokens}（估命中 ${u.estCachedTokens}）· 出 ${u.completionTokens} · 平均 ${u.calls ? Math.round(u.totalMs / u.calls) : 0}ms · ${u.models.join('、')}`)
      },
    }))
  },
}

export default plugin

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}
