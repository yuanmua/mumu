<script setup lang="ts">
/**
 * 一个配置字段：按值的类型（或清单 ui 提示）画控件，显示出厂值、「改过」与「恢复默认」。
 * 对象递归画子字段（本组件自引用）。只渲染、只发 update，值在 PluginConfig 里。
 */
import { computed, ref, watch } from 'vue'
import type { UiHint } from '../../protocol/admin.ts'
import { blankItem, getAt, hintFor, kindOf, labelOf, MASK, optionsOf, parseJson, same } from './configForm.ts'
import type { Path } from './configForm.ts'

// path 是键名数组：键名里可能有点（roles 下的 mind.decide），不能拼成点串
const props = defineProps<{ path: Path, value: unknown, defaults: unknown, ui: Record<string, UiHint> }>()
const emit = defineEmits<{ update: [path: Path, value: unknown] }>()

const key = computed(() => props.path.at(-1) ?? '')
const hint = computed(() => hintFor(props.ui, props.path))
const def = computed(() => getAt(props.defaults, props.path))
const kind = computed(() => kindOf(props.value, def.value, hint.value, key.value))
const changed = computed(() => !same(props.value, def.value))
const open = ref(false)
const set = (v: unknown): void => emit('update', props.path, v)

const children = computed(() => {
  const v = (props.value ?? {}) as Record<string, unknown>
  const d = (def.value ?? {}) as Record<string, unknown>
  return [...new Set([...Object.keys(d), ...Object.keys(v)])].filter(k => !hintFor(props.ui, [...props.path, k])?.hidden)
})

// JSON 框：本地文本，失焦时解析；坏 JSON 不提交
const jsonText = ref('')
const jsonError = ref('')
watch(() => props.value, (v) => { jsonText.value = JSON.stringify(v ?? null, null, 2) }, { immediate: true })
function commitJson(): void {
  const r = parseJson(jsonText.value)
  if ('error' in r) {
    jsonError.value = r.error
    return
  }
  jsonError.value = ''
  if (!same(r.value, props.value))
    set(r.value)
}

const list = computed(() => (Array.isArray(props.value) ? props.value : []) as (string | number)[])
const setItem = (i: number, raw: string): void => {
  const next = [...list.value]
  next[i] = typeof list.value[i] === 'number' ? Number(raw) : raw
  set(next)
}
const defText = computed(() => def.value === undefined ? '（出厂没有这一项）' : JSON.stringify(def.value))
</script>

<template>
  <div v-if="kind === 'object'" class="group">
    <button class="head" type="button" @click="open = !open">
      <span class="caret">{{ open ? '▾' : '▸' }}</span>
      <span class="label">{{ labelOf(path, hint) }}</span>
      <span v-if="changed" class="mark">改过</span>
      <span v-if="hint?.hint" class="dim hint">{{ hint.hint }}</span>
    </button>
    <div v-if="open" class="kids">
      <ConfigField v-for="k in children" :key="k" :path="[...path, k]" :value="getAt(value, [k])" :defaults="defaults" :ui="ui" @update="(p, v) => emit('update', p, v)" />
      <button v-if="changed" class="btn small" type="button" @click="set(def)">这一组恢复默认</button>
    </div>
  </div>

  <div v-else class="field">
    <div class="top">
      <span class="label" :title="path.join(' › ')">{{ labelOf(path, hint) }}</span>
      <span v-if="changed" class="mark" :title="`出厂：${defText}`">改过</span>
      <button v-if="changed" class="link" type="button" :title="`出厂：${defText}`" @click="set(def)">恢复默认</button>
    </div>
    <div v-if="hint?.hint" class="dim hint">{{ hint.hint }}</div>

    <label v-if="kind === 'boolean'" class="switch">
      <input type="checkbox" :checked="value === true" @change="set(($event.target as HTMLInputElement).checked)">
      <span>{{ value ? '开' : '关' }}</span>
    </label>
    <input v-else-if="kind === 'number'" type="number" :value="value" :min="hint?.min" :max="hint?.max" :step="hint?.step ?? 'any'" @change="set(Number(($event.target as HTMLInputElement).value))">
    <div v-else-if="kind === 'slider'" class="slider">
      <input type="range" :value="value" :min="hint?.min ?? 0" :max="hint?.max ?? 1" :step="hint?.step ?? 0.01" @input="set(Number(($event.target as HTMLInputElement).value))">
      <span class="mono">{{ value }}</span>
    </div>
    <select v-else-if="kind === 'select'" :value="value" @change="set(($event.target as HTMLSelectElement).value)">
      <option v-for="o in optionsOf(hint)" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
    </select>
    <input v-else-if="kind === 'secret'" type="password" :value="value" :placeholder="value === MASK ? '已设置；不改就别动' : ''" autocomplete="off" @change="set(($event.target as HTMLInputElement).value)">
    <input v-else-if="kind === 'string'" :value="value" @change="set(($event.target as HTMLInputElement).value)">
    <textarea v-else-if="kind === 'text'" :value="String(value ?? '')" rows="4" @change="set(($event.target as HTMLTextAreaElement).value)" />
    <div v-else-if="kind === 'list'" class="list">
      <div v-for="(item, i) in list" :key="i" class="row">
        <input :type="typeof item === 'number' ? 'number' : 'text'" :value="item" @change="setItem(i, ($event.target as HTMLInputElement).value)">
        <button class="btn small" type="button" title="删掉这一项" @click="set(list.filter((_, j) => j !== i))">✕</button>
      </div>
      <button class="btn small" type="button" @click="set([...list, blankItem(list, def)])">＋ 加一项</button>
    </div>
    <template v-else>
      <textarea v-model="jsonText" class="mono" rows="5" @blur="commitJson" />
      <div v-if="jsonError" class="err">JSON 写错了：{{ jsonError }}</div>
    </template>
  </div>
</template>

<style scoped>
.field, .group { padding: 8px 0; border-bottom: 1px dashed var(--line); }
.top, .head { display: flex; align-items: center; gap: 8px; }
.head { width: 100%; text-align: left; padding: 0; background: none; border: none; color: var(--fg); }
.label { font-weight: 600; font-size: 13px; }
.caret { width: 12px; color: var(--fg-dim); }
.hint { font-size: 11px; margin: 2px 0 4px; }
.mark { font-size: 10px; padding: 0 6px; border-radius: 999px; background: var(--warn); color: #fff; }
.link { margin-left: auto; font-size: 11px; color: var(--accent); background: none; border: none; padding: 0; }
.kids { padding-left: 14px; border-left: 2px solid var(--line); margin-top: 4px; }
input:not([type="checkbox"]):not([type="range"]), textarea, select {
  width: 100%; font: inherit; font-size: 13px; padding: 6px 9px; margin-top: 4px; resize: vertical;
  border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); color: var(--fg); outline: none;
}
input:focus, textarea:focus, select:focus { border-color: var(--accent); }
.switch { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 13px; }
.slider { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.slider input { flex: 1; }
.list { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.row { display: flex; gap: 6px; align-items: center; }
.row input { margin-top: 0 !important; }
.btn.small { font-size: 12px; padding: 3px 9px; align-self: flex-start; }
.err { color: var(--err); font-size: 12px; }
</style>
