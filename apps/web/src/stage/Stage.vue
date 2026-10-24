<script setup lang="ts">
/**
 * 舞台接口壳：只定义 props，按角色包给的 stage.kind 选实现。
 * 取不到 meta（后端没起、旧后端没有 characters 插件）时仍走 Live2D 默认。
 * key 用解析后的目录：meta 晚到但指向同一个模型时不重建舞台。
 */
import { computed } from 'vue'
import type { StageInfo } from '../protocol/types.ts'
import type { StageState } from '../store/projection.ts'
import { modelDir } from './live2d/profile.ts'
import StageLive2D from './StageLive2D.vue'
import StageTachie from './StageTachie.vue'

const props = defineProps<{ state: StageState, mouth: () => number, stage?: StageInfo }>()
const kind = computed(() => props.stage?.kind === 'tachie' ? 'tachie' : 'live2d')
const liveDir = computed(() => modelDir(kind.value === 'live2d' ? props.stage?.profile : undefined))
</script>

<template>
  <StageTachie v-if="kind === 'tachie'" :key="`tachie:${stage!.profile}`" :state="state" :mouth="mouth" :profile="stage!.profile" />
  <StageLive2D v-else :key="`live2d:${liveDir}`" :state="state" :mouth="mouth" :profile="liveDir" />
</template>
