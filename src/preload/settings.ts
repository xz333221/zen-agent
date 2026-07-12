import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type LLMProviderConfig, type Skill, type MCPServerConfig, type MCPTestResult, type DataPaths, type SearchConfig, type BrowserConfig } from '@shared/types'

const settingsAPI = {
  /** 获取配置 */
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_CONFIG),

  /** 保存配置 */
  setConfig: (config: {
    providers?: LLMProviderConfig[]
    defaultModel?: string
    embeddingModel?: string
    agent?: { maxTokens?: number; outputReserve?: number }
    mcpServers?: MCPServerConfig[]
  }) => ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_CONFIG, config),

  /** 获取 Provider 列表 */
  getProviders: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_PROVIDERS),

  /** 保存 Provider 列表 */
  setProviders: (providers: LLMProviderConfig[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_PROVIDERS, providers),

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('settings:close'),

  /** 获取快捷键配置 */
  getShortcuts: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_SHORTCUTS),

  /** 保存快捷键配置 */
  setShortcuts: (shortcuts: Record<string, string>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_SHORTCUTS, shortcuts),

  /** 获取主题模式 */
  getTheme: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_THEME),

  /** 设置主题模式 */
  setTheme: (mode: 'light' | 'dark' | 'system') =>
    ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_THEME, mode),

  /** 监听主题变化 */
  onThemeChange: (callback: (data: { mode: string; effective: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { mode: string; effective: string }) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SYS_THEME_CHANGE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SYS_THEME_CHANGE, handler)
  },

  // ── 数据导出/导入 (T-023) ──

  /** 导出数据 */
  exportData: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DATA_EXPORT, options),

  /** 导入数据 */
  importData: (filePath?: string) => ipcRenderer.invoke(IPC_CHANNELS.DATA_IMPORT, filePath),

  // ── 离线模式 / Ollama (T-024) ──

  /** 获取 Ollama 状态 */
  getOllamaStatus: () => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_STATUS),

  /** 获取已安装的模型列表 */
  getOllamaModels: () => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_LIST_MODELS),

  /** 拉取模型 */
  pullOllamaModel: (modelName: string) => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_PULL_MODEL, modelName),

  /** 删除模型 */
  deleteOllamaModel: (modelName: string) => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_DELETE_MODEL, modelName),

  /** 启用/禁用离线模式 */
  setOllamaEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_SET_ENABLED, enabled),

  /** 拉取模型列表（通过主进程避免 CORS） */
  fetchModels: (baseURL: string, apiKey: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYS_FETCH_MODELS, baseURL, apiKey),

  /** 测试连接（通过主进程避免 CORS） */
  testConnection: (baseURL: string, apiKey: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYS_TEST_CONNECTION, baseURL, apiKey),

  // ── 技能管理 ──

  /** 获取所有技能 */
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),

  /** 创建技能 */
  createSkill: (skill: {
    name: string
    description: string
    content: string
    status?: Skill['status']
  }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_CREATE, skill),

  /** 更新技能 */
  updateSkill: (id: string, updates: {
    name?: string
    description?: string
    content?: string
    status?: Skill['status']
  }) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_UPDATE, id, updates),

  /** 删除技能 */
  deleteSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, id),

  // ── MCP 服务器管理 ──

  /** 获取所有 MCP 服务器 */
  listMCPServers: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST),

  /** 添加 MCP 服务器 */
  addMCPServer: (server: Omit<MCPServerConfig, 'id' | 'createdAt' | 'updatedAt'>) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD, server),

  /** 更新 MCP 服务器 */
  updateMCPServer: (id: string, updates: Partial<MCPServerConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE, id, updates),

  /** 删除 MCP 服务器 */
  deleteMCPServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_DELETE, id),

  /** 启用/禁用 MCP 服务器 */
  toggleMCPServer: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_TOGGLE, id, enabled),

  /** 测试 MCP 服务器连接 */
  testMCPServer: (server: MCPServerConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST, server),

  // ── 数据路径 & 缩放 ──

  /** 获取数据文件路径 */
  getDataPaths: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_DATA_PATHS) as Promise<DataPaths>,

  /** 在文件管理器中打开路径 */
  openInFolder: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.SYS_OPEN_IN_FOLDER, path),

  /** 获取缩放比例 */
  getZoom: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_ZOOM) as Promise<number>,

  /** 设置缩放比例 */
  setZoom: (zoom: number) => ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_ZOOM, zoom),

  // ── 搜索配置 (T-025) ──

  /** 获取搜索配置 */
  getSearchConfig: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_CONFIG) as Promise<SearchConfig>,

  /** 保存搜索配置 */
  setSearchConfig: (config: Partial<SearchConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SET_CONFIG, config),

  /** 测试搜索 */
  testSearch: (query: string, config: SearchConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_TEST, { query, config }) as Promise<{
      success: boolean
      results?: Array<{ title: string; url: string; snippet: string; content?: string }>
      error?: string
    }>,

  // ── 浏览器配置 ──

  /** 获取浏览器配置 */
  getBrowserConfig: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_CONFIG) as Promise<BrowserConfig>,

  /** 保存浏览器配置 */
  setBrowserConfig: (config: Partial<BrowserConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_CONFIG, config),

  /** 选择目录（弹出系统对话框） */
  selectBrowserDir: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SELECT_DIR) as Promise<{
    success: boolean
    path?: string
    canceled?: boolean
    error?: string
  }>,

  /** 自动检测系统 Chrome 用户数据目录 */
  detectBrowserUserDataDir: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_DETECT_USER_DATA_DIR) as Promise<{
    success: boolean
    path?: string
    browser?: string
    profiles?: string[]
    error?: string
  }>
}

contextBridge.exposeInMainWorld('settingsAPI', settingsAPI)

export type SettingsAPI = typeof settingsAPI
