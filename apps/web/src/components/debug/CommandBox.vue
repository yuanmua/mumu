<script setup lang="ts">
/** 管理命令：输入 /命令，输出原样显示。命令本身由后端 commands 注册表决定。 */
import { ref } from 'vue'
import { runCommand } from '../../protocol/client.ts'

const line = ref('')
const output = ref<string[]>([])
const busy = ref(false)

async function run(): Promise<void> {
  const l = line.value.trim()
  if (!l || busy.value)
    return
  busy.value = true
  output.value.push(`› ${l}`)
  const lines = await runCommand(l.startsWith('/') ? l : `/${l}`)
  output.value.push(...lines)
  busy.value = false
  line.value = ''
}
</script>

<template>
  <div class="box">
    <pre class="out mono">{{ output.length ? output.join('\n') : '例：/plugins · /config get plugins.persona · /log 20 · /help\n/secret 这类敏感命令请在终端里敲。' }}</pre>
    <form class="in" @submit.prevent="run">
      <input v-model="line" class="mono" placeholder="/help" :disabled="busy">
      <button class="btn primary" :disabled="busy">执行</button>
    </form>
  </div>
</template>

<style scoped>
.box { height: 100%; display: flex; flex-direction: column; }
.out { flex: 1; overflow: auto; padding: 14px 18px; white-space: pre-wrap; word-break: break-word; color: var(--fg); }
.in { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); }
.in input { flex: 1; padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); outline: none; }
.in input:focus { border-color: var(--accent); }
</style>
