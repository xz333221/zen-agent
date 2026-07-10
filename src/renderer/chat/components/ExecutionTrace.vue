<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ExecutionTrace, TraceStep, StepType } from '@shared/types'

const props = defineProps<{
  trace: ExecutionTrace
}>()

// ── 折叠状态 ──
const expanded = ref(false)
const expandedSteps = ref<Set<string>>(new Set())
const expandedDetails = ref<Set<string>>(new Set())

function toggleStep(stepId: string) {
  if (expandedSteps.value.has(stepId)) {
    expandedSteps.value.delete(stepId)
  } else {
    expandedSteps.value.add(stepId)
  }
}

function toggleDetail(detailId: string) {
  if (expandedDetails.value.has(detailId)) {
    expandedDetails.value.delete(detailId)
  } else {
    expandedDetails.value.add(detailId)
  }
}

// ── 汇总信息 ──
const summary = computed(() => {
  const t = props.trace
  const duration = t.endTime ? ((t.endTime - t.startTime) / 1000).toFixed(1) : '...'
  const totalTokens = t.stats.totalInputTokens + t.stats.totalOutputTokens
  return {
    steps: t.steps.length,
    duration: `${duration}s`,
    tokens: totalTokens.toLocaleString(),
    cost: t.stats.estimatedCost.toFixed(4),
    models: t.stats.modelsUsed.join(' + ')
  }
})

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
      text = detail.resultSummary || JSON.stringify(detail.result, null, 2)
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

function formatTokens(step: TraceStep): string {
  if (!step.inputTokens && !step.outputTokens) return ''
  const total = (step.inputTokens || 0) + (step.outputTokens || 0)
  return `${total} tok`
}

function formatDuration(step: TraceStep): string {
  if (!step.duration) return ''
  return `${(step.duration / 1000).toFixed(1)}s`
}

// ── Token 预算可视化 ──
const tokenBreakdown = computed(() => {
  const statsStep = props.trace.steps.find(s => s.type === 'stats')
  if (!statsStep || statsStep.detail.type !== 'stats') return null
  return statsStep.detail
})

function tokenBarWidth(value: number): string {
  if (!tokenBreakdown) return '0%'
  const total = tokenBreakdown.contextBreakdown.total || 1
  return `${(value / total) * 100}%`
}
</script>

