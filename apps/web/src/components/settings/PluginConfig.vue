<script setup lang="ts">
/**
 * 一个插件的设置页：启停开关 + 按合并后的配置自动生成的表单。
 * 编辑的是「想要的完整配置」，保存时整份 PUT，服务端求差落库（改回出厂值的项自动从库里消失）。
 * 有专用面板的插件（人格、模型）在顶上给快捷入口，通用表单照样能改。
 */
import { computed, ref, watch } from 'vue'
import { failed, fetchPluginConfig, savePluginConfig, setPluginEnabled } from '../../protocol/admin.ts'
import type { PluginConfig, PluginInfo } from '../../protocol/admin.ts'
import ConfigField from './ConfigField.vue'
import { countChanged, hintFor, setAt } from './configForm.ts'

const props = defineProps<{ plugin: PluginInfo, shortcut?: string }>()
const emit = defineEmits<{ changed: [], shortcut: [] }>()

const view = ref<PluginConfig>()
const draft = ref<Record<string, unknown>>({})
const note = ref('')
const busy = ref(false)

async function load(): Promise<void> {
  note.value = ''
  view.value = undefined
  const r = await fetchPluginConfig(props.plugin.id)
  if (failed(r)) {
    note.value = `读不到：${r.error}`
    return
  }
  view.value = r
  draft.value = structuredClone(r.merged)
}
watch(() => props.plugin.id, load, { immediate: true })

const keys = computed(() => Object.keys(draft.value).filter(k => !hintFor(view.value?.ui ?? {}, [k])?.hidden))
const dirty = computed(() => view.value ? countChanged(draft.value, view.value.merged) : 0)
const fromDefault = computed(() => view.value ? countChanged(draft.value, view.value.defaults) : 0)

async function save(config = draft.value): Promise<void> {
  if (busy.value)
    return
  busy.value = true
  const r = await savePluginConfig(props.plugin.id, config)
  busy.value = false
  // 存成功但重载失败时响应也带 error，所以按有没有 merged 判断是否写进去了
  if (!('merged' in r)) {
    note.value = `没存上：${r.error}`
    return
  }
  view.value = r
  draft.value = structuredClone(r.merged)
  note.value = r.error ? `已保存，但重载失败：${r.error}` : '✓ 已保存并重载'
  emit('changed')
}

// view 是响应式代理，structuredClone 克隆不了它；配置本来就是 JSON，用 JSON 往返拷贝
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const resetAll = (): Promise<void> => save(clone(view.value?.defaults ?? {}))
const undo = (): void => { draft.value = clone(view.value?.merged ?? {}) }

async function toggle(on: boolean): Promise<void> {
  const r = await setPluginEnabled(props.plugin.id, on)
  note.value = failed(r) ? `${on ? '启用' : '停用'}失败：${r.error}` : `✓ 已${on ? '启用' : '停用'}`
  emit('changed')
}
</script>

<template>
  <div class="cfg">
    <header>
      <div class="title">
        <b>{{ plugin.title }}</b>
        <span v-if="plugin.title !== plugin.id" class="dim mono">{{ plugin.id }}</span>
      </div>
      <label class="switch" :title="plugin.id === 'surface-web' ? '网页自己不能在这里停' : ''">
        <input type="checkbox" :checked="plugin.enabled" :disabled="plugin.id === 'surface-web'" @change="toggle(($event.target as HTMLInputElement).checked)">
        {{ plugin.enabled ? '启用' : '停用' }}
      </label>
    </header>
    <p v-if="plugin.description" class="dim desc">{{ plugin.description }}</p>
    <p v-if="plugin.error" class="err">加载失败：{{ plugin.error }}</p>
    <button v-if="shortcut" class="btn" @click="emit('shortcut')">{{ shortcut }}</button>

    <div v-if="view" class="form">
      <p v-if="!keys.length" class="dim">这个插件没有可配置的项。</p>
      <ConfigField v-for="k in keys" :key="k" :path="[k]" :value="draft[k]" :defaults="view.defaults" :ui="view.ui" @update="(p, v) => { draft = setAt(draft, p, v) }" />
    </div>

    <footer v-if="view && keys.length">
      <span class="note" :class="{ ok: note.startsWith('✓') }">{{ note || (dirty ? `改了 ${dirty} 处，没保存` : fromDefault ? `与出厂不同 ${fromDefault} 处` : '全是出厂值') }}</span>
      <button class="btn" :disabled="!fromDefault || busy" title="整份改回出厂值并保存" @click="resetAll">全部恢复默认</button>
      <button class="btn" :disabled="!dirty || busy" @click="undo">撤销</button>
      <button class="btn primary" :disabled="!dirty || busy" @click="save()">{{ busy ? '保存中…' : '保存' }}</button>
    </footer>
    <p v-else-if="note" class="note">{{ note }}</p>
  </div>
</template>

<style scoped>
.cfg { display: flex; flex-direction: column; gap: 8px; min-height: 100%; }
header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.title { display: flex; align-items: baseline; gap: 8px; font-size: 15px; }
.desc { font-size: 12px; margin: 0; }
.switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; white-space: nowrap; }
.form { flex: 1; }
footer {
  position: sticky; bottom: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 10px 0; background: var(--panel-solid); border-top: 1px solid var(--line);
}
footer .btn { font-size: 12px; padding: 5px 12px; }
footer .btn:disabled { opacity: .45; cursor: default; }
.cfg > .btn { align-self: flex-start; font-size: 12px; padding: 4px 12px; }
.note { flex: 1; font-size: 12px; color: var(--fg-dim); min-width: 140px; }
.note.ok { color: var(--ok); }
.err { color: var(--err); font-size: 12px; margin: 0; }
</style>
