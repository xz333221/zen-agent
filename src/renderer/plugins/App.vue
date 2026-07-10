<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { PluginInfo, PluginManifest, PluginPermission } from '@shared/types'

// ── 状态 ──
const loading = ref(true)
const plugins = ref<PluginInfo[]>([])
const errorMsg = ref('')
const showInstallModal = ref(false)

// ── 安装表单 ──
const installForm = ref({
  id: '',
  name: '',
  version: '1.0.0',
  description: '',
  author: '',
  entry: 'index.js',
  permissions: [] as PluginPermission[]
})

// ── 所有可用权限 ──
const ALL_PERMISSIONS: { value: PluginPermission; label: string }[] = [
  { value: 'tool:register', label: '注册工具' },
  { value: 'memory:read', label: '读取记忆' },
  { value: 'memory:write', label: '写入记忆' },
  { value: 'llm:call', label: '调用 LLM' },
  { value: 'ui:render', label: '渲染 UI' },
  { value: 'storage:read', label: '读取存储' },
  { value: 'storage:write', label: '写入存储' }
]

// ── 搜索 ──
const searchTerm = ref('')

const filteredPlugins = computed(() => {
  if (!searchTerm.value) return plugins.value
  const term = searchTerm.value.toLowerCase()
  return plugins.value.filter(p =>
    p.manifest.name.toLowerCase().includes(term) ||
    p.manifest.description.toLowerCase().includes(term) ||
    p.manifest.author.toLowerCase().includes(term)
  )
})

// ── 统计 ──
const activeCount = computed(() => plugins.value.filter(p => p.status === 'active').length)
const inactiveCount = computed(() => plugins.value.filter(p => p.status === 'inactive').length)

// ── 加载插件列表 ──
async function loadPlugins() {
  loading.value = true
  try {
    plugins.value = await window.pluginsAPI.list()
  } catch (err) {
    errorMsg.value = '加载插件列表失败'
    console.error(err)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadPlugins()
})

// ── 安装插件 ──
async function handleInstall() {
  if (!installForm.value.id.trim() || !installForm.value.name.trim()) {
    errorMsg.value = '请填写插件 ID 和名称'
    return
  }

  const manifest: PluginManifest = {
    id: installForm.value.id,
    name: installForm.value.name,
    version: installForm.value.version,
    description: installForm.value.description || '无描述',
    author: installForm.value.author || '未知',
    entry: installForm.value.entry,
    permissions: installForm.value.permissions,
    enabled: true,
    installedAt: Date.now()
  }

  try {
    const result = await window.pluginsAPI.install(manifest)
    if (result.success) {
      showInstallModal.value = false
      // 重置表单
      installForm.value = {
        id: '',
        name: '',
        version: '1.0.0',
        description: '',
        author: '',
        entry: 'index.js',
        permissions: []
      }
      errorMsg.value = ''
      await loadPlugins()
    } else {
      errorMsg.value = result.error || '安装失败'
    }
  } catch (err) {
    errorMsg.value = '安装插件失败'
    console.error(err)
  }
}

// ── 卸载插件 ──
async function handleUninstall(id: string) {
  if (!confirm('确定要卸载此插件吗？')) return
  try {
    await window.pluginsAPI.uninstall(id)
    await loadPlugins()
  } catch (err) {
    errorMsg.value = '卸载插件失败'
    console.error(err)
  }
}

// ── 切换启用/禁用 ──
async function handleToggle(id: string, enabled: boolean) {
  try {
    await window.pluginsAPI.toggle(id, !enabled)
    await loadPlugins()
  } catch (err) {
    errorMsg.value = '切换插件状态失败'
    console.error(err)
  }
}

// ── 关闭窗口 ──
function handleClose() {
  window.pluginsAPI.close()
}

// ── 拖拽窗口 ──
let isDragging = false
function onTitleMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.title-btn')) return
  isDragging = true
}
function onTitleMouseMove(_e: MouseEvent) {
  if (!isDragging) return
}
function onTitleMouseUp() {
  isDragging = false
}
</script>

