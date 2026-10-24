<script setup lang="ts">
/**
 * Live2D 舞台实现：画布 + 加载 + 把 StageState 的变化交给 driver。
 * 三种失败都有说明界面：Core 没加载、模型档案缺失、模型文件缺失。聊天不受影响。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { StageState } from '../store/projection.ts'
import type { Loaded } from './live2d/loader.ts'
import { loadProfile, modelDir } from './live2d/profile.ts'

// loader/driver 依赖 pixi-live2d-display，它在 import 时就要求 Core 存在；
// 动态 import 保证 Core 缺失时只是舞台不出来，聊天不受影响。
const live2d = () => Promise.all([import('./live2d/loader.ts'), import('./live2d/driver.ts')])

const props = defineProps<{ state: StageState, mouth: () => number, profile?: string }>()
const host = ref<HTMLElement>()
const canvas = ref<HTMLCanvasElement>()
const status = ref<'loading' | 'ready' | 'no-core' | 'no-model'>('loading')
const error = ref('')
const dir = modelDir(props.profile)
let loaded: Loaded | undefined
let driver: InstanceType<Awaited<ReturnType<typeof live2d>>[1]['Driver']> | undefined
let idleFocusTimer: ReturnType<typeof setTimeout> | undefined
let gone = false

onMounted(async () => {
  const w = window as unknown as { Live2DCubismCore?: unknown }
  if (!w.Live2DCubismCore) {
    status.value = 'no-core'
    return
  }
  try {
    const [{ loadModel }, { Driver }] = await live2d()
    const profile = await loadProfile(dir)
    if (gone)
      return
    loaded = await loadModel(canvas.value!, host.value!, dir, profile)
    // 加载途中被卸载（换皮肤 / 换角色太快）：立刻拆掉，别让两个 Live2D 画布同时活着
    if (gone) {
      loaded.destroy()
      loaded = undefined
      return
    }
    driver = new Driver(loaded.model, profile)
    loaded.app.ticker.add(() => driver?.setMouth(props.mouth()))
    if (props.state.mood)
      driver.mood(props.state.mood.valence, props.state.mood.arousal)
    status.value = 'ready'
  }
  catch (e) {
    status.value = 'no-model'
    error.value = e instanceof Error ? e.message : String(e)
  }
})

onBeforeUnmount(() => {
  gone = true
  clearTimeout(idleFocusTimer)
  loaded?.destroy()
})

watch(() => props.state.emotionAt, () => { if (props.state.emotion) driver?.emotion(props.state.emotion) })
watch(() => props.state.actionAt, () => { if (props.state.action) driver?.action(props.state.action) })
watch(() => props.state.interruptedAt, () => driver?.interrupted())
watch(() => props.state.speaking, on => driver?.setSpeaking(on), { immediate: true })
watch(() => props.state.mood, m => { if (m) driver?.mood(m.valence, m.arousal) }, { deep: true })

// 眼神跟随鼠标；离开 2 秒后看回正前方
function onMove(e: PointerEvent): void {
  loaded?.model.focus(e.offsetX, e.offsetY)
  clearTimeout(idleFocusTimer)
  idleFocusTimer = setTimeout(center, 2000)
}
function center(): void {
  if (loaded && host.value)
    loaded.model.focus(host.value.clientWidth / 2, host.value.clientHeight * 0.35)
}
</script>

<template>
  <div ref="host" class="host" @pointermove="onMove" @pointerleave="center">
    <canvas ref="canvas" />
    <div v-if="status !== 'ready'" class="notice">
      <template v-if="status === 'loading'">
        <div class="dim">正在请她出来…</div>
      </template>
      <template v-else-if="status === 'no-core'">
        <div class="title">Live2D 运行时没加载</div>
        <div class="dim">本地 <code>public/live2d/core/live2dcubismcore.min.js</code> 不存在，官方 CDN 也没连上。</div>
        <div class="dim">把 Cubism SDK for Web 里的 Core 文件放到上面的路径，或检查网络后刷新。聊天照常可用。</div>
      </template>
      <template v-else>
        <div class="title">模型没加载出来</div>
        <div class="dim">{{ error }}</div>
        <div class="dim">模型放在 <code>apps/web/public/{{ dir }}/</code>，要有 profile.json 与 .model3.json。</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.host { position: relative; width: 100%; height: 100%; touch-action: none; }
canvas { display: block; width: 100%; height: 100%; }
.notice {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
  align-items: center; justify-content: center; text-align: center; padding: 24px; font-size: 14px;
}
.title { font-weight: 600; font-size: 16px; }
code { font: var(--mono); background: var(--user); padding: 1px 6px; border-radius: 4px; }
</style>
