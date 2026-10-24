<script setup lang="ts">
/**
 * 聊天记录里的一条消息：角色消息按 <|br|> 拆成多个气泡，被打断的末尾标 ⏹。
 * 平台会话（QQ 群 / 私聊，platform）里站在她那边看：别人在左、她在右，各带名字与头像（没图就画首字）；
 * @ 她的高亮；群消息可附 group-policy 的读空气小字。网页对话保持原样：你在右、她在左。
 */
import { computed, ref } from 'vue'
import type { Message } from '../../store/projection.ts'
import { segmentsOf, WEB_USER } from '../../store/projection.ts'
import { hue } from './sources.ts'

const props = defineProps<{ message: Message, name: string, platform?: boolean, showPolicy?: boolean }>()
const segments = computed(() => props.message.side === 'user' ? [props.message.text] : segmentsOf(props.message))
const time = computed(() => new Date(props.message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
// 群里每个人都是「别人」，只有网页上的你才叫「你」
const other = computed(() => props.message.side === 'user' && !!props.message.sender && props.message.sender.id !== WEB_USER)
const who = computed(() => props.message.side === 'character' ? props.name : other.value ? (props.message.sender?.name || props.message.sender?.id || '?') : '你')
// 她用主题色，别人按 id 散列：她的头像永远不会和某个群友撞色
const avatarBg = computed(() => props.message.side === 'character' ? 'var(--accent)' : `hsl(${hue(props.message.sender?.id ?? '')} 55% 55%)`)
// 头像是平台的外部地址（QQ 头像服务器）：拉不到就退回首字占位，别留一个破图
const avatarFailed = ref(false)
const policy = computed(() => {
  const p = props.message.policy
  if (!p)
    return ''
  return `读空气：${p.wake ? '叫醒她' : '没接'}${p.why.length ? ` · ${p.why.join('；')}` : ''}${p.p !== undefined ? ` · p=${p.p.toFixed(2)}` : ''}`
})
</script>

<template>
  <div class="msg" :class="[message.side, { mirror: platform }]">
    <span v-if="platform" class="avatar" :style="{ background: avatarBg }" :title="who">
      <img v-if="message.sender?.avatar && !avatarFailed" :src="message.sender.avatar" alt="" loading="lazy" referrerpolicy="no-referrer" @error="avatarFailed = true">
      <template v-else>{{ who.slice(0, 1) }}</template>
    </span>
    <div class="body">
      <div class="meta">{{ who }} · {{ time }}</div>
      <a v-for="(img, i) in message.images" :key="`img${i}`" class="bubble pic" :href="img.src" target="_blank" rel="noopener">
        <img :src="img.src" :alt="img.alt ?? '图片'" :title="img.alt" loading="lazy">
      </a>
      <div v-for="(seg, i) in segments" v-show="seg || !message.images.length" :key="i" class="bubble" :class="{ at: message.mentioned }">
        <span v-if="!seg && message.streaming" class="typing"><i /><i /><i /></span>
        {{ seg }}<span v-if="seg && message.streaming && i === segments.length - 1" class="caret" />
        <span v-if="message.truncated && i === segments.length - 1" class="cut" :title="message.cause">⏹ 被打断</span>
      </div>
      <div v-if="message.markers.length" class="markers">
        <span v-for="(k, i) in message.markers" :key="i" class="chip">{{ k.value }}</span>
      </div>
      <div v-if="showPolicy && policy" class="policy" :class="{ wake: message.policy?.wake }">{{ policy }}</div>
      <div v-if="message.work" class="work" :class="{ done: message.work.done, fail: message.work.done && !message.work.ok }">
        <span class="dot" />{{ message.work.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg { display: flex; gap: 8px; margin: 10px 0; align-items: flex-start; }
.body { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; min-width: 0; flex: 1; }
/* 网页对话：你在右、她在左；平台会话（mirror）：别人在左、她在右 */
.msg.user:not(.mirror) .body { align-items: flex-end; }
.msg.mirror.character { flex-direction: row-reverse; }
.msg.mirror.character .body { align-items: flex-end; }
.meta { font-size: 11px; color: var(--fg-dim); padding: 0 6px; }
.avatar {
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; font-weight: 600;
}
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.bubble {
  max-width: 85%; padding: 8px 13px; border-radius: var(--radius);
  background: var(--character); border: 1px solid var(--line);
  white-space: pre-wrap; word-break: break-word; line-height: 1.6;
}
/* 「自己这边」的气泡上色：网页里是你，平台会话里是她 */
.user:not(.mirror) .bubble, .mirror.character .bubble { background: var(--user); border-color: transparent; }
.bubble.at { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
.bubble.pic { padding: 4px; display: block; line-height: 0; }
.pic img { max-width: min(220px, 100%); max-height: 260px; border-radius: calc(var(--radius) - 4px); object-fit: contain; }
.typing { display: inline-flex; gap: 3px; vertical-align: middle; }
.typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--fg-dim); animation: dot 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .2s; }
.typing i:nth-child(3) { animation-delay: .4s; }
@keyframes dot { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }
.caret { display: inline-block; width: 2px; height: 1em; background: var(--accent); margin-left: 2px; vertical-align: -2px; animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.cut { color: var(--err); font-size: 11px; margin-left: 6px; }
.markers { display: flex; gap: 4px; flex-wrap: wrap; padding: 0 4px; }
.policy { font-size: 11px; color: var(--fg-dim); padding: 0 6px; }
.policy.wake { color: var(--ok); }
.work { font-size: 11px; color: var(--fg-dim); padding: 0 6px; display: flex; align-items: center; gap: 5px; }
.work .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s infinite; flex-shrink: 0; }
.work.done .dot { animation: none; background: var(--ok); }
.work.fail .dot { background: var(--err); }
@keyframes pulse { 50% { opacity: .3; } }
</style>
