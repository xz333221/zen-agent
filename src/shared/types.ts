/**
 * Zen Agent — 共享类型定义
 * 主进程和渲染进程共用
 */

// ═══════════════════════════════════════════════════════════
//  宠物状态
// ═══════════════════════════════════════════════════════════

export type PetState =
  | 'idle'         // 打坐
  | 'listening'    // 倾听
  | 'thinking'     // 思考
  | 'working'      // 执行中
  | 'happy'        // 完成
  | 'confused'     // 困惑
  | 'sleeping'     // 休眠
  | 'evolving'     // 进化中

export interface PetStateData {
  state: PetState
  /** 气泡消息（可选） */
  bubble?: {
    text: string
    type: 'info' | 'evolution' | 'memory' | 'greeting' | 'error'
    actionLabel?: string
    actionId?: string
  }
}

// ═══════════════════════════════════════════════════════════
//  对话消息
// ═══════════════════════════════════════════════════════════

export type MessageRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: number
  /** Agent 回复附带执行追踪 */
  trace?: ExecutionTrace
  /** 流式输出状态 */
  streaming?: boolean
  /** 图片附件列表 (T-021) */
  images?: ImageAttachment[]
}

// ═══════════════════════════════════════════════════════════
//  执行追踪
// ═══════════════════════════════════════════════════════════

export type StepType =
  | 'intent'
  | 'memory'
  | 'skill_match'
  | 'think'
  | 'act'
  | 'observe'
  | 'reflect'
  | 'store'
  | 'stats'
  | 'complete'
  | 'plan'
  | 'delegate'

export type StepStatus = 'running' | 'completed' | 'error' | 'skipped'

export interface TraceStep {
  id: string
  index: number
  type: StepType
  name: string
  icon: string
  startTime: number
  endTime?: number
  duration?: number
  status: StepStatus
  model?: string
  inputTokens?: number
  outputTokens?: number
  fullPrompt?: string
  fullResponse?: string
  detail: StepDetail
  children?: TraceStep[]
}

export type StepDetail =
  | IntentDetail
  | MemoryDetail
  | SkillMatchDetail
  | ThinkDetail
  | ActDetail
  | ObserveDetail
  | ReflectDetail
  | StoreDetail
  | StatsDetail
  | CompleteDetail
  | PlanDetail
  | DelegateDetail

export interface IntentDetail {
  type: 'intent'
  userInput: string
  classification: string
  complexity: 'low' | 'medium' | 'high'
  requiresPlanning: boolean
}

export interface MemoryDetail {
  type: 'memory'
  searchParams: { topK: number; minScore: number }
  retrieved: Array<{
    id: string
    content: string
    score: number
    source: string
    age: string
    confidence: number
  }>
  totalTokens: number
}

export interface SkillMatchDetail {
  type: 'skill_match'
  candidates: Array<{
    id: string
    name: string
    description: string
    score: number
    loaded: boolean
    reason: string
  }>
  loadedTokens: number
}

export interface ThinkDetail {
  type: 'think'
  reasoning: string
  decision: string
  toolsConsidered?: string[]
}

export interface ActDetail {
  type: 'act'
  toolName: string
  parameters: Record<string, unknown>
  parameterSummary: string
  result: unknown
  resultSummary: string
  resultType: 'text' | 'json' | 'code' | 'file' | 'image' | 'error'
  requiresApproval: boolean
  approved: boolean
}

export interface ObserveDetail {
  type: 'observe'
  analysis: string
  isComplete: boolean
  remainingSteps?: string[]
}

export interface ReflectDetail {
  type: 'reflect'
  selfScore: number
  scoreReason: string
  strengths: string[]
  weaknesses: string[]
  improvements: string[]
  patternDetected: boolean
}

export interface StoreDetail {
  type: 'store'
  episodicMemoryId: string
  newSemanticMemories: Array<{
    content: string
    confidence: number
    memType: 'fact' | 'preference' | 'pattern' | 'knowledge'
  }>
  skillProposal?: {
    skillName: string
    confidence: number
    sourceEpisodes: string[]
  }
}