<template>
  <div class="execution-trace">
    <!-- ═══ Level 0: 折叠摘要行 ═══ -->
    <button class="trace-summary" @click="expanded = !expanded">
      <span class="trace-toggle">{{ expanded ? '▾' : '▸' }}</span>
      <span class="trace-label">执行详情</span>
      <span class="trace-meta">
        {{ summary.steps }} 步 · {{ summary.duration }} · {{ summary.tokens }} tok · ${summary.cost }}
      </span>
    </button>

    <!-- ═══ Level 1: 步骤列表 ═══ -->
    <div v-if="expanded" class="trace-steps">
      <div
        v-for="step in trace.steps"
        :key="step.id"
        class="trace-step"
        :class="{ 'step-expanded': expandedSteps.has(step.id) }"
      >
        <!-- 步骤头部 -->
        <div class="step-header" role="button" tabindex="0" @click="toggleStep(step.id)" @keydown.enter="toggleStep(step.id)">
          <span class="step-icon">{{ stepIcons[step.type] }}</span>
          <span class="step-index">{{ step.index }}</span>
          <span class="step-name">{{ step.name }}</span>
          <span class="step-status" :class="`status-${step.status}`">
            {{ step.status === 'running' ? '⏳' : step.status === 'completed' ? '✅' : step.status === 'error' ? '❌' : '⏭️' }}
          </span>
          <span class="step-meta">
            <span v-if="formatDuration(step)" class="meta-item">{{ formatDuration(step) }}</span>
            <span v-if="formatTokens(step)" class="meta-item">{{ formatTokens(step) }}</span>
            <span v-if="step.model" class="meta-item model">{{ step.model }}</span>
          </span>
          <button
            class="copy-btn"
            title="复制输出"
            @click.stop="copyStepOutput(step)"
          >
            {{ copiedId === step.id ? '✓' : '📋' }}
          </button>
        </div>

        <!-- 步骤详情 (Level 2) -->
        <div v-if="expandedSteps.has(step.id)" class="step-detail">

          <!-- 意图识别 -->
          <template v-if="step.detail.type === 'intent'">
            <div class="detail-row">
              <span class="detail-label">输入:</span>
              <span class="detail-value">{{ step.detail.userInput }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">分类:</span>
              <span class="detail-value tag">{{ step.detail.classification }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">复杂度:</span>
              <span class="detail-value tag" :class="`complexity-${step.detail.complexity}`">{{ step.detail.complexity }}</span>
            </div>
            <div class="detail-row" v-if="step.detail.requiresPlanning">
              <span class="detail-label">规划:</span>
              <span class="detail-value">需要任务规划</span>
            </div>
          </template>

          <!-- 记忆检索 -->
          <template v-if="step.detail.type === 'memory'">
            <div class="detail-row">
              <span class="detail-label">检索到 {{ step.detail.retrieved.length }} 条记忆:</span>
            </div>
            <div v-for="mem in step.detail.retrieved" :key="mem.id" class="memory-item">
              <div class="memory-header">
                <span class="memory-score">{{ mem.score.toFixed(2) }}</span>
                <span class="memory-source">{{ mem.source }}</span>
                <span class="memory-age">{{ mem.age }}</span>
                <span class="memory-confidence">置信度: {{ (mem.confidence * 100).toFixed(0) }}%</span>
              </div>
              <p class="memory-content">{{ mem.content }}</p>
            </div>
            <div class="detail-row">
              <span class="detail-label">检索参数:</span>
              <span class="detail-value">topK={{ step.detail.searchParams.topK }}, minScore={{ step.detail.searchParams.minScore }}</span>
            </div>
            <button class="expand-detail-btn" @click="toggleDetail(step.id + '-query')">
              {{ expandedDetails.has(step.id + '-query') ? '隐藏' : '查看' }}查询详情
            </button>
          </template>

          <!-- 技能匹配 -->
          <template v-if="step.detail.type === 'skill_match'">
            <div v-for="cand in step.detail.candidates" :key="cand.id" class="skill-candidate">
              <span class="skill-status-icon">{{ cand.loaded ? '✅' : '❌' }}</span>
              <span class="skill-name">{{ cand.name }}</span>
              <span class="skill-score">({{ cand.score.toFixed(2) }})</span>
              <span class="skill-desc">{{ cand.description }}</span>
              <span class="skill-reason">{{ cand.reason }}</span>
            </div>
          </template>

          <!-- Think -->
          <template v-if="step.detail.type === 'think'">
            <div class="think-box">
              <p class="think-reasoning">{{ step.detail.reasoning }}</p>
              <div class="think-decision">
                <span class="detail-label">决策:</span>
                <span class="detail-value">{{ step.detail.decision }}</span>
              </div>
              <div v-if="step.detail.toolsConsidered?.length" class="detail-row">
                <span class="detail-label">考虑工具:</span>
                <span class="detail-value">{{ step.detail.toolsConsidered.join(', ') }}</span>
              </div>
            </div>
            <button
              v-if="step.fullPrompt"
              class="expand-detail-btn"
              @click="toggleDetail(step.id + '-prompt')"
            >
              {{ expandedDetails.has(step.id + '-prompt') ? '隐藏' : '查看' }}完整 Prompt ({{ step.inputTokens }} tok)
            </button>
            <pre v-if="expandedDetails.has(step.id + '-prompt') && step.fullPrompt" class="raw-data">{{ step.fullPrompt }}</pre>
          </template>

          <!-- Act (工具调用) -->
          <template v-if="step.detail.type === 'act'">
            <div class="act-box">
              <div class="detail-row">
                <span class="detail-label">工具:</span>
                <span class="detail-value tag">{{ step.detail.toolName }}</span>
              </div>
              <button class="expand-detail-btn" @click="toggleDetail(step.id + '-params')">
                {{ expandedDetails.has(step.id + '-params') ? '隐藏' : '查看' }}参数
              </button>
              <pre v-if="expandedDetails.has(step.id + '-params')" class="raw-data">{{ JSON.stringify(step.detail.parameters, null, 2) }}</pre>

              <div class="detail-row">
                <span class="detail-label">结果摘要:</span>
                <span class="detail-value">{{ step.detail.resultSummary }}</span>
              </div>
              <button class="expand-detail-btn" @click="toggleDetail(step.id + '-result')">
                {{ expandedDetails.has(step.id + '-result') ? '隐藏' : '查看' }}完整结果
              </button>
              <pre v-if="expandedDetails.has(step.id + '-result')" class="raw-data">{{ JSON.stringify(step.detail.result, null, 2) }}</pre>

              <div v-if="step.detail.requiresApproval" class="approval-badge">
                {{ step.detail.approved ? '✅ 已批准' : '⏳ 等待批准' }}
              </div>
            </div>
          </template>

          <!-- Observe -->
          <template v-if="step.detail.type === 'observe'">
            <p class="observe-text">{{ step.detail.analysis }}</p>
            <div class="detail-row">
              <span class="detail-label">完成:</span>
              <span class="detail-value">{{ step.detail.isComplete ? '✅ 是' : '❌ 否' }}</span>
            </div>
            <div v-if="step.detail.remainingSteps?.length" class="detail-row">
              <span class="detail-label">剩余:</span>
              <span class="detail-value">{{ step.detail.remainingSteps.join(' → ') }}</span>
            </div>
          </template>

          <!-- Reflect -->
          <template v-if="step.detail.type === 'reflect'">
            <div class="reflect-box">
              <div class="reflect-score">
                自评:
                <span v-for="i in 5" :key="i" :class="{ filled: i <= step.detail.selfScore }">★</span>
              </div>
              <p class="reflect-reason">{{ step.detail.scoreReason }}</p>
              <div v-if="step.detail.strengths.length" class="reflect-list">
                <span class="reflect-label positive">✅ 优点:</span>
                <ul>
                  <li v-for="s in step.detail.strengths" :key="s">{{ s }}</li>
                </ul>
              </div>
              <div v-if="step.detail.weaknesses.length" class="reflect-list">
                <span class="reflect-label warning">⚠️ 不足:</span>
                <ul>
                  <li v-for="w in step.detail.weaknesses" :key="w">{{ w }}</li>
                </ul>
              </div>
              <div v-if="step.detail.improvements.length" class="reflect-list">
                <span class="reflect-label info">💡 改进:</span>
                <ul>
                  <li v-for="im in step.detail.improvements" :key="im">{{ im }}</li>
                </ul>
              </div>
              <div v-if="step.detail.patternDetected" class="pattern-alert">
                🔔 检测到重复模式，建议创建新技能
              </div>
            </div>
          </template>

          <!-- Store -->
          <template v-if="step.detail.type === 'store'">
            <div class="detail-row">
              <span class="detail-label">情景记忆:</span>
              <span class="detail-value">{{ step.detail.episodicMemoryId }}</span>
            </div>
            <div v-if="step.detail.newSemanticMemories.length" class="detail-row">
              <span class="detail-label">新增语义记忆:</span>
            </div>
            <div v-for="mem in step.detail.newSemanticMemories" :key="mem.content" class="semantic-mem">
              <span class="mem-type tag">{{ mem.memType }}</span>
              <span>{{ mem.content }}</span>
              <span class="mem-conf">({{ (mem.confidence * 100).toFixed(0) }}%)</span>
            </div>
            <div v-if="step.detail.skillProposal" class="skill-proposal">
              <span class="proposal-icon">💡</span>
              技能提议: {{ step.detail.skillProposal.skillName }}
              (置信度: {{ (step.detail.skillProposal.confidence * 100).toFixed(0) }}%)
            </div>
          </template>

          <!-- Stats -->
          <template v-if="step.detail.type === 'stats'">
            <div class="token-breakdown">
              <div
                v-for="(value, key) in (Object.entries(step.detail.contextBreakdown).filter(([k]) => k !== 'budget' && k !== 'total'))"
                :key="key[0]"
                class="token-bar-row"
              >
                <span class="token-label">{{ key[0] }}</span>
                <div class="token-bar-bg">
                  <div class="token-bar-fill" :style="{ width: tokenBarWidth(value[1] as number) }"></div>
                </div>
                <span class="token-value">{{ value[1] as number }}</span>
              </div>
              <div class="token-total">
                已用: {{ step.detail.contextBreakdown.total }} / {{ step.detail.contextBreakdown.budget }} tokens
              </div>
            </div>
          </template>

          <!-- Complete -->
          <template v-if="step.detail.type === 'complete'">
            <div class="complete-box">
              <div class="detail-row">
                <span class="detail-label">总耗时:</span>
                <span class="detail-value">{{ (step.detail.totalDuration / 1000).toFixed(1) }}s</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">工具调用:</span>
                <span class="detail-value">{{ step.detail.toolCalls }} 次</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">LLM 调用:</span>
                <span class="detail-value">{{ step.detail.llmCalls }} 次</span>
              </div>
            </div>
          </template>

          <!-- Plan (T-011 Coordinator) -->
          <template v-if="step.detail.type === 'plan'">
            <div class="plan-box">
              <div class="detail-row">
                <span class="detail-label">用户请求:</span>
                <span class="detail-value">{{ step.detail.userRequest }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">分解方式:</span>
                <span class="detail-value tag">{{ step.detail.decompositionMethod === 'llm' ? 'LLM 驱动' : '规则匹配' }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">子任务数:</span>
                <span class="detail-value">{{ step.detail.taskCount }} (预计 {{ step.detail.totalEstimatedTokens }} tokens)</span>
              </div>
              <div v-for="task in step.detail.tasks" :key="task.id" class="plan-task">
                <span class="plan-task-id">{{ task.id }}</span>
                <span class="plan-task-name">{{ task.name }}</span>
                <span class="plan-task-agent tag">{{ task.agentType }}</span>
                <span v-if="task.dependencies.length" class="plan-task-dep">依赖: {{ task.dependencies.join(', ') }}</span>
                <span class="plan-task-status" :class="`task-status-${task.status}`">{{ task.status }}</span>
              </div>
            </div>
          </template>

          <!-- Delegate (T-011 Coordinator) -->
          <template v-if="step.detail.type === 'delegate'">
            <div class="delegate-box">
              <div class="detail-row">
                <span class="detail-label">任务:</span>
                <span class="detail-value">{{ step.detail.taskName }} ({{ step.detail.taskId }})</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">子 Agent:</span>
                <span class="detail-value tag">{{ step.detail.agentType }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">状态:</span>
                <span class="detail-value" :class="`delegate-status-${step.detail.status}`">{{ step.detail.status }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">耗时:</span>
                <span class="detail-value">{{ (step.detail.duration / 1000).toFixed(2) }}s</span>
              </div>
              <div v-if="step.detail.result" class="detail-row">
                <span class="detail-label">Tokens:</span>
                <span class="detail-value">{{ step.detail.result.tokensUsed }}</span>
              </div>
              <button
                v-if="step.detail.result"
                class="expand-detail-btn"
                @click="toggleDetail(step.id + '-result')"
              >
                {{ expandedDetails.has(step.id + '-result') ? '隐藏' : '查看' }}子 Agent 结果
              </button>
              <pre v-if="expandedDetails.has(step.id + '-result') && step.detail.result" class="raw-data">{{ typeof step.detail.result.data === 'string' ? step.detail.result.data : JSON.stringify(step.detail.result.data, null, 2) }}</pre>
              <div v-if="step.detail.error" class="delegate-error">
                ❌ {{ step.detail.error }}
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 汇总信息 -->
      <div class="trace-summary-stats">
        <div class="summary-item">
          <span class="summary-label">总耗时</span>
          <span class="summary-value">{{ summary.duration }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">总 Token</span>
          <span class="summary-value">{{ summary.tokens }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">成本</span>
          <span class="summary-value">${{ summary.cost }}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">模型</span>
          <span class="summary-value">{{ summary.models }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.execution-trace {
  margin-top: 8px;
  border-radius: var(--radius-input);
  background: var(--surface-tint);
  border: 1px solid var(--surface-border);
  overflow: hidden;
}

.trace-summary {
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.15s;
}

.trace-summary:hover {
  background: var(--surface-tint-hover);
}

.trace-toggle {
  font-size: 10px;
  width: 12px;
  color: var(--text-meta);
}

.trace-label {
  font-weight: 600;
  color: var(--text-primary);
}

.trace-meta {
  color: var(--text-meta);
  font-size: 11px;
}

.trace-steps {
  padding: 4px 8px 8px;
}

.trace-step {
  border-radius: 6px;
  margin-bottom: 2px;
}

.step-expanded {
  background: var(--surface-tint);
}

.step-header {
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  text-align: left;
  color: var(--text-primary);
}

.step-header:hover {
  background: var(--surface-tint-hover);
}

.step-icon {
  font-size: 14px;
}

.step-index {
  color: var(--text-meta);
  font-size: 10px;
  min-width: 16px;
}

.step-name {
  flex: 1;
  color: var(--text-primary);
}

.step-status {
  font-size: 12px;
}

.step-meta {
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: var(--text-meta);
}

.meta-item.model {
  color: var(--color-brand);
}

.step-detail {
  padding: 8px 12px 12px 36px;
  font-size: 12px;
  border-top: 1px solid var(--surface-divider);
}

.detail-row {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
  align-items: baseline;
}

.detail-label {
  color: var(--text-secondary);
  font-size: 11px;
  min-width: 60px;
  flex-shrink: 0;
}

.detail-value {
  color: var(--text-primary);
  word-break: break-word;
}

.tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: 11px;
}

.complexity-low { background: var(--color-brand-soft); color: var(--color-brand); }
.complexity-medium { background: var(--color-amber-soft); color: var(--color-amber); }
.complexity-high { background: var(--color-red-soft); color: var(--color-red); }

/* 记忆条目 */
.memory-item {
  padding: 6px 8px;
  margin: 4px 0;
  border-radius: 6px;
  background: var(--color-violet-soft);
  border-left: 3px solid var(--color-violet);
}

.memory-header {
  display: flex;
  gap: 8px;
  font-size: 10px;
  margin-bottom: 2px;
}

.memory-score {
  font-weight: 600;
  color: var(--color-violet);
}

.memory-source, .memory-age {
  color: var(--text-meta);
}

.memory-confidence {
  color: var(--text-meta);
}

.memory-content {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
}

/* 技能候选 */
.skill-candidate {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 0;
  font-size: 11px;
}

.skill-status-icon { font-size: 12px; }
.skill-name { font-weight: 600; color: var(--text-primary); }
.skill-score { color: var(--text-meta); }
.skill-desc { color: var(--text-secondary); flex: 1; }
.skill-reason { color: var(--text-meta); font-size: 10px; }

/* Think */
.think-box {
  padding: 8px;
  border-radius: 6px;
  background: var(--color-blue-soft);
  border-left: 3px solid var(--color-blue);
}

.think-reasoning {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  margin: 0 0 6px 0;
}

.think-decision {
  display: flex;
  gap: 6px;
  font-size: 11px;
}

/* Act */
.act-box {
  padding: 8px;
  border-radius: 6px;
  background: var(--color-brand-softer);
  border-left: 3px solid var(--color-brand);
}

.approval-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--color-amber-soft);
  color: var(--color-amber);
  font-size: 10px;
  margin-top: 4px;
}

/* Observe */
.observe-text {
  font-size: 12px;
  color: var(--text-primary);
  line-height: 1.4;
  margin: 0 0 6px 0;
}

/* Reflect */
.reflect-box {
  padding: 8px;
  border-radius: 6px;
  background: var(--color-amber-soft);
  border-left: 3px solid var(--color-amber);
}

.reflect-score {
  margin-bottom: 4px;
}

.reflect-score span {
  color: var(--surface-border);
  font-size: 14px;
}

.reflect-score .filled {
  color: var(--color-amber);
}

.reflect-reason {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 0 0 6px 0;
}

.reflect-list {
  margin-bottom: 4px;
}

.reflect-label {
  font-size: 11px;
  font-weight: 600;
}

.reflect-label.positive { color: var(--color-brand); }
.reflect-label.warning { color: var(--color-amber); }
.reflect-label.info { color: var(--color-blue); }

.reflect-list ul {
  margin: 2px 0 4px 16px;
  padding: 0;
}

.reflect-list li {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.pattern-alert {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--color-amber-soft);
  color: var(--color-amber);
  font-size: 11px;
}

/* Store */
.semantic-mem {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
}

.mem-type {
  background: var(--color-brand-soft);
  color: var(--color-brand);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
}

.mem-conf {
  color: var(--text-meta);
  font-size: 10px;
}

.skill-proposal {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--color-amber-soft);
  border: 1px solid var(--color-amber);
  font-size: 11px;
  color: var(--color-amber);
}

/* Stats */
.token-breakdown {
  padding: 4px 0;
}

.token-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 10px;
}

.token-label {
  width: 80px;
  color: var(--text-secondary);
  text-align: right;
}

.token-bar-bg {
  flex: 1;
  height: 12px;
  background: var(--surface-tint);
  border-radius: 3px;
  overflow: hidden;
}

.token-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-brand), var(--color-blue));
  border-radius: 3px;
  transition: width 0.3s ease;
}

.token-value {
  width: 50px;
  color: var(--text-secondary);
  font-size: 10px;
}

.token-total {
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-meta);
  text-align: right;
}

