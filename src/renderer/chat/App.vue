<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue'
import { useChatStore } from './stores/chat'
import ChatMessage from './components/ChatMessage.vue'
import InputBar from './components/InputBar.vue'
import type { TraceStep, ExecutionTrace, ImageAttachment } from '@shared/types'

const store = useChatStore()

// ── UI 引用 ──
const messageListRef = ref<HTMLElement | null>(null)

// ── 拖拽窗口（自定义标题栏）──
let isDragging = false
let dragStartX = 0
let dragStartY = 0

function onTitleMouseDown(e: MouseEvent) {
  // 不拖拽按钮区域
  const target = e.target as HTMLElement
  if (target.closest('.title-btn')) return

  isDragging = true
  dragStartX = e.screenX
  dragStartY = e.screenY

  // 通知主进程开始拖拽
  // Electron 的 frameless window 可以用 -webkit-app-region: drag
  // 但为了精确控制，我们用 CSS 方案
}

function onTitleMouseMove(e: MouseEvent) {
  if (!isDragging) return
  const deltaX = e.screenX - dragStartX
  const deltaY = e.screenY - dragStartY
  dragStartX = e.screenX
  dragStartY = e.screenY
  // 通过 Electron 的 window.moveBy 移动
  // 实际上 frameless window 可以直接用 CSS -webkit-app-region: drag
}

function onTitleMouseUp() {
  isDragging = false
}

// ── 发送消息 ──
async function handleSend(message: string, images?: ImageAttachment[]) {
  store.addUserMessage(message, images)
  store.startAssistantMessage()

  await scrollToBottom()

  // 通过 IPC 发送到主进程
  await window.chatAPI.send(message, images)
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

  // 监听流式响应
  unlistenChunk = window.chatAPI.onResponseChunk((data) => {
    store.appendChunk(data.delta)
  })

  unlistenDone = window.chatAPI.onResponseDone(() => {
    store.finishStreaming()
  })

  unlistenError = window.chatAPI.onResponseError((error) => {
    store.finishStreaming()
    // 添加错误消息
    store.messages.push({
      id: `msg-error-${Date.now()}`,
      role: 'system',
      content: `⚠️ 错误: ${error.message}`,
      timestamp: Date.now()
    })
  })

  // 监听执行追踪
  unlistenTraceStep = window.chatAPI.onTraceStep((step: TraceStep) => {
    // 实时更新追踪步骤
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
})

// ── 关闭窗口 ──
function handleClose() {
  window.chatAPI.close()
}

// ── 打开设置面板 ──
function openSettings() {
  window.chatAPI.openPanel('settings')
}
</script>

<template>
  <div class="chat-root" :class="themeClass" data-testid="chat-root">
    <!-- ═══ 自定义标题栏 ═══ -->
    <div class="title-bar" data-testid="title-bar" @mousedown="onTitleMouseDown" @mousemove="onTitleMouseMove" @mouseup="onTitleMouseUp">
      <div class="title-left">
        <span class="title-owl">🦉</span>
        <span class="title-text">Zen Agent</span>
      </div>
      <div class="title-right">
        <button class="title-btn" data-testid="btn-settings" title="设置" @click="openSettings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="title-btn" data-testid="btn-new-session" title="新建对话" @click="store.clearMessages()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <button class="title-btn is-close" data-testid="btn-close" title="关闭" @click="handleClose">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ═══ 消息列表 ═══ -->
    <div class="message-list" data-testid="message-list" ref="messageListRef">
      <!-- 空状态 -->
      <div v-if="store.messages.length === 0" class="empty-state" data-testid="empty-state">
        <div class="empty-owl" data-testid="empty-owl">🦉</div>
        <p class="empty-title">你好，我是小禅</p>
        <p class="empty-desc">你的自我进化 AI 桌面助手</p>
        <div class="empty-suggestions">
          <div class="suggestion-item">💡 帮我写一个 Vue 组件</div>
          <div class="suggestion-item">📝 写一篇技术文章</div>
          <div class="suggestion-item">🔍 搜索最新技术资讯</div>
          <div class="suggestion-item">📊 分析一段数据</div>
        </div>
      </div>

      <!-- 消息列表 -->
      <ChatMessage
        v-for="msg in store.messages"
        :key="msg.id"
        :message="msg"
        :live-steps="msg.streaming ? store.liveSteps : []"
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
}

.title-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-owl {
  font-size: 20px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.08));
}

.title-text {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
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
  font-size: 64px;
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
  padding: 14px 16px;
  border-radius: 12px;
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
</style>
