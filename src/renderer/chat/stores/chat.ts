import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatMessage, ExecutionTrace, TraceStep, ImageAttachment, Session, LLMProviderConfig } from '@shared/types'

export const useChatStore = defineStore('chat', () => {
  // ── 状态 ──
  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref(false)
  const currentStreamingId = ref<string | null>(null)
  const sessionId = ref<string>('')
  const liveSteps = ref<TraceStep[]>([])

  // ── 会话列表 ──
  const sessions = ref<Session[]>([])
  const sidebarCollapsed = ref(false)

  // ── 当前模型 ──
  const currentModel = ref<string>('')
  /** 完整模型 key（providerId::model），用于切换时的值匹配 */
  const currentModelKey = ref<string>('')
  /** 可用的 Provider 列表（用于顶部快速切换模型） */
  const availableProviders = ref<LLMProviderConfig[]>([])

  // ── 计算属性 ──
  const messageCount = computed(() => messages.value.length)

  // ── 操作 ──

  /** 添加用户消息 */
  function addUserMessage(content: string, images?: ImageAttachment[]): string {
    const id = `msg-user-${Date.now()}`
    messages.value.push({
      id,
      role: 'user',
      content,
      timestamp: Date.now(),
      images: images && images.length > 0 ? images : undefined
    })
    return id
  }

  /** 添加 Agent 消息（开始流式输出） */
  function startAssistantMessage(): string {
    const id = `msg-assistant-${Date.now()}`
    messages.value.push({
      id,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true
    })
    currentStreamingId.value = id
    isStreaming.value = true
    liveSteps.value = []
    return id
  }

  /** 追加流式输出内容 */
  function appendChunk(delta: string) {
    if (!currentStreamingId.value) return
    const msg = messages.value.find(m => m.id === currentStreamingId.value)
    if (msg) {
      msg.content += delta
    }
  }

  /** 添加实时追踪步骤 */
  function addLiveStep(step: TraceStep) {
    liveSteps.value.push(step)
  }

  /** 完成流式输出 */
  function finishStreaming() {
    if (currentStreamingId.value) {
      const msg = messages.value.find(m => m.id === currentStreamingId.value)
      if (msg) {
        msg.streaming = false
      }
    }
    currentStreamingId.value = null
    isStreaming.value = false
    liveSteps.value = []
  }

  /** 附加执行追踪到最新 Agent 消息 */
  function attachTrace(trace: ExecutionTrace) {
    // 找到最近的 assistant 消息
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'assistant') {
        messages.value[i].trace = trace
        break
      }
    }
    liveSteps.value = []
  }

  /** 清空消息 */
  function clearMessages() {
    messages.value = []
    currentStreamingId.value = null
    isStreaming.value = false
    liveSteps.value = []
  }

  /** 设置会话 ID */
  function setSessionId(id: string) {
    sessionId.value = id
  }

  /** 设置当前模型 */
  function setCurrentModel(model: string) {
    currentModel.value = model
  }

  /** 设置当前完整模型 key */
  function setCurrentModelKey(key: string) {
    currentModelKey.value = key
  }

  /** 设置可用 Provider 列表 */
  function setAvailableProviders(list: LLMProviderConfig[]) {
    availableProviders.value = list
  }

  /**
   * 切换默认模型 —— 调 IPC 持久化并更新本地状态。
   * @param key "providerId::model"
   */
  async function switchModel(key: string): Promise<boolean> {
    try {
      await window.chatAPI.setConfig({ defaultModel: key })
      currentModelKey.value = key
      // defaultModel 格式为 "providerId::modelName"，提取模型名用于徽章显示
      currentModel.value = key.split('::')[1] || key
      return true
    } catch (e) {
      console.error('[chat] switchModel failed:', e)
      return false
    }
  }

  /** 加载会话列表 */
  async function loadSessions() {
    try {
      sessions.value = await window.chatAPI.listSessions()
    } catch {
      // 静默失败
    }
  }

  /** 设置会话列表 */
  function setSessions(list: Session[]) {
    sessions.value = list
  }

  /** 切换侧边栏 */
  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  /** 加载指定会话的消息 */
  async function loadSessionMessages(sid: string) {
    try {
      const result = await window.chatAPI.loadSession(sid)
      sessionId.value = sid
      messages.value = result.messages || []
      currentStreamingId.value = null
      isStreaming.value = false
      liveSteps.value = []
      return result
    } catch {
      return null
    }
  }

  /** 删除会话 */
  async function deleteSessionById(sid: string) {
    try {
      await window.chatAPI.deleteSession(sid)
      sessions.value = sessions.value.filter(s => s.id !== sid)
      if (sessionId.value === sid) {
        clearMessages()
      }
    } catch {
      // 静默失败
    }
  }

  return {
    messages,
    isStreaming,
    currentStreamingId,
    sessionId,
    liveSteps,
    sessions,
    sidebarCollapsed,
    currentModel,
    currentModelKey,
    availableProviders,
    messageCount,
    addUserMessage,
    startAssistantMessage,
    appendChunk,
    addLiveStep,
    finishStreaming,
    attachTrace,
    clearMessages,
    setSessionId,
    setCurrentModel,
    setCurrentModelKey,
    setAvailableProviders,
    switchModel,
    loadSessions,
    setSessions,
    toggleSidebar,
    loadSessionMessages,
    deleteSessionById
  }
})
