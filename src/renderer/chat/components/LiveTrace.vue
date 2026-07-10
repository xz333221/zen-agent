<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { TraceStep, StepType } from '@shared/types'
import TraceIcon from './TraceIcon.vue'
import StatusIcon from './StatusIcon.vue'

const props = defineProps<{
  steps: TraceStep[]
}>()

// ── 折叠状态 ──
const expanded = ref(true)

// ── 自动滚动到底部 ──
const containerRef = ref<HTMLElement | null>(null)

watch(() => props.steps.length, async () => {
  await nextTick()
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight
  }
})

// ── 汇总 ──
const summary = computed(() => {
  const lastStep = props.steps[props.steps.length - 1]
  const isComplete = lastStep?.type === 'complete'
  return {
    count: props.steps.length,
    isComplete,
    lastStepName: lastStep?.name || ''
  }
})

// ── 复制步骤输出 ──
const copiedId = ref<string | null>(null)

async function copyStepOutput(step: TraceStep) {
  let text = ''
  const detail = step.detail as any
  switch (detail?.type) {
    case 'think':
      text = detail.reasoning || ''
      break
    case 'act':
      text = detail.resultSummary || ''
      break
    case 'observe':
      text = detail.analysis || ''
      break
    case 'reflect':
      text = `${detail.scoreReason || ''}\n优点: ${detail.strengths?.join(', ')}\n不足: ${detail.weaknesses?.join(', ')}`
      break
    case 'plan':
      text = detail.tasks?.map((t: any) => `${t.id}: ${t.name} (${t.agentType})`).join('\n') || ''
      break
    case 'delegate':
      text = typeof detail.result?.data === 'string' ? detail.result.data : JSON.stringify(detail.result?.data, null, 2)
      break
    default:
      text = JSON.stringify(detail, null, 2)
  }

  try {
    await navigator.clipboard.writeText(text)
    copiedId.value = step.id
    setTimeout(() => { copiedId.value = null }, 1500)
  } catch {
    // 降级方案
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    copiedId.value = step.id
    setTimeout(() => { copiedId.value = null }, 1500)
  }
}
</script>

<template>
  <div class="live-trace" data-testid="live-trace">
    <!-- 摘要行 -->
    <button class="live-summary" @click="expanded = !expanded">
      <svg class="live-toggle" :class="{ rotated: expanded }" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      <span class="live-icon">
        <svg v-if="summary.isComplete" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <svg v-else class="live-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
      </span>
      <span class="live-label">{{ summary.isComplete ? '执行完成' : '执行中...' }}</span>
      <span class="live-meta">{{ summary.count }} 步</span>
      <span v-if="!summary.isComplete" class="live-pulse"></span>
    </button>

    <!-- 实时步骤列表 -->
    <div v-if="expanded" class="live-steps" ref="containerRef" data-testid="live-steps">
      <TransitionGroup name="step-anim">
        <div
          v-for="step in steps"
          :key="step.id"
          class="live-step"
          :class="`step-type-${step.type}`"
        >
          <!-- 步骤行 -->
          <div class="live-step-row">
            <TraceIcon :type="step.type" :size="14" class="live-step-icon" />
            <span class="live-step-index">{{ step.index }}</span>
            <span class="live-step-name">{{ step.name }}</span>
            <span class="live-step-status" :class="`status-${step.status}`">
              <StatusIcon :status="step.status" :size="12" />
            </span>
            <button
              class="copy-btn"
              title="复制输出"
              @click.stop="copyStepOutput(step)"
            >
              <svg v-if="copiedId === step.id" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
          </div>

          <!-- 步骤简要信息（展开后显示） -->
          <div class="live-step-brief">
            <template v-if="step.detail.type === 'intent'">
              <span class="brief-tag" :class="`complexity-${step.detail.complexity}`">{{ step.detail.complexity }}</span>
              <span class="brief-text">{{ step.detail.classification }}</span>
            </template>
            <template v-else-if="step.detail.type === 'memory'">
              <span class="brief-text">检索到 {{ step.detail.retrieved.length }} 条记忆</span>
            </template>
            <template v-else-if="step.detail.type === 'skill_match'">
              <span class="brief-text">匹配 {{ step.detail.candidates.length }} 个技能</span>
            </template>
            <template v-else-if="step.detail.type === 'think'">
              <span class="brief-text">{{ step.detail.reasoning.slice(0, 80) }}{{ step.detail.reasoning.length > 80 ? '...' : '' }}</span>
            </template>
            <template v-else-if="step.detail.type === 'act'">
              <span class="brief-text">{{ step.detail.resultSummary }}</span>
            </template>
            <template v-else-if="step.detail.type === 'observe'">
              <span class="brief-text">{{ step.detail.analysis.slice(0, 80) }}{{ step.detail.analysis.length > 80 ? '...' : '' }}</span>
            </template>
            <template v-else-if="step.detail.type === 'reflect'">
              <span class="brief-stars">
                <svg v-for="i in 5" :key="i" :class="{ filled: i <= step.detail.selfScore }" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </span>
            </template>
            <template v-else-if="step.detail.type === 'plan'">
              <span class="brief-text">{{ step.detail.taskCount }} 个子任务 · {{ step.detail.decompositionMethod === 'llm' ? 'LLM' : '规则' }}分解</span>
            </template>
            <template v-else-if="step.detail.type === 'delegate'">
              <span class="brief-text">{{ step.detail.agentType }} → {{ step.detail.status }}</span>
            </template>
            <template v-else-if="step.detail.type === 'store'">
              <span class="brief-text">记忆已存储</span>
            </template>
            <template v-else-if="step.detail.type === 'stats'">
              <span class="brief-text">{{ step.detail.contextBreakdown.total }} / {{ step.detail.contextBreakdown.budget }} tokens</span>
            </template>
            <template v-else-if="step.detail.type === 'complete'">
              <span class="brief-text">耗时 {{ (step.detail.totalDuration / 1000).toFixed(1) }}s · {{ step.detail.llmCalls }} LLM 调用</span>
            </template>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.live-trace {
  margin-top: 8px;
  border-radius: var(--radius-input);
  background: var(--color-brand-softer);
  border: 1px solid var(--color-brand-border);
  overflow: hidden;
}