export interface StatsDetail {
  type: 'stats'
  contextBreakdown: {
    systemPrompt: number
    toolDefinitions: number
    memories: number
    skills: number
    history: number
    userInput: number
    outputReserve: number
    total: number
    budget: number
  }
}

export interface CompleteDetail {
  type: 'complete'
  totalDuration: number
  toolCalls: number
  llmCalls: number
}

// ── T-011: Coordinator Agent ──

export interface PlanDetail {
  type: 'plan'
  userRequest: string
  taskCount: number
  tasks: Array<{
    id: string
    name: string
    description: string
    agentType: string
    dependencies: string[]
    canParallelize: boolean
    status: string
    estimatedTokens: number
  }>
  totalEstimatedTokens: number
  decompositionMethod: 'llm' | 'rule'
}

export interface DelegateDetail {
  type: 'delegate'
  taskId: string
  taskName: string
  agentType: string
  agentId: string
  status: 'running' | 'completed' | 'failed' | 'skipped'
  result?: {
    status: string
    data: unknown
    tokensUsed: number
    modelUsed: string
  }
  error?: string
  duration: number
}

export interface ExecutionTrace {
  id: string
  sessionId: string
  messageId: string
  startTime: number
  endTime?: number
  steps: TraceStep[]
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    estimatedCost: number
    llmCalls: number
    toolCalls: number
    modelsUsed: string[]
  }
}

// ═══════════════════════════════════════════════════════════
//  Agent 核心
// ═══════════════════════════════════════════════════════════

export interface AgentConfig {
  /** 默认 LLM 模型 key (baseURL::model) */
  defaultModel: string
  /** 规划用模型 */
  planningModel: string
  /** 快速任务用模型 */
  fastModel: string
  /** 最大上下文 Token 数 */
  maxTokens: number
  /** 输出预留 Token */
  outputReserve: number
  /** 最近 N 条消息始终保留 */
  recentMessageWindow: number
  /** 压缩阈值 */
  compressionThreshold: number
  /** 最多检索记忆条数 */
  maxMemoriesRetrieved: number
  /** 最多加载技能数 */
  maxSkillsLoaded: number
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  defaultModel: '',
  planningModel: '',
  fastModel: '',
  maxTokens: 32000,
  outputReserve: 4000,
  recentMessageWindow: 10,
  compressionThreshold: 16000,
  maxMemoriesRetrieved: 5,
  maxSkillsLoaded: 3
}

// ═══════════════════════════════════════════════════════════
//  LLM Provider
// ═══════════════════════════════════════════════════════════

export interface LLMProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: string[]
  /** 是否默认启用 */
  enabled: boolean
}

