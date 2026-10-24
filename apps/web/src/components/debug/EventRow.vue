<script setup lang="ts">
/** 一行事件：类型着色 + 一句摘要；点开看完整内容（prompt 按角色分段可读）。 */
import { computed, ref } from 'vue'
import type { LogEvent } from '../../protocol/types.ts'

const props = defineProps<{ event: LogEvent }>()
const open = ref(false)

const family = computed(() => props.event.type.split('.')[0])

interface Img { media: string, bytes?: number, label?: string }
interface Msg { role: string, content: string, images?: Img[] }

/** 这次请求带了几张原图、多少字节（协议 §5 model.request 的 images 附件） */
function imagesOf(messages: Msg[] | undefined): string {
  const imgs = (messages ?? []).flatMap(m => m.images ?? [])
  if (!imgs.length)
    return ''
  const kb = Math.round(imgs.reduce((n, i) => n + (i.bytes ?? 0), 0) / 1024)
  return ` · ${imgs.length} 图 ${kb}KB`
}
const summary = computed(() => {
  const d = props.event.data ?? {}
  switch (props.event.type) {
    case 'percept.received': return `${d.kind} ${d.text ?? ''}`
    case 'utterance.started': return `${d.id} @${d.channel}`
    case 'utterance.part': return d.part?.text ?? `〔${d.part?.data?.value ?? d.part?.kind}〕`
    case 'utterance.settled': return `${d.id} ${d.truncated ? '⏹截断' : '完整'} "${String(d.delivered ?? '').slice(0, 40)}"`
    case 'model.request': return `${d.role} → ${d.model} (${d.messages?.length} 条${imagesOf(d.messages)})`
    case 'model.response': return `${d.role} ← ${d.chars} 字${d.aborted ? ' 打断' : ''}`
    case 'beat.opened': return (d.reasons ?? []).map((r: { source: string }) => r.source).join(' + ')
    case 'beat.closed': return `intents=${d.intents} ${d.note ?? ''}`
    case 'mind.decision': return `${d.aborted ? '作废 ' : ''}${d.tookMs}ms ${d.note ?? ''}`
    case 'action.started': return `${d.id} ${JSON.stringify(d.params ?? {}).slice(0, 60)}`
    case 'action.ended': return `${d.id} ${d.outcome}`
    case 'emotion.changed': return d.label
    case 'intent.blocked': return `${d.why} ${JSON.stringify(d.intent).slice(0, 60)}`
    default: return JSON.stringify(d).slice(0, 80)
  }
})

const detail = computed(() => {
  const e = props.event
  if (e.type === 'model.request' && Array.isArray(e.data?.messages)) {
    const meta = { ...e, data: { ...e.data, messages: `<${e.data.messages.length} 条，见下>` } }
    const imgs = (m: Msg): string => m.images?.length
      ? `\n${m.images.map(i => `〔原图 ${i.label ?? ''}/api/media/${i.media} · ${Math.round((i.bytes ?? 0) / 1024)}KB〕`).join('\n')}`
      : ''
    return `${JSON.stringify(meta, null, 2)}\n\n${e.data.messages.map((m: Msg) => `────────［${m.role}］────────\n${m.content}${imgs(m)}`).join('\n\n')}`
  }
  return JSON.stringify(e, null, 2)
})
</script>

<template>
  <div class="row" :class="family" @click="open = !open">
    <span class="seq mono">{{ event.seq }}</span>
    <span class="type mono">{{ event.type }}</span>
    <span class="sum">{{ summary }}</span>
  </div>
  <pre v-if="open" class="detail mono">{{ detail }}</pre>
</template>

<style scoped>
.row { display: flex; gap: 8px; align-items: baseline; padding: 2px 6px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.row:hover { background: var(--user); }
.seq { color: var(--fg-dim); min-width: 36px; text-align: right; font-size: 11px; }
.type { font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--user); color: var(--fg-dim); white-space: nowrap; }
.row.percept .type { color: var(--accent); }
.row.utterance .type { color: #c04b8e; }
.row.model .type { color: var(--ok); }
.row.beat .type, .row.mind .type { color: var(--warn); }
.row.action .type, .row.reflex .type { color: #8a5cf6; }
.row.intent .type, .row.emotion .type { color: var(--err); }
.sum { color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail {
  margin: 2px 6px 8px 50px; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--bg-elev); border: 1px solid var(--line); color: var(--fg);
  white-space: pre-wrap; word-break: break-word; font-size: 11.5px; max-height: 60vh; overflow: auto;
}
</style>
