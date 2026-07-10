<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { TraceStep, StepType } from '@shared/types'

const props = defineProps<{
  steps: TraceStep[]
}>()

// ── 折叠状态 ──
const expanded = ref(true)

// ── 步骤图标 ──
const stepIcons: Record<StepType, string> = {
  intent: '📝',
  memory: '🧠',
  skill_match: '🔧',
  think: '💭',
  act: '🔍',
  observe: '👁',
  reflect: '🔄',
  store: '💾',
  stats: '📊',
  complete: '✅',
  plan: '📋',
  delegate: '🤝'
}

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
      <span class="live-toggle">{{ expanded ? '▾' : '▸' }}</span>
      <span class="live-icon">{{ summary.isComplete ? '✅' : '🔄' }}</span>
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
            <span class="live-step-icon">{{ stepIcons[step.type] || '•' }}</span>
            <span class="live-step-index">{{ step.index }}</span>
            <span class="live-step-name">{{ step.name }}</span>
            <span class="live-step-status" :class="`status-${step.status}`">
              {{ step.status === 'running' ? '⏳' : step.status === 'completed' ? '✅' : step.status === 'error' ? '❌' : '⏭️' }}
            </span>
            <button
              class="copy-btn"
              title="复制输出"
              @click.stop="copyStepOutput(step)"
            >
              {{ copiedId === step.id ? '✓' : '📋' }}
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
                <span v-for="i in 5" :key="i" :class="{ filled: i <= step.detail.selfScore }">★</span>
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
  font-size: 9px;
  width: 10px;
}

.live-icon {
  font-size: 12px;
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
  font-size: 13px;
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
  font-size: 11px;
}

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

.brief-stars span {
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