export interface ChatMessageLLM {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessageLLM[]
  modelKey?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

// ═══════════════════════════════════════════════════════════
//  IPC 通道定义
// ═══════════════════════════════════════════════════════════

export const IPC_CHANNELS = {
  // Pet → Main
  PET_CLICK: 'pet:click',
  PET_DRAG: 'pet:drag',
  PET_DRAG_START: 'pet:drag-start',
  PET_DRAG_END: 'pet:drag-end',
  PET_RIGHT_CLICK: 'pet:right-click',
  PET_BUBBLE_ACTION: 'pet:bubble-action',

  // Main → Pet
  PET_STATE_CHANGE: 'pet:state-change',
  PET_SHOW_BUBBLE: 'pet:show-bubble',
  PET_HIDE_BUBBLE: 'pet:hide-bubble',

  // Chat → Main
  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  CHAT_LOAD_HISTORY: 'chat:load-history',
  CHAT_NEW_SESSION: 'chat:new-session',
  CHAT_APPROVE_PLAN: 'chat:approve-plan',
  CHAT_APPROVE_TOOL: 'chat:approve-tool',
  CHAT_NEW_SESSION_NOTIFY: 'chat:new-session-notify',
  CHAT_LIST_SESSIONS: 'chat:list-sessions',
  CHAT_DELETE_SESSION: 'chat:delete-session',
  CHAT_LOAD_SESSION: 'chat:load-session',
  CHAT_TRANSCRIBE: 'chat:transcribe',
  CHAT_GET_SUGGESTIONS: 'chat:get-suggestions',

  // Main → Chat
  CHAT_RESPONSE_CHUNK: 'chat:response-chunk',
  CHAT_RESPONSE_DONE: 'chat:response-done',
  CHAT_RESPONSE_ERROR: 'chat:response-error',
  CHAT_TRACE_STEP: 'chat:trace-step',
  CHAT_TRACE_COMPLETE: 'chat:trace-complete',
  CHAT_PLAN_PROPOSED: 'chat:plan-proposed',
  CHAT_TOOL_APPROVAL: 'chat:tool-approval',

  // System
  SYS_GET_CONFIG: 'sys:get-config',
  SYS_SET_CONFIG: 'sys:set-config',
  SYS_GET_PROVIDERS: 'sys:get-providers',
  SYS_SET_PROVIDERS: 'sys:set-providers',
  SYS_OPEN_PANEL: 'sys:open-panel',
  SYS_FETCH_MODELS: 'sys:fetch-models',
  SYS_TEST_CONNECTION: 'sys:test-connection',

  // Shortcuts (T-016)
  SYS_GET_SHORTCUTS: 'sys:get-shortcuts',
  SYS_SET_SHORTCUTS: 'sys:set-shortcuts',

  // Theme (T-018)
  SYS_GET_THEME: 'sys:get-theme',
  SYS_SET_THEME: 'sys:set-theme',
  SYS_THEME_CHANGE: 'sys:theme-change',

  // Feedback & Prompt Optimization (T-008)
  FEEDBACK_RECORD: 'feedback:record',
  PROMPT_GET_VERSIONS: 'prompt:get-versions',
  PROMPT_ROLLBACK: 'prompt:rollback',
  PROMPT_OPTIMIZE: 'prompt:optimize',
  PROMPT_GET_CURRENT: 'prompt:get-current',
  PROMPT_SET_AB_TEST: 'prompt:set-ab-test',
  PROMPT_CONCLUDE_AB_TEST: 'prompt:conclude-ab-test',

  // Skills Management (T-009)
  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
  SKILL_CREATE: 'skill:create',
  SKILL_UPDATE: 'skill:update',
  SKILL_DELETE: 'skill:delete',

  // Memory Management (T-010)
  MEMORY_LIST: 'memory:list',
  MEMORY_SEARCH: 'memory:search',
  MEMORY_GET: 'memory:get',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_CREATE: 'memory:create',
  MEMORY_STATS: 'memory:stats',

  // Tool Management (T-012)
  TOOL_LIST: 'tool:list',
  TOOL_EXECUTE: 'tool:execute',

  // Data Export/Import (T-023)
  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',
  DATA_EXPORT_SESSIONS: 'data:export-sessions',

  // Offline Mode / Ollama (T-024)
  OLLAMA_STATUS: 'ollama:status',
  OLLAMA_LIST_MODELS: 'ollama:list-models',
  OLLAMA_PULL_MODEL: 'ollama:pull-model',
  OLLAMA_DELETE_MODEL: 'ollama:delete-model',
  OLLAMA_SET_ENABLED: 'ollama:set-enabled',

  // Plugin Management (T-022)
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_INSTALL: 'plugin:install',
  PLUGIN_UNINSTALL: 'plugin:uninstall',
  PLUGIN_TOGGLE: 'plugin:toggle',
  PLUGIN_GET: 'plugin:get',

  // MCP Server Management
  MCP_LIST: 'mcp:list',
  MCP_ADD: 'mcp:add',
  MCP_UPDATE: 'mcp:update',
  MCP_DELETE: 'mcp:delete',
  MCP_TOGGLE: 'mcp:toggle',
  MCP_TEST: 'mcp:test',

  // Data Paths & Zoom
  SYS_GET_DATA_PATHS: 'sys:get-data-paths',
  SYS_OPEN_IN_FOLDER: 'sys:open-in-folder',
  SYS_GET_ZOOM: 'sys:get-zoom',
  SYS_SET_ZOOM: 'sys:set-zoom',

  // Search Config (T-025)
  SEARCH_GET_CONFIG: 'search:get-config',
  SEARCH_SET_CONFIG: 'search:set-config',
  SEARCH_TEST: 'search:test',

  // Browser Config
  BROWSER_GET_CONFIG: 'browser:get-config',
  BROWSER_SET_CONFIG: 'browser:set-config',
  BROWSER_SELECT_DIR: 'browser:select-dir',
  BROWSER_DETECT_USER_DATA_DIR: 'browser:detect-user-data-dir'
} as const

// ═══════════════════════════════════════════════════════════
//  搜索配置
// ═══════════════════════════════════════════════════════════

/** 搜索引擎类型 */
export type SearchEngine = 'baidu' | 'sogou' | 'bing' | 'searxng'

/** 搜索配置 */
export interface SearchConfig {
  /** 主搜索引擎 */
  engine: SearchEngine
  /** 备用搜索引擎（主引擎结果不足时尝试） */
  fallbackEngine: SearchEngine | 'none'
  /** SearXNG 实例 URL（当 engine 为 searxng 时使用） */
  searxngUrl: string
  /** 最大搜索结果数 */
  maxResults: number
  /** 是否抓取网页内容 */
  fetchContent: boolean
  /** 搜索超时（毫秒） */
  timeoutMs: number
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  engine: 'baidu',
  fallbackEngine: 'sogou',
  searxngUrl: '',
  maxResults: 5,
  fetchContent: true,
  timeoutMs: 30000
}

// ═══════════════════════════════════════════════════════════
//  浏览器自动化配置
// ═══════════════════════════════════════════════════════════

export type BrowserUserDataMode = 'temporary' | 'app-dedicated' | 'custom'

export interface BrowserConfig {
  /** 用户数据目录模式 */
  userDataMode: BrowserUserDataMode
  /** Chrome 可执行文件路径（留空则自动检测系统 Chrome） */
  executablePath: string
  /** 
   * 自定义用户数据目录路径（仅在 userDataMode='custom' 时使用）。
   * 设置为 Chrome 默认目录（如 C:\Users\xxx\AppData\Local\Google\Chrome\User Data）: 加载用户登录态
   * 注意: 如果 Chrome 已在运行且使用同一目录，需要先关闭 Chrome 或使用不同的 profile
   */
  userDataDir: string
  /** Profile 目录名（在 userDataDir 下的子目录，如 "Default", "Profile 1"） */
  profile: string
  /** 是否无头模式（默认 false，有头模式可以看到浏览器窗口） */
  headless: boolean
  /** 窗口宽度 */
  width: number
  /** 窗口高度 */
  height: number
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  userDataMode: 'app-dedicated',
  executablePath: '',
  userDataDir: '',
  profile: 'Default',
  headless: false,
  width: 1280,
  height: 800
}

// ═══════════════════════════════════════════════════════════
//  会话
// ═══════════════════════════════════════════════════════════

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

// ═══════════════════════════════════════════════════════════
//  技能
// ═══════════════════════════════════════════════════════════

export interface Skill {
  id: string
  name: string
  description: string
  content: string
  autoGenerated: boolean
  confidence: number
  status: 'active' | 'draft' | 'disabled' | 'rejected'
  executionCount: number
  successRate: number
  createdAt: number
  updatedAt: number
}

// ═══════════════════════════════════════════════════════════
//  记忆面板展示类型
// ═══════════════════════════════════════════════════════════

export interface MemoryItem {
  id: string
  type: 'episodic' | 'semantic'
  memType?: string
  content: string
  sessionId?: string
  userIntent?: string
  actions?: string[]
  outcome?: string
  successScore?: number
  modelUsed?: string
  skillsUsed?: string[]
  tags?: string[]
  source?: string
  confidence?: number
  importance: number
  createdAt: number
  lastAccessedAt?: number
  accessCount: number
}

// ═══════════════════════════════════════════════════════════
//  图片附件 (T-021)
// ═══════════════════════════════════════════════════════════

export interface ImageAttachment {
  id: string
  /** base64 编码的图片数据（不含 data: 前缀） */
  data: string
  /** MIME 类型，如 image/png, image/jpeg */
  mimeType: string
  /** 图片宽度 */
  width: number
  /** 图片高度 */
  height: number
  /** 文件大小（字节） */
  size: number
  /** 缩略图 base64（用于预览） */
  thumbnail?: string
}

// ═══════════════════════════════════════════════════════════
//  插件系统 (T-022)
// ═══════════════════════════════════════════════════════════

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  /** 插件入口函数名称 */
  entry: string
  /** 插件权限 */
  permissions: PluginPermission[]
  /** 是否启用 */
  enabled: boolean
  /** 安装时间 */
  installedAt: number
  /** 配置项 */
  config?: Record<string, unknown>
}

