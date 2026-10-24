/**
 * 段落组装：插件各自贡献段落，组装成完整提示词，彼此无需引用。
 * 工作记忆采用双重衰减，轮数用尽且超过最小时长才过期。
 * 内核只管衰减与结构化输出，渲染归消费方。
 */
import type { Disposer } from '../core/container.ts'
import { Registry } from '../core/registry.ts'

/** 受众标识，与模型角色对齐；'*' 表示所有受众 */
export type Audience = string

export const ALL_AUDIENCES = '*'

export interface Section {
  id: string
  audience: Audience // '*' 表示所有受众
  order: number // 越小越靠前
  render: () => string | Promise<string>
}

/** 工作记忆的结构化快照 */
export interface Note {
  source: string
  text: string
  data?: Record<string, unknown> // 结构化细节；内核自己记的带 code，渲染归消费方
  elapsedMs: number
}

interface Temp {
  text: string
  data?: Record<string, unknown>
  source: string
  remainingBeats: number
  minMs: number
  createdAt: number
}

export class PromptAssembly {
  /** 插件贡献的段落，按受众与顺序组装 */
  readonly sections = new Registry<Section>('段落', s => s.id)
  private temps: Temp[] = []

  /** 等价 sections.add */
  section(s: Section): Disposer {
    return this.sections.add(s)
  }

  /**
   * 组装某受众的全部段落；单段渲染出错只缺该段。
   * extras 是调用方本次附加的一次性段落（如发言动作的引导），与注册段落同一套 order 排序——
   * 否则调用方只能拼在整段前后，顺序就不统一了。
   */
  async assemble(audience: Audience, extras: Section[] = []): Promise<string> {
    const list = [...this.sections.list(), ...extras]
      .filter(s => s.audience === audience || s.audience === ALL_AUDIENCES)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const parts: string[] = []
    for (const s of list) {
      try {
        const text = await s.render()
        if (text.trim())
          parts.push(text.trim())
      }
      catch (e) {
        console.error(`[prompt] 段落 ${s.id} 渲染失败:`, e)
      }
    }
    return parts.join('\n\n')
  }

  /** 默认 5 拍或至少 30 秒后过期 */
  addNote(text: string, opts: { source: string, beats?: number, minMs?: number, data?: Record<string, unknown> }): void {
    this.temps.push({
      text,
      data: opts.data,
      source: opts.source,
      remainingBeats: opts.beats ?? 5,
      minMs: opts.minMs ?? 30_000,
      createdAt: Date.now(),
    })
  }

  /** 清空全部工作记忆，配合日志 reset */
  clearNotes(): void {
    this.temps = []
  }

  /** 取当前有效项；consume 为真时消耗一拍轮数。渲染归调用方 */
  notes(consume: boolean): Note[] {
    const now = Date.now()
    const keep: Temp[] = []
    const out: Note[] = []
    for (const t of this.temps) {
      const elapsedMs = now - t.createdAt
      if (t.remainingBeats <= 0 && elapsedMs >= t.minMs)
        continue
      out.push({ source: t.source, text: t.text, ...(t.data ? { data: t.data } : {}), elapsedMs })
      if (consume)
        t.remainingBeats--
      keep.push(t)
    }
    this.temps = keep
    return out
  }
}
