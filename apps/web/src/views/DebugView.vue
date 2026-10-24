<script setup lang="ts">
/** 调试页：思考时间线（默认）· 原始事件 · 模型调用 · 命令。只组合组件。 */
import { ref } from 'vue'
import { useRuntime } from '../app/runtime.ts'
import CommandBox from '../components/debug/CommandBox.vue'
import DangerZone from '../components/debug/DangerZone.vue'
import EventStream from '../components/debug/EventStream.vue'
import ModelCalls from '../components/debug/ModelCalls.vue'
import Thinking from '../components/debug/Thinking.vue'

const rt = useRuntime()
const state = rt.state
const tab = ref<'thinking' | 'events' | 'model' | 'command'>('thinking')
const TABS = [
  ['thinking', '思考'],
  ['events', '事件'],
  ['model', '模型'],
  ['command', '命令'],
] as const
</script>

<template>
  <div class="debug">
    <header>
      <RouterLink class="btn" to="/">← 回到聊天</RouterLink>
      <nav>
        <button v-for="[id, label] in TABS" :key="id" class="tab" :class="{ on: tab === id }" @click="tab = id">{{ label }}</button>
      </nav>
      <span class="dim status">{{ state.meta.name }} · {{ state.connection }} · {{ state.events.length }} 条事件</span>
    </header>
    <main>
      <Thinking v-if="tab === 'thinking'" :events="state.events" />
      <EventStream v-else-if="tab === 'events'" :events="state.events" />
      <ModelCalls v-else-if="tab === 'model'" :calls="state.modelCalls" :order="state.modelOrder" />
      <CommandBox v-else />
    </main>
    <DangerZone @clear="rt.clear()" />
  </div>
</template>

<style scoped>
.debug { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--bg-elev); }
nav { display: flex; gap: 4px; }
.tab { padding: 6px 14px; border-radius: 999px; color: var(--fg-dim); }
.tab.on { background: var(--accent); color: var(--accent-fg); }
.status { margin-left: auto; font-size: 12px; }
main { flex: 1; min-height: 0; }
@media (max-width: 640px) { .status { display: none; } }
</style>
