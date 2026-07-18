<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import { useChatStore } from './stores/chat'
import ChatMessage from './components/ChatMessage.vue'
import InputBar from './components/InputBar.vue'
import type { TraceStep, ExecutionTrace, ImageAttachment, Session } from '@shared/types'

const store = useChatStore()

// ── UI 引用 ──
const messageListRef = ref<HTMLElement | null>(null)

// ── 拖拽窗口（自定义标题栏）──
let isDragging = false
let dragStartX = 0
let dragStartY = 0

function onTitleMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.title-btn')) return
  isDragging = true
  dragStartX = e.screenX
  dragStartY = e.screenY
}

function onTitleMouseMove(e: MouseEvent) {
  if (!isDragging) return
  const deltaX = e.screenX - dragStartX
  const deltaY = e.screenY - dragStartY
  dragStartX = e.screenX
  dragStartY = e.screenY
}

function onTitleMouseUp() {
  isDragging = false
}

// ── 发送消息 ──
async function handleSend(message: string, images?: ImageAttachment[]) {
  console.log(`[App.vue] handleSend called: message="${message?.slice(0, 50)}", images=${images?.length || 0}`)
  if (images && images.length > 0) {
    console.log(`[App.vue] Image details:`, images.map(img => ({ id: img.id, mimeType: img.mimeType, width: img.width, height: img.height, dataLen: img.data?.length || 0 })))
  }
  try {
    store.addUserMessage(message, images)
    console.log(`[App.vue] addUserMessage OK`)
    store.startAssistantMessage()
    console.log(`[App.vue] startAssistantMessage OK`)

    await scrollToBottom()
    console.log(`[App.vue] scrollToBottom OK, calling IPC send...`)

    // 通过 IPC 发送到主进程
    // 关键修复：Vue ref 中的对象是响应式 Proxy，Electron IPC 的结构化克隆无法处理 Proxy
    // 必须深拷贝为纯对象后再传递
    const plainImages = images ? JSON.parse(JSON.stringify(images)) as ImageAttachment[] : undefined
    console.log(`[App.vue] Images deep-cloned for IPC: ${plainImages?.length || 0} items`)
    await window.chatAPI.send(message, plainImages)
    console.log(`[App.vue] IPC send completed`)

    // 发送后刷新会话列表
    store.loadSessions()
  } catch (err) {
    console.error(`[App.vue] handleSend ERROR:`, err)
  }
}

// ── 推荐问题 ──
const suggestions = ref<string[]>([])
const suggestionsLoading = ref(false)

// 默认推荐问题（当 LLM 未配置或生成失败时使用）
const defaultSuggestions = [
  '帮我写一个 Vue 组件',
  '写一篇技术文章',
  '搜索最新技术资讯',
  '分析一段数据'
]

/** 加载推荐问题 */
async function loadSuggestions() {
  suggestionsLoading.value = true
  try {
    const result = await window.chatAPI.getSuggestions()
    if (result && result.length > 0) {
      suggestions.value = result
    }
  } catch (e) {
    console.error('Failed to load suggestions:', e)
  } finally {
    suggestionsLoading.value = false
  }
}

/** 点击推荐问题 */
function handleSuggestionClick(text: string) {
  handleSend(text)
}

// ── 重试上一条消息 ──
async function handleRetry() {
  // 找到最后一条用户消息
  const messages = store.messages
  let lastUserMsg: { content: string; images?: ImageAttachment[] } | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserMsg = { content: messages[i].content, images: messages[i].images }
      break
    }
  }
  if (!lastUserMsg) return

  // 移除最后一条 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      messages.splice(i, 1)
      break
    }
  }

  // 重新开始流式输出
  store.startAssistantMessage()
  await scrollToBottom()
  const plainRetryImages = lastUserMsg.images ? JSON.parse(JSON.stringify(lastUserMsg.images)) as ImageAttachment[] : undefined
  await window.chatAPI.send(lastUserMsg.content, plainRetryImages)
  store.loadSessions()
}

// ── 停止生成 ──
function handleStop() {
  window.chatAPI.stop()
}

