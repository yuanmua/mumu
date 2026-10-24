/**
 * 电脑任务的工具循环：task.agent 角色每步输出一个 JSON（调哪个工具 / 做完了），
 * 本模块去身体服务执行、把结果作为下一轮的观察交回，直到完成、放弃或步数用尽。
 *
 * 立场：
 * - 模型网关只有文本消息、没有原生 tools，所以用「JSON 决定下一步」：JSON 约束 + 校验 +
 *   解析失败附错误重来，不用正则抓模型输出（handbook §9.2）。
 * - 每一步落日志 `computer.step`（真源）：她在电脑上做过什么随时能查，也是急停之后复盘的依据。
 * - 旧观察压缩：最近几步原样保留，更早的只留开头——控件树一次就几千字，全留着上下文会爆。
 * - 导演 send 来的话（对方补充的要求）在下一步之前作为「对方补充」插进对话。
 */
import type { ActionRun, ChatMessage, Ctx, LogEvent } from '../../../src/index.ts'
import { sleep } from '../../../src/index.ts'
import type { BodyClient } from './body.ts'
import { BodyError, busyText, TOOL_NAMES, TOOLS } from './body.ts'
import { ToolHealth } from './broken.ts'
import type { LookResult } from './look.ts'
import { look } from './look.ts'
import { isError } from './view.ts'

/** 关键节点的进度：start 开始做、stuck 连着出错、ask 要问对方。普通步骤不报（只落 computer.step 日志） */
export interface Progress {
  phase: 'start' | 'stuck' | 'ask'
  step: number
  text: string // 人能看懂的一句
  question?: string // ask 时要问对方的话
}

export interface AgentConfig {
  maxSteps: number
  observationChars: number
  channel?: string // 发起这件事的对话，随每条 computer.step 落日志（网页按对话投影进度用）
  progress?: (p: Progress) => Promise<void> // 关键节点回报（index.ts 发 computer.progress 感知唤醒导演）
  askTimeoutSec?: number // ask 之后等对方回答多久，默认 10 分钟
  // 每一步做完留一张屏幕小图（存进媒体目录，返回文件名，网页「电脑任务」面板按链接看）；不给就不截
  shots?: { scale: number, save: (img: { bytes: Buffer, mime: string }) => Promise<string> }
}

export interface AgentResult {
  ok: boolean
  result: string
  steps: number
  broken?: string[] // 这次任务里标为「暂不可用」的工具（同一工具连着两次同一个错误，broken.ts）
}

const KEEP_FULL = 4 // 最近几条观察原样保留
const OLD_OBS_CHARS = 300

