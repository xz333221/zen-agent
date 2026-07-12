import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, ChatMessage, ExecutionTrace, TraceStep, ImageAttachment } from '@shared/types'

const chatAPI = {
  /** 发送消息 */
  send: (message: string, images?: ImageAttachment[]) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, message, images),

  /** 停止生成 */
  stop: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_STOP),

  /** 新建会话 */
  newSession: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_NEW_SESSION),

  /** 加载历史消息 */
  loadHistory: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_LOAD_HISTORY, sessionId),

  /** 获取所有会话列表 */
  listSessions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_SESSIONS),

  /** 删除会话 */
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_SESSION, sessionId),

  /** 加载指定会话 */
  loadSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_LOAD_SESSION, sessionId),

  /** 语音转文字（通过主进程调用 Whisper API） */
  transcribe: (audioBase64: string, mimeType: string, language?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_TRANSCRIBE, audioBase64, mimeType, language),

  /** 获取基于历史记录的推荐问题 */
  getSuggestions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_SUGGESTIONS) as Promise<string[]>,

  /** 获取系统配置 */
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_CONFIG),

  /** 保存系统配置 */
  setConfig: (config: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_CONFIG, config),

  /** 获取 Provider 列表 */
  getProviders: () => ipcRenderer.invoke(IPC_CHANNELS.SYS_GET_PROVIDERS),

  /** 保存 Provider 列表 */
  setProviders: (providers: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SYS_SET_PROVIDERS, providers),

  /** 打开面板（设置、技能、记忆） */
  openPanel: (panelName: string) => ipcRenderer.invoke(IPC_CHANNELS.SYS_OPEN_PANEL, panelName),

  /** 审批执行计划 */
  approvePlan: (planId: string, approved: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_APPROVE_PLAN, planId, approved),

  /** 审批工具调用 */
  approveTool: (toolCallId: string, approved: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_APPROVE_TOOL, toolCallId, approved),

  // ── 反馈 & Prompt 优化 (T-008) ──

  /** 记录用户反馈（显式 👍/👎 或隐式 copy/edit/ignore） */
  recordFeedback: (data: {
    feedbackType: 'positive' | 'negative' | 'neutral'
    messageId?: string
    sessionId?: string
    userQuery?: string
    agentResponse?: string
    comment?: string
    implicitAction?: 'copy' | 'edit' | 'ignore'
  }) => ipcRenderer.invoke(IPC_CHANNELS.FEEDBACK_RECORD, data),

  /** 获取当前 Prompt 版本 */
  getCurrentPrompt: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_GET_CURRENT),

  /** 获取所有 Prompt 版本 */
  getPromptVersions: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_GET_VERSIONS),

  /** 手动触发 Prompt 优化 */
  optimizePrompt: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_OPTIMIZE),

  /** 回滚到上一个 Prompt 版本 */
  rollbackPrompt: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_ROLLBACK),

  /** 设置 A/B 测试 */
  setABTest: (config: { enabled: boolean; variantRatio?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROMPT_SET_AB_TEST, config),

  /** 结束 A/B 测试 */
  concludeABTest: () => ipcRenderer.invoke(IPC_CHANNELS.PROMPT_CONCLUDE_AB_TEST),

  // ── 工具管理 (T-012) ──

  /** 获取所有已注册工具 */
  getTools: () => ipcRenderer.invoke(IPC_CHANNELS.TOOL_LIST),

  /** 直接执行工具 */
  executeTool: (toolId: string, params: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.TOOL_EXECUTE, toolId, params),

  // ── 数据导出/导入 (T-023) ──

  /** 导出数据 */
  exportData: (options: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DATA_EXPORT, options),

  /** 导入数据 */
  importData: (filePath?: string) => ipcRenderer.invoke(IPC_CHANNELS.DATA_IMPORT, filePath),

  /** 导出指定会话 */
  exportSessions: (sessionIds: string[], format: 'json' | 'markdown') =>
    ipcRenderer.invoke(IPC_CHANNELS.DATA_EXPORT_SESSIONS, sessionIds, format),

  // ── 事件监听 ──

  /** 监听流式响应 */
  onResponseChunk: (callback: (data: { delta: string; messageId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { delta: string; messageId: string }) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_RESPONSE_CHUNK, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_RESPONSE_CHUNK, handler)
  },

  /** 监听响应完成 */
  onResponseDone: (callback: (data: { messageId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { messageId: string }) => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_RESPONSE_DONE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_RESPONSE_DONE, handler)
  },

  /** 监听响应错误 */
  onResponseError: (callback: (error: { message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { message: string }) => callback(error)
    ipcRenderer.on(IPC_CHANNELS.CHAT_RESPONSE_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_RESPONSE_ERROR, handler)
  },

  /** 监听执行追踪步骤更新 */
  onTraceStep: (callback: (step: TraceStep) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, step: TraceStep) => callback(step)
    ipcRenderer.on(IPC_CHANNELS.CHAT_TRACE_STEP, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_TRACE_STEP, handler)
  },

  /** 监听执行追踪完成 */
  onTraceComplete: (callback: (trace: ExecutionTrace) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, trace: ExecutionTrace) => callback(trace)
    ipcRenderer.on(IPC_CHANNELS.CHAT_TRACE_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_TRACE_COMPLETE, handler)
  },

  /** 关闭窗口 */
  close: () => ipcRenderer.invoke('chat:close'),

  /** 监听新建会话通知（来自托盘/右键菜单） */
  onNewSessionNotify: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC_CHANNELS.CHAT_NEW_SESSION_NOTIFY, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_NEW_SESSION_NOTIFY, handler)
  },

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
  }
}

contextBridge.exposeInMainWorld('chatAPI', chatAPI)

export type ChatAPI = typeof chatAPI
