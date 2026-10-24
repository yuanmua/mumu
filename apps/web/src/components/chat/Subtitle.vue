<script setup lang="ts">
/** 当前这句的流式字幕：按 <|br|> 分段，只显示已呈现（reveal）的部分；说完几秒后淡出。 */
import { computed, ref, watch } from 'vue'
import type { Message } from '../../store/projection.ts'
import { segmentsOf } from '../../store/projection.ts'

const props = defineProps<{ message?: Message }>()
const visible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined

const segments = computed(() => props.message ? segmentsOf(props.message) : [])
const lastSegment = computed(() => segments.value[segments.value.length - 1] ?? '')
const markers = computed(() => {
  const m = props.message
  if (!m)
    return []
  // 只显示已呈现区间内的标记
  return m.markers.filter(k => k.at <= m.reveal)
})

const images = computed(() => props.message?.images ?? [])

const work = computed(() => props.message?.work)

watch(() => [props.message?.id, props.message?.reveal, props.message?.streaming, images.value.length, work.value?.text, work.value?.done] as const, ([, reveal, streaming, pics, , workDone]) => {
  clearTimeout(hideTimer)
  if (!props.message || (!reveal && !pics)) {
    visible.value = false
    return
  }
  visible.value = true
  // 图多停一会儿；电脑上的活没做完就一直显示进度；完整的都在「记录」里
  if (!streaming && !(work.value && !workDone))
    hideTimer = setTimeout(() => { visible.value = false }, pics ? 15000 : 4500)
}, { immediate: true })
</script>

<template>
  <Transition name="fade">
    <div v-if="visible && message" class="subtitle">
      <div v-if="images.length" class="pics">
        <a v-for="(img, i) in images" :key="i" :href="img.src" target="_blank" rel="noopener"><img :src="img.src" :alt="img.alt ?? '图片'" :title="img.alt"></a>
      </div>
      <div v-for="(seg, i) in segments.slice(0, -1)" :key="i" class="seg older">{{ seg }}</div>
      <div v-if="lastSegment || !images.length" class="seg">
        {{ lastSegment }}<span v-if="message.streaming" class="caret" />
        <span v-if="message.truncated" class="cut">⏹</span>
      </div>
      <div v-if="markers.length" class="markers">
        <span v-for="(k, i) in markers" :key="i" class="chip">{{ k.value }}</span>
      </div>
      <div v-if="work" class="work" :class="{ done: work.done }">{{ work.done ? '' : '⋯ ' }}{{ work.text }}</div>
    </div>
  </Transition>
</template>

<style scoped>
.subtitle {
  max-width: min(680px, calc(100vw - 32px));
  margin: 0 auto 10px;
  padding: 12px 18px;
  border-radius: var(--radius);
  background: var(--panel); backdrop-filter: blur(14px);
  border: 1px solid var(--line); box-shadow: var(--shadow);
  font-size: 16px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
}
.seg + .seg { margin-top: 6px; }
.pics { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.pics img { max-height: 220px; max-width: 100%; border-radius: calc(var(--radius) - 4px); display: block; }
.seg.older { color: var(--fg-dim); font-size: 14px; }
.caret { display: inline-block; width: 2px; height: 1em; background: var(--accent); margin-left: 2px; vertical-align: -2px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.cut { color: var(--err); font-size: 12px; margin-left: 6px; }
.markers { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.work { margin-top: 6px; font-size: 12px; color: var(--fg-dim); }
.work.done { color: var(--ok); }
.fade-enter-active, .fade-leave-active { transition: opacity .35s, transform .35s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(6px); }
</style>