const RULES = `你在操作一台 Windows 11（中文界面）电脑，替主人完成一件具体的事。你每次只调用一个工具，看到结果再决定下一步。

【做法】
- 能用命令可靠完成的（建文件夹、写文件、查路径、核实结果）优先用 exec 跑 PowerShell。
- 任务明确要在某个程序的界面里做（如「打开记事本写…」「打开设置里的…」），就真的在界面里做：apps 启动 → ui_tree 看控件 → ui_click / type → 需要时 key。
  「打开 X 里的 Y」：先打开 X 的首页，再用 ui_click 一级级点到 Y，别用 URI 或命令直接跳——对方要的是你在界面里真的点过去。
- 界面一变就重新 ui_tree；编号 #n 只在最近一次 ui_tree 内有效。找控件优先按名字（name + controlType），比坐标可靠；mouse 是最后的办法。
- 键盘只发给前台窗口。如果结果说「切不到前台」，别反复重试：改用 ui_click / exec，实在不行就结束并说明原因。
- 做完一定核实（比如 exec 里 Test-Path / Get-Content 看文件真的在、内容对），再输出 done。
- 找图、存图：browser open 必应图片搜索（https://www.bing.com/images/search?q=关键词）→ browser images 列出图片 → browser download 按编号存到要求的目录（dir）→ exec 核实文件在。
  不要右键「图片另存为」、不要在图片网格上点缩略图找大图（控件树里没有图片，点不开，40 步都会耗在这上面）。
- 同一个工具连着两次报一字不差的错误，它就是坏了（结果里会标【工具暂不可用】）：别再试第三次，换路线；换不了就 done ok:false，result 里写清「某某工具坏了」，别说成「点不开 / 找不到」。

【经验】
- 桌面路径先查：exec [Environment]::GetFolderPath('Desktop')，可能在 OneDrive 下面。
- Win11 记事本会恢复上次的标签页，直接 ctrl+s 可能存到旧文件上；新内容存成新文件用 ctrl+shift+s（另存为），在「另存为」窗口的「文件名:」框（Edit）填完整路径，再点「保存(S)」。
- 设置里的「显示」在中文版可能叫「屏幕」（系统 › 屏幕）。
- 窗口标题可能是英文（记事本的标题是「… - Notepad」）。
- 网页上点了两次都超时的按钮，别再点第三次：换 selector，或用它的快捷键（browser press，如 YouTube 播放 / 暂停是 k）。
- 看视频要真的看：开始播放后每隔 30～60 秒（wait 几次）look 一次画面，能读到字幕 / 简介 / 评论就 browser read 读，
  看够任务要求的时长（没说就看 3 分钟左右）再结束；result 里写看到的具体内容（画面、说了什么、评论在吵什么）和实际看了多久，别拿标题和简介凑。
- 玩游戏要玩到任务给的目标：每操作几步就看一次局面（能 browser read 读到分数 / 格子就读文字，读不到再 look），没达到目标别输出 done；
  result 写最终分数或结局。任务只说「通关」而这游戏一局通不了（2048 要上千步）就先给自己定一个这局做得到的目标（如 2048 合出 256），
  第一步的 say 里说清；键盘游戏一步按一串键（browser press 逗号分隔 + repeat，一步几十下）再看局面，别一步一个键。
  游戏必须你自己操作（key / browser press / mouse / reflex）：不许写脚本、开自动玩程序、用 eval 改游戏状态或注入自动寻路代替你玩——那不叫玩。
  实时游戏（蛇一直在跑的格子类游戏）：你一步要好几秒，按完键再看时局面早变了——别怀疑「按键被重复发送」、别去读游戏代码找 bug，也别暂停当回合制玩。
  用 reflex：它是你的手上反应，只看画面按键，策略和目标都是你定的，算你自己玩。先 apps start 开游戏拿到 pid → reflex probe 看颜色 →
  look / 截图量出棋盘区域和格子数 → reflex grid 核对字符画 → reflex start（chase 追食物，stopWhen 写目标）→ 每隔几秒 wait + reflex state 看进展，
  死了就按游戏的重开键再 start；达到目标 stop，截图发结果。分低就分低，result 里如实写。
  「玩到游戏结束」不是目标，拿分才是：一局死了而目标没达到（比如 0 分）、步数还剩一半以上，就重开再玩（R / 空格 / 回车，看游戏提示），
  换上面的回合制玩法；步数快用完时再截最好那局的图收尾。任务没写分数目标就自己定一个（贪吃蛇至少吃 5 个），第一步 say 里说清。
- 开程序（游戏、窗口、写好的脚本）一律用 apps start（path 给解释器、args 给脚本），不要在 exec 里 Start-Process / cmd 去开：
  exec 开出来的会带一个命令行窗口、权限也可能不一样，按键会发不进去（实测她因此以为「窗口不理我」，转去写脚本代玩）。
  开之前先 windows 看有没有同名的旧窗口，有就 apps close（按 pid）关掉——同名窗口多开时按键会发进旧窗口；只剩一个，key 的 window 用标题就只会命中它。玩完 / 不用了也按 pid 关掉，别留在桌面上。
- 【对方补充】和「对方刚在对话里说」是对方的新要求，优先于原任务：和你正在做的冲突就立刻改做法（比如叫你别用脚本就马上停掉脚本）。
  网页游戏的局面优先用 browser eval 跑 JS 读（如 2048 读 .tile 的文字、.score-container），读不到再 look；桌面游戏用 key 的 repeat。
- 等待用 wait 一次等 30～60 秒（上限 60），别每 10 秒一步地耗步数。
- 结果说「还在电脑上执行」「排队没轮到」「结果不明」时，别原样再做一遍：先 windows 看是不是弹了提示框在等人（比如 UAC 确认框——那是主人的事，你别点），
  或 exec 查现状（文件在不在、进程在不在），再决定。exec 超过 timeoutSec 会连同它起的程序一起结束（结果里 timedOut）；装软件这类慢活 timeoutSec 给够（如 300）。

【不要做】
- 不改用户账户、UAC、密码、安全或防火墙设置；不输入任何密码；不删任务没让删的东西。遇到需要这些的，直接结束并说明。

【输出】只输出一个 JSON 对象，不要任何多余文字：
调用工具：{"say":"一句话说你这步在干嘛（给旁人看）","tool":"工具名","args":{…}}
要问对方（需要对方拿主意、确认或补信息时，比如有两个同名文件删哪个、要不要覆盖、装哪个版本）：{"ask":"要问的话，一句"}——会停下来等对方回答，答复以【对方补充】回来；别为能自己查到的事问。
结束：{"done":true,"ok":true 或 false,"result":"做成了什么 / 为什么没做成，写清具体结果（路径、内容）"}

【工具】
${TOOLS.map(t => `- ${t.name}: ${t.doc}`).join('\n')}`