/* Complete */
.complete-box {
  padding: 4px 0;
}

/* 原始数据展示 */
.raw-data {
  margin-top: 6px;
  padding: 8px;
  background: var(--surface-tint);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-primary);
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.expand-detail-btn {
  margin-top: 4px;
  padding: 3px 10px;
  border: 1px solid var(--surface-border);
  border-radius: 4px;
  background: transparent;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.expand-detail-btn:hover {
  background: var(--surface-tint-hover);
  color: var(--text-primary);
  border-color: var(--color-brand);
}

/* 汇总 */
.trace-summary-stats {
  display: flex;
  gap: 16px;
  padding: 10px 12px;
  margin-top: 4px;
  border-top: 1px solid var(--surface-divider);
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.summary-label {
  font-size: 10px;
  color: var(--text-meta);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.summary-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

/* ── T-011: Plan / Delegate 步骤样式 ── */

.plan-box {
  padding: 8px;
  border-radius: 6px;
  background: var(--color-blue-soft);
  border-left: 3px solid var(--color-blue);
}

.plan-task {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 0;
  font-size: 11px;
  border-bottom: 1px dashed var(--surface-divider);
}

.plan-task:last-child {
  border-bottom: none;
}

.plan-task-id {
  color: var(--text-meta);
  font-size: 10px;
  min-width: 40px;
}

.plan-task-name {
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
}

.plan-task-agent {
  font-size: 10px;
}

.plan-task-dep {
  color: var(--text-meta);
  font-size: 10px;
}

.plan-task-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
}

.task-status-pending { background: var(--surface-tint); color: var(--text-meta); }
.task-status-running { background: var(--color-blue-soft); color: var(--color-blue); }
.task-status-completed { background: var(--color-brand-soft); color: var(--color-brand); }
.task-status-failed { background: var(--color-red-soft); color: var(--color-red); }
.task-status-skipped { background: var(--surface-tint); color: var(--text-meta); }

.delegate-box {
  padding: 8px;
  border-radius: 6px;
  background: var(--color-violet-soft);
  border-left: 3px solid var(--color-violet);
}

.delegate-status-completed { color: var(--color-brand); font-weight: 600; }
.delegate-status-failed { color: var(--color-red); font-weight: 600; }
.delegate-status-running { color: var(--color-blue); }
.delegate-status-skipped { color: var(--text-meta); }

.delegate-error {
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--color-red-soft);
  color: var(--color-red);
  font-size: 11px;
}

/* ── 复制按钮 ── */

.copy-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  flex-shrink: 0;
  color: var(--text-meta);
}

.step-header:hover .copy-btn {
  opacity: 0.6;
}

.copy-btn:hover {
  opacity: 1 !important;
  background: var(--surface-tint-hover);
  color: var(--text-primary);
}

/* ── 步骤展开动画 ── */

.step-detail {
  animation: slideDown 0.2s ease;
}

@keyframes slideDown {
  from {
    opacity: 0;
    max-height: 0;
  }
  to {
    opacity: 1;
    max-height: 500px;
  }
}

.trace-steps {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