export type PluginPermission =
  | 'tool:register'
  | 'memory:read'
  | 'memory:write'
  | 'llm:call'
  | 'ui:render'
  | 'storage:read'
  | 'storage:write'

export interface PluginInfo {
  manifest: PluginManifest
  /** 插件状态 */
  status: 'active' | 'inactive' | 'error'
  /** 错误信息 */
  error?: string
  /** 插件提供的工具列表 */
  tools?: string[]
  /** 插件提供的 UI 组件列表 */
  uiComponents?: string[]
}

// ═══════════════════════════════════════════════════════════
//  数据导出/导入 (T-023)
// ═══════════════════════════════════════════════════════════

export interface ExportOptions {
  /** 导出格式 */
  format: 'json' | 'markdown'
  /** 导出范围 */
  scope: 'all' | 'sessions' | 'memories'
  /** 指定会话 ID（scope 为 sessions 时使用） */
  sessionIds?: string[]
  /** 开始时间 */
  startTime?: number
  /** 结束时间 */
  endTime?: number
}

export interface ExportResult {
  success: boolean
  /** 导出文件路径 */
  filePath?: string
  /** 导出数据内容（用于预览） */
  content?: string
  /** 导出的记录数 */
  count: number
  error?: string
}

export interface ImportResult {
  success: boolean
  /** 导入的会话数 */
  sessionsImported: number
  /** 导入的消息数 */
  messagesImported: number
  /** 导入的记忆数 */
  memoriesImported: number
  error?: string
}