.live-summary {
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-brand);
  transition: background 0.15s;
}

.live-summary:hover {
  background: var(--color-brand-soft);
}

.live-toggle {
  width: 9px;
  height: 9px;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.live-toggle.rotated {
  transform: rotate(90deg);
}

.live-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.live-spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.live-label {
  font-weight: 600;
}

.live-meta {
  color: var(--text-meta);
  font-size: 11px;
}

.live-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

.live-steps {
  padding: 4px 8px 8px;
  max-height: 220px;
  overflow-y: auto;
}

.live-steps::-webkit-scrollbar {
  width: 4px;
}

.live-steps::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 2px;
}

.live-step {
  border-radius: 4px;
  padding: 4px 8px;
  margin-bottom: 2px;
  transition: background 0.15s;
}

.live-step:hover {
  background: var(--surface-tint);
}

.step-type-plan {
  background: var(--color-blue-soft);
  border-left: 2px solid var(--color-blue);
}

.step-type-delegate {
  background: var(--color-violet-soft);
  border-left: 2px solid var(--color-violet);
}

.live-step-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.live-step-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.live-step-index {
  color: var(--text-meta);
  font-size: 10px;
  min-width: 14px;
}

.live-step-name {
  flex: 1;
  color: var(--text-primary);
}

.live-step-status {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.status-running { color: var(--color-blue); }
.status-completed { color: var(--color-brand); }
.status-error { color: var(--color-red); }
.status-skipped { color: var(--text-meta); }

.copy-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  color: var(--text-meta);
  display: flex;
  align-items: center;
  justify-content: center;
}

.live-step:hover .copy-btn {
  opacity: 0.6;
}

.copy-btn:hover {
  opacity: 1 !important;
  background: var(--surface-tint-hover);
  color: var(--text-primary);
}

.live-step-brief {
  padding: 2px 0 2px 24px;
  font-size: 11px;
  color: var(--text-meta);
}

.brief-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  margin-right: 6px;
}

.brief-text {
  color: var(--text-secondary);
}

.brief-stars {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.brief-stars svg {
  color: var(--surface-border);
  font-size: 11px;
}

.brief-stars .filled {
  color: var(--color-amber);
}

.complexity-low { background: var(--color-brand-soft); color: var(--color-brand); }
.complexity-medium { background: var(--color-amber-soft); color: var(--color-amber); }
.complexity-high { background: var(--color-red-soft); color: var(--color-red); }

/* 步骤动画 */
.step-anim-enter-active {
  transition: all 0.3s ease;
}

.step-anim-enter-from {
  opacity: 0;
  transform: translateX(-10px);
}

.step-anim-move {
  transition: transform 0.3s ease;
}
</style>
