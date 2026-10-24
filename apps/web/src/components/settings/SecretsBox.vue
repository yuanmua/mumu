<script setup lang="ts">
/**
 * 密钥：只写不读。列表只有名字和更新时间；值发出去就清空输入框，页面上永远看不到。
 * 配置里用名字引用（如 provider 的 apiKeyRef、onebot 的 tokenRef）。
 */
import { onMounted, ref } from 'vue'
import { failed, fetchSecrets, saveSecret } from '../../protocol/admin.ts'

const list = ref<{ name: string, updatedAt: number }[]>([])
const name = ref('')
const value = ref('')
const note = ref('')

async function load(): Promise<void> {
  const r = await fetchSecrets()
  if (failed(r))
    note.value = r.error
  else list.value = r
}
onMounted(load)

async function save(n: string, v: string): Promise<void> {
  const r = await saveSecret(n, v)
  note.value = failed(r) ? `没成功：${r.error}` : v ? `✓ 已存 ${n}` : `✓ 已删 ${n}`
  if (!failed(r))
    value.value = ''
  await load()
}
function remove(n: string): void {
  if (confirm(`删掉密钥 ${n}？用到它的插件会失效`))
    void save(n, '')
}
const when = (at: number): string => new Date(at).toLocaleString('zh-CN', { hour12: false })
</script>

<template>
  <div class="box">
    <b>密钥</b>
    <p class="dim">只写不读：存进去之后网页上看不到值。配置里填它的名字（如 apiKeyRef: deepseek）。</p>
    <table>
      <tbody>
        <tr v-for="s in list" :key="s.name">
          <td class="mono">{{ s.name }}</td>
          <td class="dim">{{ when(s.updatedAt) }}</td>
          <td><button class="btn small" @click="remove(s.name)">删除</button></td>
        </tr>
      </tbody>
    </table>
    <form @submit.prevent="name.trim() && value && save(name.trim(), value)">
      <input v-model="name" placeholder="名字（如 deepseek）" autocomplete="off">
      <input v-model="value" type="password" placeholder="值（存同名 = 覆盖）" autocomplete="new-password">
      <button class="btn primary" :disabled="!name.trim() || !value">存</button>
    </form>
    <p class="note" :class="{ ok: note.startsWith('✓') }">{{ note }}</p>
  </div>
</template>

<style scoped>
.box { display: flex; flex-direction: column; gap: 10px; }
.box p { margin: 0; font-size: 12px; }
table { border-collapse: collapse; font-size: 13px; }
td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
form { display: flex; gap: 6px; flex-wrap: wrap; }
input { flex: 1; min-width: 140px; padding: 6px 9px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); color: var(--fg); font: inherit; font-size: 13px; }
.btn.small { font-size: 11px; padding: 2px 8px; }
.note { color: var(--err); }
.note.ok { color: var(--ok); }
</style>
