<script setup lang="ts">
import type { StepStatus } from '@shared/types'

const props = withDefaults(defineProps<{
  status: StepStatus
  size?: number
}>(), {
  size: 14
})

const iconPaths: Record<StepStatus, string> = {
  running: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  completed: '<polyline points="20 6 9 17 4 12"/>',
  error: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  skipped: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>'
}

const isSpinning = props.status === 'running'
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :class="{ spinning: isSpinning }"
    v-html="iconPaths[status] || ''"
  />
</template>

<style scoped>
.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