// ── 自动滚动到底部 ──
async function scrollToBottom() {
  await nextTick()
  if (messageListRef.value) {
    messageListRef.value.scrollTop = messageListRef.value.scrollHeight
  }
}

// 监听消息变化自动滚动
watch(() => store.messages.length, () => {
  scrollToBottom()
})

// 也监听流式内容变化
watch(
  () => store.messages.map(m => m.content).join(''),
  () => {
    if (store.isStreaming) {
      scrollToBottom()
    }
  }
)

// ── 新建会话 ──
async function handleNewSession() {
  const session = await window.chatAPI.newSession()
  store.setSessionId(session.sessionId)
  store.clearMessages()
  await store.loadSessions()
}

// ── 加载历史会话 ──
async function handleLoadSession(sid: string) {
  await store.loadSessionMessages(sid)
  await scrollToBottom()
}

// ── 删除会话 ──
async function handleDeleteSession(sid: string) {
  await store.deleteSessionById(sid)
}

// ── 格式化时间 ──
function formatTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// ── IPC 事件监听 ──
let unlistenChunk: (() => void) | null = null
let unlistenDone: (() => void) | null = null
let unlistenError: (() => void) | null = null
let unlistenTraceStep: (() => void) | null = null
let unlistenTraceComplete: (() => void) | null = null
let unlistenNewSession: (() => void) | null = null

// ── 主题管理 ──
const effectiveTheme = ref('light')
let unlistenTheme: (() => void) | null = null

onMounted(async () => {
  // 新建会话
  const session = await window.chatAPI.newSession()
  store.setSessionId(session.sessionId)

// 加载会话列表
await store.loadSessions()

// 加载当前模型信息
try {
  const config = await window.chatAPI.getConfig()
  if (config?.defaultModel) {
    // defaultModel 格式为 "providerId::modelName"，提取模型名
    const modelName = config.defaultModel.split('::')[1] || config.defaultModel
    store.setCurrentModel(modelName)
    store.setCurrentModelKey(config.defaultModel)
  }
  if (config?.providers) {
    store.setAvailableProviders(config.providers)
  }
} catch (e) {
  console.error('Failed to load model config:', e)
}

// 加载推荐问题（基于历史记录动态生成）
loadSuggestions()

  // 监听流式响应
  unlistenChunk = window.chatAPI.onResponseChunk((data) => {
    store.appendChunk(data.delta)
  })

  unlistenDone = window.chatAPI.onResponseDone(() => {
    store.finishStreaming()
    store.loadSessions()
  })

  unlistenError = window.chatAPI.onResponseError((error) => {
    store.finishStreaming()
    // 添加错误消息
    store.messages.push({
      id: `msg-error-${Date.now()}`,
      role: 'system',
      content: `错误: ${error.message}`,
      timestamp: Date.now()
    })
  })

  // 监听执行追踪
  unlistenTraceStep = window.chatAPI.onTraceStep((step: TraceStep) => {
    store.addLiveStep(step)
  })

  unlistenTraceComplete = window.chatAPI.onTraceComplete((trace: ExecutionTrace) => {
    store.attachTrace(trace)
  })

  // 监听托盘/右键菜单的新建会话通知
  unlistenNewSession = window.chatAPI.onNewSessionNotify(async () => {
    const session = await window.chatAPI.newSession()
    store.setSessionId(session.sessionId)
    store.clearMessages()
    await store.loadSessions()
  })

  // 初始化主题
  try {
    const themeData = await window.chatAPI.getTheme()
    effectiveTheme.value = themeData.effective
  } catch {}

  // 监听主题变化
  unlistenTheme = window.chatAPI.onThemeChange((data) => {
    effectiveTheme.value = data.effective
  })

  // 点击外部关闭模型下拉
  document.addEventListener('click', onDocumentClickCloseDropdown, true)
})

const themeClass = computed(() => `theme-${effectiveTheme.value}`)

onUnmounted(() => {
  unlistenChunk?.()
  unlistenDone?.()
  unlistenError?.()
  unlistenTraceStep?.()
  unlistenTraceComplete?.()
  unlistenNewSession?.()
  unlistenTheme?.()
  document.removeEventListener('click', onDocumentClickCloseDropdown, true)
})

