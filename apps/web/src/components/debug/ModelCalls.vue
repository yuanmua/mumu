<script setup lang="ts">
/** 模型调用：左列表、右详情。「跟随最新」自动切到新调用。 */
import { computed, ref, watch } from 'vue'
import type { ModelCall } from '../../store/projection.ts'
import ModelCallDetail from './ModelCallDetail.vue'

const props = defineProps<{ calls: Record<string, ModelCall>, order: string[] }>()
const selected = ref<string>()
const followLatest = ref(true)

const list = computed(() => [...props.order].reverse().map(id => props.calls[id]).filter(Boolean))
const current = computed(() => selected.value ? props.calls[selected.value] : list.value[0])

watch(() => props.order.length, () => {
  if (followLatest.value)
    selected.value = props.order[props.order.length - 1]
}, { immediate: true })

const status = (c: ModelCall): string => c.result ? (c.result.aborted ? '打断' : '完成') : '进行中'
</script>

<template>
  <div class="calls">
    <aside class="list">
      <header>
        <span class="dim">{{ list.length }} 次调用</span>
        <label class="dim"><input v-model="followLatest" type="checkbox"> 跟随最新</label>
      </header>
      <div class="rows">
        <button v-for="c in list" :key="c.reqId" class="call" :class="{ sel: current?.reqId === c.reqId }" @click="selected = c.reqId; followLatest = false">
          <span class="mono id">{{ c.reqId }}</span>
          <span class="role">{{ c.role }}</span>
          <span class="st" :class="status(c)">{{ status(c) }}</span>
          <span class="dim mono small">{{ c.result ? `${c.result.endedAt - c.startedAt}ms` : '' }}</span>
        </button>
      </div>
    </aside>
    <div class="detail">
      <ModelCallDetail v-if="current" :call="current" />
      <div v-else class="empty dim">还没有模型调用</div>
    </div>
  </div>
</template>

<style scoped>
.calls { height: 100%; display: grid; grid-template-columns: 280px 1fr; }
.list { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-height: 0; }
.list header { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 12px; }
.rows { flex: 1; overflow-y: auto; padding: 6px; }
.call {
  width: 100%; display: grid; grid-template-columns: 54px 1fr auto auto; gap: 8px; align-items: baseline;
  padding: 7px 10px; border-radius: var(--radius-sm); text-align: left; border: 1px solid transparent; font-size: 13px;
}
.call:hover { background: var(--user); }
.call.sel { background: var(--user); border-color: var(--accent); }
.id { color: var(--accent); font-size: 12px; }
.st { font-size: 11px; }
.st.进行中 { color: var(--warn); }
.st.完成 { color: var(--ok); }
.st.打断 { color: var(--err); }
.small { font-size: 11px; }
.detail { min-height: 0; overflow: hidden; }
.empty { padding: 60px; text-align: center; }
@media (max-width: 800px) { .calls { grid-template-columns: 1fr; grid-template-rows: 200px 1fr; } .list { border-right: none; border-bottom: 1px solid var(--line); } }
</style>
