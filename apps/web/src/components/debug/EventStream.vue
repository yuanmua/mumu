<script setup lang="ts">
/** 原始事件流：seq · type · 摘要，可过滤、点行展开。model.request 的 messages 按角色分段。 */
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEvent } from '../../protocol/types.ts'
import EventRow from './EventRow.vue'

const props = defineProps<{ events: LogEvent[] }>()
const filter = ref('')
const list = ref<HTMLElement>()
const follow = ref(true)

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q)
    return props.events
  return props.events.filter(e => (`${e.type} ${JSON.stringify(e.data)}`).toLowerCase().includes(q))
})

function onScroll(): void {
  const el = list.value
  if (el)
    follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}
watch(() => props.events.length, async () => {
  await nextTick()
  if (follow.value && list.value)
    list.value.scrollTop = list.value.scrollHeight
}, { immediate: true })
</script>

<template>
  <div class="stream">
    <div class="tools">
      <input v-model="filter" class="filter mono" placeholder="过滤：类型或内容，如 utterance / model.request / 天气">
      <span class="dim mono">{{ shown.length }} / {{ events.length }}</span>
    </div>
    <div ref="list" class="rows" @scroll="onScroll">
      <EventRow v-for="e in shown" :key="e.seq" :event="e" />
    </div>
  </div>
</template>

<style scoped>
.stream { height: 100%; display: flex; flex-direction: column; }
.tools { display: flex; gap: 10px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.filter { flex: 1; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); outline: none; }
.filter:focus { border-color: var(--accent); }
.rows { flex: 1; overflow-y: auto; padding: 6px 10px 30px; }
</style>