// ── 关闭窗口 ──
function handleClose() {
  window.chatAPI.close()
}

// ── 打开设置面板 ──
function openSettings() {
  window.chatAPI.openPanel('settings')
}

// ── 顶部快速切换模型 ──
const showModelDropdown = ref(false)
/** 已启用且有模型的 Provider */
const enabledProviders = computed(() =>
  store.availableProviders.filter(p => p.enabled && p.models.length > 0)
)
const hasModels = computed(() => enabledProviders.value.length > 0)

function toggleModelDropdown() {
  showModelDropdown.value = !showModelDropdown.value
}
function closeModelDropdown() {
  showModelDropdown.value = false
}

/** 点击外部区域时关闭模型下拉 */
function onDocumentClickCloseDropdown(e: MouseEvent) {
  if (!showModelDropdown.value) return
  const target = e.target as HTMLElement
  if (!target.closest('.model-switcher')) {
    closeModelDropdown()
  }
}
async function selectModel(key: string) {
  await store.switchModel(key)
  closeModelDropdown()
}
</script>

<template>
  <div class="chat-root" :class="themeClass" data-testid="chat-root">
    <!-- ═══ 自定义标题栏 ═══ -->
    <div class="title-bar" data-testid="title-bar" @mousedown="onTitleMouseDown" @mousemove="onTitleMouseMove" @mouseup="onTitleMouseUp">
      <div class="title-left">
        <button class="title-btn sidebar-toggle" title="切换侧边栏" @click="store.toggleSidebar()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
        </button>
        <svg class="title-owl-icon" width="22" height="22" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
          <!-- 耳簇 -->
          <path d="M 58 62 Q 48 35 62 48 Q 58 42 58 62 Z" fill="#3A3A42"/>
          <path d="M 142 62 Q 152 35 138 48 Q 142 42 142 62 Z" fill="#3A3A42"/>
          <!-- 身体 -->
          <ellipse cx="100" cy="118" rx="58" ry="62" fill="#3A3A42"/>
          <!-- 腹部 -->
          <ellipse cx="100" cy="128" rx="36" ry="42" fill="#E8E4DD"/>
          <!-- 翅膀 -->
          <ellipse cx="52" cy="122" rx="14" ry="32" transform="rotate(12 52 122)" fill="#2E2E35"/>
          <ellipse cx="148" cy="122" rx="14" ry="32" transform="rotate(-12 148 122)" fill="#2E2E35"/>
          <!-- 眼窝 -->
          <circle cx="80" cy="92" r="23" fill="#E8E4DD"/>
          <circle cx="120" cy="92" r="23" fill="#E8E4DD"/>
          <!-- 瞳孔 -->
          <circle cx="80" cy="92" r="13" fill="#F5A623"/>
          <circle cx="120" cy="92" r="13" fill="#F5A623"/>
          <circle cx="80" cy="92" r="8" fill="#1A1A1A"/>
          <circle cx="120" cy="92" r="8" fill="#1A1A1A"/>
          <!-- 高光 -->
          <circle cx="84" cy="88" r="4" fill="#FFFFFF"/>
          <circle cx="124" cy="88" r="4" fill="#FFFFFF"/>
          <circle cx="76" cy="96" r="2" fill="#FFFFFF"/>
          <circle cx="116" cy="96" r="2" fill="#FFFFFF"/>
          <!-- 喙 -->
          <path d="M 100 103 L 93 112 Q 100 117 107 112 Z" fill="#E8A030" stroke="#C88820" stroke-width="0.5"/>
        </svg>
        <span class="title-text">Zen Agent</span>
        <div class="model-switcher" data-testid="model-switcher">
          <button
            class="title-model-badge is-clickable"
            :class="{ open: showModelDropdown }"
            data-testid="model-badge"
            title="切换模型"
            @click="toggleModelDropdown"
          >
            <span class="model-dot"></span>
            <span class="model-badge-name">{{ store.currentModel || '选择模型' }}</span>
            <svg class="model-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>

          <Transition name="model-dropdown">
            <div v-if="showModelDropdown" class="model-dropdown" data-testid="model-dropdown">
              <template v-if="hasModels">
                <div
                  v-for="provider in enabledProviders"
                  :key="provider.id"
                  class="model-group"
                >
                  <div class="model-group-label">{{ provider.name }}</div>
                  <button
                    v-for="model in provider.models"
                    :key="`${provider.id}::${model}`"
                    class="model-option"
                    :class="{ active: store.currentModelKey === `${provider.id}::${model}` }"
                    @click="selectModel(`${provider.id}::${model}`)"
                  >
                    <span class="model-option-check" v-if="store.currentModelKey === `${provider.id}::${model}`">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                    <span class="model-option-name">{{ model }}</span>
                  </button>
                </div>
              </template>
              <div v-else class="model-dropdown-empty">
                <p>尚未配置任何模型</p>
                <button class="model-dropdown-action" @click="closeModelDropdown(); openSettings()">去设置</button>
              </div>
            </div>
          </Transition>
        </div>
      </div>
      <div class="title-right">
        <button class="title-btn" data-testid="btn-settings" title="设置" @click="openSettings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="title-btn" data-testid="btn-new-session" title="新建对话" @click="handleNewSession">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <button class="title-btn is-close" data-testid="btn-close" title="关闭" @click="handleClose">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ═══ 主体区域 ═══ -->
    <div class="chat-body">
      <!-- ═══ 左侧侧边栏 ═══ -->
      <Transition name="sidebar">
        <div v-if="!store.sidebarCollapsed" class="sidebar" data-testid="sidebar">
          <div class="sidebar-header">
            <span class="sidebar-title">对话历史</span>
            <button class="sidebar-new-btn" title="新建对话" @click="handleNewSession">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
          </div>
          <div class="sidebar-list">
            <div v-if="store.sessions.length === 0" class="sidebar-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.3;">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span>暂无对话记录</span>
            </div>
            <div
              v-for="session in store.sessions"
              :key="session.id"
              class="session-item"
              :class="{ active: session.id === store.sessionId }"
              @click="handleLoadSession(session.id)"
            >
              <svg class="session-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <div class="session-info">
                <span class="session-title-text">{{ session.title || '新对话' }}</span>
                <span class="session-meta">{{ formatTime(session.updatedAt) }} · {{ session.messageCount }} 条</span>
              </div>
              <button
                class="session-delete"
                title="删除"
                @click.stop="handleDeleteSession(session.id)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </Transition>

      <!-- ═══ 消息列表 ═══ -->
      <div class="chat-main">
        <div class="message-list" data-testid="message-list" ref="messageListRef">
          <!-- 空状态 -->
          <div v-if="store.messages.length === 0" class="empty-state" data-testid="empty-state">
            <div class="empty-owl" data-testid="empty-owl">
              <svg width="72" height="72" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                <!-- 耳簇 -->
                <path d="M 58 62 Q 48 35 62 48 Q 58 42 58 62 Z" fill="#3A3A42"/>
                <path d="M 142 62 Q 152 35 138 48 Q 142 42 142 62 Z" fill="#3A3A42"/>
                <!-- 身体 -->
                <ellipse cx="100" cy="118" rx="58" ry="62" fill="#3A3A42"/>
                <!-- 腹部 -->
                <ellipse cx="100" cy="128" rx="36" ry="42" fill="#E8E4DD"/>
                <!-- 翅膀 -->
                <ellipse cx="52" cy="122" rx="14" ry="32" transform="rotate(12 52 122)" fill="#2E2E35"/>
                <ellipse cx="148" cy="122" rx="14" ry="32" transform="rotate(-12 148 122)" fill="#2E2E35"/>
                <!-- 眼窝 -->
                <circle cx="80" cy="92" r="23" fill="#E8E4DD"/>
                <circle cx="120" cy="92" r="23" fill="#E8E4DD"/>
                <!-- 瞳孔 -->
                <circle cx="80" cy="92" r="13" fill="#F5A623"/>
                <circle cx="120" cy="92" r="13" fill="#F5A623"/>
                <circle cx="80" cy="92" r="8" fill="#1A1A1A"/>
                <circle cx="120" cy="92" r="8" fill="#1A1A1A"/>
                <!-- 高光 -->
                <circle cx="84" cy="88" r="4" fill="#FFFFFF"/>
                <circle cx="124" cy="88" r="4" fill="#FFFFFF"/>
                <circle cx="76" cy="96" r="2" fill="#FFFFFF"/>
                <circle cx="116" cy="96" r="2" fill="#FFFFFF"/>
                <!-- 喙 -->
                <path d="M 100 103 L 93 112 Q 100 117 107 112 Z" fill="#E8A030" stroke="#C88820" stroke-width="0.5"/>
              </svg>
            </div>
            <p class="empty-title">你好，我是小禅</p>
            <p class="empty-desc">你的自我进化 AI 桌面助手</p>