type Step =
  | { kind: 'tool', say: string, tool: string, args: Record<string, unknown> }
  | { kind: 'ask', question: string }
  | { kind: 'done', ok: boolean, result: string }


/**
 * 对方在发起这件事的那个对话里新说的话，直接进工具循环，不经导演转：
 * 原来只靠导演 send，它常常嘴上应了不转（实测「别写脚本替你玩」导演回了句「得盯着点」，电脑那边照样跑脚本）。
 * 导演再 send 一遍也无妨，模型看到重复的补充只会更确定。
 */
export async function runTask(
  ctx: Ctx,
  a: ActionRun,
  body: BodyClient,
  task: string,
  cfg: AgentConfig,
): Promise<AgentResult> {
  const extra: string[] = [] // 导演 send 来的补充 + 对方在同一对话里新说的话
  const channel = a.channel ?? ctx.log.history({ limit: 20 }).filter(t => t.role === 'other').at(-1)?.channel
  const off = ctx.bus.on('log.appended', (e: LogEvent) => {
    const d = e.data ?? {}
    if (e.type === 'percept.received' && d.sender && typeof d.text === 'string' && d.text.trim() && (d.channel ?? 'main') === (channel ?? 'main'))
      extra.push(`对方刚在对话里说：「${d.text.trim().slice(0, 300)}」`)
  })
  try {
    return await runLoop(ctx, a, body, task, cfg, extra)
  }
  finally {
    off()
  }
}

