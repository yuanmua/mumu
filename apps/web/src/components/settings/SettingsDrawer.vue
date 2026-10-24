<script setup lang="ts">
/**
 * 设置抽屉：左边插件列表（状态点）+ 插件面板 + 密钥，右边是选中项的内容。
 * 所有插件的配置自动有表单（PluginConfig），插件报的面板统一渲染（PanelView）——
 * 网页上的「设置」不为任何具体插件写代码；人格、模型这类已有专用面板的给快捷入口。
 */
import { computed, ref, watch } from 'vue'
import { failed, fetchPlugins } from '../../protocol/admin.ts'
import type { PluginInfo, WebPanel } from '../../protocol/admin.ts'
import { fetchMeta } from '../../protocol/client.ts'
import PanelView from './PanelView.vue'
import PluginConfig from './PluginConfig.vue'
import SecretsBox from './SecretsBox.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [], openPersona: [], openModels: [] }>()

// 专用面板的快捷入口：键是插件 id；这是前端已有组件的入口，不是插件的特例逻辑
const SHORTCUTS: Record<string, { label: string, go: () => void }> = {
  'persona': { label: '用人格面板编辑', go: () => emit('openPersona') },
  'provider-openai': { label: '用模型面板编辑（按环节选模型）', go: () => emit('openModels') },
}

type Pick = { kind: 'plugin', id: string } | { kind: 'panel', id: string } | { kind: 'secrets' }
const plugins = ref<PluginInfo[]>([])
const panels = ref<WebPanel[]>([])
const picked = ref<Pick>()
const error = ref('')

async function load(): Promise<void> {
  const [p, meta] = await Promise.all([fetchPlugins(), fetchMeta()])
  error.value = failed(p) ? p.error : ''
  if (!failed(p))
    plugins.value = p
  panels.value = meta?.panels ?? []
  if (!picked.value && plugins.value.length)
    picked.value = { kind: 'plugin', id: plugins.value[0].id }
}
watch(() => props.open, (o) => { if (o) void load() }, { immediate: true })

const plugin = computed(() => picked.value?.kind === 'plugin' ? plugins.value.find(p => p.id === (picked.value as { id: string }).id) : undefined)
const panel = computed(() => picked.value?.kind === 'panel' ? panels.value.find(p => p.id === (picked.value as { id: string }).id) : undefined)
const dot = (p: PluginInfo): string => p.error ? 'err' : !p.enabled ? 'off' : p.loaded ? 'on' : 'warn'
const isPicked = (k: Pick['kind'], id?: string): boolean => picked.value?.kind === k && (!id || (picked.value as { id?: string }).id === id)
</script>

<template>
  <Transition name="fade">
    <div v-if="open" class="mask" @click.self="emit('close')">
      <aside class="drawer">
        <header>
          <b>设置</b>
          <span class="dim">每个插件的配置都在这里；改完即生效（插件自动重载）</span>
          <button class="btn" @click="emit('close')">关闭</button>
        </header>
        <p v-if="error" class="err">{{ error }}</p>
        <div class="body">
          <nav>
            <div class="sec dim">插件</div>
            <button v-for="p in plugins" :key="p.id" class="item" :class="{ on: isPicked('plugin', p.id) }" :title="p.error ?? p.description" @click="picked = { kind: 'plugin', id: p.id }">
              <span class="dot" :class="dot(p)" />
              <span class="t">{{ p.title }}</span>
            </button>
            <template v-if="panels.length">
              <div class="sec dim">面板</div>
              <button v-for="p in panels" :key="p.id" class="item" :class="{ on: isPicked('panel', p.id) }" @click="picked = { kind: 'panel', id: p.id }">
                <span class="t">▦ {{ p.title }}</span>
              </button>
            </template>
            <div class="sec dim">其他</div>
            <button class="item" :class="{ on: isPicked('secrets') }" @click="picked = { kind: 'secrets' }"><span class="t">🔑 密钥</span></button>
          </nav>
          <section>
            <PluginConfig v-if="plugin" :key="plugin.id" :plugin="plugin" :shortcut="SHORTCUTS[plugin.id]?.label" @changed="load" @shortcut="SHORTCUTS[plugin.id]?.go()" />
            <PanelView v-else-if="panel" :key="panel.id" :panel="panel" />
            <SecretsBox v-else-if="isPicked('secrets')" />
          </section>
        </div>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.mask { position: absolute; inset: 0; z-index: 8; background: rgba(0, 0, 0, .25); display: flex; justify-content: center; align-items: center; }
.drawer {
  width: min(960px, calc(100vw - 24px)); height: min(720px, calc(100vh - 24px));
  display: flex; flex-direction: column; background: var(--panel-solid);
  border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
}
header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
header .dim { flex: 1; font-size: 12px; }
header .btn { font-size: 12px; padding: 4px 10px; }
.body { flex: 1; display: flex; min-height: 0; }
nav { width: 200px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--line); padding: 6px; }
section { flex: 1; overflow-y: auto; padding: 12px 16px 0; }
.sec { font-size: 11px; padding: 8px 8px 4px; }
.item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--radius-sm); text-align: left; font-size: 13px; background: none; border: none; color: var(--fg); }
.item:hover { background: var(--user); }
.item.on { background: var(--user); outline: 1px solid var(--accent); }
.t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--fg-dim); }
.dot.on { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.err { background: var(--err); }
.err { color: var(--err); font-size: 12px; margin: 6px 16px; }
@media (max-width: 640px) {
  .body { flex-direction: column; }
  nav { width: auto; max-height: 30%; border-right: none; border-bottom: 1px solid var(--line); }
}
.fade-enter-active, .fade-leave-active { transition: opacity .15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