<div class="empty-suggestions">
<div
v-for="(text, i) in (suggestions.length > 0 ? suggestions : defaultSuggestions)"
:key="i"
class="suggestion-item"
@click="handleSuggestionClick(text)"
>
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
<template v-if="i === 0"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></template>
<template v-else-if="i === 1"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></template>
<template v-else-if="i === 2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></template>
<template v-else><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></template>
</svg>
<span v-if="suggestionsLoading && suggestions.length === 0" class="suggestion-loading-text">正在分析你的历史对话...</span>
<template v-else>{{ text }}</template>
</div>
</div>
          </div>

          <!-- 消息列表 -->
          <ChatMessage
            v-for="msg in store.messages"
            :key="msg.id"
            :message="msg"
            :live-steps="msg.streaming ? store.liveSteps : []"
            @retry="handleRetry"
          />
        </div>

        <!-- ═══ 输入区 ═══ -->
        <InputBar
          :disabled="store.isStreaming"
          :streaming="store.isStreaming"
          @send="handleSend"
          @stop="handleStop"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: linear-gradient(180deg, var(--surface-root-from) 0%, var(--surface-root-to) 100%);
  border-radius: var(--radius-card);
  overflow: hidden;
  border: 1px solid var(--surface-border);
  box-shadow: var(--shadow-card);
}

