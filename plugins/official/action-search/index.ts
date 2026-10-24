/**
 * search 动作：查资料、看新闻、找图直接调搜索 API，不再开电脑浏览器（工具即动作，handbook §9.4）。
 *
 * 立场：
 * - 大脑 start search {query, kind?, count?}；结果以 `search.result` 感知唤醒大脑（同 dsh.result），同时进工作记忆，
 *   发言者照「刚才发生的事」说，没搜到的不编。这个动作从不说话：说什么、怎么说交给随后的 reply。
 * - 来源可换（providers.ts）：网页 / 新闻默认 DeepSeek 官方 Search API；DeepSeek 没有图片搜索，图片默认必应 + 360 并行。
 * - 密钥只存名字（apiKeyRef，默认与对话共用的 `deepseek`），每次搜索时现取：主人后来才填密钥也不用重载。
 * - 图片下载到本地目录，结果里给完整路径，大脑接着 start image 发——发图仍走 image 原来的规矩。
 * - 不标「需要主人」：搜索只读、不碰她的电脑，谁请求都可以搜（guard 不拦）。
 */
import type { Plugin } from '../../../src/index.ts'
import { formatElapsed, PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import type { StatusCard } from '../surface-web/index.ts'
import { look } from './look.ts'
import { IMAGE_PROVIDERS, WEB_PROVIDERS } from './providers.ts'
import type { Outcome, SearchConfig, SearchDeps } from './search.ts'
import { runSearch } from './search.ts'

export interface ActionSearchConfig extends SearchConfig {
  lookRules?: string[]
}

const plugin: Plugin<ActionSearchConfig> = {
  name: 'action-search',
  inject: ['secrets', 'commands'],
  apply(ctx, cfg = {}) {
    const secrets = ctx.use<SecretsService>('secrets')
    const commands = ctx.use<CommandService>('commands')
    const keyName = cfg.apiKeyRef ?? 'deepseek'
    const web = WEB_PROVIDERS[cfg.provider ?? 'deepseek']
    const deps: SearchDeps = {
      fetch: (url, init) => fetch(url, init),
      key: name => secrets.get(name),
      look: (bytes, mime, query, signal) => look(req => ctx.model.complete(req), query, bytes, mime, signal, cfg.lookRules),
    }

    ctx.effect(() => ctx.actions.register({
      name: 'search',
      description: '上网搜：查资料、看最新消息、找图。直接调搜索接口，一两秒就回（图片要下载、看一眼，几秒），不用开电脑、不用 computer。'
        + '结果以 search.result 回来（也会进你的工作记忆）：标题、一句摘要、链接；图片是已经存到本地的路径和图里是什么。'
        + '搜到的图要发出去就接着 start image（params.path 用结果里的路径）。',
      paramsHint: '{"query":"关键词，像搜索框里那样写，如「SpaceX 星舰」","kind":"可选：web（默认，查资料）| news（新闻、最近发生了什么）| image（找图）","count":"可选，要几条（网页默认 5，图片默认 3）"}',
      reloadPolicy: 'abort', // 搜索是秒级的事，重载时掐掉也无妨
      run: async (a) => {
        // 同 computer：意图不带频道时取最近一条对方消息所在的对话，否则结果回到别的对话里
        const channel = a.channel
          ?? ctx.log.history({ limit: 20 }).filter(t => t.role === 'other').at(-1)?.channel
        a.note(a.params.kind === 'image' ? '在搜图' : '在搜')
        const r = await runSearch(a.params, cfg, deps, a.signal)
        if (a.signal.aborted)
          return
        a.note(r.ok ? '搜到了' : '没搜成')
        a.remember(`${r.text}\n${hint(r)}`, { beats: 6 })
        // 先让带频道的感知唤醒大脑，再让动作结算（理由同 action-dsh）
        await ctx.io.percept({
          kind: 'search.result',
          channel,
          text: r.text,
          data: {
            actionId: a.id,
            ok: r.ok,
            kind: r.kind,
            query: r.query,
            provider: r.provider,
            elapsedMs: r.elapsedMs,
            ...(r.error ? { error: r.error } : {}),
            ...(r.hits ? { hits: r.hits.map(h => ({ title: h.title, url: h.url, site: h.site, date: h.date })) } : {}),
            ...(r.images ? { images: r.images, dropped: r.dropped ?? 0 } : {}),
            ...(r.unfit ? { unfit: true } : {}),
          },
        })
      },
    }))

    ctx.effect(() => ctx.prompt.section({
      id: 'search-teaching-mind',
      audience: 'mind',
      order: PROMPT_ORDER.teaching,
      render: () => '【搜索】查资料、问最新消息 / 新闻、要网上的图：先 start search，不用开浏览器、不用 computer（几秒就回）。'
        + 'kind：查资料 web、新闻 / 今天发生了什么 news、找图 image。可以同一拍 start reply 应一声（「我搜搜」），别让 reply 说已经查到了。'
        + 'search.result 回来：查资料 / 新闻就 start reply，guidance 写搜到的要点（挑一两条要紧的，用她自己的话说，别念链接，对方要才给链接）；'
        + '找图就挑一张合适的 start image（params.path 用结果里的路径，alt 写图里是什么），image 发完会再叫你，那时 reply 说两句。'
        + '一般只发一张，对方要几张才发几张：「正在运行」里已经有 image、或刚发过这次搜的图，就别再起 image。'
        + '结果说图都对不上：别发，照结果里「网上说的」弄清这个词指什么，换个更准的词再 search 一次；换过还不行就让她说没找到合适的。'
        + '没搜到或出错，就让她照实说一声。computer 只留给要在电脑上点点按按、操作软件的事。',
    }))
    ctx.effect(() => ctx.prompt.section({
      id: 'search-teaching',
      audience: 'performer',
      order: PROMPT_ORDER.teaching,
      render: () => '【搜索】你能上网搜东西、找图。搜到的内容在「刚才发生的事」里，照那个说，没写的别编；还没搜回来就别说「查到了」，只说「我搜搜」。',
    }))

    ctx.intercept<{ cards: StatusCard[] }>('web/status', async (s, next) => {
      const hasKey = !web?.needsKey || Boolean(secrets.get(keyName))
      const today = new Date().setHours(0, 0, 0, 0)
      const results = ctx.log.events.filter(e => e.type === 'percept.received' && e.data.kind === 'search.result')
      const n = results.filter(e => e.at >= today).length
      const last = results.at(-1)
      s.cards.push({
        id: 'action-search',
        title: '搜索',
        level: !web ? 'err' : hasKey ? 'ok' : 'warn',
        text: !web ? `不认识的搜索来源「${cfg.provider}」` : hasKey ? `已配置（${web.title}）` : `没密钥：网页「密钥」里填「${keyName}」`,
        items: [
          `网页 / 新闻：${web?.title ?? cfg.provider} · 图片：${(cfg.imageProviders?.length ? cfg.imageProviders : ['bing', 'so360']).map(id => IMAGE_PROVIDERS[id]?.title ?? `不认识的「${id}」`).join(' + ')}`,
          `今天搜了 ${n} 次`,
          ...(last ? [`最近一次（${formatElapsed(Date.now() - last.at)}前）：${last.data.data?.ok ? '✓' : '✗'} ${String(last.data.data?.query ?? '')}`] : []),
        ],
      })
      return next()
    })

    ctx.effect(() => commands.register({
      name: 'search',
      usage: 'search [news|image] <关键词>',
      description: '直接搜一次看结果（不进对话，调试用）',
      async run(args, io) {
        const kind = args[0] === 'news' || args[0] === 'image' ? args.shift() : 'web'
        const query = args.join(' ')
        if (!query) {
          io.print('用法：/search [news|image] <关键词>')
          return
        }
        const r = await runSearch({ query, kind }, cfg, deps)
        io.print(`${r.text}\n（${r.provider}，${r.elapsedMs}ms）`)
      },
    }))
  },
}

/** 跟在结果后面的一句：她会把工作记忆里的话原样说给对方听，所以这里只教怎么用，不放技术细节 */
function hint(r: Outcome): string {
  if (!r.ok)
    return '还没跟对方说的话，告诉对方一声没搜成（说人话，别念报错）。'
  if (r.kind === 'image') {
    if (r.unfit)
      return '这些图都不对，对方还没看到；别说找到了。'
    return r.images?.length ? '这些图对方还没看到；发出去之前别说「发了」。' : ''
  }
  return r.hits?.length ? '这是你刚搜到的；跟对方说时挑要紧的用自己的话讲，别念链接（对方要才给）。' : '没搜到，就照实说没搜到，别编。'
}

export default plugin
