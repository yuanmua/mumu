<script setup lang="ts">
/**
 * 左上角：名字、状态点、新对话、人格、语音开关、内心开关、调试入口，下一行换角色 / 皮肤。
 * 只读投影，只发事件；换角色 / 皮肤的命令由调用方给的函数执行。
 */
import { computed } from 'vue'
import type { Projection } from '../../store/projection.ts'
import CharacterPicker from './CharacterPicker.vue'
import DesktopPetToggle from './DesktopPetToggle.vue'

const props = defineProps<{
  state: Projection
  voice: boolean
  showMind: boolean
  mindNote?: string
  useCharacter: (id: string) => Promise<string[]>
  useSkin: (profile: string) => Promise<string[]>
}>()
const emit = defineEmits<{ toggleVoice: [], toggleMind: [], newConversation: [], editPersona: [], editModels: [], openSettings: [] }>()

const status = computed(() => {
  const c = props.state.connection
  if (c === 'offline' || c === 'connecting')
    return { text: '离线', cls: 'off' }
  if (c === 'reconnecting')
    return { text: '重连中', cls: 'off' }
  if (props.state.stage.speaking)
    return { text: '说话中', cls: 'speak' }
  if (props.state.thinking)
    return { text: '在想', cls: 'think' }
  return { text: '在线', cls: 'on' }
})
</script>

<template>
  <div class="bar">
    <div class="who">
      <span class="dot" :class="status.cls" />
      <span class="name">{{ state.meta.name || '…' }}</span>
      <span class="dim">{{ status.text }}</span>
      <span v-if="state.stage.mood" class="dim mood">· {{ state.stage.mood.label }}</span>
    </div>
    <div v-if="showMind && mindNote" class="mind">内心：{{ mindNote }}</div>
    <div class="actions">
      <button class="btn primary" title="开一个新对话（历史各自独立）" @click="emit('newConversation')">＋ 新对话</button>
      <button class="btn" @click="emit('editPersona')">人格</button>
      <button class="btn" title="每个环节用哪个模型" @click="emit('editModels')">模型</button>
      <button v-if="state.meta.voice" class="btn" :class="{ primary: voice }" @click="emit('toggleVoice')">
        {{ voice ? '语音 开' : '语音 关' }}
      </button>
      <button class="btn" :class="{ primary: showMind }" @click="emit('toggleMind')">内心</button>
      <DesktopPetToggle />
      <RouterLink class="btn" to="/debug">思考</RouterLink>
      <button class="btn" title="所有插件的配置、面板、密钥" @click="emit('openSettings')">设置</button>
      <RouterLink class="btn" to="/status" title="各部分是否在线">状态</RouterLink>
    </div>
    <CharacterPicker
      :characters="state.meta.characters"
      :skins="state.meta.skins"
      :current-id="state.meta.id"
      :stage="state.meta.stage"
      :use-character="useCharacter"
      :use-skin="useSkin"
    />
  </div>
</template>

<style scoped>
.bar {
  position: absolute; top: 14px; left: 14px; z-index: 5;
  display: flex; flex-direction: column; gap: 8px; max-width: min(520px, calc(100vw - 28px));
}
.who {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 999px;
  background: var(--panel); backdrop-filter: blur(12px);
  border: 1px solid var(--line); box-shadow: var(--shadow);
}
.name { font-weight: 600; }
.mood { font-size: 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--fg-dim); }
.dot.on { background: var(--ok); }
.dot.speak { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.dot.think { background: var(--warn); animation: pulse 1.6s ease-in-out infinite; }
.dot.off { background: var(--err); }
@keyframes pulse { 50% { transform: scale(1.5); opacity: .6; } }
.mind {
  font-size: 12px; color: var(--fg-dim); padding: 6px 12px;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm);
  backdrop-filter: blur(12px);
}
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.actions .btn { font-size: 12px; padding: 4px 10px; backdrop-filter: blur(12px); }
</style>