/* ═══ 标题栏 ═══ */
.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--surface-card-soft);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--surface-divider);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  position: relative;
  z-index: 100;
}

.title-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sidebar-toggle {
  -webkit-app-region: no-drag;
}

.title-owl-icon {
  color: var(--color-brand);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.08));
}

.title-text {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.title-model-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  margin-left: 2px;
  line-height: 1.4;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 顶部快速切换模型 ── */
.model-switcher {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
}

.title-model-badge.is-clickable {
  -webkit-app-region: no-drag;
  border: none;
  cursor: pointer;
  font: inherit;
  transition: background 0.15s ease, color 0.15s ease;
}
.title-model-badge.is-clickable:hover {
  background: color-mix(in srgb, var(--color-brand-soft) 70%, var(--color-brand) 14%);
}
.title-model-badge.is-clickable.open {
  background: var(--color-brand);
  color: #fff;
}
.title-model-badge.is-clickable.open .model-dot {
  background: #fff;
}

.model-badge-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.model-caret {
  flex-shrink: 0;
  opacity: 0.7;
  transition: transform 0.18s ease;
}
.title-model-badge.open .model-caret {
  transform: rotate(180deg);
}

.model-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  min-width: 220px;
  max-width: 320px;
  max-height: 360px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  background: var(--surface-card);
  border: 1px solid var(--surface-border);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
  -webkit-app-region: no-drag;
}

.model-group + .model-group {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--surface-divider);
}

.model-group-label {
  padding: 4px 8px;
  font-size: 10px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.6);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.model-option {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}
.model-option:hover {
  background: var(--surface-hover, var(--surface-card-soft));
}
.model-option.active {
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-weight: 600;
}