async function runLoop(
  ctx: Ctx,
  a: ActionRun,
  body: BodyClient,
  task: string,
  cfg: AgentConfig,
  extra: string[],
): Promise<AgentResult> {
  a.note('看看电脑在不在')
  const h = await body.health(a.signal, 3) // 一次没回应不等于不在（实测上一件事卡住时连着三个任务开头就判了连不上）
  if (h.interactive === false)
    return { ok: false, result: '身体服务没跑在她的登录桌面里（session 0），界面操作做不了', steps: 0 }
  const busy = busyText(h)

  const messages: ChatMessage[] = [
    { role: 'system', content: RULES },
    { role: 'user', content: `任务：${task}\n\n电脑现状：用户 ${String(h.user)}，屏幕 ${JSON.stringify(h.screen)}。${busy ? `身体那边还有之前的活没做完：${busy}（同类操作会排在它后面）。` : ''}开始吧。` },
  ]
  void (async () => {
    for await (const m of a.inbox) extra.push(m)
  })()

  const report = async (p: Progress): Promise<void> => {
    try {
      await cfg.progress?.(p)
    }
    catch (e) {
      console.error('[computer] 进度回报失败:', e) // 回报只是旁路：发不出去不影响做事
    }
  }
  let badOutputs = 0
  let errorStreak = 0
  let verify: 'none' | 'asked' | 'asked2' | 'evidence' = 'none' // done 之前的核实状态
  let evidence = '' // 核实步骤的观察，带进结果
  let stuckReported = false
  const health = new ToolHealth() // 同一工具连着两次同一个错误 → 这次任务里不再用它
  // 任何一种结束都把坏掉的工具写进结果：她要能如实说「浏览器工具坏了」，而不是「图点不开」
  const finish = (r: AgentResult): AgentResult => {
    const s = health.summary()
    return { ...r, broken: health.tools, result: s ? `${r.result}。${s}` : r.result }
  }
  for (let i = 1; i <= cfg.maxSteps; i++) {
    if (a.signal.aborted)
      return finish({ ok: false, result: '被叫停了', steps: i - 1 })
    if (extra.length)
      messages.push({ role: 'user', content: `【对方补充】${extra.splice(0).join('；')}` })

    compact(messages)
    const raw = await ctx.model.complete({ role: 'task.agent', messages, signal: a.signal })
    if (a.signal.aborted)
      return finish({ ok: false, result: '被叫停了', steps: i - 1 })
    messages.push({ role: 'assistant', content: raw })

    let step: Step
    try {
      step = parseStep(raw)
      badOutputs = 0
    }
    catch (e) {
      // 结构化输出失败：附错误重来；连续两次就放弃，免得空转烧步数
      if (++badOutputs >= 2)
        return finish({ ok: false, result: `我这边的思路乱了（连续输出无法解析：${String(e)}）`, steps: i })
      messages.push({ role: 'user', content: `上面的输出无法解析（${String(e)}）。只输出一个合法的 JSON 对象。` })
      continue
    }

    if (step.kind === 'done') {
      // 说「做成了」必须先拿证据：模型会只查两次路径就编出「六个文件都建好、每个都核对过」（实测，文件根本不存在）。
      // 第一次 done 不收，逼它用工具核实；核实步骤跑过（有真实观察）再 done 才收，并把证据摘要带进结果；两次都不肯拿证据就按没做成
      if (step.ok && verify !== 'evidence') {
        if (verify === 'none' || verify === 'asked') {
          verify = verify === 'none' ? 'asked' : 'asked2'
          a.note(`第 ${i} 步：说做成了，先拿证据核实`)
          messages.push({
            role: 'user',
            content: verify === 'asked'
              ? '【核实】你说做成了，先别结束。用一个工具拿出证据：文件就 exec 列目录并 Get-Content 读内容，网页就 browser read，界面就 ui_tree 或 look。只输出那个工具调用的 JSON；证据对不上就继续做，或输出 done ok:false 如实说没做成。'
              : '【核实】上一条没有调工具就又说做成了——没有工具结果的「做成了」不算数。现在只允许输出一个工具调用的 JSON 去拿证据。',
          })
          continue
        }
        // asked2 之后还是不拿证据：如实报没做成
        const shot = await keepShot(body, cfg.shots, undefined, a.signal)
        const r = finish({ ok: false, result: `说做成了但拿不出证据（没有核实步骤），按没做成算。它的说法是：${step.result}`, steps: i })
        ctx.log.append('computer.step', { actionId: a.id, channel: cfg.channel, step: i, done: true, ok: false, result: r.result, shot, broken: r.broken })
        return r
      }
      // 做完时的屏幕也留一张：结果说「保存好了」，图上能看出到底存没存
      const shot = await keepShot(body, cfg.shots, undefined, a.signal)
      const r = finish({ ok: step.ok, result: step.ok && evidence ? `${step.result}（核实到的：${clip(evidence, 240)}）` : step.result, steps: i })
      ctx.log.append('computer.step', { actionId: a.id, channel: cfg.channel, step: i, done: true, ok: step.ok, result: r.result, shot, broken: r.broken })
      return r
    }

    if (step.kind === 'ask') {
      // 停下来等对方拿主意：导演把问题转给对方，对方答了导演 send 回来（进 inbox）
      a.note(`第 ${i} 步：在问对方——${step.question}`)
      ctx.log.append('computer.step', { actionId: a.id, channel: cfg.channel, step: i, say: `问对方：${step.question}`, tool: 'ask', args: {}, observation: '' })
      await report({ phase: 'ask', step: i, text: `做到第 ${i} 步，要问一下：${step.question}`, question: step.question })
      // 转问的 reply 可能被硬闸拦掉、导演却以为问过了（实测）：一分钟没回答就再唤醒一次
      const answer = await waitAnswer(extra, (cfg.askTimeoutSec ?? 600) * 1000, a.signal, () =>
        report({ phase: 'ask', step: i, text: `问了一分钟还没得到回答，可能没问出口，再问一次：${step.question}`, question: step.question }))
      if (a.signal.aborted)
        return finish({ ok: false, result: '被叫停了', steps: i })
      if (answer === undefined)
        return finish({ ok: false, result: `问了对方「${step.question}」，等了 ${Math.round((cfg.askTimeoutSec ?? 600) / 60)} 分钟没有回答，先停下了`, steps: i })
      messages.push({ role: 'user', content: `【对方补充】${answer}` })
      continue
    }

    a.note(`第 ${i} 步：${step.say || step.tool}`)
    if (i === 1)
      await report({ phase: 'start', step: 1, text: `开始做了，第一步：${step.say || step.tool}` })
    let obs: string
    let image: { bytes: Buffer, mime: string } | undefined
    if (health.isBroken(step.tool)) {
      // 已经标为坏了还叫：不去身体服务（去了也是同一个错），直接告诉它换路线，省一次往返
      obs = health.refusal(step.tool)
    }
    else if (step.tool === 'look') {
      const r = await look(ctx, body, step.args, a.signal).catch((e: unknown): LookResult => {
        if (e instanceof BodyError || a.signal.aborted)
          throw e
        return { text: `出错：看图失败（${e instanceof Error ? e.message : String(e)}），换 ui_tree / browser read 读文字` }
      })
      obs = r.text
      image = r.image
    }
    else {
      obs = await execute(body, step, a.signal, t => a.note(`第 ${i} 步：${t}`))
    }
    if (health.record(step.tool, obs)) {
      // 刚好在这一步判定坏了：提示附在观察后面，模型下一步就知道换路线
      a.note(`第 ${i} 步：${step.tool} 连着两次同一个错误，标为暂不可用，换路线`)
      obs = `${obs}\n${health.notice(step.tool)}`
    }
    const shot = await keepShot(body, cfg.shots, image, a.signal)
    ctx.log.append('computer.step', {
      actionId: a.id,
      channel: cfg.channel,
      step: i,
      say: step.say,
      tool: step.tool,
      args: step.args,
      observation: obs.slice(0, 2000),
      shot,
    })
    messages.push({ role: 'user', content: `【结果】${clip(obs, cfg.observationChars)}` })
    if (verify === 'asked' || verify === 'asked2') {
      // 核实步骤跑过了：这条观察就是证据，之后的 done 才收
      verify = 'evidence'
      evidence = isError(obs) ? '' : obs
    }
    // 单次出错是常态（控件没找到就换办法），连着两步都不通才叫卡住；一轮卡住只报一次，顺了之后再卡再报
    if (isError(obs)) {
      if (++errorStreak >= 2 && !stuckReported) {
        stuckReported = true
        await report({ phase: 'stuck', step: i, text: `第 ${i} 步卡住了（连着 ${errorStreak} 步没走通）：${step.say || step.tool} → ${obs.slice(0, 120)}，在换办法` })
      }
    }
    else {
      errorStreak = 0
      stuckReported = false
    }
  }
  // 步数用完：让它把进展说清再停。只回一句「N 步没做完」时她只能干巴巴认输，说不出玩到哪了（实测 2048 那局）
  let progress = ''
  try {
    messages.push({ role: 'user', content: '步数用完了，现在必须停。输出 done（ok 按是否达到目标填），result 写清做到哪一步了：具体进展、分数 / 局面、卡在哪。' })
    const last = parseStep(await ctx.model.complete({ role: 'task.agent', messages, signal: a.signal }))
    if (last.kind === 'done')
      progress = last.result
  }
  catch {
    progress = '' // 总结失败不影响停下：退回只报步数，安全
  }
  return finish({ ok: false, result: `${cfg.maxSteps} 步还没做完，先停下了${progress ? `：${progress}` : ''}`, steps: cfg.maxSteps })
}

