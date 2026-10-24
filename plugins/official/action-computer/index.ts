/**
 * computer 动作：在她自己的 Windows 上动手做事（工具即动作，handbook §9.4）。
 *
 * 立场：
 * - 本插件只编排：决定下一步的是 task.agent 角色（agent.ts），真正动手的是跑在那台电脑
 *   登录桌面里的身体服务（apps/body）。地址、token、步数都是配置，`/config set` 可改。
 * - 做事是一个普通的动作实例：导演照常思考、reply 照常说话，「边聊边做」不需要任何特殊机制。
 * - 结果两路回去：一条 `computer.result` 感知唤醒导演（她据此开口说做完了），
 *   一条工作记忆给发言者看具体结果（reply 只读工作记忆，不读唤醒原因）。
 * - 不说话：这个动作从不调 a.utter()，开口永远是 reply 的事。
 */
import { resolve } from 'node:path'
import type { MaterialBlock, Plugin, RunningView } from '../../../src/index.ts'
import { formatElapsed, PROMPT_ORDER } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import type { SecretsService } from '../secrets/index.ts'
import { runTask } from './agent.ts'
import { BodyClient, BodyError } from './body.ts'
import { saveShot } from './shots.ts'
import { handsOn, runningBrief, tasksOf } from './view.ts'
import { webExtras } from './web.ts'

interface ComputerConfig {
  url?: string
  tokenSecret?: string // secrets 里存 token 的名字；身体服务没开 token 时留空即可
  maxSteps?: number
  requestTimeoutSec?: number
  stepWaitSec?: number // 一步超时后身体服务还活着时，最多再等它多久
  observationChars?: number
  shots?: boolean // 每步留一张截图
  shotScale?: number
  shotsDir?: string // 媒体目录，与 surface-web 的 media 一致，网页经 /api/media/<name> 看
  shotsKeep?: number
  panelTasks?: number // 网页面板显示最近几次任务
}

