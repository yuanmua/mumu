/**
 * 人格面板的表单 ↔ 协议形状（/api/persona）。纯函数，vitest 测。
 *
 * 表单只编辑 emo、act 两组词（逗号分隔）；别的 marker 通道原样带回去，
 * 因为 POST 的 markers 是整体替换，丢了就是删了。
 * 「要求」三态：内置（null）/ 自定义（整段）/ 不要（''）——和 persona 插件的配置语义一一对应。
 */
import type { Persona } from '../../protocol/types.ts'

export type RulesMode = 'default' | 'custom' | 'none'

export interface PersonaForm {
  name: string
  prompt: string
  style: string
  rulesMode: RulesMode
  rules: string
  emo: string
  act: string
  others: Record<string, string[]> // 表单不编辑的通道，保存时原样带回
  aliases: string // 一行一个「平台：网名」，如「qq：沐沐小号」
}

/** 中英文逗号、顿号都算分隔；去空、去重。用户手打的词表，不是模型输出 */
export function splitWords(s: string): string[] {
  return [...new Set(s.split(/[,，、]/).map(w => w.trim()).filter(Boolean))]
}

export const formatAliases = (a: Record<string, string> = {}): string => Object.entries(a).map(([p, h]) => `${p}：${h}`).join('\n')

/** 「平台：网名」逐行解析（中英文冒号都认）；坏行给出原因 */
export function parseAliases(text: string): { value: Record<string, string> } | { error: string } {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line)
      continue
    const i = line.search(/[:：]/)
    const platform = i > 0 ? line.slice(0, i).trim().toLowerCase() : ''
    const handle = i > 0 ? line.slice(i + 1).trim() : ''
    if (!/^[a-z][\w-]*$/.test(platform) || !handle)
      return { error: `网名这一行看不懂：「${line}」，要写成「qq：网名」` }
    out[platform] = handle
  }
  return { value: out }
}

/** 保存时用：validate 已挡掉坏行，这里坏了就当没写 */
function aliasesOf(text: string): Record<string, string> {
  const a = parseAliases(text)
  return 'value' in a ? a.value : {}
}

export function toForm(p: Persona): PersonaForm {
  const { emo = [], act = [], ...others } = p.markers
  return {
    name: p.name,
    prompt: p.prompt,
    style: p.style,
    rulesMode: p.rules === null ? 'default' : p.rules === '' ? 'none' : 'custom',
    rules: p.rules ?? '',
    emo: emo.join('，'),
    act: act.join('，'),
    others,
    aliases: formatAliases(p.aliases),
  }
}

/** 表单能不能存；不能就返回给人看的原因 */
export function validate(f: PersonaForm): string | undefined {
  if (!f.name.trim())
    return '名字不能空'
  if (!f.prompt.trim())
    return '人设不能空'
  if (f.rulesMode === 'custom' && !f.rules.trim())
    return '自定义「要求」是空的；不想要这一段就选「不要」'
  const a = parseAliases(f.aliases)
  if ('error' in a)
    return a.error
  return undefined
}

export function toPatch(f: PersonaForm): Persona {
  return {
    name: f.name.trim(),
    prompt: f.prompt.trim(),
    style: f.style.trim(),
    rules: f.rulesMode === 'default' ? null : f.rulesMode === 'none' ? '' : f.rules.trim(),
    markers: { ...f.others, emo: splitWords(f.emo), act: splitWords(f.act) },
    aliases: aliasesOf(f.aliases),
  }
}
