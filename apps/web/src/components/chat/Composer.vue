<script setup lang="ts">
/**
 * 底部输入框：Enter 发送，Shift+Enter 换行；/ 开头不发给角色；发送即打断。
 * 输入框永不禁用、永不被输出推动。可选的语音输入按钮（浏览器识别，流式送入内核）。
 */
import { ref } from 'vue'

// readonly：当前是 QQ 群这类平台会话时给一句说明——网页在这里发话，她会在真群里接「网页上的你」，所以只看不发
const props = defineProps<{ listening?: boolean, canListen?: boolean, readonly?: string }>()
const emit = defineEmits<{ send: [text: string], toggleListen: [] }>()
const text = ref('')
const hint = ref('')
const box = ref<HTMLTextAreaElement>()

function submit(): void {
  const t = text.value.trim()
  if (!t)
    return
  if (props.readonly) {
    hint.value = props.readonly
    setTimeout(() => { hint.value = '' }, 4000)
    return
  }
  if (t.startsWith('/')) {
    hint.value = '管理命令在终端里敲，或去「思考」页的命令框'
    setTimeout(() => { hint.value = '' }, 3000)
    return
  }
  text.value = ''
  resize()
  emit('send', t)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

function resize(): void {
  const el = box.value
  if (!el)
    return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
}
</script>

<template>
  <div class="composer">
    <div v-if="hint" class="hint">{{ hint }}</div>
    <div class="row">
      <textarea
        ref="box"
        v-model="text"
        rows="1"
        :placeholder="props.readonly ?? '说点什么…（Enter 发送，Shift+Enter 换行；她说话时发送就是打断）'"
        @keydown="onKey"
        @input="resize"
      />
      <button v-if="props.canListen" class="btn mic" :class="{ primary: props.listening }" title="语音输入" @click="emit('toggleListen')">
        {{ props.listening ? '● 听着' : '🎤' }}
      </button>
      <button class="btn primary" @click="submit">发送</button>
    </div>
  </div>
</template>

<style scoped>
.composer { max-width: min(680px, calc(100vw - 32px)); margin: 0 auto; }
.hint { font-size: 12px; color: var(--fg-dim); text-align: center; margin-bottom: 6px; }
.row {
  display: flex; gap: 8px; align-items: flex-end;
  padding: 8px; border-radius: var(--radius);
  background: var(--panel); backdrop-filter: blur(14px);
  border: 1px solid var(--line); box-shadow: var(--shadow);
}
textarea {
  flex: 1; resize: none; border: none; outline: none; background: transparent;
  padding: 8px 10px; line-height: 1.5; max-height: 160px;
}
.mic { padding: 6px 10px; }
</style>
