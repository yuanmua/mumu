<script setup lang="ts">
/** 一次模型调用：请求分段（可折叠）、chunk 时间轴（相对发起时刻）、结果。 */
import { computed, ref } from 'vue'
import type { ModelCall } from '../../store/projection.ts'

const props = defineProps<{ call: ModelCall }>()
const openMsgs = ref(new Set<number>())
function toggle(i: number): void {
  if (openMsgs.value.has(i))
    openMsgs.value.delete(i)
  else openMsgs.value.add(i)
}
const firstChunkMs = computed(() => props.call.chunks.length ? props.call.chunks[0].at - props.call.startedAt : undefined)
const total = computed(() => props.call.result ? props.call.result.endedAt - props.call.startedAt : undefined)
</script>

<template>
  <div class="detail">
    <header>
      <span class="big mono">{{ call.reqId }}</span>
      <span class="kv">角色 <b>{{ call.role }}</b></span>
      <span class="kv">模型 <b>{{ call.provider }}/{{ call.model }}</b></span>
      <span v-if="firstChunkMs !== undefined" class="kv">首包 <b>{{ firstChunkMs }}ms</b></span>
      <span v-if="total !== undefined" class="kv">总耗时 <b>{{ total }}ms</b></span>
      <span v-if="call.result" class="kv">输出 <b>{{ call.result.chars }} 字</b></span>
      <span v-if="call.result?.usage" class="kv">tokens <b>{{ call.result.usage.prompt }} + {{ call.result.usage.completion }}</b></span>
      <span v-if="call.result?.aborted" class="kv err">被打断</span>
    </header>
    <div class="body">
      <section>
        <h4>请求（{{ call.messages.length }} 条）</h4>
        <div v-for="(m, i) in call.messages" :key="i" class="m" :class="m.role">
          <div class="mh" @click="toggle(i)">［{{ m.role }}］ {{ openMsgs.has(i) ? '收起' : `${m.content.length} 字，点开` }}</div>
          <pre v-if="openMsgs.has(i)" class="mono">{{ m.content }}</pre>
        </div>
      </section>
      <section>
        <h4>流（{{ call.chunks.length }} 个 chunk）</h4>
        <div v-if="!call.chunks.length" class="dim">历史调用没有 chunk 明细（只有实时调用才观察得到）</div>
        <div v-else class="chunks mono">
          <div v-for="(c, i) in call.chunks" :key="i" class="ck">
            <span class="t dim">+{{ c.at - call.startedAt }}ms</span>
            <span class="c">{{ c.text }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.detail { height: 100%; display: flex; flex-direction: column; }
header { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--bg-elev); }
.big { color: var(--accent); font-size: 15px; }
.kv { font-size: 12px; color: var(--fg-dim); }
.kv b { color: var(--fg); font-weight: 500; }
.kv.err { color: var(--err); }
.body { flex: 1; overflow-y: auto; padding: 14px 18px; }
section { margin-bottom: 18px; }
h4 { font-size: 12px; color: var(--fg-dim); letter-spacing: .1em; margin-bottom: 8px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.m { margin-bottom: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
.mh { padding: 5px 12px; font-size: 12px; cursor: pointer; background: var(--bg-elev); color: var(--warn); user-select: none; }
.m.system .mh { color: #c04b8e; }
.m.assistant .mh { color: var(--ok); }
.m pre { padding: 10px 12px; white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow-y: auto; }
.chunks { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-elev); padding: 8px 10px; max-height: 44vh; overflow-y: auto; }
.ck { display: flex; gap: 10px; align-items: baseline; }
.ck .t { flex: none; min-width: 72px; text-align: right; font-size: 11px; }
.ck .c { white-space: pre-wrap; word-break: break-word; }
</style>
