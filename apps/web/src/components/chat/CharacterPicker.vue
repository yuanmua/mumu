<script setup lang="ts">
/**
 * 角色栏里的两个下拉：换角色（人设 + 舞台 + 声音整体换）/ 换皮肤（只换舞台）。
 * 下拉的值只认 meta：选了之后后端重载、事件流重连、meta 重新取到才算换好，
 * 中间显示「切换中」；所以刷新页面看到的永远是后端配置里的那身，不会弹回。
 */
import { computed, ref, watch } from 'vue'
import type { CharacterInfo, SkinInfo, StageInfo } from '../../protocol/types.ts'

const props = defineProps<{
  characters: CharacterInfo[]
  skins: SkinInfo[]
  currentId?: string
  stage?: StageInfo
  useCharacter: (id: string) => Promise<string[]>
  useSkin: (profile: string) => Promise<string[]>
}>()

const pending = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

// meta 变了 = 后端已按新配置重载完
watch(() => [props.currentId, props.stage?.profile], () => {
  pending.value = false
  clearTimeout(timer)
})

/** 当前皮肤：没有 meta.stage 时前端走 Live2D 默认模型（见 stage/live2d/profile.ts），这里也按它显示 */
const skinValue = computed(() => props.stage?.kind === 'tachie' ? '' : props.stage?.profile ?? '')

async function run(task: Promise<string[]>): Promise<void> {
  pending.value = true
  error.value = ''
  const lines = await task
  if (!lines.some(l => l.includes('✓'))) {
    pending.value = false
    error.value = lines.join(' ').trim() || '切换失败'
    return
  }
  // 兜底：重载没引起 meta 变化（比如选了同一个）也别一直转
  clearTimeout(timer)
  timer = setTimeout(() => { pending.value = false }, 5000)
}

function pickCharacter(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  if (id && id !== props.currentId)
    void run(props.useCharacter(id))
}
function pickSkin(e: Event): void {
  const profile = (e.target as HTMLSelectElement).value
  if (profile && profile !== skinValue.value)
    void run(props.useSkin(profile))
}
</script>

<template>
  <div v-if="characters.length || skins.length" class="picker">
    <label v-if="characters.length" class="sel">
      <span class="dim">角色</span>
      <select :value="currentId ?? ''" :disabled="pending" @change="pickCharacter">
        <option v-if="!currentId" value="" disabled>（未选）</option>
        <option v-for="c in characters" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
    </label>
    <label v-if="skins.length" class="sel">
      <span class="dim">皮肤</span>
      <select :value="skinValue" :disabled="pending" @change="pickSkin">
        <option v-if="!skins.some(s => s.profile === skinValue)" value="" disabled>{{ stage?.kind === 'tachie' ? '立绘' : '默认' }}</option>
        <option v-for="s in skins" :key="s.id" :value="s.profile">{{ s.id }}</option>
      </select>
    </label>
    <span v-if="pending" class="dim hint">切换中…</span>
    <span v-else-if="error" class="err hint" :title="error">{{ error }}</span>
  </div>
</template>

<style scoped>
.picker { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sel {
  display: flex; align-items: center; gap: 4px; font-size: 12px;
  padding: 3px 4px 3px 10px; border-radius: var(--radius-sm);
  background: var(--panel); border: 1px solid var(--line); backdrop-filter: blur(12px);
}
select { font: inherit; color: var(--fg); background: transparent; border: none; outline: none; padding: 1px 2px; }
.hint { font-size: 12px; }
.err { color: var(--err); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
