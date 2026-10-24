<script setup lang="ts">
/**
 * 记录抽屉里的对话列表：每个会话标来源（网页 / QQ 群 / QQ 私聊…），可按来源筛选；
 * 标题是群名 / 对方名，显示未读数与「她今天在这说了几条」。只渲染，切换由父组件做。
 */
import { computed, ref } from 'vue'
import type { Conversation } from '../../protocol/types.ts'
import { badge, matches, sourceOf, unread } from './sources.ts'
import type { SourceFilter } from './sources.ts'

const props = defineProps<{ conversations: Conversation[], channel: string, seen: Record<string, number> }>()
const emit = defineEmits<{ switch: [channel: string] }>()

const FILTERS: { id: SourceFilter, label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'web', label: '🌐 网页' },
  { id: 'group', label: '👥 群' },
  { id: 'private', label: '💬 私聊' },
]
const filter = ref<SourceFilter>('all')
// 只有一种来源时筛选没意义，不显示
const showFilters = computed(() => new Set(props.conversations.map(c => sourceOf(c).kind)).size > 1)
const shown = computed(() => props.conversations.filter(c => matches(c, filter.value)))
const countOf = (f: SourceFilter): number => props.conversations.filter(c => matches(c, f)).length
const when = (at: number): string => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
</script>

<template>
  <div class="convs">
    <div v-if="showFilters" class="filters">
      <button v-for="f in FILTERS" :key="f.id" class="chip" :class="{ on: filter === f.id }" @click="filter = f.id">
        {{ f.label }} <span class="dim">{{ countOf(f.id) }}</span>
      </button>
    </div>
    <button
      v-for="c in shown"
      :key="c.channel"
      class="conv"
      :class="{ on: c.channel === channel }"
      :title="c.channel"
      @click="emit('switch', c.channel)"
    >
      <span class="icon">{{ badge(sourceOf(c)).icon }}</span>
      <span class="main">
        <span class="t">{{ c.title }}</span>
        <span class="dim m">
          <span class="tag">{{ badge(sourceOf(c)).label }}</span>
          {{ c.count ? `${c.count} 句` : '' }}{{ c.said ? ` · 她今天说了 ${c.said} 条` : '' }}{{ c.lastAt ? ` · ${when(c.lastAt)}` : '' }}
        </span>
      </span>
      <span v-if="unread(c, seen, channel)" class="unread">{{ unread(c, seen, channel) > 99 ? '99+' : unread(c, seen, channel) }}</span>
    </button>
    <div v-if="!conversations.some(c => c.channel === channel)" class="conv on">
      <span class="icon">🌐</span>
      <span class="main"><span class="t">新对话</span><span class="dim m">说第一句话后出现在列表里</span></span>
    </div>
  </div>
</template>

<style scoped>
.convs { max-height: 40%; overflow-y: auto; border-bottom: 1px solid var(--line); padding: 6px; }
.filters { display: flex; gap: 4px; flex-wrap: wrap; padding: 2px 4px 6px; }
.chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--line); background: none; color: var(--fg); }
.chip.on { border-color: var(--accent); background: var(--user); }
.conv {
  width: 100%; display: flex; gap: 8px; align-items: center;
  padding: 6px 8px; border-radius: var(--radius-sm); text-align: left; font-size: 13px;
}
.conv:hover { background: var(--user); }
.conv.on { background: var(--user); outline: 1px solid var(--accent); }
.icon { width: 18px; text-align: center; flex-shrink: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); margin-right: 4px; }
.unread { flex-shrink: 0; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--err); color: #fff; font-size: 11px; text-align: center; line-height: 18px; }
</style>
