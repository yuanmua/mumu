<script setup lang="ts">
/**
 * 状态总览：/api/status 的卡片。内置卡片（网页、插件、动作）由 surface-web 出，
 * 其余（模型路由与探活、QQ 连接、guard 主人、角色……）由各插件经 web/status 水线自己报（协议 §7），这里一视同仁地画。
 *
 * 10 秒一刷、页面看不见时不刷：插件报卡时可能真去探活（provider 会打 DeepSeek 和本地 4090），
 * 刷太勤或后台标签页一直刷，就是白白在打别人的接口。切回来立刻补一次。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { failed, fetchStatus } from '../protocol/admin.ts'
import type { StatusCard } from '../protocol/admin.ts'

const EVERY_MS = 10_000
const cards = ref<StatusCard[]>([])
const error = ref('')
const at = ref('')
let timer: ReturnType<typeof setInterval> | undefined

async function load(): Promise<void> {
  const r = await fetchStatus()
  error.value = failed(r) ? r.error : ''
  if (!failed(r))
    cards.value = r
  at.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
}
function onVisible(): void {
  if (document.visibilityState === 'visible')
    void load()
}
onMounted(() => {
  void load()
  timer = setInterval(() => { if (document.visibilityState === 'visible') void load() }, EVERY_MS)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <div class="page">
    <header>
      <RouterLink class="btn" to="/">← 聊天</RouterLink>
      <b>状态</b>
      <span class="dim">{{ error ? `取不到：${error}` : `每 10 秒刷新（看不见时不刷）· ${at}` }}</span>
    </header>
    <div class="grid">
      <div v-for="c in cards" :key="c.id" class="card" :class="c.level">
        <div class="top"><span class="dot" /><b>{{ c.title }}</b></div>
        <div class="text">{{ c.text }}</div>
        <ul v-if="c.items?.length"><li v-for="(it, i) in c.items" :key="i">{{ it }}</li></ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; overflow-y: auto; padding: 16px; background: var(--bg); }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
header .btn { font-size: 12px; padding: 4px 10px; }
header .dim { font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.card { padding: 12px 14px; border-radius: var(--radius); background: var(--bg-elev); border: 1px solid var(--line); border-left-width: 4px; }
.card.ok { border-left-color: var(--ok); }
.card.warn { border-left-color: var(--warn); }
.card.err { border-left-color: var(--err); }
.card.info { border-left-color: var(--fg-dim); }
.top { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-dim); }
.ok .dot { background: var(--ok); }
.warn .dot { background: var(--warn); }
.err .dot { background: var(--err); }
.text { margin: 6px 0 0; font-size: 14px; }
ul { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--fg-dim); }
li { word-break: break-word; }
</style>
