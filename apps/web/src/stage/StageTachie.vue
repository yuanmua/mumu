<script setup lang="ts">
/**
 * 立绘舞台实现：一组整图叠层 + CSS transform。不引入任何依赖。
 *
 * 分层：表情图们（同一时刻只有一张不透明，200ms 淡入淡出）→ 张嘴图（透明度 = 口型值）→ 闭眼图（眨眼时瞬间盖上）。
 * 动画全部程序化（呼吸、待机摆动、眨眼、口型、手势、打断），由 tachie/driver 算每帧结果，
 * 这里只把结果写到元素上。transform / opacity 每帧直接写 style：这是动画，不是样式。
 * 底图缺失 → 整个舞台是说明卡；表情图缺一两张 → 照常演，顶上一枚小标签可展开清单。聊天不受影响。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { StageState } from '../store/projection.ts'
import { TachieDriver } from './tachie/driver.ts'
import { toTransform } from './tachie/gestures.ts'
import { imageFiles, loadTachieProfile } from './tachie/profile.ts'
import type { TachieProfile } from './tachie/profile.ts'
import TachieNotice from './tachie/TachieNotice.vue'

const props = defineProps<{ state: StageState, mouth: () => number, profile: string }>()
const anchor = ref<HTMLElement>()
const figure = ref<HTMLElement>()
const mouthEl = ref<HTMLImageElement>()
const status = ref<'loading' | 'ready' | 'no-profile' | 'no-base'>('loading')
const error = ref('')
const profile = ref<TachieProfile>()
const files = ref<string[]>([])
const found = ref<Record<string, boolean>>({})
const current = ref('')
const eyesClosed = ref(false)
const showList = ref(false)
const dir = props.profile.replace(/^\/+|\/+$/g, '')
const url = (file: string): string => `/${dir}/${file}`
const missing = computed(() => files.value.filter(f => found.value[f] === false))
// 表情层只放真有文件的图；缺的图在 driver 里仍会被指到，这时画面停在上一张而不是消失
const layers = computed(() => (profile.value ? files.value.filter(f => found.value[f] && f !== profile.value!.eyesClosed && f !== profile.value!.mouthOpen) : []))
let driver: TachieDriver | undefined
let raf = 0
let heightPx = 0

function probe(file: string): Promise<{ ok: boolean, w: number, h: number }> {
  return new Promise((resolve) => {
    const im = new Image()
    im.onload = () => resolve({ ok: true, w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = () => resolve({ ok: false, w: 0, h: 0 })
    im.src = url(file)
  })
}

function measure(): void {
  heightPx = figure.value?.clientHeight ?? 0
}

function tick(): void {
  if (driver && figure.value) {
    driver.setMouth(props.mouth())
    const f = driver.frame()
    figure.value.style.transform = toTransform(f.offset, heightPx)
    if (f.image !== current.value && layers.value.includes(f.image))
      current.value = f.image
    eyesClosed.value = f.eyesClosed
    if (mouthEl.value)
      mouthEl.value.style.opacity = f.mouth.toFixed(3)
  }
  raf = requestAnimationFrame(tick)
}

onMounted(async () => {
  try {
    profile.value = await loadTachieProfile(dir)
  }
  catch (e) {
    status.value = 'no-profile'
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
  const p = profile.value
  files.value = imageFiles(p)
  const results = await Promise.all(files.value.map(async f => [f, await probe(f)] as const))
  for (const [f, r] of results) found.value[f] = r.ok
  const base = results.find(([f]) => f === p.base)?.[1]
  if (!base?.ok) {
    status.value = 'no-base'
    return
  }
  if (missing.value.length)
    console.info(`[tachie] 缺 ${missing.value.length} 张图，相关表情会停在上一张：`, missing.value.join(' '))
  // 适配：高度按视口比例，宽度按底图比例，底边按 fit.y 抬高；都是一次性的布局，不是动画
  anchor.value?.style.setProperty('--fit-h', String(p.fit.height))
  anchor.value?.style.setProperty('--fit-y', String(p.fit.y))
  anchor.value?.style.setProperty('--ar', `${base.w} / ${base.h}`)
  driver = new TachieDriver(p)
  if (props.state.mood)
    driver.mood(props.state.mood.valence, props.state.mood.arousal)
  driver.setSpeaking(props.state.speaking)
  current.value = p.base
  status.value = 'ready'
  requestAnimationFrame(() => { measure(); tick() })
  window.addEventListener('resize', measure)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', measure)
})

watch(() => props.state.emotionAt, () => { if (props.state.emotion) driver?.emotion(props.state.emotion) })
watch(() => props.state.actionAt, () => { if (props.state.action) driver?.action(props.state.action) })
watch(() => props.state.interruptedAt, () => driver?.interrupted())
watch(() => props.state.speaking, on => driver?.setSpeaking(on))
watch(() => props.state.mood, m => { if (m) driver?.mood(m.valence, m.arousal) }, { deep: true })
</script>

<template>
  <div class="host">
    <div v-show="status === 'ready'" ref="anchor" class="anchor">
      <div ref="figure" class="figure">
        <img v-for="f in layers" :key="f" :src="url(f)" class="layer expr" :class="{ on: f === current }" alt="" draggable="false">
        <img v-if="profile?.mouthOpen && found[profile.mouthOpen]" ref="mouthEl" :src="url(profile.mouthOpen)" class="layer mouth" alt="" draggable="false">
        <img v-if="profile?.eyesClosed && found[profile.eyesClosed]" :src="url(profile.eyesClosed)" class="layer eyes" :class="{ on: eyesClosed }" alt="" draggable="false">
      </div>
    </div>
    <button v-if="status === 'ready' && missing.length" class="btn hint" @click="showList = !showList">
      立绘缺 {{ missing.length }} 张图
    </button>
    <div v-if="status === 'loading'" class="loading dim">正在请她出来…</div>
    <TachieNotice v-else-if="status !== 'ready' || showList" :dir="dir" :profile="profile" :files="files" :found="found" :error="error" />
  </div>
</template>

<style scoped>
.host { position: relative; width: 100%; height: 100%; overflow: hidden; }
.anchor {
  position: absolute; left: 50%; bottom: calc(100% * var(--fit-y, 0));
  height: calc(100% * var(--fit-h, 1)); aspect-ratio: var(--ar, 3 / 5);
  transform: translateX(-50%);
}
/* 旋转轴放在脚附近：整图摆动时脚不离地，看起来是身体在动 */
.figure { position: absolute; inset: 0; transform-origin: 50% 92%; will-change: transform; }
.layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0; user-select: none; pointer-events: none; }
.expr { transition: opacity 200ms ease; }
.expr.on { opacity: 1; }
.eyes.on { opacity: 1; }
.loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 14px; }
.hint { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 5; font-size: 12px; color: var(--warn); }
</style>
