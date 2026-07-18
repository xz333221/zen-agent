<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import ZenOwl from './components/ZenOwl.vue'
import SpeechBubble from './components/SpeechBubble.vue'
import type { PetState, PetStateData } from '@shared/types'

// ── 宠物状态 ──
const petState = ref<PetState>('idle')
const bubble = ref<PetStateData['bubble'] | null>(null)

// ── 拖拽支持（优化流畅度：主进程轮询模式）──
let isDragging = false
let dragMoved = false

function onMouseDown(_e: MouseEvent) {
  isDragging = true
  dragMoved = false
}

function onMouseMove(e: MouseEvent) {
  if (!isDragging) return

  // 首次检测到移动时，通知主进程开始轮询拖拽
  if (!dragMoved) {
    if (Math.abs(e.movementX) > 2 || Math.abs(e.movementY) > 2) {
      dragMoved = true
      window.petAPI.onDragStart()
    }
  }
}

function onMouseUp(e: MouseEvent) {
  if (!isDragging) return
  isDragging = false

  // 如果有拖动，通知主进程结束拖拽并保存位置
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
  dragMoved = false
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
  // 全局 mouseup 监听：防止鼠标拖出窗口后无法结束拖拽
  window.addEventListener('mouseup', onMouseUp)
  // 全局 mousemove 监听：拖拽中即使鼠标移出窗口也能继续
  window.addEventListener('mousemove', onMouseMove)

  // 监听状态变化
  unlistenState = window.petAPI.onStateChange((data: PetStateData) => {
    petState.value = data.state
    if (data.bubble) {
      bubble.value = data.bubble
    }
  })

  // ── 气泡功能暂时禁用（透明窗口区域会拦截桌面点击）──
  // 如需恢复，取消下方注释即可
  // unlistenBubble = window.petAPI.onShowBubble((b) => {
  //   bubble.value = b
  // })
  //
  // setTimeout(() => {
  //   bubble.value = {
  //     text: '你好！我是小禅，点击我开始对话吧。',
  //     type: 'greeting',
  //     actionLabel: '开始对话',
  //     actionId: 'start-chat'
  //   }
  // }, 800)

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
  window.removeEventListener('mouseup', onMouseUp)
  window.removeEventListener('mousemove', onMouseMove)
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
    <!-- 气泡功能暂时禁用 -->
    <!-- <div class="pet-bubble-wrapper">
      <SpeechBubble
        v-if="bubble"
        :bubble="bubble"
        @action="onBubbleAction"
        @dismiss="onBubbleDismiss"
      />
    </div> -->

    <ZenOwl :state="petState" />
  </div>
</template>

<style scoped>
.pet-root {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: visible;
}

/* 气泡功能暂时禁用 */
/* .pet-bubble-wrapper {
  position: absolute;
  bottom: 165px;
  right: 10px;
  z-index: 10;
  max-width: 320px;
  pointer-events: none;
} */
</style>
