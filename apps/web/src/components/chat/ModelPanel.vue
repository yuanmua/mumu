<script setup lang="ts">
/**
 * 左侧抽屉：模型路由（provider-openai 的角色绑定）。每个角色一张卡：端点、温度、长度、失败改用。
 * 每次打开都重新读 /api/models——终端 /config set 可能刚改过，不信本地缓存。
 * 保存提交整张表；后端只把和出厂不同的部分存进库，所以「恢复出厂」= 填回出厂值再保存。
 */
import { computed, ref, watch } from 'vue'
import { fetchModels, saveModels } from '../../protocol/client.ts'
import type { Models } from '../../protocol/types.ts'
import { applyPreset, applyToAll, followDefault, isChanged, ROLE_LABELS, toForms, toRoleForm, toRoles, validate } from './modelsForm.ts'
import type { RoleForm } from './modelsForm.ts'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const data = ref<Models>()
const forms = ref<RoleForm[]>([])
const note = ref('')
const busy = ref(false)

function show(m: Models): void {
  data.value = m
  forms.value = toForms(m)
}

watch(() => props.open, async (open) => {
  if (!open)
    return
  note.value = ''
  data.value = undefined
  const m = await fetchModels()
  if (m)
    show(m)
  else note.value = '读不到模型配置（后端没起，或没装 provider-openai 插件）'
}, { immediate: true })

/** 没写的端点项显示它会继承到的值，免得以为是空的 */
function inherited(f: RoleForm, k: 'baseURL' | 'model' | 'apiKeyRef'): string {
  if (f.role === 'default')
    return ''
  const d = forms.value.find(x => x.role === 'default')
  return d?.[k] ? `继承：${d[k]}` : ''
}

function resetRole(i: number): void {
  const role = forms.value[i].role
  forms.value[i] = toRoleForm(role, data.value?.defaults[role])
}

function resetAll(): void {
  if (!data.value)
    return
  forms.value = toForms({ ...data.value, roles: data.value.defaults })
  note.value = '已填回出厂值（全走 API），点保存才生效'
}

/** 「全走某端点」只列和出厂 default 不同的预设；和 default 相同的那档就是「全走 API」 */
const allPresets = computed(() => data.value?.presets.filter(p => p.baseURL !== data.value?.defaults.default?.baseURL) ?? [])

function allTo(p: Models['presets'][number]): void {
  forms.value = applyToAll(forms.value, p)
  note.value = `除 default 外都改成「${p.name}」，失败退回 default；点保存才生效`
}

async function submit(): Promise<void> {
  if (busy.value)
    return
  const bad = validate(forms.value)
  if (bad) {
    note.value = bad
    return
  }
  busy.value = true
  const res = await saveModels(toRoles(forms.value))
  busy.value = false
  if ('error' in res) {
    note.value = `没存上：${res.error}`
    return
  }
  show(res)
  note.value = '✓ 已保存，下一次调用模型起生效'
}
</script>

<template>
  <Transition name="slide">
    <aside v-if="open" class="panel">
      <header>
        <span>模型</span>
        <button class="btn" @click="emit('close')">收起</button>
      </header>
      <form v-if="data" class="body" @submit.prevent="submit">
        <p class="dim">空着的项由 default 继承。密钥本身用终端或调试页「命令」里的 <code>/secret set 名字 key</code> 设，这里只填名字。</p>
        <section v-for="(f, i) in forms" :key="f.role" class="role">
          <div class="head">
            <b>{{ f.role }}</b>
            <span v-if="isChanged(f, data.defaults)" class="tag">改过</span>
            <span class="dim">{{ ROLE_LABELS[f.role] }}</span>
          </div>
          <div class="quick">
            <button v-for="p in data.presets" :key="p.name" type="button" class="chip" @click="forms[i] = applyPreset(f, p)">{{ p.name }}</button>
            <button v-if="f.role !== 'default'" type="button" class="chip" @click="forms[i] = followDefault(f)">跟随 default</button>
            <button type="button" class="chip" @click="resetRole(i)">恢复出厂</button>
          </div>
          <div class="grid">
            <label class="wide">地址<input v-model="f.baseURL" :placeholder="inherited(f, 'baseURL')"></label>
            <label>模型<input v-model="f.model" :placeholder="inherited(f, 'model')"></label>
            <label>密钥名<input v-model="f.apiKeyRef" list="model-keys" :placeholder="inherited(f, 'apiKeyRef')"></label>
            <label>温度<input v-model="f.temperature" inputmode="decimal" placeholder="模型默认"></label>
            <label>最长输出<input v-model="f.maxTokens" inputmode="numeric" placeholder="模型默认"></label>
            <label v-if="f.role !== 'default'">失败改用
              <select v-model="f.fallback">
                <option value="">不改用</option>
                <option v-for="r in forms.filter(x => x.role !== f.role)" :key="r.role" :value="r.role">{{ r.role }}</option>
              </select>
            </label>
            <label>首块限时 ms<input v-model="f.timeoutMs" inputmode="numeric" :placeholder="f.fallback ? '默认 5000' : '不限'"></label>
            <label>JSON 模式
              <select v-model="f.responseFormat">
                <option value="">默认</option>
                <option value="json">json</option>
                <option value="text">text</option>
              </select>
            </label>
          </div>
        </section>
        <datalist id="model-keys"><option v-for="k in data.keys" :key="k" :value="k" /></datalist>
        <div class="foot">
          <span class="note" :class="{ ok: note.startsWith('✓') }">{{ note }}</span>
          <button v-for="p in allPresets" :key="p.name" type="button" class="btn" @click="allTo(p)">全走{{ p.name }}</button>
          <button type="button" class="btn" title="恢复出厂：全部走 default 的云端模型" @click="resetAll">全走 API</button>
          <button class="btn primary" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </form>
      <div v-else class="body dim">{{ note || '读取中…' }}</div>
    </aside>
  </Transition>
</template>

<style scoped>
.panel {
  position: absolute; top: 0; left: 0; bottom: 0; width: min(560px, 100vw); z-index: 7;
  display: flex; flex-direction: column;
  background: var(--panel); backdrop-filter: blur(16px);
  border-right: 1px solid var(--line); box-shadow: var(--shadow);
}
header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid var(--line); font-weight: 600;
}
header .btn { font-size: 12px; padding: 4px 10px; }
.body { flex: 1; overflow-y: auto; padding: 12px 16px 20px; display: flex; flex-direction: column; gap: 12px; }
.dim { font-weight: 400; font-size: 11px; color: var(--fg-dim); margin: 0; }
code { font: var(--mono); }
.role { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--bg-elev); }
.head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.tag { font-size: 11px; color: var(--accent); }
.quick { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
.chip:hover { border-color: var(--accent); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.wide { grid-column: 1 / -1; }
label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; font-weight: 600; }
input, select {
  font: inherit; font-weight: 400; font-size: 12px; padding: 5px 8px; min-width: 0;
  border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg); color: var(--fg); outline: none;
}
input:focus, select:focus { border-color: var(--accent); }
.foot {
  display: flex; justify-content: flex-end; align-items: center; gap: 8px;
  position: sticky; bottom: -20px; margin: 0 -16px -20px; padding: 10px 16px 14px;
  background: var(--panel-solid); border-top: 1px solid var(--line);
}
.note { flex: 1; font-size: 12px; color: var(--err); }
.note.ok { color: var(--ok); }
.slide-enter-active, .slide-leave-active { transition: transform .25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(-100%); }
</style>
