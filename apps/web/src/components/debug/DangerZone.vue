<script setup lang="ts">
/** 清除记忆：3 秒内点两次才执行。配置库与密钥不动。 */
import { ref } from 'vue'

const emit = defineEmits<{ clear: [] }>()
const armed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function click(): void {
  if (!armed.value) {
    armed.value = true
    timer = setTimeout(() => { armed.value = false }, 3000)
    return
  }
  clearTimeout(timer)
  armed.value = false
  emit('clear')
}
</script>

<template>
  <div class="zone">
    <span class="dim">清除记忆：对话日志归零（含落盘），工作记忆清空；配置与密钥不动。</span>
    <button class="btn danger" :class="{ armed }" @click="click">{{ armed ? '再点一次确认' : '清除记忆' }}</button>
  </div>
</template>

<style scoped>
.zone { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12px; }
</style>
