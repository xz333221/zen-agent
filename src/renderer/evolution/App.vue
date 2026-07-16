<template>
  <div class="evo-root" :class="{ dark: isDark }">
    <!-- 标题栏 -->
    <div class="title-bar">
      <div class="title-left">
        <span class="title-owl">🦉</span>
        <span class="title-text">自进化面板</span>
      </div>
      <div class="title-right">
        <button class="btn-icon" @click="handleClose" title="关闭">✕</button>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="evo-content">
      <!-- 状态卡片 -->
      <div class="card status-card">
        <div class="card-header">
          <span class="card-icon">📊</span>
          <span class="card-title">当前状态</span>
          <button v-if="!status.running" class="btn-primary btn-sm" @click="toggleEvolution">
            {{ status.enabled ? '已启用 (点击关闭)' : '启用自进化' }}
          </button>
          <span v-else class="badge badge-running">{{ status.phase || '运行中' }}</span>
        </div>
        <div class="status-grid">
          <div class="status-item">
            <span class="status-label">运行状态</span>
            <span class="status-value">{{ status.running ? '进化中...' : (status.enabled ? '等待触发' : '已关闭') }}</span>
          </div>
          <div class="status-item">
            <span class="status-label">空闲时间</span>
            <span class="status-value">{{ formatDuration(status.idleSince) }}</span>
          </div>
          <div class="status-item">
            <span class="status-label">上次进化</span>
            <span class="status-value">{{ formatTimeAgo(status.lastEvolutionTime) }}</span>
          </div>
          <div class="status-item">
            <span class="status-label">进化阶段</span>
            <span class="status-value phase-badge" :class="'phase-' + (status.phase || 'idle')">{{ phaseLabel(status.phase) }}</span>
          </div>
        </div>
      </div>

      <!-- Token 预算卡片 -->
      <div class="card budget-card">
        <div class="card-header">
          <span class="card-icon">💰</span>
          <span class="card-title">Token 预算</span>
        </div>
        <div class="budget-info" v-if="status.tokenBudget">
          <div class="budget-row">
            <span class="budget-label">周期总额</span>
            <span class="budget-value">{{ status.tokenBudget.totalBudget.toLocaleString() }}</span>
          </div>
          <div class="budget-row">
            <span class="budget-label">已用</span>
            <span class="budget-value">{{ status.tokenBudget.totalUsed.toLocaleString() }} ({{ status.tokenBudget.utilizationPercent }}%)</span>
          </div>
          <div class="budget-bar">
            <div class="budget-bar-used" :style="{ width: status.tokenBudget.utilizationPercent + '%' }"></div>
          </div>
          <div class="budget-row">
            <span class="budget-label">自进化预算</span>
            <span class="budget-value">{{ status.tokenBudget.evolutionUsed.toLocaleString() }} / {{ status.tokenBudget.evolutionBudget.toLocaleString() }}</span>
          </div>
          <div class="budget-row">
            <span class="budget-label">剩余可用</span>
            <span class="budget-value highlight">{{ status.tokenBudget.remainingForEvolution.toLocaleString() }}</span>
          </div>
        </div>
      </div>

      <!-- 统计卡片 -->
      <div class="card stats-card" v-if="status.stats">
        <div class="card-header">
          <span class="card-icon">📈</span>
          <span class="card-title">进化统计</span>
        </div>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-num">{{ status.stats.total }}</div>
            <div class="stat-label">总计</div>
          </div>
          <div class="stat-box stat-success">
            <div class="stat-num">{{ status.stats.success }}</div>
            <div class="stat-label">成功</div>
          </div>
          <div class="stat-box stat-fail">
            <div class="stat-num">{{ status.stats.failure }}</div>
            <div class="stat-label">失败</div>
          </div>
          <div class="stat-box stat-rollback">
            <div class="stat-num">{{ status.stats.rolledBack }}</div>
            <div class="stat-label">回滚</div>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="card action-card">
        <div class="card-header">
          <span class="card-icon">⚡</span>
          <span class="card-title">操作</span>
        </div>
        <div class="action-buttons">
          <button class="btn-primary" @click="runOnce" :disabled="runningOnce">
            {{ runningOnce ? '进化中...' : '立即进化一次' }}
          </button>
          <button class="btn-secondary" @click="refreshStatus">刷新状态</button>
        </div>
      </div>

      <!-- 进化历史 -->
      <div class="card history-card">
        <div class="card-header">
          <span class="card-icon">📜</span>
          <span class="card-title">进化历史</span>
        </div>
        <div class="history-list" v-if="records.length > 0">
          <div v-for="r in records" :key="r.id" class="history-item" :class="'outcome-' + r.outcome" @click="selectRecord(r.id)">
            <div class="history-header">
              <span class="history-outcome" :class="'badge-' + r.outcome">{{ outcomeLabel(r.outcome) }}</span>
              <span class="history-time">{{ formatTime(r.startedAt) }}</span>
            </div>
            <div class="history-goal">{{ r.goal || r.trigger }}</div>
            <div class="history-meta" v-if="r.tokensUsed">
              Tokens: {{ (r.tokensUsed.input + r.tokensUsed.output).toLocaleString() }}
              <span v-if="r.commitHash"> · Commit: {{ r.commitHash.slice(0, 8) }}</span>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">暂无进化记录</div>
      </div>

      <!-- 进化详情 -->
      <div class="card detail-card" v-if="selectedRecord">
        <div class="card-header">
          <span class="card-icon">🔍</span>
          <span class="card-title">进化详情</span>
          <button class="btn-icon" @click="selectedRecord = null">✕</button>
        </div>
        <div class="detail-body">
          <div class="detail-row"><span class="detail-label">目标</span><span class="detail-value">{{ selectedRecord.goal || selectedRecord.trigger }}</span></div>
          <div class="detail-row"><span class="detail-label">结果</span><span class="detail-value">{{ outcomeLabel(selectedRecord.outcome) }}</span></div>
          <div class="detail-row" v-if="selectedRecord.failureReason"><span class="detail-label">失败原因</span><span class="detail-value">{{ selectedRecord.failureReason }}</span></div>
          <div class="detail-row" v-if="selectedRecord.filesChanged?.length"><span class="detail-label">修改文件</span><span class="detail-value">{{ selectedRecord.filesChanged.join(', ') }}</span></div>
          <div class="detail-row" v-if="selectedRecord.commitHash"><span class="detail-label">Commit</span><span class="detail-value">{{ selectedRecord.commitHash }}</span></div>
          <div class="detail-logs" v-if="selectedRecord.logs?.length">
            <div class="detail-label">过程日志</div>
            <div class="log-entries">
              <div v-for="(log, i) in selectedRecord.logs" :key="i" class="log-entry">
                <span class="log-time">{{ formatLogTime(log.timestamp) }}</span>
                <span class="log-phase">[{{ log.phase }}]</span>
                <span class="log-msg">{{ log.message }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface EvolutionStatus {
  running: boolean
  phase: string
  enabled: boolean
  lastEvolutionTime: number
  idleSince: number
  tokenBudget: {
    cycleStart: string
    totalUsed: number
    totalBudget: number
    evolutionUsed: number
    evolutionBudget: number
    remainingForEvolution: number
    utilizationPercent: number
  } | null
  stats: {
    total: number
    success: number
    failure: number
    rolledBack: number
    totalTokensInput: number
    totalTokensOutput: number
    lastEvolutionAt: number | null
  } | null
}

interface EvolutionRecord {
  id: string
  phase: string
  trigger: string
  goal: string
  filesChanged: string[]
  plan: unknown
  testResult: unknown
  evaluation: unknown
  outcome: string
  commitHash: string | null
  failureReason: string | null
  tokensUsed: { input: number; output: number }
  startedAt: number
  finishedAt: number | null
  logs: Array<{ timestamp: number; phase: string; message: string }>
}

const isDark = ref(false)
const status = ref<EvolutionStatus>({
  running: false, phase: 'idle', enabled: false, lastEvolutionTime: 0, idleSince: 0, tokenBudget: null, stats: null
})
const records = ref<EvolutionRecord[]>([])
const selectedRecord = ref<EvolutionRecord | null>(null)
const runningOnce = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function refreshStatus() {
  try {
    const s = await window.evolutionAPI.getStatus()
    status.value = s as EvolutionStatus
  } catch (e) {
    console.error('Failed to get evolution status:', e)
  }
}

async function refreshRecords() {
  try {
    const r = await window.evolutionAPI.getRecords(30)
    records.value = (r || []) as EvolutionRecord[]
  } catch (e) {
    console.error('Failed to get records:', e)
  }
}

async function toggleEvolution() {
  try {
    const newEnabled = !status.value.enabled
    await window.evolutionAPI.setEnabled(newEnabled)
    status.value.enabled = newEnabled
    refreshStatus()
  } catch (e) {
    console.error('Failed to toggle evolution:', e)
  }
}

async function runOnce() {
  runningOnce.value = true
  try {
    await window.evolutionAPI.runOnce()
    await refreshStatus()
    await refreshRecords()
  } catch (e) {
    console.error('Failed to run evolution:', e)
  } finally {
    runningOnce.value = false
  }
}

async function selectRecord(id: string) {
  try {
    const r = await window.evolutionAPI.getRecord(id)
    selectedRecord.value = r as EvolutionRecord
  } catch (e) {
    console.error('Failed to get record:', e)
  }
}

function handleClose() {
  window.evolutionAPI.close()
}

function formatDuration(ms: number): string {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min`
  return `${Math.floor(m / 60)}h ${m % 60}min`
}

function formatTimeAgo(ts: number): string {
  if (!ts) return '从未'
  return formatDuration(Date.now() - ts) + '前'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN')
}

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN')
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    idle: '空闲', analyzing: '分析中', planning: '规划中', modifying: '修改代码中',
    building: '编译中', testing: '测试中', evaluating: '评估中', committing: '提交中', done: '完成'
  }
  return labels[phase] || phase
}

function outcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    success: '✓ 成功', partial: '◐ 部分', failure: '✗ 失败', rolled_back: '↺ 已回滚'
  }
  return labels[outcome] || outcome
}

onMounted(() => {
  refreshStatus()
  refreshRecords()
  pollTimer = setInterval(() => {
    refreshStatus()
    if (status.value.running) {
      refreshRecords()
    }
  }, 3000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