/**
 * 这一步做完屏幕是什么样：look 刚取的图直接留，否则现截一张小的。
 * 截不到（锁屏、身体掉线、被叫停）就不留：截图只是旁证，身体掉线由下一步的工具调用正式报出来，这里不抢着报。
 */
async function keepShot(
  body: BodyClient,
  shots: AgentConfig['shots'],
  image: { bytes: Buffer, mime: string } | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!shots || signal.aborted)
    return undefined
  try {
    const img = image ?? await body.image(undefined, signal, shots.scale)
    return 'error' in img ? undefined : await shots.save(img)
  }
  catch {
    return undefined // 见上：旁证拿不到不影响这一步
  }
}

async function execute(body: BodyClient, step: Extract<Step, { kind: 'tool' }>, signal: AbortSignal, onWait: (text: string) => void): Promise<string> {
  if (step.tool === 'wait') {
    const sec = Math.min(Math.max(Number(step.args.sec) || 1, 0), 60)
    await sleep(sec * 1000, signal)
    return `等了 ${sec} 秒`
  }
  const def = TOOLS.find(t => t.name === step.tool)!
  try {
    const r = await body.call(def.path!, step.args, signal, onWait)
    // 控件树的正文是排好版的文本，直接给，比 JSON 转义后好读得多
    if (step.tool === 'ui_tree' && typeof r.text === 'string')
      return `${String(r.window)}${r.truncated ? '（节点太多已截断，可缩小 depth 或换个窗口）' : ''}\n${r.text}`
    return JSON.stringify(r)
  }
  catch (e) {
    if (e instanceof BodyError)
      throw e // 连不上身体服务：整件事做不下去，交给上层收尾
    if (signal.aborted)
      throw e
    return `出错：${e instanceof Error ? e.message : String(e)}`
  }
}

