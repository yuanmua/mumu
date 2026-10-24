<script setup lang="ts">
/**
 * 角色栏的「桌宠」开关：她电脑桌面上的 Live2D 桌宠显示与否。
 * 状态来自 desktop-pet 插件的 GET /api/desktop-pet/state（存配置库），每 3 秒轮询一次：
 * 从桌宠托盘或 /pet 命令改了，这里几秒内自己跟上，不用刷新。点一下发 /pet on|off。
 * 后端没装插件（接口 404）就不出现。自己取状态，不经共用的投影，免得动别人的文件。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { call, failed } from '../../protocol/admin.ts'
import { runCommand } from '../../protocol/client.ts'

const POLL_MS = 3000

const visible = ref<boolean | undefined>()
const alive = ref(false)
const busy = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

async function refresh(): Promise<void> {
  const s = await call<{ visible?: boolean, alive?: boolean }>('/api/desktop-pet/state')
  if (failed(s)) {
    if (s.error === 'HTTP 404')
      visible.value = undefined // 没装插件：按钮不出现
    return // 后端暂时不通：保持上次显示，下一轮再取
  }
  visible.value = s.visible === true
  alive.value = s.alive === true
}

async function toggle(): Promise<void> {
  if (busy.value || visible.value === undefined)
    return
  busy.value = true
  try {
    await runCommand(visible.value ? '/pet off' : '/pet on')
    await new Promise(r => setTimeout(r, 400)) // 配置写入会重载插件，稍等再读
    await refresh()
  }
  finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => { void refresh() }, POLL_MS)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <button
    v-if="visible !== undefined"
    class="btn"
    :class="{ primary: visible }"
    :disabled="busy"
    :title="alive ? '她电脑桌面上的 Live2D 桌宠' : '她电脑桌面上的 Live2D 桌宠（桌宠程序现在没在跑）'"
    @click="toggle"
  >
    {{ visible ? '桌宠 开' : '桌宠 关' }}
  </button>
</template>
