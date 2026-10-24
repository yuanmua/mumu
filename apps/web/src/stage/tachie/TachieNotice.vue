<script setup lang="ts">
/**
 * 立绘缺图时的说明卡：要哪些文件、放哪里、多大、姿势要求。
 * 底图缺失时它就是整个舞台；底图在而表情图缺时由父组件按需展开。只渲染，不读状态。
 */
import { describeImage } from './profile.ts'
import type { TachieProfile } from './profile.ts'

defineProps<{
  dir: string
  profile?: TachieProfile
  files: string[]
  found: Record<string, boolean>
  error?: string
}>()
</script>

<template>
  <div class="notice">
    <div class="title">{{ profile ? '立绘还没放齐' : '立绘档案没加载出来' }}</div>
    <div v-if="error" class="dim">{{ error }}</div>
    <div class="dim">图放在 <code>apps/web/public/{{ dir }}/</code>，档案是同目录的 <code>profile.json</code>。聊天照常可用。</div>
    <ul v-if="profile" class="files">
      <li v-for="f in files" :key="f" :class="{ ok: found[f], missing: found[f] === false }">
        <span class="mark">{{ found[f] ? '✓' : '✗' }}</span>
        <code>{{ f }}</code>
        <span class="dim">{{ describeImage(profile, f) }}</span>
      </li>
    </ul>
    <div class="dim rules">
      尺寸建议 1200×2000 透明 PNG（竖构图、全身、正面）。所有图<b>同一姿势、同一构图、同一画幅</b>，只改脸：
      表情图之间逐像素对齐，切换时才不会跳。闭眼图、张嘴图可以只画局部（其余透明），叠在上面用。
    </div>
  </div>
</template>

<style scoped>
.notice {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px;
  align-items: center; justify-content: center; text-align: center; padding: 24px; font-size: 14px;
}
.title { font-weight: 600; font-size: 16px; }
code { font: var(--mono); background: var(--user); padding: 1px 6px; border-radius: 4px; }
.files { list-style: none; padding: 0; margin: 4px 0; text-align: left; max-width: 520px; width: 100%; font-size: 13px; }
.files li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.mark { width: 1.2em; text-align: center; }
.ok .mark { color: var(--ok); }
.missing .mark { color: var(--err); }
.rules { max-width: 520px; font-size: 13px; }
</style>