/** 等导演 send 来的下一条（对方的回答）；超时或被叫停返回 undefined。remind：一分钟没回答时叫一次 */
async function waitAnswer(extra: string[], timeoutMs: number, signal: AbortSignal, remind?: () => Promise<void>): Promise<string | undefined> {
  const started = Date.now()
  const until = started + timeoutMs
  let reminded = false
  while (Date.now() < until && !signal.aborted) {
    if (extra.length)
      return extra.splice(0).join('；')
    if (!reminded && remind && Date.now() - started > 60_000) {
      reminded = true
      await remind()
    }
    await sleep(500, signal) // 被叫停时 sleep 立即返回，循环条件会退出
  }
  return undefined
}

function parseStep(text: string): Step {
  const obj = JSON.parse(extractJson(text)) as Record<string, unknown>
  if (typeof obj.ask === 'string' && obj.ask.trim())
    return { kind: 'ask', question: obj.ask.trim() }
  if (obj.done === true) {
    return {
      kind: 'done',
      ok: obj.ok !== false,
      result: typeof obj.result === 'string' ? obj.result : '（没写结果）',
    }
  }
  if (typeof obj.tool !== 'string' || !TOOL_NAMES.has(obj.tool))
    throw new TypeError(`tool 必须是 ${[...TOOL_NAMES].join(' / ')} 之一，或输出 done`)
  const args = obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
    ? obj.args as Record<string, unknown>
    : {}
  return { kind: 'tool', say: typeof obj.say === 'string' ? obj.say : '', tool: obj.tool, args }
}

/** 更早的观察只留开头：模型需要知道那步做过、大致结果，不需要几千字的旧控件树 */
function compact(messages: ChatMessage[]): void {
  const obsIdx = messages
    .map((m, i) => (m.role === 'user' && m.content.startsWith('【结果】') ? i : -1))
    .filter(i => i >= 0)
  for (const i of obsIdx.slice(0, -KEEP_FULL)) {
    const c = messages[i].content
    if (c.length > OLD_OBS_CHARS)
      messages[i] = { role: 'user', content: `${c.slice(0, OLD_OBS_CHARS)}…（旧结果已省略）` }
  }
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…（截断，共 ${s.length} 字）`
}

/** 提取第一个配平的 JSON 对象，容忍外层多余文本与代码围栏 */
function extractJson(text: string): string {
  const start = text.indexOf('{')
  if (start < 0)
    throw new Error('输出中没有 JSON')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc)
        esc = false
      else if (c === '\\')
        esc = true
      else if (c === '"')
        inStr = false
    }
    else if (c === '"') {
      inStr = true
    }
    else if (c === '{') {
      depth++
    }
    else if (c === '}') {
      depth--
      if (!depth)
        return text.slice(start, i + 1)
    }
  }
  throw new Error('JSON 未闭合')
}
