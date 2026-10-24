<script setup lang="ts">
/**
 * 右侧抽屉：对话列表（带来源、筛选、未读）+ 当前对话的完整记录。贴底自动跟随，用户上翻则停住。
 * 平台会话（QQ 群 / 私聊）按她的视角排：别人在左、她在右；群里可打开「读空气」看每句为什么接 / 不接。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { Conversation } from '../../protocol/types.ts'
import type { Message } from '../../store/projection.ts'
import ConversationList from './ConversationList.vue'
import MessageBubble from './MessageBubble.vue'
import { badge, isPlatform, sourceOf } from './sources.ts'

const props = defineProps<{ open: boolean, messages: Message[], name: string, conversations: Conversation[], channel: string, seen: Record<string, number> }>()
const emit = defineEmits<{ close: [], switch: [channel: string], create: [] }>()
const list = ref<HTMLElement>()
let follow = true

const current = computed(() => props.conversations.find(c => c.channel === props.channel))
const source = computed(() => sourceOf(current.value))
const platform = computed(() => isPlatform(source.value))
const hasPolicy = computed(() => props.messages.some(m => m.policy))
const POLICY_KEY = 'mumu.showPolicy'
const showPolicy = ref(readFlag())
function readFlag(): boolean {
  try {
    return localStorage.getItem(POLICY_KEY) !== '0'
  }
  catch {
    return true // 读不到本地存储：默认显示
  }
}
function togglePolicy(): void {
  showPolicy.value = !showPolicy.value
  try {
    localStorage.setItem(POLICY_KEY, showPolicy.value ? '1' : '0')
  }
  catch {
    // 存不了就只在这次页面里生效
  }
}

function onScroll(): void {
  const el = list.value
  if (!el)
    return
  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

watch(() => [props.messages.length, props.messages[props.messages.length - 1]?.reveal, props.open, props.channel], async () => {
  await nextTick()
  if (follow && list.value)
    list.value.scrollTop = list.value.scrollHeight
})
</script>

<template>
  <Transition name="slide">
    <aside v-if="open" class="drawer">
      <header>
        <span>对话</span>
        <div class="hb">
          <button class="btn primary" @click="emit('create')">新对话</button>
          <button class="btn" @click="emit('close')">收起</button>
        </div>
      </header>
      <ConversationList :conversations="conversations" :channel="channel" :seen="seen" @switch="c => emit('switch', c)" />
      <div v-if="current" class="now">
        <span>{{ badge(source).icon }} <b>{{ current.title }}</b> <span class="dim">{{ badge(source).label }}{{ source.id && source.name ? ` · ${source.id}` : '' }}</span></span>
        <button v-if="hasPolicy" class="btn small" :class="{ primary: showPolicy }" title="每句群消息为什么叫醒 / 没叫醒她（group-policy）" @click="togglePolicy">读空气</button>
      </div>
      <div ref="list" class="list" @scroll="onScroll">
        <div v-if="!messages.length" class="empty dim">还没聊过。说点什么吧。</div>
        <MessageBubble v-for="m in messages" :key="m.id" :message="m" :name="name" :platform="platform" :show-policy="showPolicy" />
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: min(440px, 100vw); z-index: 6;
  display: flex; flex-direction: column;
  background: var(--panel); backdrop-filter: blur(16px);
  border-left: 1px solid var(--line); box-shadow: var(--shadow);
}
header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; border-bottom: 1px solid var(--line); font-weight: 600;
}
.hb { display: flex; gap: 6px; }
.hb .btn { font-size: 12px; padding: 4px 10px; }
.now { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--line); font-size: 13px; }
.now .dim { font-size: 11px; }
.btn.small { font-size: 11px; padding: 2px 9px; }
.list { flex: 1; overflow-y: auto; padding: 8px 16px 24px; }
.empty { padding: 40px 0; text-align: center; }
.slide-enter-active, .slide-leave-active { transition: transform .25s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }
</style>