const plugin: Plugin<ComputerConfig> = {
  name: 'action-computer',
  inject: ['secrets', 'commands'],
  apply(ctx, cfg = {}) {
    const secrets = ctx.use<SecretsService>('secrets')
    const commands = ctx.use<CommandService>('commands')
    // 每次用时现取：/secret set 之后不用重载插件
    const client = (): BodyClient => new BodyClient({
      url: cfg.url ?? 'http://127.0.0.1:8765',
      token: cfg.tokenSecret ? secrets.get(cfg.tokenSecret) : undefined,
      requestTimeoutSec: cfg.requestTimeoutSec ?? 90,
      stepWaitSec: cfg.stepWaitSec ?? 300,
    })
    const shots = cfg.shots === false
      ? undefined
      : {
          scale: Math.min(1, Math.max(0.2, Number(cfg.shotScale) || 0.5)),
          save: (img: { bytes: Buffer, mime: string }) => saveShot(resolve(cfg.shotsDir ?? 'data/media'), img, cfg.shotsKeep ?? 400),
        }
    // stop 只是 abort，实例要等结算才离开运行表，所以按快照逐个停，不能 while 到 false
    const stopAll = (): string[] => {
      const ids = ctx.actions.snapshot().map(r => r.id).filter(id => id.startsWith('computer#'))
      for (const id of ids)
        ctx.actions.stop(id, '急停')
      return ids
    }

    // 网页：状态卡「电脑身体」、面板「电脑任务」、自带接口（web.ts）
    webExtras(ctx, { client, panelTasks: cfg.panelTasks ?? 30, shotsOn: !!shots, stopAll })

    ctx.effect(() => ctx.actions.register({
      name: 'computer',
      description: '在你自己的电脑（一台 Windows）上动手做事：开程序、点界面、打字、跑命令、上网、整理文件。'
        + '只是查资料、看新闻、找网上的图，用 search（几秒就回），不用开电脑。'
        + '对方让你「帮我在电脑上…」「帮我打开 / 建 / 下载 / 整理…」时用。它在后台一步步做，你照常聊天；'
        + '做完会有 computer.result 回来，那时再用自己的话告诉对方结果。一次交一件完整的事，别拆成好几个同时跑；'
        + '对方中途补充要求就 send 给运行中的 computer。看视频、玩游戏这类事，task 里写清看多久、玩到什么分数目标（如「至少吃 5 个果子」，别写「玩到游戏结束」——一撞墙就算完成了），并给 maxSteps。',
      paramsHint: '{"task":"要做的事，写完整具体：路径、文件名、要写的内容都带上，如「在桌面建文件夹 test，打开记事本写一句"你好"，另存为 桌面\\\\test\\\\hello.txt」","maxSteps":"可选，默认 25；玩游戏、看视频这类长活给 80～150"}',
      // drain：改配置 / 改文件触发的热重载不杀正在做的电脑任务（实测 abort 会把做到第 16 步的活掐掉），
      // 跑着的实例用旧闭包做完；真要停用 /body stop 或导演 stop
      reloadPolicy: 'drain',
      run: async (a) => {
        const task = String(a.params.task ?? '').trim()
        if (!task) {
          a.remember('想在电脑上做事，但没说要做什么（computer 缺 task），什么也没做。')
          return
        }
        // 导演常在「reply 刚结束」那拍才想起来启动 computer，那拍的唤醒原因没有频道，
        // 意图就不带频道；回报若落到 main，她会在别的对话里说「做完了」（实测）。
        // 兜底取日志里最近一条对方说的话所在的频道——那就是交代这件事的对话
        const channel = a.channel
          ?? ctx.log.history({ limit: 20 }).filter(t => t.role === 'other').at(-1)?.channel
        let ok = false
        let result: string
        let steps = 0
        let broken: string[] = [] // 这次标为「暂不可用」的工具（result 文字里已经用人话说了，这里给面板 / 复盘用）
        let detail: string | undefined // 连不上的技术细节（地址、探活次数）：只进 data 给面板看，不进她的感知——她会原样念给群友听
        try {
          // 玩游戏、看视频这类长活可以单次要更多步，但封顶，免得一句话烧掉几百次模型调用
          const asked = Math.floor(Number(a.params.maxSteps))
          const r = await runTask(ctx, a, client(), task, {
            maxSteps: asked > 0 ? Math.min(asked, 150) : cfg.maxSteps ?? 25,
            observationChars: cfg.observationChars ?? 3000,
            shots,
            channel,
            // 关键节点（开始、卡住、要问对方）发一条感知唤醒导演，让她在原对话里说一句；普通步骤只落日志不唤醒
            progress: p => ctx.io.percept({
              kind: 'computer.progress',
              channel,
              text: `电脑上的事「${task.length > 40 ? `${task.slice(0, 40)}…` : task}」${p.text}`,
              data: { actionId: a.id, task, phase: p.phase, step: p.step, question: p.question },
            }),
          })
          ;({ ok, result, steps } = r)
          broken = r.broken ?? []
        }
        catch (e) {
          if (a.signal.aborted)
            result = '做到一半被叫停了'
          else if (e instanceof BodyError) {
            // 全量测试 2026-10-22 real-debug-fragment：她在群里说「那个身体服务没起来，试了三次都不行」——系统层的词从这里漏出去的
            detail = e.message
            result = '电脑那边连不上，这次没做成（跟对方就说电脑连不上，别提地址、端口、「身体服务」这些词）'
          }
          else
            throw e // 其他错误交给动作层记 error，并照常唤醒导演
        }
        a.note(ok ? '做完了' : '没做成')
        const line = `电脑上的事「${task}」${ok ? '做完了' : '没做成'}（${steps} 步）：${result}`
        a.remember(`${line}。还没告诉对方的话，用自己的话简单说一下结果。`, { beats: 4 })
        // await：让带频道的感知先唤醒导演，再让动作结算。反过来的话，结算那次唤醒（不带频道）先开一拍，
        // 导演在那拍里就起了回报的 reply，频道回落到 main，她在别的对话里说「弄好了」（实测）
        await ctx.io.percept({
          kind: 'computer.result',
          channel,
          text: line,
          data: { actionId: a.id, task, ok, steps, result, detail, broken },
        })
      },
    }))

    // 能力教学：不教的话发言者以为自己「住在屏幕里、碰不到电脑」，反射一开口就把事推掉了，
    // 导演再顺着那句话走（实测）。和 expression-basic 教表情一样，能力由提供它的插件来教
    ctx.effect(() => ctx.prompt.section({
      id: 'computer-teaching',
      audience: 'performer',
      order: PROMPT_ORDER.teaching,
      render: () => '【你的电脑】你有一台自己的 Windows 电脑，你真的能用它做事（建文件、开软件、上网、整理东西）。'
        + '对方让你在电脑上帮忙时，只说「好，我这就去弄」这类话，别说碰不到。'
        + '「刚才发生的事」里没有电脑那边的结果，就是还没做完：绝不能说「开好了」「弄完了」「看完了」「通关了」，结果出来再说。'
        + '也别一句话里先说「这就去看」紧接着就「看完了」——你还没动手。',
    }))
    ctx.effect(() => ctx.prompt.section({
      id: 'computer-teaching-mind',
      audience: 'mind',
      order: PROMPT_ORDER.teaching,
      render: () => '【你的电脑】你有一台自己的 Windows 电脑。对方让你在电脑上做事时：start computer（params.task 把要做的事写完整具体），'
        + 'reply 照常聊（反射多半已经应了一声）。事情做没做，只看「正在运行」里有没有 computer、有没有 computer.result 回来——'
        + 'reply 嘴上说「弄好了」「看完了」不算，那只是说说（反射常常抢着这么说）；对方的要求还没有对应的 computer，就 start 一个。'
        + '对方嫌你没认真做（「才看了两秒」「根本没玩」），也是要你再去做一次。'
        + 'computer 做完会有 computer.result 唤醒你，那时 start reply（append:true，guidance 写结果要点）告诉对方；没做成也要说。'
        + '中途的 computer.progress（data.phase）：start = 开始做了、stuck = 卡住在换办法——在那个对话 start reply（append:true）用一句话说进度，别长篇；'
        + 'ask = 它要问对方（data.question）——把问题原样问对方，对方答了就 send 给那个 computer（target 用 data.actionId），它在等。'
        + '对方中途问「怎么样了」「到哪了」，按【你的电脑】里的第几步、刚做了什么如实答。',
    }))

    // 发言者也要知道电脑上此刻在干嘛：对方插一句「你在玩啥」，反射只能凭空编（实测答成「在翻网站、好多弹窗」，
    // 其实已经在玩 2048）。从运行表现算；每步都变，所以放提示词靠后（time 槽），不破坏前面的前缀缓存
    ctx.effect(() => ctx.prompt.section({
      id: 'computer-now',
      audience: 'performer',
      order: PROMPT_ORDER.time,
      // 「手头的活」一个段落管 computer 与 dsh 两类（都从日志投影，view.ts handsOn），四种状态写死：
      // 进行中 / 刚做完 / 刚失败 / 对方说了还没开始——反射抢着说「看完了 / 写好了」的毛病从材料侧堵
      render: () => {
        const runs: RunningView[] = ctx.actions.snapshot().filter(r => r.id.startsWith('computer#') || r.id.startsWith('dsh#'))
        const text = handsOn(ctx.log.events, runs)
        if (!text)
          return ''
        // 最近一次 look 看到的才是实情（任务原文常是「比如 2048、贪吃蛇…」，反射会挑错）
        const recent = [...ctx.log.events].reverse()
        const saw = runs.map((r) => {
          const obs = recent.find(e => e.type === 'computer.step' && e.data.actionId === r.id && e.data.tool === 'look')?.data.observation
          return obs ? `- ${r.id} 刚看到：${String(obs).replace('【看到的】', '').slice(0, 90)}` : ''
        }).filter(Boolean)
        return saw.length ? `${text}\n${saw.join('\n')}` : text
      },
    }))

    // 给导演一块「电脑现状」材料：反射常常先嘴上应了（甚至说「弄好了」），导演那拍又被作废，
    // 下一拍只看到「reply 完成」就以为事办完了（实测）。把「有没有 computer 在做」摆在它眼前。
    // 状态全部从运行表与日志现算，不在插件里另存一份
    ctx.intercept<{ blocks: MaterialBlock[] }>('beat/gather', async (m, next) => {
      const running = ctx.actions.snapshot().filter(r => r.id.startsWith('computer#'))
      // 「手头的活」：任务、第几步、刚做了什么、卡在哪、是否在等对方回答——都从日志现算（view.ts）
      const byId = new Map(tasksOf(ctx.log.events, 50).map(t => [t.id, t]))
      const lines = running.length
        ? running.map((r) => {
            const t = byId.get(r.id)
            const lastSaid = ctx.log.history({ channel: t?.channel ?? r.channel ?? 'main', limit: 10 }).filter(x => x.role === 'self').at(-1)?.text
            return `- 手头的活：${t ? runningBrief(t, r.note, r.runningMs, lastSaid) : `${r.id} 正在做（${Math.round(r.runningMs / 1000)}s）：${r.note}`}`
          })
        : ['- 现在没有在做的电脑任务']
      const last = [...ctx.log.events].reverse()
        .find(e => e.type === 'percept.received' && e.data.kind === 'computer.result')
      if (last)
        lines.push(`- 最近一次结果（${formatElapsed(Date.now() - last.at)}前）：${String(last.data.text).slice(0, 200)}`)
      // 反射常抢着说「我再看看…真的好了」，导演跟着判「刚回完，没什么要补」（实测两次）。
      // 把「对方最新一句之后有没有起过电脑上的活」这个结构事实算出来摆着，不靠它自己从历史里推
      const said = [...ctx.log.events].reverse().find(e => e.type === 'percept.received' && e.data.sender && e.data.text)
      // 按同一对话判断：别的对话里刚起的 computer 不算（多对话并行时实测误判成「已经起过」）
      const saidChannel = said?.data.channel ?? 'main'
      const runningHere = running.some(r => (r.channel ?? 'main') === saidChannel)
      if (said && !runningHere && Date.now() - said.at < 10 * 60_000) {
        const acted = ctx.log.events.some(e => e.at >= said.at && e.type === 'action.started'
          && (e.data.type === 'computer' || e.data.type === 'dsh') && (e.data.channel === undefined || e.data.channel === saidChannel))
        if (!acted)
          lines.push(`- 对话 ${saidChannel} 里对方最新一句（${formatElapsed(Date.now() - said.at)}前）「${String(said.data.text).slice(0, 80)}」之后那个对话还没起过 computer / dsh。它要是让你在电脑上做事（看、玩、找、装、写…），这一拍就 start，别只回嘴`)
      }
      m.blocks.push({
        from: 'action-computer',
        order: 30,
        text: `【你的电脑】\n${lines.join('\n')}\n对方让你在电脑上做、但上面没有的事，就是还没开始做。`,
      })
      return next()
    })

    ctx.effect(() => commands.register({
      name: 'body',
      usage: 'body [stop]',
      description: '身体服务（她的电脑）状态；stop = 急停所有正在做的电脑任务',
      async run(args, io) {
        if (args[0] === 'stop') {
          const ids = stopAll()
          io.print(ids.length ? `已叫停 ${ids.length} 个电脑任务：${ids.join('、')}` : '没有正在做的电脑任务')
          return
        }
        const c = client()
        try {
          const h = await c.health(AbortSignal.timeout(10_000))
          io.print(`身体服务 ${c.url}：${JSON.stringify(h)}`)
        }
        catch (e) {
          io.print(e instanceof Error ? e.message : String(e))
        }
      },
    }))
  },
}

export default plugin
