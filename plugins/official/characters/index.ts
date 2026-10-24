/**
 * 角色包插件：把「她是谁、站在哪个舞台上、用什么声音」打包成一个目录，一条命令整体切换。
 *
 * 立场：
 * - 本插件不持有角色状态。切换 = 把角色包的内容写进各自插件的配置
 *   （persona 的人设、tts 的声音、surface-web 的 character），由装配层按既有规则重载它们。
 *   所以它消失了角色也还在；它只是「一次写多处」的快捷方式。
 * - 舞台信息走 web/meta 水线进 meta.character.stage。surface-web 不认识角色包，前端不写死任何角色。
 * - 角色包目录随插件走（characters/<id>/character.json），坏掉的包跳过并告警，不拖垮别的包。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigService, Plugin } from '../../../src/index.ts'
import type { CommandService } from '../commands/index.ts'
import { parseCharacter, parseStage } from './pack.ts'
import type { CharacterPack } from './pack.ts'
import { webExtras } from './web.ts'

interface CharactersConfig {
  dir?: string // 角色包目录，相对本插件目录
}

/**
 * 写进 plugins.surface-web.character 的形状；前端经 /api/meta 拿到其中的 stage。
 * id 可缺：从没 /character use 过、直接换皮肤时，不知道「当前角色」是哪个包，也不该猜。
 */
interface Current {
  id?: string
  stage: CharacterPack['stage']
}

function scan(root: string): Map<string, CharacterPack> {
  const packs = new Map<string, CharacterPack>()
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  }
  catch {
    // 目录不存在 = 没有角色包；命令仍登记，list 会说明
    return packs
  }
  for (const dir of dirs) {
    const file = join(root, dir, 'character.json')
    try {
      const pack = parseCharacter(JSON.parse(readFileSync(file, 'utf8')), dir)
      if (packs.has(pack.id))
        throw new Error(`id "${pack.id}" 与另一个角色包重复`)
      packs.set(pack.id, pack)
    }
    catch (e) {
      // 一个坏包不该让整个插件起不来；告警后跳过它
      console.warn(`[characters] 跳过 ${file}:`, e instanceof Error ? e.message : e)
    }
  }
  return packs
}

const plugin: Plugin<CharactersConfig> = {
  name: 'characters',
  inject: ['config', 'commands'],
  apply(ctx, cfg = {}) {
    const here = dirname(fileURLToPath(import.meta.url))
    const packs = scan(join(here, cfg.dir ?? 'characters'))
    const config = ctx.use<ConfigService>('config')
    const commands = ctx.use<CommandService>('commands')
    const current = (): Current | undefined => config.get<Current>('plugins.surface-web.character')

    // surface-web 的配置最后写、且延后写：写入即重载它，重载会立刻断开全部连接——
    // 包括此刻可能正在跑这条命令的那个 HTTP 请求（Web 页面）。先让回复发出去。
    const setCurrent = (next: Current): void => {
      setTimeout(() => config.set('plugins.surface-web.character', next), 300)
    }

    const use = (pack: CharacterPack): void => {
      // persona：先整棵写入（顶层路径不触发重载），再写一个叶子触发恰好一次重载。
      // 逐个叶子写会触发多次并发重载，装配层的 unload/load 会互相打架。
      const persona = {
        ...(config.get<Record<string, unknown>>('plugins.persona') ?? {}),
        name: pack.name,
        prompt: pack.persona.prompt,
        style: pack.persona.style ?? '',
        markers: pack.persona.markers ?? {},
        // 网名跟着角色走：包里没写就存 null（merge patch 的「删除」），否则 persona 默认里沐沐的 QQ 网名会合并到别的角色身上
        aliases: pack.persona.aliases ?? null,
      }
      config.set('plugins.persona', persona)
      config.set('plugins.persona.name', pack.name)
      if (pack.voice?.voice)
        config.set('plugins.tts.voice', pack.voice.voice)
      setCurrent({ id: pack.id, stage: pack.stage })
    }

    /** 只换舞台不换人设：名字、性格、声音都留着，只是「这阵子长这样」 */
    const skin = (profile: string, kind = 'live2d'): Current['stage'] => {
      const stage = parseStage(kind, profile)
      setCurrent({ ...current(), stage })
      return stage
    }

    ctx.effect(() => commands.register({
      name: 'character',
      usage: 'character list | use <id> | skin <profile> [live2d|tachie]',
      description: '角色包：列出 / 整体切换角色（人设、舞台、声音）/ 只换当前角色的舞台皮肤',
      run(args, io) {
        const [op, id] = args
        if (op === 'list') {
          if (!packs.size) {
            io.print('  没有角色包；在插件目录 characters/<id>/character.json 加一个')
            return
          }
          const cur = current()
          for (const p of packs.values()) {
            const skinned = p.id === cur?.id && cur.stage.profile !== p.stage.profile ? `，皮肤 ${cur.stage.profile}` : ''
            const mark = p.id === cur?.id ? `  ← 当前${skinned}` : ''
            const voice = p.voice?.voice ? `  声音 ${p.voice.voice}` : ''
            io.print(`  ${p.id}  ${p.name}  舞台 ${p.stage.kind}（${p.stage.profile}）${voice}${mark}`)
          }
          return
        }
        if (op === 'use') {
          const pack = id ? packs.get(id) : undefined
          if (!pack)
            throw new Error(id ? `没有叫 ${id} 的角色包；/character list 看全部` : '用法: /character use <id>')
          use(pack)
          io.print(`  ✓ 切到 ${pack.name}（${pack.id}）：人设已写入 persona，舞台 ${pack.stage.kind}${pack.voice?.voice ? `，声音 ${pack.voice.voice}` : ''}`)
          io.print('  网页会在重连后换舞台；终端下一句话起生效')
          return
        }
        if (op === 'skin') {
          if (!id)
            throw new Error('用法: /character skin <profile> [live2d|tachie]，例：/character skin live2d/models/haru')
          const stage = skin(id, args[2])
          io.print(`  ✓ 皮肤换成 ${stage.kind}（${stage.profile}）；人设不变，网页重连后换舞台`)
          return
        }
        throw new Error('用法: /character list | use <id> | skin <profile> [live2d|tachie]')
      },
    }))

    // 读配置而不是读内存：切换角色后本插件不会重载，surface-web 的 character 却已变
    ctx.intercept<{ character?: Record<string, unknown>, characters?: unknown }>('web/meta', async (meta, next) => {
      const cur = current()
      if (cur?.stage)
        meta.character = { ...meta.character, stage: cur.stage }
      if (cur?.id)
        meta.character = { ...meta.character, id: cur.id }
      meta.characters = [...packs.values()].map(p => ({ id: p.id, name: p.name, stage: p.stage }))
      return next()
    })

    webExtras(ctx, { packs, current, use })
  },
}

export default plugin
