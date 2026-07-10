<script setup lang="ts">
import type { PetStateData } from '@shared/types'

const props = defineProps<{
  bubble: NonNullable<PetStateData['bubble']>
}>()

const emit = defineEmits<{
  action: [actionId: string]
  dismiss: []
}>()

const typeColors: Record<string, string> = {
  info: '#5BAA8A',
  evolution: '#F5A623',
  memory: '#7B68EE',
  greeting: '#5BAA8A',
  error: '#E85D5D'
}
</script>

<template>
  <div class="speech-bubble" data-testid="speech-bubble" :style="{ '--accent': typeColors[bubble.type] || '#5BAA8A' }">
    <button class="bubble-close" data-testid="bubble-close" @click="emit('dismiss')">×</button>
    <p class="bubble-text">{{ bubble.text }}</p>
    <button
      v-if="bubble.actionLabel && bubble.actionId"
      class="bubble-action"
      data-testid="bubble-action"
      @click="emit('action', bubble.actionId!)"
    >
      {{ bubble.actionLabel }}
    </button>
    <!-- 气泡小尖角 -->
    <div class="bubble-arrow"></div>
  </div>
</template>

<style scoped>
.speech-bubble {
  position: relative;
  min-width: 200px;
  max-width: 300px;
  padding: 14px 16px;
  padding-right: 28px;
  background: rgba(255, 255, 255, 0.97);
  border: 1.5px solid var(--accent);
  border-radius: 16px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(10px);
  animation: bubble-in 0.3s ease;
}

@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.bubble-close {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  font-size: 16px;
  color: #999;
  cursor: pointer;
  line-height: 1;
  border-radius: 50%;
  transition: all 0.15s;
}

.bubble-close:hover {
  background: rgba(0, 0, 0, 0.08);
  color: #666;
}

.bubble-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #333;
}

.bubble-action {
  margin-top: 8px;
  padding: 5px 12px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.bubble-action:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.bubble-arrow {
  position: absolute;
  bottom: -7px;
  right: 40px;
  width: 12px;
  height: 12px;
  background: rgba(255, 255, 255, 0.97);
  border-right: 1.5px solid var(--accent);
  border-bottom: 1.5px solid var(--accent);
  transform: rotate(45deg);
}
</style>

<style>
/* ═══ 暗色主题下的气泡 ═══ */
.theme-dark .speech-bubble {
  background: rgba(30, 30, 46, 0.96);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.theme-dark .bubble-text {
  color: #ddd;
}

.theme-dark .bubble-close {
  color: #666;
}

.theme-dark .bubble-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #aaa;
}

.theme-dark .bubble-arrow {
  background: rgba(30, 30, 46, 0.96);
}
</style>
