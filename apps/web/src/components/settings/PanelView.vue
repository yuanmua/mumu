<script setup lang="ts">
/**
 * 通用面板：插件经 meta.panels 报定义（协议 §7），这里按 kind 画表格 / 卡片 / JSON / 滚动日志，
 * 带搜索与分页；actions 变顶部按钮（带 input 的旁边多一个输入框），rowActions 变每行按钮，做完自动刷新；
 * format 'image' 的列画成缩略图。插件只管一个接口和一份定义，前端不为任何插件写代码。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { call, failed } from '../../protocol/admin.ts'
import type { PanelAction, WebPanel } from '../../protocol/admin.ts'
import { actionBody, cellText, columnsOf, imageSrc, linesOf, page, rowsOf, refreshMs, search } from './panelData.ts'
import type { Row } from './panelData.ts'

const props = defineProps<{ panel: WebPanel }>()

const data = ref<unknown>()
const error = ref('')
const notice = ref('')
const typed = ref<Record<string, string>>({})
const q = ref('')
const n = ref(0)
const busy = ref(false)
const logBox = ref<HTMLElement>()
let timer: ReturnType<typeof setInterval> | undefined

async function load(): Promise<void> {
  const r = await call<unknown>(props.panel.endpoint)
  if (failed(r)) {
    error.value = r.error
    return
  }
  error.value = ''
  data.value = r
  if (props.panel.kind === 'log') {
    await nextTick()
    logBox.value?.scrollTo({ top: logBox.value.scrollHeight })
  }
}

watch(() => props.panel, () => {
  clearInterval(timer)
  data.value = undefined
  q.value = ''
  n.value = 0
  void load()
  const ms = refreshMs(props.panel)
  if (ms)
    timer = setInterval(() => void load(), ms)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))

const rows = computed(() => search(rowsOf(data.value), q.value))
const shown = computed(() => page(rows.value, n.value))
const cols = computed(() => columnsOf(props.panel, rows.value))
const lines = computed(() => search(linesOf(data.value), q.value))

async function act(a: PanelAction, item?: Row): Promise<void> {
  const body = actionBody(a.input, typed.value[a.label] ?? '', item)
  if (!body) {
    error.value = `先写：${a.input}`
    return
  }
  if (busy.value || (a.confirm && !confirm(a.confirm)))
    return
  busy.value = true
  notice.value = a.input ? `${a.label}…` : ''
  const r = await call<unknown>(a.endpoint, a.method ?? 'POST', body)
  busy.value = false
  error.value = failed(r) ? `${a.label}失败：${r.error}` : ''
  // 插件可以回一句 message 告诉你做成了什么
  const msg = !failed(r) && typeof r === 'object' && r !== null ? (r as { message?: unknown }).message : undefined
  notice.value = typeof msg === 'string' ? msg : ''
  if (!failed(r) && a.input)
    typed.value[a.label] = ''
  await load()
}
</script>

<template>
  <div class="panel">
    <header>
      <b>{{ panel.title }}</b>
      <input v-if="panel.kind !== 'json'" v-model="q" placeholder="搜索…" @input="n = 0">
      <template v-for="a in panel.actions ?? []" :key="a.label">
        <input v-if="a.input !== undefined" v-model="typed[a.label]" class="act-input" :placeholder="a.input" :disabled="busy" @keydown.enter="act(a)">
        <button class="btn" :disabled="busy" @click="act(a)">{{ a.label }}</button>
      </template>
      <button class="btn" title="重新取一次" @click="load">刷新</button>
    </header>
    <p v-if="notice && !error" class="dim">{{ notice }}</p>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-else-if="data === undefined" class="dim">读取中…</p>

    <template v-else-if="panel.kind === 'table'">
      <div class="scroll">
        <table>
          <thead><tr><th v-for="c in cols" :key="c.key">{{ c.label ?? c.key }}</th><th v-if="panel.rowActions?.length" /></tr></thead>
          <tbody>
            <tr v-for="(r, i) in shown.items" :key="i">
              <td v-for="c in cols" :key="c.key">
                <img v-if="c.format === 'image' && imageSrc(r[c.key])" class="thumb" :src="imageSrc(r[c.key])" loading="lazy" alt="">
                <template v-else>{{ cellText(r[c.key], c.format) }}</template>
              </td>
              <td v-if="panel.rowActions?.length" class="acts">
                <button v-for="a in panel.rowActions" :key="a.label" class="btn small" :disabled="busy" @click="act(a, r)">{{ a.label }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else-if="panel.kind === 'cards'" class="cards">
      <div v-for="(r, i) in shown.items" :key="i" class="card">
        <template v-for="c in cols" :key="c.key">
          <img v-if="c.format === 'image' && imageSrc(r[c.key])" class="card-img" :src="imageSrc(r[c.key])" loading="lazy" :alt="c.label ?? c.key">
          <div v-else class="kv"><span class="dim">{{ c.label ?? c.key }}</span><span>{{ cellText(r[c.key], c.format) }}</span></div>
        </template>
        <div v-if="panel.rowActions?.length" class="acts">
          <button v-for="a in panel.rowActions" :key="a.label" class="btn small" :disabled="busy" @click="act(a, r)">{{ a.label }}</button>
        </div>
      </div>
    </div>

    <pre v-else-if="panel.kind === 'log'" ref="logBox" class="log mono">{{ lines.join('\n') || '（空）' }}</pre>
    <pre v-else class="json mono">{{ JSON.stringify(data, null, 2) }}</pre>

    <footer v-if="(panel.kind === 'table' || panel.kind === 'cards') && data !== undefined">
      <span class="dim">{{ rows.length }} 条</span>
      <template v-if="shown.pages > 1">
        <button class="btn small" :disabled="shown.page === 0" @click="n = shown.page - 1">上一页</button>
        <span class="dim">{{ shown.page + 1 }} / {{ shown.pages }}</span>
        <button class="btn small" :disabled="shown.page >= shown.pages - 1" @click="n = shown.page + 1">下一页</button>
      </template>
    </footer>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 10px; }
header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
header b { margin-right: auto; font-size: 15px; }
header input { padding: 5px 9px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); color: var(--fg); font: inherit; font-size: 13px; width: 160px; }
header .btn { font-size: 12px; padding: 4px 10px; }
header .act-input { width: 200px; }
.thumb { width: 56px; height: 56px; object-fit: contain; border-radius: var(--radius-sm); background: var(--bg); }
.card-img { width: 100%; height: 140px; object-fit: contain; border-radius: var(--radius-sm); background: var(--bg); margin-bottom: 4px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; word-break: break-word; }
th { font-size: 12px; color: var(--fg-dim); font-weight: 600; }
.acts { white-space: nowrap; display: flex; gap: 4px; }
.btn.small { font-size: 11px; padding: 2px 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.card { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 10px; background: var(--bg-elev); font-size: 13px; display: flex; flex-direction: column; gap: 3px; }
.kv { display: flex; gap: 8px; justify-content: space-between; }
.kv span:last-child { text-align: right; word-break: break-word; }
.log, .json { margin: 0; max-height: 60vh; overflow: auto; padding: 10px; border-radius: var(--radius-sm); background: var(--bg-elev); border: 1px solid var(--line); white-space: pre-wrap; word-break: break-word; }
footer { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.err { color: var(--err); font-size: 13px; margin: 0; }
</style>
