/**
 * 角色包的形状与校验。纯函数，不碰文件系统、不碰 ctx。
 *
 * 一个角色包 = 一份 character.json：她是谁（persona）、在哪个舞台上、用什么声音。
 * 这里只认形状不认内容：人设怎么写是 persona 的事，舞台档案怎么写是前端的事，
 * 本文件只保证 /character use 写出去的配置不会是半个。
 */
export type StageKind = 'live2d' | 'tachie'

export interface CharacterPack {
  id: string
  name: string
  persona: {
    prompt: string
    style?: string
    markers?: Record<string, string[]> // 键为 marker 通道 track，值为词汇
    aliases?: Record<string, string> // 各平台网名：键为平台（qq…），值为网名；真名是 name
  }
  stage: {
    kind: StageKind
    profile: string // 相对 apps/web/public 的目录，前端去 /<profile>/profile.json 取档案
  }
  voice?: { voice?: string }
}

const KINDS: StageKind[] = ['live2d', 'tachie']

function str(v: unknown, what: string, required: true): string
function str(v: unknown, what: string, required?: false): string | undefined
function str(v: unknown, what: string, required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required)
      throw new Error(`缺 ${what}`)
    return undefined
  }
  if (typeof v !== 'string' || !v.trim())
    throw new Error(`${what} 必须是非空字符串`)
  return v
}

function markers(v: unknown): Record<string, string[]> | undefined {
  if (v === undefined)
    return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('persona.markers 必须是 { 通道: [词…] }')
  const out: Record<string, string[]> = {}
  for (const [track, words] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(words) || words.some(w => typeof w !== 'string' || !w.trim()))
      throw new Error(`persona.markers.${track} 必须是非空字符串数组`)
    out[track] = words as string[]
  }
  return out
}

function aliases(v: unknown): Record<string, string> | undefined {
  if (v === undefined)
    return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('persona.aliases 必须是 { 平台: 网名 }')
  for (const [platform, handle] of Object.entries(v as Record<string, unknown>))
    str(handle, `persona.aliases.${platform}`, true)
  return v as Record<string, string>
}

/** 把一份 character.json 解析成角色包；形状不对就抛错说清哪一项 */
export function parseCharacter(raw: unknown, fallbackId: string): CharacterPack {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('character.json 必须是对象')
  const r = raw as Record<string, unknown>
  const persona = r.persona
  if (!persona || typeof persona !== 'object')
    throw new Error('缺 persona')
  const p = persona as Record<string, unknown>
  const stage = r.stage
  if (!stage || typeof stage !== 'object')
    throw new Error('缺 stage')
  const s = stage as Record<string, unknown>
  const voice = r.voice && typeof r.voice === 'object' ? (r.voice as Record<string, unknown>) : undefined
  return {
    id: str(r.id, 'id') ?? fallbackId,
    name: str(r.name, 'name', true),
    persona: {
      prompt: str(p.prompt, 'persona.prompt', true),
      style: str(p.style, 'persona.style'),
      markers: markers(p.markers),
      aliases: aliases(p.aliases),
    },
    stage: parseStage(s.kind, s.profile),
    voice: voice ? { voice: str(voice.voice, 'voice.voice') } : undefined,
  }
}

/** 舞台的形状校验：角色包与 /character skin 共用，换皮肤写出去的舞台和角色包里的同一个标准 */
export function parseStage(rawKind: unknown, rawProfile: unknown): CharacterPack['stage'] {
  const kind = str(rawKind, 'stage.kind', true)
  if (!KINDS.includes(kind as StageKind))
    throw new Error(`stage.kind 只能是 ${KINDS.join(' | ')}，收到 ${kind}`)
  // profile 是 URL 片段：去掉首尾斜杠，前端统一拼 /<profile>/profile.json
  const profile = str(rawProfile, 'stage.profile', true).replace(/^\/+|\/+$/g, '')
  // 它会被拼进 URL 去取档案；带 .. 的路径没有正当用途，挡掉免得指出站点根
  if (profile.split('/').includes('..'))
    throw new Error(`stage.profile 不能含 ..，收到 ${profile}`)
  return { kind: kind as StageKind, profile }
}
