<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import ZenOwl from './components/ZenOwl.vue'
import SpeechBubble from './components/SpeechBubble.vue'
import type { PetState, PetStateData } from '@shared/types'

// ── 宠物状态 ──
const petState = ref<PetState>('idle')
const bubble = ref<PetStateData['bubble'] | null>(null)

// ── 拖拽支持（优化流畅度）──
let isDragging = false
let dragStartX = 0
let dragStartY = 0
let dragMoved = false
let rafId: number | null = null
let pendingDeltaX = 0
let pendingDeltaY = 0

function onMouseDown(e: MouseEvent) {
  isDragging = true
  dragMoved = false
  dragStartX = e.screenX
  dragStartY = e.screenY
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging) return
  const deltaX = e.screenX - dragStartX
  const deltaY = e.screenY - dragStartY
  if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
    dragMoved = true
  }
  if (dragMoved) {
    // 使用 requestAnimationFrame 合并多个拖拽事件，减少 IPC 通信频率
    pendingDeltaX += deltaX
    pendingDeltaY += deltaY
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        window.petAPI.onDrag(pendingDeltaX, pendingDeltaY)
        pendingDeltaX = 0
        pendingDeltaY = 0
        rafId = null
      })
    }
    dragStartX = e.screenX
    dragStartY = e.screenY
  }
}

function onMouseUp(e: MouseEvent) {
  if (!isDragging) return
  isDragging = false
  // 取消未执行的 raf
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
    // 发送剩余的 delta
    if (pendingDeltaX !== 0 || pendingDeltaY !== 0) {
      window.petAPI.onDrag(pendingDeltaX, pendingDeltaY)
      pendingDeltaX = 0
      pendingDeltaY = 0
    }
  }
  // 如果有拖动，通知主进程保存位置
  if (dragMoved) {
    window.petAPI.onDragEnd()
  }
  // 如果没有拖动，则视为点击
  if (!dragMoved) {
    if (e.button === 2) {
      window.petAPI.onRightClick()
    } else {
      window.petAPI.onClick()
    }
  }
}

// 阻止默认右键菜单
function onContextMenu(e: Event) {
  e.preventDefault()
}

// ── 主题管理 ──
const effectiveTheme = ref('light')
let unlistenTheme: (() => void) | null = null
const themeClass = computed(() => `theme-${effectiveTheme.value}`)

// ── IPC 监听 ──
let unlistenState: (() => void) | null = null
let unlistenBubble: (() => void) | null = null

onMounted(async () => {
  // 监听状态变化
  unlistenState = window.petAPI.onStateChange((data: PetStateData) => {
    petState.value = data.state
    if (data.bubble) {
      bubble.value = data.bubble
    }
  })

  // 监听气泡
  unlistenBubble = window.petAPI.onShowBubble((b) => {
    bubble.value = b
  })

  // 首次启动问候
  setTimeout(() => {
    bubble.value = {
      text: '你好！我是小禅 🦉 点击我开始对话吧。',
      type: 'greeting',
      actionLabel: '开始对话',
      actionId: 'start-chat'
    }
  }, 800)

  // 初始化主题
  try {
    const themeData = await window.petAPI.getTheme()
    effectiveTheme.value = themeData.effective
  } catch {}

  // 监听主题变化
  unlistenTheme = window.petAPI.onThemeChange((data) => {
    effectiveTheme.value = data.effective
  })
})

onUnmounted(() => {
  unlistenState?.()
  unlistenBubble?.()
  unlistenTheme?.()
})

// ── 气泡事件 ──
function onBubbleAction(actionId: string) {
  if (actionId === 'start-chat') {
    window.petAPI.onClick()
  } else {
    window.petAPI.onBubbleAction(actionId)
  }
  bubble.value = null
}

function onBubbleDismiss() {
  bubble.value = null
}
</script>

<template>
  <div
    class="pet-root"
    :class="themeClass"
    data-testid="pet-root"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @contextmenu="onContextMenu"
  >
    <div class="pet-bubble-wrapper">
      <SpeechBubble
        v-if="bubble"
        :bubble="bubble"
        @action="onBubbleAction"
        @dismiss="onBubbleDismiss"
      />
    </div>

    <ZenOwl :state="petState" />
  </div>
</template>

<style scoped>
.pet-root {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  position: relative;
  overflow: visible;
}

.pet-bubble-wrapper {
  position: absolute;
  bottom: 165px;
  right: 10px;
  z-index: 10;
  max-width: 320px;
}
</style>