<template>
  <div class="plugins-root" data-testid="plugins-root">
    <!-- ═══ 标题栏 ═══ -->
    <div class="title-bar" data-testid="title-bar"
         @mousedown="onTitleMouseDown" @mousemove="onTitleMouseMove" @mouseup="onTitleMouseUp">
      <div class="title-left">
        <span class="title-owl">🦉</span>
        <span class="title-text">插件管理</span>
      </div>
      <div class="title-right">
        <button class="title-btn" data-testid="btn-install-plugin" title="安装插件" @click="showInstallModal = true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <button class="title-btn" data-testid="btn-close-plugins" title="关闭" @click="handleClose">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ═══ 内容区 ═══ -->
    <div class="plugins-content" v-if="!loading">
      <!-- 统计栏 -->
      <div class="stats-bar" data-testid="stats-bar">
        <div class="stat-item">
          <span class="stat-label">总计</span>
          <span class="stat-value">{{ plugins.length }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">活跃</span>
          <span class="stat-value active">{{ activeCount }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">停用</span>
          <span class="stat-value inactive">{{ inactiveCount }}</span>
        </div>
        <div class="search-box">
          <input
            type="text"
            class="search-input"
            data-testid="plugin-search"
            v-model="searchTerm"
            placeholder="搜索插件..."
          />
        </div>
      </div>

      <!-- 错误提示 -->
      <div v-if="errorMsg" class="error-msg" data-testid="error-msg">{{ errorMsg }}</div>

      <!-- 空状态 -->
      <div v-if="filteredPlugins.length === 0" class="empty-state" data-testid="empty-plugins">
        <div class="empty-icon">🔌</div>
        <p class="empty-title">暂无插件</p>
        <p class="empty-desc">点击 + 按钮安装插件</p>
      </div>

      <!-- 插件列表 -->
      <div v-else class="plugin-list" data-testid="plugin-list">
        <div
          v-for="plugin in filteredPlugins"
          :key="plugin.manifest.id"
          class="plugin-card"
          :class="{ inactive: !plugin.manifest.enabled }"
          data-testid="plugin-card"
        >
          <div class="plugin-header">
            <div class="plugin-name">
              <span class="plugin-status" :class="plugin.manifest.enabled ? 'enabled' : 'disabled'"></span>
              {{ plugin.manifest.name }}
              <span class="plugin-version">v{{ plugin.manifest.version }}</span>
            </div>
            <div class="plugin-actions">
              <button
                class="btn-icon"
                data-testid="btn-toggle-plugin"
                @click="handleToggle(plugin.manifest.id, plugin.manifest.enabled)"
                :title="plugin.manifest.enabled ? '禁用' : '启用'"
              >
                {{ plugin.manifest.enabled ? '👁' : '🚫' }}
              </button>
              <button
                class="btn-icon"
                data-testid="btn-uninstall-plugin"
                @click="handleUninstall(plugin.manifest.id)"
                title="卸载"
              >
                🗑
              </button>
            </div>
          </div>
          <div class="plugin-description">{{ plugin.manifest.description }}</div>
          <div class="plugin-meta">
            <span class="meta-item">作者: {{ plugin.manifest.author }}</span>
            <span class="meta-item">入口: {{ plugin.manifest.entry }}</span>
            <span class="meta-item status" :class="plugin.status">
              {{ plugin.status === 'active' ? '✅ 活跃' : plugin.status === 'inactive' ? '⏸ 停用' : '❌ 错误' }}
            </span>
          </div>
          <div v-if="plugin.error" class="plugin-error">{{ plugin.error }}</div>
          <div v-if="plugin.manifest.permissions.length > 0" class="plugin-permissions">
            <span
              v-for="perm in plugin.manifest.permissions"
              :key="perm"
              class="permission-tag"
            >{{ perm }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <!-- ═══ 安装插件弹窗 ═══ -->
    <div v-if="showInstallModal" class="modal-overlay" data-testid="install-modal" @click.self="showInstallModal = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>安装插件</h3>
          <button class="btn-icon" @click="showInstallModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label">插件 ID</label>
            <input type="text" class="form-input" data-testid="input-plugin-id"
                   v-model="installForm.id" placeholder="如: my-plugin" />
          </div>
          <div class="form-row">
            <label class="form-label">名称</label>
            <input type="text" class="form-input" data-testid="input-plugin-name"
                   v-model="installForm.name" placeholder="插件名称" />
          </div>
          <div class="form-row">
            <label class="form-label">版本</label>
            <input type="text" class="form-input" data-testid="input-plugin-version"
                   v-model="installForm.version" placeholder="1.0.0" />
          </div>
          <div class="form-row">
            <label class="form-label">描述</label>
            <input type="text" class="form-input" data-testid="input-plugin-desc"
                   v-model="installForm.description" placeholder="插件描述" />
          </div>
          <div class="form-row">
            <label class="form-label">作者</label>
            <input type="text" class="form-input" data-testid="input-plugin-author"
                   v-model="installForm.author" placeholder="作者名称" />
          </div>
          <div class="form-row">
            <label class="form-label">权限</label>
            <div class="permission-list">
              <label
                v-for="perm in ALL_PERMISSIONS"
                :key="perm.value"
                class="permission-checkbox"
              >
                <input
                  type="checkbox"
                  :value="perm.value"
                  v-model="installForm.permissions"
                />
                {{ perm.label }}
              </label>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showInstallModal = false">取消</button>
          <button class="btn-save" data-testid="btn-confirm-install" @click="handleInstall">安装</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugins-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: linear-gradient(180deg, #f8f9fa 0%, #ffffff 100%);
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
}

.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  -webkit-app-region: drag;
  user-select: none;
}

.title-left { display: flex; align-items: center; gap: 6px; }
.title-owl { font-size: 16px; }
.title-text { font-size: 13px; font-weight: 600; color: #555; }
.title-right { display: flex; gap: 4px; -webkit-app-region: no-drag; }

.title-btn {
  width: 24px; height: 24px; border: none; border-radius: 6px;
  background: transparent; color: #888; cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.title-btn:hover { background: rgba(0, 0, 0, 0.06); color: #555; }

.plugins-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.stats-bar {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  align-items: center;
}

.stat-item { display: flex; flex-direction: column; align-items: center; }
.stat-label { font-size: 11px; color: #999; }
.stat-value { font-size: 20px; font-weight: 700; color: #333; }
.stat-value.active { color: #5BAA8A; }
.stat-value.inactive { color: #ccc; }

.search-box { flex: 1; }
.search-input {
  width: 100%; padding: 6px 12px; border: 1px solid rgba(0,0,0,0.1);
  border-radius: 8px; font-size: 13px; outline: none;
  background: rgba(255,255,255,0.8); transition: border-color 0.2s;
}
.search-input:focus { border-color: rgba(91,170,138,0.5); }

.empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 60px 20px; text-align: center;
}
.empty-icon { font-size: 48px; margin-bottom: 12px; }
.empty-title { font-size: 16px; font-weight: 700; color: #333; margin: 0 0 4px 0; }
.empty-desc { font-size: 13px; color: #999; margin: 0; }

.plugin-list { display: flex; flex-direction: column; gap: 12px; }

.plugin-card {
  padding: 14px 16px;
  background: rgba(255,255,255,0.8);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 12px;
  transition: all 0.15s;
}
.plugin-card:hover { border-color: rgba(91,170,138,0.2); }
.plugin-card.inactive { opacity: 0.6; }

.plugin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.plugin-name { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: #333; }
.plugin-version { font-size: 11px; color: #999; font-weight: 400; }
.plugin-status { width: 8px; height: 8px; border-radius: 50%; }
.plugin-status.enabled { background: #5BAA8A; }
.plugin-status.disabled { background: #ccc; }

.plugin-actions { display: flex; gap: 4px; }
.btn-icon {
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; cursor: pointer; font-size: 14px;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s;
}
.btn-icon:hover { background: rgba(0,0,0,0.06); }

.plugin-description { font-size: 13px; color: #666; margin-bottom: 6px; }

.plugin-meta { display: flex; gap: 12px; font-size: 11px; color: #aaa; flex-wrap: wrap; }
.meta-item.status.active { color: #5BAA8A; }
.meta-item.status.inactive { color: #ccc; }
.meta-item.status.error { color: #E85D5D; }

.plugin-error { font-size: 12px; color: #E85D5D; margin-top: 6px; }

.plugin-permissions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.permission-tag {
  font-size: 10px; padding: 2px 6px; border-radius: 4px;
  background: rgba(91,170,138,0.1); color: #5BAA8A;
}

.error-msg { padding: 8px 12px; background: rgba(232,93,93,0.1); border-radius: 8px; font-size: 12px; color: #E85D5D; margin-bottom: 12px; }

.loading-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; }
.spinner { width: 24px; height: 24px; border: 3px solid rgba(91,170,138,0.2); border-top-color: #5BAA8A; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 8px; }
@keyframes spin { to { transform: rotate(360deg); } }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal-content {
  background: white; border-radius: 12px; width: 420px; max-height: 80vh;
  overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.2);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid rgba(0,0,0,0.06); }
.modal-header h3 { font-size: 16px; font-weight: 700; }
.modal-body { padding: 16px; }
.modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid rgba(0,0,0,0.06); }

.form-row { margin-bottom: 12px; }
.form-label { display: block; font-size: 12px; color: #666; margin-bottom: 4px; }
.form-input {
  width: 100%; padding: 8px 10px; border: 1px solid rgba(0,0,0,0.1);
  border-radius: 8px; font-size: 13px; outline: none; transition: border-color 0.2s;
}
.form-input:focus { border-color: rgba(91,170,138,0.5); }

.permission-list { display: flex; flex-wrap: wrap; gap: 8px; }
.permission-checkbox { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #555; cursor: pointer; }

.btn-cancel { padding: 6px 16px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; background: white; cursor: pointer; font-size: 13px; }
.btn-save { padding: 6px 16px; border: none; border-radius: 8px; background: #5BAA8A; color: white; cursor: pointer; font-size: 13px; }
.btn-save:hover { background: #4a9a7a; }
</style>
