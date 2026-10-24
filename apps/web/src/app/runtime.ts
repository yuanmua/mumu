/**
 * 运行时：把协议客户端、投影、发声控制接在一起。全应用一个实例。
 * 这里是副作用的唯一执行点：reduce 只返回「该做什么」，live 之后才真做。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { clearMemory, fetchConversations, fetchMeta, openEvents, runCommand, savePersona, sendInput } from '../protocol/client.ts'
import type { Conversation, Persona } from '../protocol/types.ts'
import { createProjection, reduce, resetProjection } from '../store/projection.ts'
import type { Projection } from '../store/projection.ts'
import { Speaker } from '../voice/speaker.ts'

const VOICE_KEY = 'mumu.voice'
const CHANNEL_KEY = 'mumu.channel'
const SEEN_KEY = 'mumu.seen'

export interface Runtime {
  state: Projection
  speaker: Speaker
  conversations: Ref<Conversation[]>
  /** 每个对话看过时的句数（未读 = count − seen） */
  seen: Ref<Record<string, number>>
  send: (text: string) => Promise<boolean>
  clear: () => Promise<boolean>
  setVoice: (on: boolean) => void
  voice: () => boolean
  /** 切到某个对话（内核频道）：重连事件流，服务端重放该对话 */
  switchConversation: (channel: string) => void
  /** 新对话：生成新频道 id，发第一句话后它才出现在列表里 */
  newConversation: () => string
  /** 存人格；成功后重新取 meta（名字可能变了） */
  savePersona: (patch: Partial<Persona>) => Promise<Persona | { error: string }>
  /**
   * 换角色 / 换皮肤：都是后端命令，写进配置才不会刷新就弹回。
   * 命令执行后 surface-web 重载、事件流断开重连，onOpen 里重新 loadMeta 拿到新舞台——这里不自己改 meta。
   * 返回命令输出，出错时界面原样显示。
   */
  useCharacter: (id: string) => Promise<string[]>
  useSkin: (profile: string) => Promise<string[]>
}

let instance: Runtime | undefined

export function useRuntime(): Runtime {
  if (instance)
    return instance
  const state = createProjection()
  const speaker = new Speaker(state)
  const conversations = ref<Conversation[]>([])

  try {
    speaker.enabled = localStorage.getItem(VOICE_KEY) === '1'
    state.channel = localStorage.getItem(CHANNEL_KEY) || 'main'
  }
  catch {
    // 隐私模式等情况读不到，用默认
  }
  // 每个对话「看过时有几句」：与列表里的 count 相减即未读。只是这个浏览器的阅读进度，存本地
  const seen = ref<Record<string, number>>({})
  try {
    seen.value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
  }
  catch {
    // 读不到或坏了：当作都没看过
  }
  const refreshConversations = async (): Promise<void> => {
    conversations.value = await fetchConversations()
    // 正在看的这个对话，看到的就是全部
    const cur = conversations.value.find(c => c.channel === state.channel)
    if (cur && seen.value[cur.channel] !== cur.count) {
      seen.value = { ...seen.value, [cur.channel]: cur.count }
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(seen.value))
      }
      catch {
        // 存不了：刷新后未读数会回来，不影响别的
      }
    }
  }

  const loadMeta = async (): Promise<void> => {
    const meta = await fetchMeta()
    if (meta) {
      state.meta.name = meta.character?.name ?? ''
      state.meta.voice = !!meta.voice?.available
      state.meta.stage = meta.character?.stage // 角色包切换后 surface-web 重载、事件流重连、这里重新取到新舞台
      state.meta.id = meta.character?.id
      state.meta.characters = meta.characters ?? []
      state.meta.skins = meta.skins ?? []
    }
    state.meta.ready = true // 取不到也算有结果：舞台走默认模型，不能一直不出来
  }
  void loadMeta()

  let close: (() => void) | undefined
  const connect = (): void => {
    close?.()
    close = openEvents({
      onOpen: () => {
        // 重连 = 重新重放：清空投影，从头重建
        resetProjection(state)
        state.connection = 'replaying'
        speaker.stopAll()
        void loadMeta()
        void refreshConversations()
      },
      onError: () => {
        state.connection = state.connection === 'connecting' ? 'offline' : 'reconnecting'
      },
      onIncoming: (e) => {
        for (const fx of reduce(state, e)) {
          if (fx.kind === 'text')
            speaker.feed(fx.uttId, fx.text, fx.total)
          else if (fx.kind === 'settled')
            speaker.finish(fx.uttId, fx.truncated)
          else if (fx.kind === 'reset')
            speaker.stopAll()
        }
        if ((e as { type: string }).type === 'percept.received')
          void refreshConversations() // 新对话的第一句之后它才出现在列表里
      },
    }, state.channel)
  }
  connect()

  const switchConversation = (channel: string): void => {
    if (channel === state.channel)
      return
    state.channel = channel
    try {
      localStorage.setItem(CHANNEL_KEY, channel)
    }
    catch {
      // 存不了也能用
    }
    resetProjection(state)
    state.connection = 'connecting'
    speaker.stopAll()
    connect()
  }

  instance = {
    state,
    speaker,
    conversations,
    seen,
    send: (text) => {
      speaker.player.unlock() // 用户手势：顺便解锁音频
      return sendInput(text, state.channel)
    },
    switchConversation,
    newConversation: () => {
      const id = `c:${Date.now().toString(36)}`
      switchConversation(id)
      return id
    },
    savePersona: async (patch) => {
      const res = await savePersona(patch)
      // persona 是写配置后异步重载的，meta 里的名字由它的 web/meta 拦截器报；稍等它装好再取
      if (!('error' in res))
        setTimeout(() => void loadMeta(), 600)
      return res
    },
    useCharacter: id => runCommand(`/character use ${id}`),
    useSkin: profile => runCommand(`/character skin ${profile}`),
    clear: clearMemory,
    setVoice: (on) => {
      speaker.enabled = on
      if (on)
        speaker.player.unlock()
      else speaker.stopAll()
      try {
        localStorage.setItem(VOICE_KEY, on ? '1' : '0')
      }
      catch {
        // 存不了就下次再问
      }
    },
    voice: () => speaker.enabled,
  }
  return instance
}