// ═══════════════════════════════════════════════════════════
//  离线模式 / Ollama (T-024)
// ═══════════════════════════════════════════════════════════

export interface OllamaModel {
  name: string
  size: number
  digest: string
  modifiedAt: string
  /** 模型参数量（如 7B, 13B） */
  parameterSize?: string
  /** 量化级别 */
  quantizationLevel?: string
}

export interface OllamaStatus {
  /** Ollama 是否在线 */
  online: boolean
  /** Ollama 服务地址 */
  host: string
  /** 是否启用离线模式 */
  offlineMode: boolean
  /** 已安装的模型列表 */
  models: OllamaModel[]
  /** 当前使用的模型 */
  currentModel?: string
}

export interface OllamaPullProgress {
  model: string
  status: 'pulling' | 'success' | 'error'
  /** 进度百分比 0-100 */
  percent?: number
  /** 已下载大小（字节） */
  downloaded?: number
  /** 总大小（字节） */
  total?: number
  /** 状态消息 */
  message?: string
}

// ═══════════════════════════════════════════════════════════
//  MCP 服务器配置
// ═══════════════════════════════════════════════════════════

export interface MCPServerConfig {
  id: string
  /** 服务器名称 */
  name: string
  /** 传输方式 */
  transport: 'stdio' | 'sse' | 'streamable-http'
  /** SSE/HTTP 模式下的服务器 URL */
  url?: string
  /** stdio 模式下的命令 */
  command?: string
  /** stdio 模式下的参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** 是否启用 */
  enabled: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

export interface MCPTestResult {
  success: boolean
  message: string
  /** 服务器提供的工具列表 */
  tools?: string[]
}

// ═══════════════════════════════════════════════════════════
//  数据路径信息
// ═══════════════════════════════════════════════════════════

export interface DataPaths {
  /** 配置文件路径 (config.json) */
  configFile: string
  /** 数据库文件路径 */
  databaseFile: string
  /** 数据目录 (userData) */
  dataDir: string
  /** 技能存储目录 */
  skillsDir: string
  /** 插件目录 */
  pluginsDir: string
  /** 日志目录 */
  logsDir: string
}
