<script setup lang="ts">
/**
 * 思考时间线：按轮次展示角色在想什么、什么时候开口、说了什么、被打断在哪、导演为什么不动。
 * 数据来自 store/thinking.ts 的纯函数；这里只负责排版。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEvent } from '../../protocol/types.ts'
import { buildTurns } from '../../store/thinking.ts'
import type { Turn, TurnItem } from '../../store/thinking.ts'

const props = defineProps<{ events: LogEvent[] }>()
const turns = computed<Turn[]>(() => buildTurns(props.events))
const list = ref<HTMLElement>()
const follow = ref(true)
const expanded = ref(new Set<string>())

const LABEL: Record<TurnItem['kind'], string> = {
  user: '你说',
  reflex: '脊椎',
  reply: '回复',
  decision: '大脑',
  blocked: '硬闸',
  timer: '定时',
  emotion: '心情',
  tool: '工具',
  error: '出错',
  thinking: '开拍',
}

const ms = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
const clock = (at: number): string => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function toggle(key: string): void {
  if (expanded.value.has(key))
    expanded.value.delete(key)
  else expanded.value.add(key)
}

function onScroll(): void {
  const el = list.value
  if (el)
    follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

watch(() => props.events.length, async () => {
  await nextTick()
  if (follow.value && list.value)
    list.value.scrollTop = list.value.scrollHeight
}, { immediate: true })
</script>

<template>
  <div ref="list" class="thinking" @scroll="onScroll">
    <div v-if="!turns.length" class="empty dim">还没有任何思考。去聊天页说句话，再回来看。</div>

    <section v-for="t in turns" :key="t.id" class="turn">
      <header>
        <span class="when mono">{{ clock(t.startedAt) }}</span>
        <span v-if="t.kind === 'user'" class="user-text">你：{{ t.user }}</span>
        <span v-else-if="t.kind === 'timer'" class="dim">她自己醒来</span>
        <span v-else class="dim">启动</span>
      </header>

      <ol class="items">
        <li v-for="it in t.items.filter(i => i.kind !== 'user')" :key="it.key" class="item" :class="it.kind">
          <span class="offset mono">+{{ ms(it.offsetMs) }}</span>
          <span class="label">{{ LABEL[it.kind] }}</span>
          <div class="body">
            <!-- 回复 -->
            <template v-if="it.reply">
              <div class="title">
                {{ it.title }}
                <span class="stats mono">
                  <template v-if="it.reply.firstTokenMs !== undefined">首字 {{ ms(it.reply.firstTokenMs) }}</template>
                  <template v-if="it.reply.durationMs !== undefined"> · 共 {{ ms(it.reply.durationMs) }}</template>
                  <template v-if="it.reply.text"> · {{ it.reply.text.length }} 字</template>
                  <template v-if="!it.reply.settled"> · 进行中</template>
                </span>
              </div>
              <div v-if="it.reply.guidance" class="guidance">心里想的：{{ it.reply.guidance }}</div>
              <blockquote v-if="it.reply.text" class="said" :class="{ truncated: it.reply.truncated }">{{ it.reply.text }}</blockquote>
              <div v-if="it.reply.truncated && it.reply.generated.length > it.reply.text.length" class="unsaid">
                <button class="link" @click="toggle(it.key)">{{ expanded.has(it.key) ? '收起' : '看没说出去的部分' }}（{{ it.reply.generated.length - it.reply.text.length }} 字，{{ it.reply.cause }}）</button>
                <blockquote v-if="expanded.has(it.key)" class="said ghost">{{ it.reply.generated.slice(it.reply.text.length) }}</blockquote>
              </div>
              <div v-if="it.reply.markers.length" class="markers">
                <span v-for="(k, i) in it.reply.markers" :key="i" class="chip">{{ k.track }}:{{ k.value }}</span>
              </div>
            </template>

            <!-- 大脑决定；被新输入作废的只留一行淡显，那是正常机制不是问题（原因会带到下一拍） -->
            <template v-else-if="it.decision && it.decision.aborted">
              <div class="title dim small">思考被取代（有新输入，原因带到下一拍），{{ ms(it.decision.tookMs) }} 后作废</div>
            </template>
            <template v-else-if="it.decision">
              <div class="title">
                <span>{{ it.title }}</span>
                <span class="stats mono">想了 {{ ms(it.decision.tookMs) }}<template v-if="it.decision.wakeAfterSec"> · {{ it.decision.wakeAfterSec }}s 后再看</template></span>
              </div>
              <div v-if="it.decision.note" class="note">“{{ it.decision.note }}”</div>
              <div v-if="it.decision.reasons.length" class="reasons dim">因为：{{ it.decision.reasons.map(r => r.text).join('；') }}</div>
            </template>

            <!-- 其他 -->
            <template v-else>
              <div class="title">{{ it.title }}</div>
              <div v-if="it.detail" class="note dim">{{ it.detail }}</div>
            </template>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.thinking { height: 100%; overflow-y: auto; padding: 16px 20px 40px; }
.empty { padding: 60px 0; text-align: center; }
.turn { margin-bottom: 22px; }
.turn header {
  display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px;
  padding-bottom: 6px; border-bottom: 1px solid var(--line);
}
.when { color: var(--fg-dim); font-size: 12px; }
.user-text { font-weight: 600; font-size: 15px; }
.items { list-style: none; padding: 0; margin: 0; }
.item {
  display: grid; grid-template-columns: 64px 44px 1fr; gap: 10px; align-items: baseline;
  padding: 6px 0; border-left: 2px solid transparent;
}
.offset { color: var(--fg-dim); font-size: 12px; text-align: right; }
.label { font-size: 11px; padding: 1px 6px; border-radius: 6px; text-align: center; background: var(--user); color: var(--fg-dim); }
.item.reply .label { background: var(--accent); color: var(--accent-fg); }
.item.reflex .label { background: var(--ok); color: #fff; }
.item.decision .label { background: var(--warn); color: #1c1f26; }
.item.blocked .label, .item.error .label { background: var(--err); color: #fff; }
.item.timer .label { background: var(--fg-dim); color: #fff; }
.body { min-width: 0; }
.title { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.stats { color: var(--fg-dim); font-size: 12px; }
.small { font-size: 12px; }
.guidance { font-size: 13px; color: var(--fg-dim); margin-top: 2px; }
.said {
  margin: 6px 0 0; padding: 8px 12px; border-radius: var(--radius-sm);
  background: var(--character); border: 1px solid var(--line);
  white-space: pre-wrap; word-break: break-word; line-height: 1.6;
}
.said.truncated { border-right: 3px solid var(--err); }
.said.ghost { color: var(--fg-dim); border-style: dashed; }
.unsaid { margin-top: 4px; font-size: 12px; }
.link { color: var(--accent); font-size: 12px; padding: 0; }
.markers { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
.note { margin-top: 2px; font-style: italic; }
.reasons { font-size: 12px; margin-top: 2px; }
@media (max-width: 640px) {
  .item { grid-template-columns: 52px 40px 1fr; gap: 6px; }
  .thinking { padding: 12px; }
}
</style>