.model-option-check {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--color-brand);
}
.model-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-dropdown-empty {
  padding: 10px 8px;
  text-align: center;
}
.model-dropdown-empty p {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
.model-dropdown-action {
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  background: var(--color-brand);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.model-dropdown-action:hover {
  filter: brightness(1.08);
}

/* 下拉动画 */
.model-dropdown-enter-active,
.model-dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.model-dropdown-enter-from,
.model-dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.model-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand);
  flex-shrink: 0;
  animation: model-pulse 2s ease-in-out infinite;
}

@keyframes model-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.title-right {
  display: flex;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.title-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-button);
  background: transparent;
  color: var(--text-meta);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
}

.title-btn:hover {
  background: var(--color-brand-soft);
  color: var(--color-brand);
  transform: scale(1.05);
}

.title-btn:active {
  transform: scale(0.94);
}

.title-btn.is-close:hover {
  background: var(--color-red-soft);
  color: var(--color-red);
}

/* ═══ 主体区域 ═══ */
.chat-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* ═══ 侧边栏 ═══ */
.sidebar {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-card-soft);
  backdrop-filter: blur(20px) saturate(180%);
  border-right: 1px solid var(--surface-divider);
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  flex-shrink: 0;
}

.sidebar-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-meta);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.sidebar-new-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.sidebar-new-btn:hover {
  background: var(--color-brand);
  color: var(--text-on-brand);
  transform: scale(1.05);
}

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 8px;
}

.sidebar-list::-webkit-scrollbar {
  width: 4px;
}

.sidebar-list::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 2px;
}

.sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 16px;
  color: var(--text-meta);
  font-size: 12px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
  margin-bottom: 2px;
  position: relative;
}

.session-item:hover {
  background: var(--surface-tint-hover);
}

.session-item.active {
  background: var(--color-brand-soft);
}

.session-item.active .session-title-text {
  color: var(--color-brand);
  font-weight: 600;
}

.session-icon {
  color: var(--text-meta);
  flex-shrink: 0;
}

.session-item.active .session-icon {
  color: var(--color-brand);
}

.session-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.session-title-text {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-meta {
  font-size: 10px;
  color: var(--text-meta);
}

.session-delete {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-meta);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.session-item:hover .session-delete {
  opacity: 0.6;
}

.session-delete:hover {
  opacity: 1 !important;
  background: var(--color-red-soft);
  color: var(--color-red);
}

/* ═══ 聊天主区域 ═══ */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* ═══ 消息列表 ═══ */
.message-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scroll-behavior: smooth;
  padding: 8px 0 16px;
}

.message-list::-webkit-scrollbar {
  width: 6px;
}

.message-list::-webkit-scrollbar-track {
  background: transparent;
}

.message-list::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 3px;
}

.message-list::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

/* ═══ 空状态 ═══ */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 56px 24px 32px;
  text-align: center;
}

.empty-owl {
  color: var(--color-brand);
  margin-bottom: 18px;
  animation: float 4s cubic-bezier(0.32, 0.72, 0, 1) infinite;
  filter: drop-shadow(0 4px 12px rgba(91, 170, 138, 0.15));
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.empty-title {
  font-size: 26px;
  font-weight: 800;
  color: var(--text-primary);
  margin: 0 0 8px 0;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.empty-desc {
  font-size: 14px;
  color: var(--text-meta);
  margin: 0 0 28px 0;
  font-weight: 400;
  line-height: 1.5;
}

.empty-suggestions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 360px;
}

.suggestion-item {
display: flex;
align-items: center;
gap: 8px;
padding: 14px 16px;
border-radius: 12px;
cursor: pointer;
  background: var(--surface-card);
  border: 1px solid var(--surface-border);
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease,
    color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  text-align: left;
  line-height: 1.4;
}

.suggestion-item:hover {
  background: var(--color-brand-softer);
  border-color: var(--color-brand-border);
  color: var(--text-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(91, 170, 138, 0.08);
}

.suggestion-item:active {
transform: translateY(0);
}

.suggestion-loading-text {
color: var(--text-meta);
font-style: italic;
}

/* ═══ 侧边栏动画 ═══ */
.sidebar-enter-active,
.sidebar-leave-active {
  transition: all 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}

.sidebar-enter-from,
.sidebar-leave-to {
  width: 0;
  opacity: 0;
}
</style>
