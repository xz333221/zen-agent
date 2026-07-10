/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// ── Window API 类型声明（由 preload 注入）──

interface PetAPI {
  onClick: () => void
  onDrag: (deltaX: number, deltaY: number) => void
  onRightClick: () => void
  onBubbleAction: (actionId: string) => Promise<unknown>
  onStateChange: (callback: (data: import('./src/shared/types').PetStateData) => void) => () => void
  onShowBubble: (callback: (bubble: import('./src/shared/types').PetStateData['bubble']) => void) => () => void
}

interface ChatAPI {
  send: (message: string, images?: import('./src/shared/types').ImageAttachment[]) => Promise<unknown>
  stop: () => Promise<unknown>
  newSession: () => Promise<{ sessionId: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>
  loadHistory: (sessionId: string) => Promise<{ messages: import('./src/shared/types').ChatMessage[]; sessionId: string }>
  listSessions: () => Promise<any[]>
  deleteSession: (sessionId: string) => Promise<{ success: boolean }>
  loadSession: (sessionId: string) => Promise<{ session: any; messages: import('./src/shared/types').ChatMessage[] }>
  transcribe: (audioBase64: string, mimeType: string, language?: string) => Promise<{ success: boolean; text?: string; error?: string }>
  approvePlan: (planId: string, approved: boolean) => Promise<unknown>
  approveTool: (toolCallId: string, approved: boolean) => Promise<unknown>
  onResponseChunk: (callback: (data: { delta: string; messageId: string }) => void) => () => void
  onResponseDone: (callback: (data: { messageId: string }) => void) => () => void
  onResponseError: (callback: (error: { message: string }) => void) => () => void
  onTraceStep: (callback: (step: import('./src/shared/types').TraceStep) => void) => () => void
  onTraceComplete: (callback: (trace: import('./src/shared/types').ExecutionTrace) => void) => () => void
  onNewSessionNotify: (callback: () => void) => () => void
  getConfig: () => Promise<any>
  setConfig: (config: unknown) => Promise<unknown>
  getProviders: () => Promise<unknown>
  setProviders: (providers: unknown) => Promise<unknown>
  openPanel: (panelName: string) => Promise<unknown>
  recordFeedback: (data: any) => Promise<unknown>
  getCurrentPrompt: () => Promise<unknown>
  getPromptVersions: () => Promise<unknown>
  optimizePrompt: () => Promise<unknown>
  rollbackPrompt: () => Promise<unknown>
  setABTest: (config: any) => Promise<unknown>
  concludeABTest: () => Promise<unknown>
  getTools: () => Promise<unknown>
  executeTool: (toolId: string, params: Record<string, unknown>) => Promise<unknown>
  exportData: (options: unknown) => Promise<unknown>
  importData: (filePath?: string) => Promise<unknown>
  exportSessions: (sessionIds: string[], format: 'json' | 'markdown') => Promise<unknown>
  getTheme: () => Promise<{ mode: string; effective: string }>
  setTheme: (mode: 'light' | 'dark' | 'system') => Promise<{ success: boolean; mode: string; effective: string }>
  onThemeChange: (callback: (data: { mode: string; effective: string }) => void) => () => void
  close: () => Promise<unknown>
}

interface SettingsAPI {
  getConfig: () => Promise<any>
  setConfig: (config: {
    providers?: import('./src/shared/types').LLMProviderConfig[]
    defaultModel?: string
    embeddingModel?: string
    agent?: { maxTokens?: number; outputReserve?: number }
    mcpServers?: import('./src/shared/types').MCPServerConfig[]
  }) => Promise<unknown>
  getProviders: () => Promise<unknown>
  setProviders: (providers: import('./src/shared/types').LLMProviderConfig[]) => Promise<unknown>
  close: () => Promise<unknown>
  getShortcuts: () => Promise<Record<string, string>>
  setShortcuts: (shortcuts: Record<string, string>) => Promise<unknown>
  getTheme: () => Promise<{ mode: string; effective: string }>
  setTheme: (mode: 'light' | 'dark' | 'system') => Promise<{ success: boolean; mode: string; effective: string }>
  onThemeChange: (callback: (data: { mode: string; effective: string }) => void) => () => void
  exportData: (options: unknown) => Promise<unknown>
  importData: (filePath?: string) => Promise<unknown>
  getOllamaStatus: () => Promise<any>
  getOllamaModels: () => Promise<any[]>
  pullOllamaModel: (modelName: string) => Promise<any>
  deleteOllamaModel: (modelName: string) => Promise<any>
  setOllamaEnabled: (enabled: boolean) => Promise<any>
  fetchModels: (baseURL: string, apiKey: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
  testConnection: (baseURL: string, apiKey: string) => Promise<{ success: boolean; message: string }>
  listSkills: () => Promise<import('./src/shared/types').Skill[]>
  createSkill: (skill: { name: string; description: string; content: string; status?: import('./src/shared/types').Skill['status'] }) => Promise<unknown>
  updateSkill: (id: string, updates: { name?: string; description?: string; content?: string; status?: import('./src/shared/types').Skill['status'] }) => Promise<unknown>
  deleteSkill: (id: string) => Promise<unknown>
  listMCPServers: () => Promise<import('./src/shared/types').MCPServerConfig[]>
  addMCPServer: (server: Omit<import('./src/shared/types').MCPServerConfig, 'id' | 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; server?: import('./src/shared/types').MCPServerConfig }>
  updateMCPServer: (id: string, updates: Partial<import('./src/shared/types').MCPServerConfig>) => Promise<{ success: boolean }>
  deleteMCPServer: (id: string) => Promise<{ success: boolean }>
  toggleMCPServer: (id: string, enabled: boolean) => Promise<{ success: boolean }>
  testMCPServer: (server: import('./src/shared/types').MCPServerConfig) => Promise<import('./src/shared/types').MCPTestResult>
}

interface SkillsAPI {
  list: () => Promise<import('./src/shared/types').Skill[]>
  get: (id: string) => Promise<unknown>
  create: (skill: { name: string; description: string; content: string; status?: import('./src/shared/types').Skill['status'] }) => Promise<unknown>
  update: (id: string, updates: { name?: string; description?: string; content?: string; status?: import('./src/shared/types').Skill['status'] }) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
  close: () => Promise<unknown>
}

interface Window {
  petAPI: PetAPI
  chatAPI: ChatAPI
  settingsAPI: SettingsAPI
  skillsAPI: SkillsAPI
}
