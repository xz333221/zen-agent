<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { MemoryItem } from '@shared/types'

// ── 状态 ──
const loading = ref(true)
const memories = ref<MemoryItem[]>([])
const errorMsg = ref('')
const successMsg = ref('')

// ── 搜索 ──
const searchQuery = ref('')
const isSearching = ref(false)
const filterType = ref<'all' | 'episodic' | 'semantic'>('all')

// ── 统计 ──
const stats = ref({ totalMemories: 0, episodicCount: 0, semanticCount: 0 })

// ── 详情查看 ──
const selectedMemory = ref<MemoryItem | null>(null)
const showDetailModal = ref(false)

// ── 创建记忆 ──
const showCreateModal = ref(false)
const newMemory = ref({
  content: '',
  type: 'semantic' as 'episodic' | 'semantic',
  importance: 0.5,
  tags: ''
})

// ── 筛选后的记忆 ──
const filteredMemories = computed(() => {
  if (filterType.value === 'all') return memories.value
  return memories.value.filter(m => m.type === filterType.value)
})

// ── 加载记忆列表 ──
async function loadMemories() {
  loading.value = true
  errorMsg.value = ''
  try {
    const [list, s] = await Promise.all([
      window.memoryAPI.list({ limit: 200 }),
      window.memoryAPI.stats()
    ])
    memories.value = list
    stats.value = s
  } catch (err) {
    errorMsg.value = '加载记忆失败'
    console.error(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadMemories()
})

// ── 搜索记忆 ──
async function handleSearch() {
  if (!searchQuery.value.trim()) {
    await loadMemories()
    return
  }

  isSearching.value = true
  errorMsg.value = ''
  try {
    const results = await window.memoryAPI.search(searchQuery.value, 50)
    memories.value = results
  } catch (err) {
    errorMsg.value = '搜索失败'
    console.error(err)
  } finally {
    isSearching.value = false
  }
}

// ── 查看详情 ──
function handleViewDetail(memory: MemoryItem) {
  selectedMemory.value = memory
  showDetailModal.value = true
}

// ── 删除记忆 ──
async function handleDelete(memory: MemoryItem) {
  if (!confirm('确定删除这条记忆？')) return
  try {
    await window.memoryAPI.remove(memory.id)
    successMsg.value = '记忆已删除'
    setTimeout(() => { successMsg.value = '' }, 2000)
    await loadMemories()
  } catch (err) {
    errorMsg.value = '删除失败'
    console.error(err)
  }
}

// ── 创建记忆 ──
async function handleCreate() {
  if (!newMemory.value.content.trim()) {
    errorMsg.value = '请输入记忆内容'
    return
  }

  errorMsg.value = ''
  try {
    await window.memoryAPI.create({
      content: newMemory.value.content,
      type: newMemory.value.type,
      importance: newMemory.value.importance,
      tags: newMemory.value.tags
        ? newMemory.value.tags.split(',').map(s => s.trim()).filter(Boolean)
        : []
    })
    showCreateModal.value = false
    newMemory.value = { content: '', type: 'semantic', importance: 0.5, tags: '' }
    successMsg.value = '记忆已添加'
    setTimeout(() => { successMsg.value = '' }, 2000)
    await loadMemories()
  } catch (err) {
    errorMsg.value = '创建失败'
    console.error(err)
  }
}

// ── 关闭窗口 ──
function handleClose() {
  window.memoryAPI.close()
}

// ── 格式化时间 ──
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ── 类型标签 ──
const typeLabels: Record<string, string> = {
  episodic: '情景',
  semantic: '语义'
}
</script>

<template>
  <div class="memory-root" data-testid="memory-root">
    <!-- ═══ 标题栏 ═══ -->
    <div class="title-bar" data-testid="title-bar">
      <div class="title-left">
        <svg class="title-owl" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="8.5" cy="10" r="1.5" fill="currentColor"/><circle cx="15.5" cy="10" r="1.5" fill="currentColor"/><path d="M12 14a3 3 0 0 0-3 3h6a3 3 0 0 0-3-3z"/></svg>
        <span class="title-text">记忆浏览</span>
      </div>
      <div class="title-right">
        <button class="title-btn" data-testid="btn-close-memory" title="关闭" @click="handleClose">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ═══ 内容区 ═══ -->
    <div class="memory-content" v-if="!loading">
      <!-- 统计栏 -->
      <div class="stats-bar" data-testid="stats-bar">
        <div class="stat-item">
          <span class="stat-value">{{ stats.totalMemories }}</span>
          <span class="stat-label">总计</span>
        </div>
        <div class="stat-item">
          <span class="stat-value episodic">{{ stats.episodicCount }}</span>
          <span class="stat-label">情景</span>
        </div>
        <div class="stat-item">
          <span class="stat-value semantic">{{ stats.semanticCount }}</span>
          <span class="stat-label">语义</span>
        </div>
      </div>

      <!-- 搜索 + 筛选 + 创建 -->
      <div class="toolbar">
        <input
          type="text"
          class="search-input"
          data-testid="search-input"
          v-model="searchQuery"
          placeholder="语义搜索记忆..."
          @keyup.enter="handleSearch"
        />
        <button class="btn-search" data-testid="btn-search" @click="handleSearch" :disabled="isSearching">
          {{ isSearching ? '搜索中...' : '搜索' }}
        </button>
        <select class="filter-select" data-testid="filter-type" v-model="filterType">
          <option value="all">全部类型</option>
          <option value="episodic">情景</option>
          <option value="semantic">语义</option>
        </select>
        <button class="btn-add" data-testid="btn-add-memory" @click="showCreateModal = true">
          + 添加记忆
        </button>
      </div>

      <!-- 提示消息 -->
      <div v-if="errorMsg" class="error-msg" data-testid="error-msg">{{ errorMsg }}</div>
      <div v-if="successMsg" class="success-msg" data-testid="success-msg">{{ successMsg }}</div>

      <!-- 空状态 -->
      <div v-if="filteredMemories.length === 0" class="empty-state" data-testid="empty-memories">
        <p>暂无记忆</p>
        <p class="hint">Agent 会在对话中自动积累记忆，也可以手动添加</p>
      </div>

      <!-- 记忆时间线 -->
      <div v-else class="memory-timeline" data-testid="memory-list">
        <div
          v-for="memory in filteredMemories"
          :key="memory.id"
          class="memory-card"
          :data-testid="`memory-card-${memory.id}`"
          @click="handleViewDetail(memory)"
        >
          <div class="memory-header">
            <span class="memory-type-badge" :class="memory.type">{{ typeLabels[memory.type] || memory.type }}</span>
            <span v-if="memory.memType" class="memory-mem-type">{{ memory.memType }}</span>
            <span class="memory-time">{{ formatTime(memory.createdAt) }}</span>
            <div class="memory-actions">
              <button class="btn-icon" @click.stop="handleDelete(memory)" title="删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            </div>
          </div>
          <div class="memory-content-text">
            {{ memory.userIntent || memory.content }}
          </div>
          <div class="memory-meta">
            <span v-if="memory.importance" class="meta-item">
              重要性 {{ (memory.importance * 100).toFixed(0) }}%
            </span>
            <span v-if="memory.confidence" class="meta-item">
              置信度 {{ (memory.confidence * 100).toFixed(0) }}%
            </span>
            <span class="meta-item">访问 {{ memory.accessCount }} 次</span>
            <span v-if="memory.source" class="meta-item">{{ memory.source }}</span>
          </div>
          <div v-if="memory.tags && memory.tags.length > 0" class="memory-tags">
            <span v-for="tag in memory.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- ═══ 记忆详情弹窗 ═══ -->
    <div v-if="showDetailModal && selectedMemory" class="modal-overlay" data-testid="memory-detail-modal" @click.self="showDetailModal = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>记忆详情</h3>
          <button class="btn-icon" @click="showDetailModal = false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal-body">
          <div class="detail-row">
            <span class="detail-label">ID</span>
            <span class="detail-value">{{ selectedMemory.id }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">类型</span>
            <span class="detail-value">{{ typeLabels[selectedMemory.type] || selectedMemory.type }}</span>
          </div>
          <div v-if="selectedMemory.memType" class="detail-row">
            <span class="detail-label">子类型</span>
            <span class="detail-value">{{ selectedMemory.memType }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">创建时间</span>
            <span class="detail-value">{{ formatTime(selectedMemory.createdAt) }}</span>
          </div>
          <div v-if="selectedMemory.lastAccessedAt" class="detail-row">
            <span class="detail-label">最后访问</span>
            <span class="detail-value">{{ formatTime(selectedMemory.lastAccessedAt) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">访问次数</span>
            <span class="detail-value">{{ selectedMemory.accessCount }}</span>
          </div>
          <div v-if="selectedMemory.importance" class="detail-row">
            <span class="detail-label">重要性</span>
            <span class="detail-value">{{ (selectedMemory.importance * 100).toFixed(0) }}%</span>
          </div>
          <div v-if="selectedMemory.confidence" class="detail-row">
            <span class="detail-label">置信度</span>
            <span class="detail-value">{{ (selectedMemory.confidence * 100).toFixed(0) }}%</span>
          </div>
          <div v-if="selectedMemory.source" class="detail-row">
            <span class="detail-label">来源</span>
            <span class="detail-value">{{ selectedMemory.source }}</span>
          </div>
          <div v-if="selectedMemory.userIntent" class="detail-section">
            <div class="detail-label">用户意图</div>
            <div class="detail-text">{{ selectedMemory.userIntent }}</div>
          </div>
          <div v-if="selectedMemory.outcome" class="detail-section">
            <div class="detail-label">结果</div>
            <div class="detail-text">{{ selectedMemory.outcome }}</div>
          </div>
          <div class="detail-section">
            <div class="detail-label">内容</div>
            <div class="detail-text">{{ selectedMemory.content }}</div>
          </div>
          <div v-if="selectedMemory.actions && selectedMemory.actions.length > 0" class="detail-section">
            <div class="detail-label">执行动作</div>
            <div class="detail-text">{{ selectedMemory.actions.join(' → ') }}</div>
          </div>
          <div v-if="selectedMemory.tags && selectedMemory.tags.length > 0" class="detail-section">
            <div class="detail-label">标签</div>
            <div class="memory-tags">
              <span v-for="tag in selectedMemory.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showDetailModal = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- ═══ 创建记忆弹窗 ═══ -->
    <div v-if="showCreateModal" class="modal-overlay" data-testid="memory-create-modal" @click.self="showCreateModal = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>添加记忆</h3>
          <button class="btn-icon" @click="showCreateModal = false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label">记忆内容</label>
            <textarea
              class="form-textarea"
              data-testid="input-memory-content"
              v-model="newMemory.content"
              rows="5"
              placeholder="输入要记住的内容..."
            ></textarea>
          </div>
          <div class="form-row">
            <label class="form-label">类型</label>
            <select class="form-select" data-testid="input-memory-type" v-model="newMemory.type">
              <option value="semantic">语义（事实/偏好/知识）</option>
              <option value="episodic">情景（交互记录）</option>
            </select>
          </div>
          <div class="form-row">
            <label class="form-label">
              重要性
              <span class="value-display">{{ (newMemory.importance * 100).toFixed(0) }}%</span>
            </label>
            <input
              type="range"
              class="form-slider"
              data-testid="input-memory-importance"
              min="0" max="1" step="0.1"
              v-model.number="newMemory.importance"
            />
          </div>
          <div class="form-row">
            <label class="form-label">标签（逗号分隔）</label>
            <input
              type="text"
              class="form-input"
              data-testid="input-memory-tags"
              v-model="newMemory.tags"
              placeholder="如: 编程, 学习, 偏好"
            />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showCreateModal = false">取消</button>
          <button class="btn-save" data-testid="btn-save-memory" @click="handleCreate">添加</button>
        </div>
      </div>
    </div>
  </div>
</template>
