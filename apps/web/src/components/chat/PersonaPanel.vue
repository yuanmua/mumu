<script setup lang="ts">
/**
 * 左侧抽屉：改人格（name / prompt / style / 要求 / emo、act 词）。
 * 每次打开都重新读 /api/persona——别处（终端 /config set、换角色）可能刚改过，不信本地缓存。
 * 保存由调用方给的 save 执行（runtime 负责存完刷新 meta），本组件只管表单。
 * 底下挂插件报的 `near: 'persona'` 面板（如她自己标的兴趣），用通用 PanelView 画，本组件不认识具体插件。
 */
import { ref, watch } from 'vue'
import type { WebPanel } from '../../protocol/admin.ts'
import { fetchMeta, fetchPersona } from '../../protocol/client.ts'
import type { Persona } from '../../protocol/types.ts'
import PanelView from '../settings/PanelView.vue'
import { toForm, toPatch, validate } from './personaForm.ts'
import type { PersonaForm } from './personaForm.ts'

const props = defineProps<{ open: boolean, save: (p: Persona) => Promise<Persona | { error: string }> }>()
const emit = defineEmits<{ close: [] }>()

const form = ref<PersonaForm>()
const note = ref('')
const busy = ref(false)
const near = ref<WebPanel[]>([])

watch(() => props.open, async (open) => {
  if (!open)
    return
  note.value = ''
  form.value = undefined
  void fetchMeta().then((m) => { near.value = (m?.panels ?? []).filter(p => p.near === 'persona') })
  const p = await fetchPersona()
  if (p)
    form.value = toForm(p)
  else note.value = '读不到人格配置（后端没起，或没装 persona 插件）'
}, { immediate: true })

async function submit(): Promise<void> {
  const f = form.value
  if (!f || busy.value)
    return
  const bad = validate(f)
  if (bad) {
    note.value = bad
    return
  }
  busy.value = true
  const res = await props.save(toPatch(f))
  busy.value = false
  if ('error' in res) {
    note.value = `没存上：${res.error}`
    return
  }
  form.value = toForm(res)
  note.value = '✓ 已保存，她下一句话起就按这个来'
}
</script>

<template>
  <Transition name="slide">
    <aside v-if="open" class="drawer">
      <header>
        <span>人格</span>
        <button class="btn" @click="emit('close')">收起</button>
      </header>
      <form v-if="form" class="body" @submit.prevent="submit">
        <label>名字 <span class="dim">真名</span><input v-model="form.name" maxlength="40"></label>
        <label>各平台网名 <span class="dim">一行一个「平台：网名」；群里叫网名或真名都算叫她</span><textarea v-model="form.aliases" rows="2" placeholder="qq：沐沐小号" /></label>
        <label>人设 <span class="dim">她是谁、性格、喜好，两三句</span><textarea v-model="form.prompt" rows="7" /></label>
        <label>腔调 <span class="dim">口头禅、句尾习惯，一两句</span><textarea v-model="form.style" rows="3" /></label>
        <fieldset>
          <legend>要求 <span class="dim">像真人说话的底线，放在提示词最后</span></legend>
          <div class="modes">
            <label class="mode"><input v-model="form.rulesMode" type="radio" value="default">用内置</label>
            <label class="mode"><input v-model="form.rulesMode" type="radio" value="custom">自定义</label>
            <label class="mode"><input v-model="form.rulesMode" type="radio" value="none">不要</label>
          </div>
          <textarea v-if="form.rulesMode === 'custom'" v-model="form.rules" rows="5" placeholder="整段替换内置的「要求」" />
        </fieldset>
        <label>表情词 emo <span class="dim">逗号分隔；舞台档案里没映射的词会降级成小动作</span><input v-model="form.emo" placeholder="脸红，嘟嘴"></label>
        <label>动作词 act <span class="dim">逗号分隔</span><input v-model="form.act" placeholder="翻书，歪头"></label>
        <div class="foot">
          <span class="note" :class="{ ok: note.startsWith('✓') }">{{ note }}</span>
          <button class="btn primary" :disabled="busy">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </form>
      <div v-else class="body dim">{{ note || '读取中…' }}</div>
      <section v-for="p in near" :key="p.id" class="near">
        <PanelView :panel="p" />
      </section>
    </aside>
  </Transition>
</template>

<style scoped>
/* 不叫 .panel：scoped 样式会套到子组件 PanelView 的根节点（它也叫 .panel）上，把它也绝对定位铺满 */
.drawer {
  position: absolute; top: 0; left: 0; bottom: 0; width: min(440px, 100vw); z-index: 7;
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
label, legend { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
.dim { font-weight: 400; font-size: 11px; }
fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
input:not([type="radio"]), textarea {
  font: inherit; font-weight: 400; font-size: 13px; padding: 7px 10px; resize: vertical;
  border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--bg-elev); color: var(--fg); outline: none;
}
input:focus, textarea:focus { border-color: var(--accent); }
.modes { display: flex; gap: 14px; }
.mode { flex-direction: row; align-items: center; gap: 4px; font-weight: 400; }
.foot {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  position: sticky; bottom: -20px; margin: 0 -16px -20px; padding: 10px 16px 14px;
  background: var(--panel-solid); border-top: 1px solid var(--line);
}
.near { max-height: 42%; overflow: auto; padding: 10px 16px 14px; border-top: 1px solid var(--line); background: var(--panel-solid); }
.note { font-size: 12px; color: var(--err); }
.note.ok { color: var(--ok); }
.slide-enter-active, .slide-leave-active { transition: transform .25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(-100%); }
</style>
