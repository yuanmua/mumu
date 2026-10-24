<script setup lang="ts">
/** 聊天页：舞台铺满，左上角色栏（左侧人格抽屉），右上记录抽屉，底部字幕 + 输入框。只组合组件。 */
import { computed, ref } from 'vue'
import { useRuntime } from '../app/runtime.ts'
import CharacterBar from '../components/chat/CharacterBar.vue'
import Composer from '../components/chat/Composer.vue'
import HistoryDrawer from '../components/chat/HistoryDrawer.vue'
import ModelPanel from '../components/chat/ModelPanel.vue'
import PersonaPanel from '../components/chat/PersonaPanel.vue'
import { badge, isPlatform, sourceOf } from '../components/chat/sources.ts'
import Subtitle from '../components/chat/Subtitle.vue'
import SettingsDrawer from '../components/settings/SettingsDrawer.vue'
import Stage from '../stage/Stage.vue'
import { Listener, supported } from '../voice/listen.ts'

const rt = useRuntime()
const state = rt.state
const drawer = ref(false)
const persona = ref(false)
const models = ref(false)
const settings = ref(false)
const voice = ref(rt.voice())
const showMind = ref(false)
const listening = ref(false)
const listener = new Listener()

const current = computed(() => state.current ? state.messages.find(m => m.id === state.current) : undefined)
// 没有正在说的，就显示最后一条角色消息（它会在几秒后淡出）
const subtitleMessage = computed(() => current.value ?? [...state.messages].reverse().find(m => m.side === 'character'))
// 平台会话（QQ 群 / 私聊）只看不发：网页在这发话，她会在真群里接「网页上的你」
const readonly = computed(() => {
  const c = rt.conversations.value.find(x => x.channel === state.channel)
  const s = sourceOf(c)
  return c && isPlatform(s) ? `这是${badge(s).label}「${c.title}」的记录，网页上只看不发` : undefined
})
const mindNote = computed(() => {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]
    if (e.type === 'mind.decision' && e.data?.note)
      return String(e.data.note)
  }
  return undefined
})

function toggleVoice(): void {
  voice.value = !voice.value
  rt.setVoice(voice.value)
}
function toggleListen(): void {
  if (listening.value)
    listener.stop()
  else void listener.start(a => { listening.value = a })
}
</script>

<template>
  <div class="chat">
    <Stage v-if="state.meta.ready" class="stage" :state="state.stage" :mouth="() => rt.speaker.tick()" :stage="state.meta.stage" />
    <CharacterBar
      :state="state"
      :voice="voice"
      :show-mind="showMind"
      :mind-note="mindNote"
      :use-character="rt.useCharacter"
      :use-skin="rt.useSkin"
      @toggle-voice="toggleVoice"
      @toggle-mind="showMind = !showMind"
      @new-conversation="rt.newConversation()"
      @edit-persona="persona = true"
      @edit-models="models = true; persona = false"
      @open-settings="settings = true"
    />
    <PersonaPanel :open="persona" :save="rt.savePersona" @close="persona = false" />
    <ModelPanel :open="models" @close="models = false" />
    <SettingsDrawer :open="settings" @close="settings = false" @open-persona="settings = false; persona = true" @open-models="settings = false; models = true" />
    <button class="btn history-btn" @click="drawer = !drawer">记录 {{ state.messages.length ? `· ${state.messages.length}` : '' }}</button>
    <div class="bottom">
      <Subtitle :message="subtitleMessage" />
      <Composer :listening="listening" :can-listen="supported()" :readonly="readonly" @send="rt.send" @toggle-listen="toggleListen" />
    </div>
    <HistoryDrawer
      :open="drawer"
      :messages="state.messages"
      :name="state.meta.name"
      :conversations="rt.conversations.value"
      :channel="state.channel"
      :seen="rt.seen.value"
      @close="drawer = false"
      @switch="rt.switchConversation"
      @create="rt.newConversation()"
    />
  </div>
</template>

<style scoped>
.chat { position: relative; height: 100%; overflow: hidden; background: var(--stage-bg); }
.stage { position: absolute; inset: 0; }
.history-btn { position: absolute; top: 14px; right: 14px; z-index: 5; font-size: 12px; backdrop-filter: blur(12px); }
.bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 16px max(16px, env(safe-area-inset-bottom)); z-index: 5; }
</style>
