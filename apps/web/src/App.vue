<script setup lang="ts">
/** 壳：路由出口 + 顶部连接状态条。连接状态来自投影，不自己维护。 */
import { computed } from 'vue'
import { useRuntime } from './app/runtime.ts'

const { state } = useRuntime()
const banner = computed(() => {
  switch (state.connection) {
    case 'offline': return '连不上后端。先在终端 npm start，再刷新。'
    case 'reconnecting': return '连接断了，正在重连…'
    case 'connecting': return '连接中…'
    default: return ''
  }
})
</script>

<template>
  <div class="shell">
    <div v-if="banner" class="banner" :class="state.connection">{{ banner }}</div>
    <RouterView />
  </div>
</template>

<style scoped>
.shell { height: 100%; position: relative; }
.banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 50;
  padding: 6px 16px; text-align: center; font-size: 13px;
  background: var(--warn); color: #1c1f26;
}
.banner.offline { background: var(--err); color: #fff; }
.banner.connecting { background: var(--panel-solid); color: var(--fg-dim); border-bottom: 1px solid var(--line); }
</style>
