<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import type { LLMProviderConfig, Skill, MCPServerConfig, MCPTestResult } from '@shared/types'

// ── 状态 ──
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const errorMsg = ref('')

const providers = ref<LLMProviderConfig[]>([])
const defaultModel = ref('')
const embeddingModel = ref('')
const maxTokens = ref(32000)
const outputReserve = ref(4000)

// ── 当前导航页 ──
const activeNav = ref('providers')

const NAV_ITEMS = [
  { id: 'providers', label: '模型服务', icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>' },
  { id: 'models', label: '默认模型', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
  { id: 'agent', label: 'Agent 配置', icon: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>' },
  { id: 'skills', label: '技能配置', icon: '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>' },
  { id: 'mcp', label: 'MCP 服务器', icon: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
  { id: 'shortcuts', label: '快捷键', icon: '<rect x="2" y="4" width="20" height="16" rx="2" ry="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>' },
  { id: 'theme', label: '外观主题', icon: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><line x1="2" y1="12" x2="22" y2="12"/>' },
  { id: 'ollama', label: '离线模式', icon: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>' },
  { id: 'data', label: '数据管理', icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' }
] as const

// ── 快捷键配置 ──
const shortcuts = ref<Record<string, string>>({})
const SHORTCUT_LABELS: Record<string, string> = {
  toggleChat: '显示/隐藏对话',
  newSession: '新建会话',
  togglePet: '显示/隐藏宠物'
}
const recordingKey = ref<string | null>(null)

// ── 主题配置 ──
const themeMode = ref<'light' | 'dark' | 'system'>('system')
const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统', icon: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>' },
  { value: 'light', label: '亮色', icon: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>' },
  { value: 'dark', label: '暗色', icon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' }
] as const
let unlistenTheme: (() => void) | null = null

// ── 离线模式 / Ollama (T-024) ──
const ollamaStatus = ref<{ online: boolean; host: string; offlineMode: boolean; models: any[]; currentModel?: string } | null>(null)
const ollamaLoading = ref(false)
const pullModelName = ref('')
const pullingModel = ref(false)
const pullProgress = ref(0)
const pullMessage = ref('')
const RECOMMENDED_MODELS = [
  { name: 'llama3.2:3b', description: 'Meta Llama 3.2 3B — 轻量级', size: '~2GB' },
  { name: 'qwen2.5:7b', description: '通义千问 2.5 7B — 中文优秀', size: '~4.7GB' },
  { name: 'gemma2:2b', description: 'Google Gemma 2 2B — 轻量', size: '~1.6GB' }
]

// ── 数据导出/导入 (T-023) ──
const exportFormat = ref<'json' | 'markdown'>('json')
const exportScope = ref<'all' | 'sessions' | 'memories'>('all')
const exportLoading = ref(false)
const exportResult = ref('')
const importLoading = ref(false)
const importResult = ref('')

// ── 技能配置 ──
const skills = ref<Skill[]>([])
const skillsLoading = ref(false)
const editingSkill = ref<Skill | null>(null)
const showSkillModal = ref(false)
const isCreatingSkill = ref(false)

const skillStatusLabels: Record<Skill['status'], string> = {
  active: '活跃',
  draft: '草稿',
  disabled: '已禁用',
  rejected: '已拒绝'
}

async function loadSkills() {
  skillsLoading.value = true
  try {
    skills.value = await window.settingsAPI.listSkills()
  } catch (err) {
    console.error('加载技能失败:', err)
  } finally {
    skillsLoading.value = false
  }
}

function handleCreateSkill() {
  editingSkill.value = {
    id: '',
    name: '',
    description: '',
    content: '',
    autoGenerated: false,
    confidence: 0.5,
    status: 'active',
    executionCount: 0,
    successRate: 0,
    createdAt: 0,
    updatedAt: 0
  }
  isCreatingSkill.value = true
  showSkillModal.value = true
}

function handleEditSkill(skill: Skill) {
  editingSkill.value = { ...skill }
  isCreatingSkill.value = false
  showSkillModal.value = true
}

async function handleSaveSkill() {
  if (!editingSkill.value) return
  if (!editingSkill.value.name.trim()) {
    errorMsg.value = '请填写技能名称'
    return
  }
  if (!editingSkill.value.description.trim()) {
    errorMsg.value = '请填写技能描述'
    return
  }
  errorMsg.value = ''
  try {
    if (isCreatingSkill.value) {
      await window.settingsAPI.createSkill({
        name: editingSkill.value.name,
        description: editingSkill.value.description,
        content: editingSkill.value.content,
        status: editingSkill.value.status
      })
    } else {
      await window.settingsAPI.updateSkill(editingSkill.value.id, {
        name: editingSkill.value.name,
        description: editingSkill.value.description,
        content: editingSkill.value.content,
        status: editingSkill.value.status
      })
    }
    showSkillModal.value = false
    editingSkill.value = null
    await loadSkills()
  } catch (err) {
    errorMsg.value = '保存技能失败'
    console.error(err)
  }
}

async function handleDeleteSkill(id: string) {
  if (!confirm('确定删除该技能？')) return
  try {
    await window.settingsAPI.deleteSkill(id)
    await loadSkills()
  } catch (err) {
    errorMsg.value = '删除技能失败'
    console.error(err)
  }
}

async function toggleSkillStatus(skill: Skill) {
  const newStatus: Skill['status'] = skill.status === 'active' ? 'disabled' : 'active'
  try {
    await window.settingsAPI.updateSkill(skill.id, { status: newStatus })
    await loadSkills()
  } catch (err) {
    errorMsg.value = '更新状态失败'
    console.error(err)
  }
}

// ── MCP 服务器配置 ──
const mcpServers = ref<MCPServerConfig[]>([])
const mcpLoading = ref(false)
const editingMCP = ref<MCPServerConfig | null>(null)
const showMCPModal = ref(false)
const isCreatingMCP = ref(false)
const mcpTesting = ref(false)
const mcpTestResult = ref<MCPTestResult | null>(null)

const MCP_TRANSPORT_LABELS: Record<MCPServerConfig['transport'], string> = {
  'stdio': 'Stdio (本地进程)',
  'sse': 'SSE (远程)',
  'streamable-http': 'HTTP (远程)'
}

async function loadMCPServers() {
  mcpLoading.value = true
  try {
    mcpServers.value = await window.settingsAPI.listMCPServers()
  } catch (err) {
    console.error('加载 MCP 服务器失败:', err)
  } finally {
    mcpLoading.value = false
  }
}

function handleAddMCP() {
  editingMCP.value = {
    id: '',
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    url: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0
  }
  isCreatingMCP.value = true
  mcpTestResult.value = null
  showMCPModal.value = true
}

function handleEditMCP(server: MCPServerConfig) {
  editingMCP.value = { ...server }
  isCreatingMCP.value = false
  mcpTestResult.value = null
  showMCPModal.value = true
}

async function handleSaveMCP() {
  if (!editingMCP.value) return
  if (!editingMCP.value.name.trim()) {
    errorMsg.value = '请填写服务器名称'
    return
  }
  if (editingMCP.value.transport === 'stdio' && !editingMCP.value.command?.trim()) {
    errorMsg.value = '请填写命令'
    return
  }
  if (editingMCP.value.transport !== 'stdio' && !editingMCP.value.url?.trim()) {
    errorMsg.value = '请填写服务器 URL'
    return
  }
  errorMsg.value = ''
  try {
    if (isCreatingMCP.value) {
      await window.settingsAPI.addMCPServer({
        name: editingMCP.value.name,
        transport: editingMCP.value.transport,
        url: editingMCP.value.url,
        command: editingMCP.value.command,
        args: editingMCP.value.args,
        env: editingMCP.value.env,
        enabled: editingMCP.value.enabled
      })
    } else {
      await window.settingsAPI.updateMCPServer(editingMCP.value.id, {
        name: editingMCP.value.name,
        transport: editingMCP.value.transport,
        url: editingMCP.value.url,
        command: editingMCP.value.command,
        args: editingMCP.value.args,
        env: editingMCP.value.env,
        enabled: editingMCP.value.enabled
      })
    }
    showMCPModal.value = false
    editingMCP.value = null
    await loadMCPServers()
  } catch (err) {
    errorMsg.value = '保存 MCP 服务器失败'
    console.error(err)
  }
}

async function handleDeleteMCP(id: string) {
  if (!confirm('确定删除该 MCP 服务器？')) return
  try {
    await window.settingsAPI.deleteMCPServer(id)
    await loadMCPServers()
  } catch (err) {
    errorMsg.value = '删除 MCP 服务器失败'
    console.error(err)
  }
}

async function toggleMCP(server: MCPServerConfig) {
  try {
    await window.settingsAPI.toggleMCPServer(server.id, !server.enabled)
    await loadMCPServers()
  } catch (err) {
    errorMsg.value = '更新状态失败'
    console.error(err)
  }
}

async function testMCP() {
  if (!editingMCP.value) return
  mcpTesting.value = true
  mcpTestResult.value = null
  try {
    mcpTestResult.value = await window.settingsAPI.testMCPServer(editingMCP.value)
  } catch (err: any) {
    mcpTestResult.value = { success: false, message: `测试失败: ${err.message}` }
  } finally {
    mcpTesting.value = false
  }
}

// ── MCP args/env 编辑辅助 ──
const mcpArgsText = ref('')
const mcpEnvText = ref('')

function syncMCPArgsFromText() {
  if (!editingMCP.value) return
  editingMCP.value.args = mcpArgsText.value.split(/\s+/).filter(Boolean)
}

function syncMCPEnvFromText() {
  if (!editingMCP.value) return
  const env: Record<string, string> = {}
  for (const line of mcpEnvText.value.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i)
    if (match) {
      env[match[1]] = match[2]
    }
  }
  editingMCP.value.env = env
}

watch(showMCPModal, (val) => {
  if (val && editingMCP.value) {
    mcpArgsText.value = editingMCP.value.args?.join(' ') || ''
    mcpEnvText.value = Object.entries(editingMCP.value.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')
  }
})

// ── 当前编辑的 Provider ──
const editingProvider = ref<LLMProviderConfig | null>(null)
const showProviderModal = ref(false)

// ── Provider 预设列表（参考 ai-model-form）──
const LOGO_CDN = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png'

interface ProviderPreset {
  id: string
  label: string
  url: string
  icon: string
  models: string[]
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', icon: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  { id: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com/v1', icon: 'claude-color', models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'] },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1', icon: 'deepseek-color', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'gemini', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', icon: 'gemini-color', models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
  { id: 'xai', label: 'xAI (Grok)', url: 'https://api.x.ai/v1', icon: 'grok', models: ['grok-3', 'grok-3-mini', 'grok-2-vision'] },
  { id: 'mistral', label: 'Mistral AI', url: 'https://api.mistral.ai/v1', icon: 'mistral-color', models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'] },
  { id: 'minimax', label: 'MiniMax', url: 'https://api.minimaxi.com/v1', icon: 'minimax-color', models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2', 'MiniMax-Text-01', 'abab6.5s-chat'] },
  { id: 'moonshot', label: 'Moonshot (Kimi)', url: 'https://api.moonshot.cn/v1', icon: 'kimi-color', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] },
  { id: 'zhipu', label: '智谱 AI', url: 'https://open.bigmodel.cn/api/paas/v4', icon: 'zhipu-color', models: ['glm-4-plus', 'glm-4-flash', 'glm-4-air'] },
  { id: 'qwen', label: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', icon: 'qwen-color', models: ['qwen-plus', 'qwen-turbo', 'qwen-max'] },
  { id: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', icon: 'groq', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', icon: 'openrouter', models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'] },
  { id: 'ollama', label: 'Ollama (本地)', url: 'http://localhost:11434/v1', icon: 'ollama', models: ['llama3.2', 'qwen2.5', 'gemma2'] },
]

function logoUrl(icon: string): string {
  if (icon.endsWith('-color')) return `${LOGO_CDN}/dark/${icon}.png`
  return `${LOGO_CDN}/dark/${icon}.png`
}

// ── 表单状态（参考 ai-model-form）──
const showApiKey = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const fetchingModels = ref(false)
const fetchedModels = ref<string[]>([])
const showProviderDropdown = ref(false)
const showModelDropdown = ref(false)
const endpointQuery = ref('')
const modelQuery = ref('')

// ── 选中的 Provider 预设 ──
const selectedPreset = computed(() => {
  if (!editingProvider.value) return null
  return PROVIDER_PRESETS.find(p => p.url === editingProvider.value!.baseURL)
})

// ── 过滤后的 Provider 列表 ──
const filteredProviders = computed(() => {
  const q = endpointQuery.value.toLowerCase()
  if (!q) return PROVIDER_PRESETS
  return PROVIDER_PRESETS.filter(p =>
    p.label.toLowerCase().includes(q) || p.url.toLowerCase().includes(q)
  )
})

// ── 过滤后的模型列表（合并预设和拉取的模型）──
const availableModels = computed(() => {
  const models = new Set<string>()
  if (selectedPreset.value) {
    selectedPreset.value.models.forEach(m => models.add(m))
  }
  fetchedModels.value.forEach(m => models.add(m))
  const q = modelQuery.value.toLowerCase()
  const all = Array.from(models)
  if (!q) return all
  return all.filter(m => m.toLowerCase().includes(q))
})

function selectProviderPreset(preset: ProviderPreset) {
  if (!editingProvider.value) return
  editingProvider.value.baseURL = preset.url
  editingProvider.value.name = preset.label
  showProviderDropdown.value = false
  testResult.value = null
  fetchModels()
}

function toggleProviderDropdown() {
  showProviderDropdown.value = !showProviderDropdown.value
  if (showProviderDropdown.value) {
    endpointQuery.value = editingProvider.value?.baseURL || ''
  }
}

function onEndpointInput() {
  endpointQuery.value = editingProvider.value?.baseURL || ''
  showProviderDropdown.value = true
  testResult.value = null
}

function onEndpointBlur() {
  setTimeout(() => { showProviderDropdown.value = false }, 150)
}

function toggleModelDropdown() {
  showModelDropdown.value = !showModelDropdown.value
  if (showModelDropdown.value && fetchedModels.value.length === 0 && editingProvider.value?.baseURL) {
    fetchModels()
  }
}

function onModelInput() {
  showModelDropdown.value = true
}

function onModelBlur() {
  setTimeout(() => { showModelDropdown.value = false }, 150)
}

function onModelKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && modelQuery.value.trim()) {
    e.preventDefault()
    const model = modelQuery.value.trim()
    if (!editingProvider.value) return
    if (!editingProvider.value.models.includes(model)) {
      editingProvider.value.models.push(model)
    }
    modelQuery.value = ''
  }
}

function selectModel(model: string) {
  if (!editingProvider.value) return
  if (!editingProvider.value.models.includes(model)) {
    editingProvider.value.models.push(model)
  } else {
    editingProvider.value.models = editingProvider.value.models.filter(m => m !== model)
  }
}

function removeModel(model: string) {
  if (!editingProvider.value) return
  editingProvider.value.models = editingProvider.value.models.filter(m => m !== model)
}

// ── 自动拉取模型列表（通过 IPC 主进程避免 CORS）──
async function fetchModels() {
  if (!editingProvider.value?.baseURL) return
  fetchingModels.value = true
  try {
    const result = await window.settingsAPI.fetchModels(
      editingProvider.value.baseURL,
      editingProvider.value.apiKey
    )
    if (result.success) {
      fetchedModels.value = result.models || []
      if (editingProvider.value.models.length === 0 && fetchedModels.value.length > 0) {
        editingProvider.value.models = fetchedModels.value.slice(0, 5)
      }
    }
  } catch {
  } finally {
    fetchingModels.value = false
  }
}

// ── 测试连接（通过 IPC 主进程避免 CORS）──
async function testConnection() {
  if (!editingProvider.value) return
  if (!editingProvider.value.baseURL.trim()) {
    testResult.value = { ok: false, message: '请填写 API Base URL' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const result = await window.settingsAPI.testConnection(
      editingProvider.value.baseURL,
      editingProvider.value.apiKey
    )
    testResult.value = { ok: result.success, message: result.success ? result.message : result.message }
    if (result.success) {
      await fetchModels()
    }
  } catch (e: any) {
    testResult.value = { ok: false, message: `网络错误: ${e.message}` }
  } finally {
    testing.value = false
  }
}

watch(() => editingProvider.value?.apiKey, (newKey, oldKey) => {
  if (!editingProvider.value?.baseURL) return
  const hadKey = oldKey && oldKey.trim().length > 0
  const hasKey = newKey && newKey.trim().length > 0
  if (hadKey !== hasKey) {
    fetchModels()
  }
})

const allModels = computed(() => {
  const models = new Set<string>()
  providers.value.forEach(p => p.models.forEach(m => models.add(m)))
  return Array.from(models)
})

// ── 加载配置 ──
onMounted(async () => {
  try {
    const config = await window.settingsAPI.getConfig()
    providers.value = config.providers || []
    defaultModel.value = config.defaultModel || ''
    embeddingModel.value = config.embeddingModel || ''
    maxTokens.value = config.maxTokens || 32000
    outputReserve.value = 4000
    shortcuts.value = await window.settingsAPI.getShortcuts()
  const themeData = await window.settingsAPI.getTheme()
  themeMode.value = themeData.mode as 'light' | 'dark' | 'system'
  applyThemeClass(themeData.effective)

  try {
    ollamaStatus.value = await window.settingsAPI.getOllamaStatus()
  } catch {}

  // 加载技能和 MCP 服务器
  loadSkills()
  loadMCPServers()
  } catch (err) {
    errorMsg.value = '加载配置失败'
    console.error(err)
  } finally {
    loading.value = false
  }

  unlistenTheme = window.settingsAPI.onThemeChange((data) => {
    if (data.mode !== themeMode.value) {
      themeMode.value = data.mode as 'light' | 'dark' | 'system'
    }
    applyThemeClass(data.effective)
  })
})

// ── 保存配置 ──
async function handleSave() {
  saving.value = true
  errorMsg.value = ''
  try {
    await window.settingsAPI.setConfig({
      providers: providers.value,
      defaultModel: defaultModel.value,
      embeddingModel: embeddingModel.value,
      agent: {
        maxTokens: maxTokens.value,
        outputReserve: outputReserve.value
      },
      mcpServers: mcpServers.value
    })
    await window.settingsAPI.setShortcuts(shortcuts.value)
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } catch (err) {
    errorMsg.value = '保存配置失败'
    console.error(err)
  } finally {
    saving.value = false
  }
}

// ── Provider 操作 ──
function addProvider() {
  editingProvider.value = {
    id: `provider-${Date.now()}`,
    name: '',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    models: ['gpt-4o-mini'],
    enabled: true
  }
  showApiKey.value = false
  testing.value = false
  testResult.value = null
  fetchingModels.value = false
  fetchedModels.value = []
  showProviderDropdown.value = false
  showModelDropdown.value = false
  endpointQuery.value = ''
  modelQuery.value = ''
  showProviderModal.value = true
  fetchModels()
}

function editProvider(provider: LLMProviderConfig) {
  editingProvider.value = { ...provider }
  showApiKey.value = false
  testing.value = false
  testResult.value = null
  fetchingModels.value = false
  fetchedModels.value = []
  showProviderDropdown.value = false
  showModelDropdown.value = false
  endpointQuery.value = ''
  modelQuery.value = ''
  showProviderModal.value = true
  fetchModels()
}

function deleteProvider(id: string) {
  providers.value = providers.value.filter(p => p.id !== id)
  if (defaultModel.value.startsWith(id + '::')) {
    defaultModel.value = ''
  }
  if (embeddingModel.value.startsWith(id + '::')) {
    embeddingModel.value = ''
  }
}

function saveProvider() {
  if (!editingProvider.value) return
  if (!editingProvider.value.name.trim()) {
    errorMsg.value = '请填写 Provider 名称'
    return
  }
  if (!editingProvider.value.baseURL.trim()) {
    errorMsg.value = '请填写 API Base URL'
    return
  }

  const idx = providers.value.findIndex(p => p.id === editingProvider.value!.id)
  if (idx >= 0) {
    providers.value[idx] = editingProvider.value
  } else {
    providers.value.push(editingProvider.value)
  }

  if (!defaultModel.value && editingProvider.value.models.length > 0) {
    defaultModel.value = `${editingProvider.value.id}::${editingProvider.value.models[0]}`
  }

  showProviderModal.value = false
  editingProvider.value = null
  errorMsg.value = ''
}

function toggleProvider(provider: LLMProviderConfig) {
  provider.enabled = !provider.enabled
}

function onModelChange(event: Event) {
  const target = event.target as HTMLSelectElement
  defaultModel.value = target.value
}

function onEmbeddingModelChange(event: Event) {
  const target = event.target as HTMLSelectElement
  embeddingModel.value = target.value
}

// ── 快捷键录制 ──
function startRecording(key: string) {
  recordingKey.value = key
}

function stopRecording() {
  recordingKey.value = null
}

function onShortcutKeydown(e: KeyboardEvent) {
  if (!recordingKey.value) return
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    recordingKey.value = null
    return
  }

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')

  const keyName = e.key
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(keyName)) return

  let keyPart = keyName
  if (keyName.length === 1) {
    keyPart = keyName.toUpperCase()
  } else if (keyName === 'ArrowUp') keyPart = 'Up'
  else if (keyName === 'ArrowDown') keyPart = 'Down'
  else if (keyName === 'ArrowLeft') keyPart = 'Left'
  else if (keyName === 'ArrowRight') keyPart = 'Right'

  parts.push(keyPart)
  shortcuts.value[recordingKey.value] = parts.join('+')
  recordingKey.value = null
}

// ── 主题切换 ──
function applyThemeClass(effective: string) {
  const root = document.querySelector('.settings-root')
  if (root) {
    root.classList.toggle('theme-dark', effective === 'dark')
    root.classList.toggle('theme-light', effective === 'light')
  }
}

async function onThemeChange(mode: 'light' | 'dark' | 'system') {
  themeMode.value = mode
  const result = await window.settingsAPI.setTheme(mode)
  applyThemeClass(result.effective)
}

// ── 关闭窗口 ──
function handleClose() {
  window.settingsAPI.close()
}

// ── Ollama 操作 (T-024) ──
async function refreshOllamaStatus() {
  ollamaLoading.value = true
  try {
    ollamaStatus.value = await window.settingsAPI.getOllamaStatus()
  } catch {}
  ollamaLoading.value = false
}

async function toggleOfflineMode() {
  if (!ollamaStatus.value) return
  const newEnabled = !ollamaStatus.value.offlineMode
  await window.settingsAPI.setOllamaEnabled(newEnabled)
  ollamaStatus.value.offlineMode = newEnabled
}

async function handlePullModel(modelName?: string) {
  const name = modelName || pullModelName.value.trim()
  if (!name) return
  pullingModel.value = true
  pullProgress.value = 0
  pullMessage.value = `正在下载 ${name}...`
  try {
    const result = await window.settingsAPI.pullOllamaModel(name)
    if (result.success) {
      pullMessage.value = `${name} 下载完成`
      pullModelName.value = ''
      await refreshOllamaStatus()
    } else {
      pullMessage.value = `下载失败: ${result.error}`
    }
  } catch (err) {
    pullMessage.value = '下载失败'
  } finally {
    pullingModel.value = false
    setTimeout(() => { pullMessage.value = '' }, 5000)
  }
}

async function handleDeleteModel(modelName: string) {
  if (!confirm(`确定要删除模型 ${modelName} 吗？`)) return
  try {
    await window.settingsAPI.deleteOllamaModel(modelName)
    await refreshOllamaStatus()
  } catch {}
}

// ── 数据导出/导入 (T-023) ──
async function handleExport() {
  exportLoading.value = true
  exportResult.value = ''
  try {
    const result = await window.settingsAPI.exportData({
      format: exportFormat.value,
      scope: exportScope.value
    })
    if (result.success) {
      exportResult.value = `导出成功: ${result.filePath} (${result.count} 条记录)`
    } else {
      exportResult.value = result.error || '导出失败'
    }
  } catch (err) {
    exportResult.value = '导出失败'
  } finally {
    exportLoading.value = false
    setTimeout(() => { exportResult.value = '' }, 5000)
  }
}

async function handleImport() {
  importLoading.value = true
  importResult.value = ''
  try {
    const result = await window.settingsAPI.importData()
    if (result.success) {
      importResult.value = `导入成功: ${result.sessionsImported} 个会话, ${result.messagesImported} 条消息`
    } else {
      importResult.value = result.error || '导入失败'
    }
  } catch (err) {
    importResult.value = '导入失败'
  } finally {
    importLoading.value = false
    setTimeout(() => { importResult.value = '' }, 5000)
  }
}

// ── 拖拽窗口 ──
let isDragging = false
function onTitleMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.closest('.title-btn')) return
  isDragging = true
}
function onTitleMouseMove(e: MouseEvent) {
  if (!isDragging) return
}
function onTitleMouseUp() {
  isDragging = false
}
</script>

<template>
  <div class="settings-root" data-testid="settings-root">
    <!-- ═══ 标题栏 ═══ -->
    <div class="title-bar" data-testid="title-bar"
         @mousedown="onTitleMouseDown" @mousemove="onTitleMouseMove" @mouseup="onTitleMouseUp">
      <div class="title-left">
        <svg class="title-owl-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="8" r="3" fill="currentColor" stroke="none"/>
          <circle cx="8.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
          <circle cx="15.5" cy="13" r="1.5" fill="currentColor" stroke="none"/>
          <path d="M8.5 16.5c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5"/>
        </svg>
        <span class="title-text">设置</span>
      </div>
      <div class="title-right">
        <button class="title-btn" data-testid="btn-save-settings-top"
                :disabled="saving" @click="handleSave" :title="saving ? '保存中...' : '保存配置'">
          <svg v-if="saving" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
        </button>
        <button class="title-btn" data-testid="btn-close-settings" title="关闭" @click="handleClose">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- ═══ 主体区域：左侧导航 + 右侧内容 ═══ -->
    <div class="settings-body" v-if="!loading">
      <!-- ═══ 左侧导航 ═══ -->
      <nav class="settings-nav">
        <button
          v-for="item in NAV_ITEMS"
          :key="item.id"
          class="nav-item"
          :class="{ active: activeNav === item.id }"
          @click="activeNav = item.id"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="item.icon" />
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <!-- ═══ 右侧内容 ═══ -->
      <div class="settings-content">
        <!-- ── Provider 配置 ── -->
        <section v-show="activeNav === 'providers'" class="settings-section" data-testid="provider-section">
          <div class="section-header">
            <h2 class="section-title">LLM 模型服务</h2>
            <button class="btn-add" data-testid="btn-add-provider" @click="addProvider">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              添加 Provider
            </button>
          </div>

          <div v-if="providers.length === 0" class="empty-providers" data-testid="empty-providers">
            <p>尚未配置任何 Provider</p>
            <p class="hint">点击「添加 Provider」开始配置</p>
          </div>

          <div v-else class="provider-list" data-testid="provider-list">
            <div v-for="provider in providers" :key="provider.id" class="provider-card"
                 :class="{ disabled: !provider.enabled }">
              <div class="provider-info">
                <div class="provider-name">
                  <span class="provider-status" :class="provider.enabled ? 'enabled' : 'disabled'"></span>
                  {{ provider.name }}
                </div>
                <div class="provider-url">{{ provider.baseURL }}</div>
                <div class="provider-models">
                  <span v-for="model in provider.models" :key="model" class="model-tag">{{ model }}</span>
                </div>
              </div>
              <div class="provider-actions">
                <button class="btn-icon" @click="toggleProvider(provider)" :title="provider.enabled ? '禁用' : '启用'">
                  <svg v-if="provider.enabled" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
                <button class="btn-icon" @click="editProvider(provider)" title="编辑">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon" @click="deleteProvider(provider.id)" title="删除">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- ── 默认模型 ── -->
        <section v-show="activeNav === 'models'" class="settings-section">
          <h2 class="section-title">默认模型</h2>
          <div class="form-row">
            <label class="form-label">选择模型</label>
            <select class="form-select" data-testid="select-default-model" :value="defaultModel" @change="onModelChange">
              <option value="">未选择</option>
              <optgroup v-for="provider in providers.filter(p => p.enabled)" :key="provider.id" :label="provider.name">
                <option v-for="model in provider.models" :key="model" :value="`${provider.id}::${model}`">
                  {{ model }}
                </option>
              </optgroup>
            </select>
          </div>

          <h2 class="section-title" style="margin-top: 24px;">嵌入模型 <span class="section-hint">（用于记忆/语义搜索）</span></h2>
          <div class="form-row">
            <label class="form-label">
              选择嵌入模型
              <span class="hint-text">嵌入模型与聊天模型不同，如 OpenAI 的 text-embedding-3-small。留空则使用伪嵌入（无语义搜索能力）。</span>
            </label>
            <select class="form-select" data-testid="select-embedding-model" :value="embeddingModel" @change="onEmbeddingModelChange">
              <option value="">未配置（使用伪嵌入）</option>
              <optgroup v-for="provider in providers.filter(p => p.enabled)" :key="provider.id" :label="provider.name">
                <option v-for="model in provider.models" :key="model" :value="`${provider.id}::${model}`">
                  {{ model }}
                </option>
              </optgroup>
            </select>
          </div>
        </section>

        <!-- ── Agent 配置 ── -->
        <section v-show="activeNav === 'agent'" class="settings-section">
          <h2 class="section-title">Agent 配置</h2>
          <div class="form-row">
            <label class="form-label">最大上下文 Token
              <span class="value-display">{{ maxTokens.toLocaleString() }}</span>
            </label>
            <input type="range" class="form-slider" data-testid="slider-max-tokens"
                   min="4000" max="128000" step="1000"
                   v-model.number="maxTokens" />
          </div>
          <div class="form-row">
            <label class="form-label">输出预留 Token
              <span class="value-display">{{ outputReserve.toLocaleString() }}</span>
            </label>
            <input type="range" class="form-slider" data-testid="slider-output-reserve"
                   min="1000" max="16000" step="500"
                   v-model.number="outputReserve" />
          </div>
        </section>

        <!-- ── 技能配置 ── -->
        <section v-show="activeNav === 'skills'" class="settings-section" data-testid="skills-section">
          <div class="section-header">
            <h2 class="section-title">技能配置</h2>
            <button class="btn-add" data-testid="btn-add-skill-settings" @click="handleCreateSkill">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              新建技能
            </button>
          </div>
          <p class="hint-text" style="margin-bottom: 12px;">技能是可复用的 Prompt 模板，Agent 会根据对话内容自动匹配最相关的技能。</p>

          <div v-if="skills.length === 0" class="empty-providers">
            <p>暂无技能</p>
            <p class="hint">点击「新建技能」创建第一个技能</p>
          </div>

          <div v-else class="provider-list">
            <div v-for="skill in skills" :key="skill.id" class="provider-card" :class="{ disabled: skill.status === 'disabled' }">
              <div class="provider-info">
                <div class="provider-name">
                  <span class="provider-status" :class="skill.status === 'active' ? 'enabled' : 'disabled'"></span>
                  {{ skill.name }}
                  <span class="model-tag">{{ skillStatusLabels[skill.status] }}</span>
                  <span v-if="skill.autoGenerated" class="model-tag" style="background: rgba(245, 158, 11, 0.1); color: #d97706;">自动生成</span>
                </div>
                <div class="provider-url">{{ skill.description }}</div>
                <div class="provider-models">
                  <span class="model-tag" style="opacity: 0.7;">使用 {{ skill.executionCount }} 次</span>
                  <span class="model-tag" style="opacity: 0.7;">成功率 {{ (skill.successRate * 100).toFixed(0) }}%</span>
                </div>
              </div>
              <div class="provider-actions">
                <button class="btn-icon" @click="toggleSkillStatus(skill)" :title="skill.status === 'active' ? '禁用' : '启用'">
                  <svg v-if="skill.status === 'active'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
                <button class="btn-icon" @click="handleEditSkill(skill)" title="编辑">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon" @click="handleDeleteSkill(skill.id)" title="删除">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- ── MCP 服务器配置 ── -->
        <section v-show="activeNav === 'mcp'" class="settings-section" data-testid="mcp-section">
          <div class="section-header">
            <h2 class="section-title">MCP 服务器</h2>
            <button class="btn-add" data-testid="btn-add-mcp" @click="handleAddMCP">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
              添加服务器
            </button>
          </div>
          <p class="hint-text" style="margin-bottom: 12px;">MCP (Model Context Protocol) 服务器为 Agent 提供外部工具和数据源。支持 Stdio 本地进程和 SSE/HTTP 远程服务器。</p>

          <div v-if="mcpServers.length === 0" class="empty-providers">
            <p>暂无 MCP 服务器</p>
            <p class="hint">点击「添加服务器」配置 MCP 连接</p>
          </div>

          <div v-else class="provider-list">
            <div v-for="server in mcpServers" :key="server.id" class="provider-card" :class="{ disabled: !server.enabled }">
              <div class="provider-info">
                <div class="provider-name">
                  <span class="provider-status" :class="server.enabled ? 'enabled' : 'disabled'"></span>
                  {{ server.name }}
                  <span class="model-tag">{{ MCP_TRANSPORT_LABELS[server.transport] }}</span>
                </div>
                <div class="provider-url">{{ server.transport === 'stdio' ? server.command : server.url }}</div>
                <div v-if="server.transport === 'stdio' && server.args && server.args.length > 0" class="provider-models">
                  <span v-for="arg in server.args" :key="arg" class="model-tag" style="opacity: 0.7;">{{ arg }}</span>
                </div>
              </div>
              <div class="provider-actions">
                <button class="btn-icon" @click="toggleMCP(server)" :title="server.enabled ? '禁用' : '启用'">
                  <svg v-if="server.enabled" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
                <button class="btn-icon" @click="handleEditMCP(server)" title="编辑">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon" @click="handleDeleteMCP(server.id)" title="删除">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- ── 快捷键配置 ── -->
        <section v-show="activeNav === 'shortcuts'" class="settings-section" data-testid="shortcuts-section">
          <h2 class="section-title">快捷键</h2>
          <div v-for="(label, key) in SHORTCUT_LABELS" :key="key" class="form-row shortcut-row">
            <label class="form-label">{{ label }}</label>
            <div class="shortcut-input-wrapper"
                 @keydown="onShortcutKeydown"
                 @click="startRecording(key as string)"
                 tabindex="0">
              <span v-if="recordingKey === key" class="shortcut-recording">按下快捷键...</span>
              <span v-else-if="shortcuts[key]" class="shortcut-value" data-testid="shortcut-value">{{ shortcuts[key] }}</span>
              <span v-else class="shortcut-empty">未设置</span>
              <button v-if="shortcuts[key] && recordingKey !== key"
                      class="shortcut-clear"
                      @click.stop="shortcuts[key] = ''">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </section>

        <!-- ── 主题配置 ── -->
        <section v-show="activeNav === 'theme'" class="settings-section" data-testid="theme-section">
          <h2 class="section-title">外观主题</h2>
          <div class="form-row">
            <label class="form-label">外观</label>
            <div class="theme-options">
              <button
                v-for="option in THEME_OPTIONS"
                :key="option.value"
                class="theme-option-btn"
                :class="{ active: themeMode === option.value }"
                :data-testid="'theme-btn-' + option.value"
                @click="onThemeChange(option.value)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="option.icon" />
                <span>{{ option.label }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- ── 离线模式 / Ollama ── -->
        <section v-show="activeNav === 'ollama'" class="settings-section" data-testid="ollama-section">
          <h2 class="section-title">离线模式 (Ollama)</h2>
          <div class="form-row" v-if="ollamaStatus">
            <label class="form-label">
              状态:
              <span :class="ollamaStatus.online ? 'status-online' : 'status-offline'">
                <span class="status-dot" :class="ollamaStatus.online ? 'online' : 'offline'"></span>
                {{ ollamaStatus.online ? '在线' : '离线' }}
              </span>
              <button class="btn-small" data-testid="btn-refresh-ollama" @click="refreshOllamaStatus">刷新</button>
            </label>
          </div>
          <div class="form-row" v-if="ollamaStatus">
            <label class="form-label">启用离线模式</label>
            <button
              class="theme-option-btn"
              :class="{ active: ollamaStatus.offlineMode }"
              data-testid="btn-toggle-offline"
              @click="toggleOfflineMode"
            >
              {{ ollamaStatus.offlineMode ? '已启用' : '已禁用' }}
            </button>
          </div>
          <div v-if="ollamaStatus && ollamaStatus.models.length > 0" class="form-row" data-testid="ollama-models">
            <label class="form-label">已安装模型</label>
            <div v-for="model in ollamaStatus.models" :key="model.name" class="provider-card">
              <div class="provider-info">
                <div class="provider-name">{{ model.name }}</div>
                <div class="provider-url">{{ (model.size / 1024 / 1024 / 1024).toFixed(1) }} GB</div>
              </div>
              <button class="btn-icon" data-testid="btn-delete-model" @click="handleDeleteModel(model.name)" title="删除">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">下载模型</label>
            <div class="ollama-pull-row">
              <input type="text" class="form-input" data-testid="input-pull-model" v-model="pullModelName" placeholder="如: llama3.2:3b" :disabled="pullingModel" />
              <button class="btn-save" data-testid="btn-pull-model" :disabled="pullingModel || !pullModelName.trim()" @click="handlePullModel()">
                {{ pullingModel ? '下载中...' : '下载' }}
              </button>
            </div>
          </div>
          <div v-if="pullMessage" class="form-row">
            <span class="pull-message" data-testid="pull-message">{{ pullMessage }}</span>
          </div>
          <div class="form-row">
            <label class="form-label">推荐模型</label>
            <div class="recommended-models">
              <button v-for="model in RECOMMENDED_MODELS" :key="model.name" class="recommended-model-btn" @click="handlePullModel(model.name)">
                <span class="model-name">{{ model.name }}</span>
                <span class="model-desc">{{ model.description }}</span>
                <span class="model-size">{{ model.size }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- ── 数据导出/导入 ── -->
        <section v-show="activeNav === 'data'" class="settings-section" data-testid="data-section">
          <h2 class="section-title">数据导出/导入</h2>
          <div class="form-row">
            <label class="form-label">导出格式</label>
            <select class="form-select" data-testid="select-export-format" v-model="exportFormat">
              <option value="json">JSON</option>
              <option value="markdown">Markdown</option>
            </select>
          </div>
          <div class="form-row">
            <label class="form-label">导出范围</label>
            <select class="form-select" data-testid="select-export-scope" v-model="exportScope">
              <option value="all">全部（会话+记忆）</option>
              <option value="sessions">仅会话</option>
              <option value="memories">仅记忆</option>
            </select>
          </div>
          <div class="form-row">
            <button class="btn-save" data-testid="btn-export" :disabled="exportLoading" @click="handleExport">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ exportLoading ? '导出中...' : '导出数据' }}
            </button>
            <button class="btn-cancel" data-testid="btn-import" :disabled="importLoading" @click="handleImport">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {{ importLoading ? '导入中...' : '导入数据' }}
            </button>
          </div>
          <div v-if="exportResult" class="form-row result-msg" data-testid="export-result">{{ exportResult }}</div>
          <div v-if="importResult" class="form-row result-msg" data-testid="import-result">{{ importResult }}</div>
        </section>

        <!-- 错误和保存提示 -->
        <div v-if="errorMsg" class="error-msg" data-testid="error-msg">{{ errorMsg }}</div>
        <Transition name="banner">
          <div v-if="saved" class="saved-msg" data-testid="saved-msg">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            配置已保存
          </div>
        </Transition>

        <!-- 保存按钮 -->
        <div class="actions">
          <button class="btn-save" data-testid="btn-save-settings"
                  :disabled="saving" @click="handleSave">
            {{ saving ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </div>
    </div>

    <div v-else class="loading-state">
      <div class="spinner"></div>
      <p>加载配置中...</p>
    </div>

    <!-- ═══ Provider 编辑弹窗 ═══ -->
    <div v-if="showProviderModal" class="modal-overlay" data-testid="provider-modal" @click.self="showProviderModal = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>{{ editingProvider?.id?.startsWith('provider-') && !providers.find(p => p.id === editingProvider?.id) ? '添加' : '编辑' }} Provider</h3>
          <button class="btn-icon" @click="showProviderModal = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body" v-if="editingProvider">
          <!-- Provider 选择（Combobox + Logo） -->
          <div class="form-row">
            <label class="form-label">API Endpoint <span class="required">*</span></label>
            <div class="combobox" :class="{ open: showProviderDropdown }">
              <div class="combo-input-row">
                <img v-if="selectedPreset" class="combo-logo" :src="logoUrl(selectedPreset.icon)" :alt="selectedPreset.label" width="16" height="16" @error="($event.target as HTMLImageElement).style.display='none'" />
                <svg v-else class="combo-logo-fallback" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                <input type="text" class="combo-input" data-testid="input-provider-url"
                       v-model="editingProvider.baseURL"
                       placeholder="https://api.openai.com/v1"
                       autocomplete="off"
                       @focus="showProviderDropdown = true"
                       @blur="onEndpointBlur"
                       @input="onEndpointInput" />
                <button v-if="editingProvider.baseURL" type="button" class="combo-clear" tabindex="-1" @mousedown.prevent="editingProvider.baseURL = ''; showProviderDropdown = false">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
                <button type="button" class="combo-arrow" tabindex="-1" @mousedown.prevent="toggleProviderDropdown">
                  <svg :style="{ transform: showProviderDropdown ? 'rotate(180deg)' : 'rotate(0)' }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              </div>
              <div v-if="showProviderDropdown && filteredProviders.length" class="combo-dropdown">
                <button v-for="preset in filteredProviders" :key="preset.id" type="button"
                        class="combo-dropdown-item" :class="{ active: editingProvider.baseURL === preset.url }"
                        @mousedown.prevent="selectProviderPreset(preset)">
                  <img class="dropdown-logo" :src="logoUrl(preset.icon)" :alt="preset.label" width="16" height="16" @error="($event.target as HTMLImageElement).style.display='none'" />
                  <span class="dropdown-label">{{ preset.label }}</span>
                  <span class="dropdown-url">{{ preset.url }}</span>
                  <svg v-if="editingProvider.baseURL === preset.url" class="dropdown-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 名称 -->
          <div class="form-row">
            <label class="form-label">显示名称</label>
            <input type="text" class="form-input" data-testid="input-provider-name"
                   v-model="editingProvider.name" placeholder="例如: OpenAI" />
          </div>

          <!-- API Key（带显隐切换） -->
          <div class="form-row">
            <label class="form-label">API Key</label>
            <div class="input-with-action">
              <input :type="showApiKey ? 'text' : 'password'" class="form-input has-action" data-testid="input-provider-key"
                     v-model="editingProvider.apiKey" placeholder="sk-..." autocomplete="new-password" spellcheck="false" />
              <button type="button" class="input-action-btn" tabindex="-1" @click="showApiKey = !showApiKey" :title="showApiKey ? '隐藏' : '显示'">
                <svg v-if="showApiKey" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          </div>

          <!-- 模型选择（Combobox + 自动拉取） -->
          <div class="form-row">
            <label class="form-label">
              模型
              <button v-if="fetchingModels" type="button" class="mini-loading" disabled>拉取中...</button>
              <button v-else type="button" class="mini-btn" @click="fetchModels" title="从 API 拉取模型列表">刷新模型</button>
            </label>
            <div class="combobox" :class="{ open: showModelDropdown }">
              <div class="combo-input-row">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
                <input type="text" class="combo-input" data-testid="input-provider-models"
                       v-model="modelQuery"
                       @focus="showModelDropdown = true"
                       @blur="onModelBlur"
                       @keydown="onModelKeydown"
                       placeholder="搜索或输入模型名称" autocomplete="off" />
                <button type="button" class="combo-arrow" tabindex="-1" @mousedown.prevent="toggleModelDropdown">
                  <svg :style="{ transform: showModelDropdown ? 'rotate(180deg)' : 'rotate(0)' }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              </div>
              <div v-if="showModelDropdown && availableModels.length" class="combo-dropdown">
                <button v-for="model in availableModels" :key="model" type="button"
                        class="combo-dropdown-item model-item" :class="{ active: editingProvider.models.includes(model) }"
                        @mousedown.prevent="selectModel(model)">
                  <span class="dropdown-label">{{ model }}</span>
                  <svg v-if="editingProvider.models.includes(model)" class="dropdown-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </button>
              </div>
              <div v-if="showModelDropdown && !availableModels.length && !fetchingModels" class="combo-dropdown">
                <div class="combo-empty">暂无可用模型，请先选择 Endpoint 或输入 API Key 后点击"刷新模型"</div>
              </div>
            </div>
            <!-- 已选模型标签 -->
            <div v-if="editingProvider.models.length > 0" class="model-tags-edit">
              <span v-for="model in editingProvider.models" :key="model" class="model-tag-edit">
                {{ model }}
                <button type="button" class="tag-remove" @click="removeModel(model)">
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </span>
            </div>
          </div>

          <!-- 测试连接结果 -->
          <Transition name="banner">
            <div v-if="testResult" class="test-banner" :class="testResult.ok ? 'ok' : 'fail'">
              <svg v-if="testResult.ok" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <span>{{ testResult.message }}</span>
            </div>
          </Transition>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showProviderModal = false">取消</button>
          <button class="btn-test" data-testid="btn-test-provider" :disabled="testing" @click="testConnection">
            <svg v-if="testing" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            {{ testing ? '测试中...' : '测试连接' }}
          </button>
          <button class="btn-save" data-testid="btn-save-provider" @click="saveProvider">保存</button>
        </div>
      </div>
    </div>

    <!-- ═══ 技能编辑弹窗 ═══ -->
    <div v-if="showSkillModal" class="modal-overlay" data-testid="skill-settings-modal" @click.self="showSkillModal = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>{{ isCreatingSkill ? '新建技能' : '编辑技能' }}</h3>
          <button class="btn-icon" @click="showSkillModal = false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal-body" v-if="editingSkill">
          <div class="form-row">
            <label class="form-label">技能名称</label>
            <input type="text" class="form-input" data-testid="input-skill-name-settings" v-model="editingSkill.name" placeholder="例如: 代码审查" />
          </div>
          <div class="form-row">
            <label class="form-label">技能描述</label>
            <input type="text" class="form-input" data-testid="input-skill-desc-settings" v-model="editingSkill.description" placeholder="简要描述技能的用途" />
          </div>
          <div class="form-row">
            <label class="form-label">Prompt 模板</label>
            <textarea class="form-input" data-testid="input-skill-content-settings" v-model="editingSkill.content" rows="8" placeholder="输入 Prompt 模板内容..." style="font-family: 'SF Mono', 'Consolas', monospace; font-size: 12px; resize: vertical;"></textarea>
          </div>
          <div class="form-row" v-if="!isCreatingSkill">
            <label class="form-label">状态</label>
            <select class="form-select" v-model="editingSkill.status">
              <option value="active">活跃</option>
              <option value="draft">草稿</option>
              <option value="disabled">已禁用</option>
              <option value="rejected">已拒绝</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showSkillModal = false">取消</button>
          <button class="btn-save" data-testid="btn-save-skill-settings" @click="handleSaveSkill">{{ isCreatingSkill ? '创建' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- ═══ MCP 服务器编辑弹窗 ═══ -->
    <div v-if="showMCPModal" class="modal-overlay" data-testid="mcp-modal" @click.self="showMCPModal = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>{{ isCreatingMCP ? '添加 MCP 服务器' : '编辑 MCP 服务器' }}</h3>
          <button class="btn-icon" @click="showMCPModal = false"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal-body" v-if="editingMCP">
          <div class="form-row">
            <label class="form-label">服务器名称 <span class="required">*</span></label>
            <input type="text" class="form-input" data-testid="input-mcp-name" v-model="editingMCP.name" placeholder="例如: 文件系统 MCP" />
          </div>
          <div class="form-row">
            <label class="form-label">传输方式</label>
            <select class="form-select" v-model="editingMCP.transport">
              <option value="stdio">Stdio (本地进程)</option>
              <option value="sse">SSE (远程服务器)</option>
              <option value="streamable-http">HTTP (远程服务器)</option>
            </select>
          </div>

          <!-- Stdio 配置 -->
          <template v-if="editingMCP.transport === 'stdio'">
            <div class="form-row">
              <label class="form-label">命令 <span class="required">*</span></label>
              <input type="text" class="form-input" data-testid="input-mcp-command" v-model="editingMCP.command" placeholder="例如: npx @modelcontextprotocol/server-filesystem" />
            </div>
            <div class="form-row">
              <label class="form-label">参数（空格分隔）</label>
              <input type="text" class="form-input" v-model="mcpArgsText" @input="syncMCPArgsFromText" placeholder="例如: /path/to/allowed/dir" />
            </div>
            <div class="form-row">
              <label class="form-label">环境变量（每行 KEY=value）</label>
              <textarea class="form-input" v-model="mcpEnvText" @input="syncMCPEnvFromText" rows="4" placeholder="API_KEY=xxx&#10;NODE_ENV=production" style="font-family: 'SF Mono', 'Consolas', monospace; font-size: 12px; resize: vertical;"></textarea>
            </div>
          </template>

          <!-- SSE / HTTP 配置 -->
          <template v-else>
            <div class="form-row">
              <label class="form-label">服务器 URL <span class="required">*</span></label>
              <input type="text" class="form-input" data-testid="input-mcp-url" v-model="editingMCP.url" placeholder="https://example.com/mcp/sse" />
            </div>
          </template>

          <div class="form-row">
            <label class="form-label">
              启用
              <input type="checkbox" v-model="editingMCP.enabled" style="margin-left: 8px;" />
            </label>
          </div>

          <!-- 测试结果 -->
          <Transition name="banner">
            <div v-if="mcpTestResult" class="test-banner" :class="mcpTestResult.success ? 'ok' : 'fail'">
              <svg v-if="mcpTestResult.success" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <span>{{ mcpTestResult.message }}</span>
            </div>
          </Transition>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="showMCPModal = false">取消</button>
          <button class="btn-test" data-testid="btn-test-mcp" :disabled="mcpTesting" @click="testMCP">
            <svg v-if="mcpTesting" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            {{ mcpTesting ? '测试中...' : '测试连接' }}
          </button>
          <button class="btn-save" data-testid="btn-save-mcp" @click="handleSaveMCP">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>
