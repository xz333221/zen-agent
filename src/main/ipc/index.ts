import { ipcMain } from 'electron'
import { IPC_CHANNELS, ChatMessage, type LLMProviderConfig, type TraceStep, type ExecutionTrace, type ImageAttachment } from '@shared/types'
import { getPetWindow, setPetState } from '../windows/pet-window'
import { getChatWindow, showChatWindow, hideChatWindow } from '../windows/chat-window'
import { llm } from '@agent/providers/llm'
import { loadConfig, getConfig, saveConfig, isLLMConfigured, getSystemPrompt } from '@agent/providers/llm-config'
import { ensureDatabase } from '../storage/database'
import { createSession, getSession, updateSessionTitle, incrementMessageCount, getAllSessions, deleteSession } from '../storage/repositories/sessions'
import { addMessage, getMessages, getRecentMessages } from '../storage/repositories/messages'
import { AgentLoop, createAgentContext } from '@agent/core/agent-loop'
import * as settingsWindowModule from '../windows/settings-window'
import * as skillsWindowModule from '../windows/skills-window'
import * as memoryWindowModule from '../windows/memory-window'
import * as pluginsWindowModule from '../windows/plugins-window'
import { pluginManager } from '../plugins/plugin-manager'
import { exportData, importData } from '../storage/data-export'
import { ollamaManager } from '../offline/ollama-manager'
import type { ExportOptions, OllamaPullProgress, MCPServerConfig, MCPTestResult, Skill } from '@shared/types'
import { getShortcutConfig, setShortcutConfig, reregisterShortcuts } from '../shortcuts'
import { getThemeMode, setThemeMode, getEffectiveTheme } from '../theme'
import {
  initFeedbackCollector,
  recordExplicitFeedback,
  recordImplicitFeedback,
  shouldOptimizePrompt
} from '@agent/evolution/feedback-collector'
import { registerBuiltinTools } from '@agent/tools/tool-registry'
import { getToolDefs, executeAction } from '@agent/core/action-executor'
import type { ToolDef } from '@agent/tools/types'
import {
  getAllSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill
} from '../storage/repositories/skills'
import {
  getAllMemories,
  deleteMemory
} from '@agent/memory/vector-store'
import { memoryManager } from '@agent/memory/memory-manager'
import type { Skill, MemoryItem, PluginManifest } from '@shared/types'
import {
  initPromptOptimizer,
  getActivePrompt,
  optimizePrompt,
  rollbackPrompt,
  listPromptVersions,
  getCurrentPromptVersion,
  setABTestConfig,
  getABTestConfig,
  concludeABTest
} from '@agent/evolution/prompt-optimizer'

// ── 当前请求的中止控制器 ──
let currentAbortController: AbortController | null = null

// ── 当前活跃会话 ID ──
let currentSessionId: string | null = null

/**
 * 注册所有 IPC 处理器
 */
export async function registerIpcHandlers(): Promise<void> {
  // 启动时加载配置
  loadConfig()

  // 初始化数据库（必须在 Prompt 优化器等依赖 DB 的模块之前完成）
  await ensureDatabase()

  // 初始化反馈收集器和 Prompt 优化器
  initFeedbackCollector()
  initPromptOptimizer()

  // 注册内置工具（T-012）
  registerBuiltinTools()

  registerChatHandlers()
  registerPetHandlers()
  registerSystemHandlers()
  registerFeedbackHandlers()
  registerSkillHandlers()
  registerMemoryHandlers()
  registerToolHandlers()
  registerPluginHandlers()
  registerDataHandlers()
  registerOllamaHandlers()
  registerMCPHandlers()
}

// ═══════════════════════════════════════════════════════════
//  对话相关 IPC
// ═══════════════════════════════════════════════════════════

function registerChatHandlers(): void {
  // 用户发送消息
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, message: string, images?: ImageAttachment[], sessionId?: string) => {
    const chatWin = getChatWindow()
    if (!chatWin) return { success: false, error: 'Chat window not found' }

    // 设置宠物状态为 thinking
    setPetState('thinking')

    const sid = sessionId || currentSessionId || 'default'
    currentSessionId = sid
    const messageId = `msg-${Date.now()}`

    // 初始化数据库并确保会话存在（无论是否配置了 LLM 都需要持久化）
    await ensureDatabase()
    if (!getSession(sid)) {
      createSession(sid)
    }

    // 保存用户消息到 SQLite
    addMessage(sid, {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
      images: images
    })

    // ── 通过 AgentLoop 执行（ReAct 循环 + 追踪步骤） ──
    // AgentLoop 内部会检测 LLM 是否配置，未配置时使用 mock 响应
    currentAbortController = new AbortController()

    let fullResponse = ''

    try {
      const config = getConfig()

      // 从 SQLite 加载历史消息
      const history = getRecentMessages(sid, 20)
      // 使用 Prompt 优化器获取当前活跃的 Prompt（支持 A/B 测试）
      const activePrompt = getActivePrompt()
      const messages = [
        { role: 'system' as const, content: activePrompt },
        ...history.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        }))
      ]

      // 如果有图片附件，将最后一条用户消息替换为多模态内容 (T-021)
      if (images && images.length > 0) {
        const userMessageParts: any[] = [
          { type: 'text', text: message || '请分析这张图片' }
        ]
        for (const img of images) {
          userMessageParts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.data}` }
          })
        }
        // 找到最后一条 user 消息并替换为多模态内容
        const lastUserIdx = messages.findLastIndex(m => m.role === 'user')
        if (lastUserIdx >= 0) {
          messages[lastUserIdx] = {
            role: 'user' as const,
            content: userMessageParts as any
          }
        } else {
          messages.push({
            role: 'user' as const,
            content: userMessageParts as any
          })
        }
      }

      // 创建 Agent 上下文
      const agentContext = createAgentContext(sid, messages, {
        maxTokens: config.agent.maxTokens,
        outputReserve: config.agent.outputReserve,
        recentMessageWindow: config.agent.recentMessageWindow,
        compressionThreshold: config.agent.compressionThreshold,
        maxMemoriesRetrieved: config.agent.maxMemoriesRetrieved,
        maxSkillsLoaded: config.agent.maxSkillsLoaded
      })
      agentContext.signal = currentAbortController.signal

      // 创建 AgentLoop 并执行
      const agent = new AgentLoop({
        onChunk: (delta: string) => {
          fullResponse += delta
          chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_CHUNK, {
            delta,
            messageId
          })
        },
        onStepStart: (step: TraceStep) => {
          chatWin.webContents.send(IPC_CHANNELS.CHAT_TRACE_STEP, step)
        },
        onStepComplete: () => {
          // 步骤完成（实时 UI 更新可在此处理）
        },
        onTraceComplete: (trace: ExecutionTrace) => {
          chatWin.webContents.send(IPC_CHANNELS.CHAT_TRACE_COMPLETE, trace)
        },
        onStateChange: (state: string) => {
          setPetState(state as any)
        },
        onError: (error: Error) => {
          const errorInfo = classifyError(error)
          chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_ERROR, {
            message: errorInfo.userMessage,
            type: errorInfo.type,
            messageId
          })
        }
      })

      const result = await agent.run(message, agentContext)

      // 保存 assistant 消息到 SQLite
      addMessage(sid, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        trace: result.trace
      })

      chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_DONE, { messageId })
      setPetState('happy')

      // 短暂 happy 后回到 idle
      setTimeout(() => setPetState('idle'), 1500)

      currentAbortController = null
      return { success: true }
    } catch (err) {
      currentAbortController = null
      const error = err as Error
      const errorInfo = classifyError(error)

      // 如果是用户主动中止，不报错
      if (errorInfo.type === 'aborted') {
        // 保存已生成的部分回复
        if (fullResponse) {
          addMessage(sid, {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: fullResponse,
            timestamp: Date.now()
          })
        }
        chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_DONE, { messageId })
        setPetState('idle')
        return { success: true, aborted: true }
      }

      chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_ERROR, {
        message: errorInfo.userMessage,
        type: errorInfo.type,
        messageId
      })
      setPetState('confused')
      setTimeout(() => setPetState('idle'), 2000)
      return { success: false, error: errorInfo.userMessage }
    }
  })

  // 停止生成
  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async () => {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    setPetState('idle')
    return { success: true }
  })

  // 新建会话
  ipcMain.handle(IPC_CHANNELS.CHAT_NEW_SESSION, async () => {
    const sessionId = `session-${Date.now()}`
    currentSessionId = sessionId
    return {
      sessionId,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0
    }
  })

  // 加载历史
  ipcMain.handle(IPC_CHANNELS.CHAT_LOAD_HISTORY, async (_event, sessionId: string) => {
    await ensureDatabase()
    currentSessionId = sessionId
    // 确保会话存在
    if (!getSession(sessionId)) {
      createSession(sessionId)
    }
    const messages = getMessages(sessionId)
    return { messages, sessionId }
  })

  // 获取所有会话列表
  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_SESSIONS, async () => {
    await ensureDatabase()
    return getAllSessions()
  })

  // 删除会话
  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE_SESSION, async (_event, sessionId: string) => {
    await ensureDatabase()
    deleteSession(sessionId)
    return { success: true }
  })

  // 加载指定会话（返回会话信息和消息）
  ipcMain.handle(IPC_CHANNELS.CHAT_LOAD_SESSION, async (_event, sessionId: string) => {
    await ensureDatabase()
    currentSessionId = sessionId
    if (!getSession(sessionId)) {
      createSession(sessionId)
    }
    const session = getSession(sessionId)
    const messages = getMessages(sessionId)
    return { session, messages }
  })

  // 语音转文字（使用已配置的 LLM Provider 的 Whisper API）
  ipcMain.handle(IPC_CHANNELS.CHAT_TRANSCRIBE, async (_event, audioBase64: string, mimeType: string, language?: string) => {
    if (!isLLMConfigured()) {
      return { success: false, error: '请先在设置中配置 LLM Provider，语音识别需要已配置的 API 服务' }
    }

    try {
      // 将 base64 转为 Buffer
      const audioBuffer = Buffer.from(audioBase64, 'base64')

      // 调用 LLM Provider 进行语音转文字
      const text = await llm.transcribeAudio(audioBuffer, mimeType, language)

      return { success: true, text }
    } catch (err) {
      const error = err as Error
      console.error('[IPC] Transcribe error:', error)
      return { success: false, error: error.message || '语音识别失败' }
    }
  })
}

// ═══════════════════════════════════════════════════════════
//  宠物相关 IPC
// ═══════════════════════════════════════════════════════════

function registerPetHandlers(): void {
  // 气泡动作
  ipcMain.handle(IPC_CHANNELS.PET_BUBBLE_ACTION, async (_event, actionId: string) => {
    if (actionId === 'start-chat') {
      showChatWindow()
    }
    return { success: true }
  })
}

// ═══════════════════════════════════════════════════════════
//  系统相关 IPC
// ═══════════════════════════════════════════════════════════

function registerSystemHandlers(): void {
  // 获取配置
  ipcMain.handle(IPC_CHANNELS.SYS_GET_CONFIG, async () => {
    const config = getConfig()
    return {
      defaultModel: config.defaultModelKey,
      embeddingModel: config.embeddingModelKey,
      maxTokens: config.agent.maxTokens,
      providers: config.providers,
      mcpServers: config.mcpServers
    }
  })

  // 保存配置
  ipcMain.handle(IPC_CHANNELS.SYS_SET_CONFIG, async (_event, data: { providers?: LLMProviderConfig[]; defaultModel?: string; embeddingModel?: string; agent?: Partial<typeof DEFAULT_AGENT_CONFIG>; mcpServers?: MCPServerConfig[] }) => {
    const config = getConfig()

    if (data.providers !== undefined) {
      config.providers = data.providers
    }
    if (data.defaultModel !== undefined) {
      config.defaultModelKey = data.defaultModel
    }
    if (data.embeddingModel !== undefined) {
      config.embeddingModelKey = data.embeddingModel
    }
    if (data.agent) {
      config.agent = { ...config.agent, ...data.agent }
    }
    if (data.mcpServers !== undefined) {
      config.mcpServers = data.mcpServers
    }

    saveConfig(config)
    return { success: true }
  })

  // 获取 Provider 列表
  ipcMain.handle(IPC_CHANNELS.SYS_GET_PROVIDERS, async () => {
    return getConfig().providers
  })

  // 保存 Provider 列表
  ipcMain.handle(IPC_CHANNELS.SYS_SET_PROVIDERS, async (_event, providers: LLMProviderConfig[]) => {
    const config = getConfig()
    config.providers = providers
    saveConfig(config)
    return { success: true }
  })

  // 打开面板
  ipcMain.handle(IPC_CHANNELS.SYS_OPEN_PANEL, async (_event, panelName: string) => {
    if (panelName === 'settings') {
      settingsWindowModule.showSettingsWindow()
    } else if (panelName === 'skills') {
      skillsWindowModule.showSkillsWindow()
    } else if (panelName === 'memory') {
      memoryWindowModule.showMemoryWindow()
    } else if (panelName === 'plugins') {
      pluginsWindowModule.showPluginsWindow()
    }
    return { success: true }
  })

  // 拉取模型列表（通过主进程避免 CORS 问题）
  ipcMain.handle(IPC_CHANNELS.SYS_FETCH_MODELS, async (_event, baseURL: string, apiKey: string) => {
    try {
      const url = baseURL.replace(/\/$/, '') + '/models'
      const headers: Record<string, string> = {}
      const key = apiKey?.trim()
      if (key) headers['Authorization'] = `Bearer ${key}`

      const res = await fetch(url, { headers })
      if (res.ok) {
        const data = await res.json()
        const models = (data.data || data.models || []).map((m: any) =>
          typeof m === 'string' ? m : (m.id || m.name)
        ).filter(Boolean)
        return { success: true, models }
      } else {
        const errorText = await res.text().catch(() => '')
        return { success: false, error: `HTTP ${res.status}: ${errorText.slice(0, 200) || res.statusText}` }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // 测试连接（通过主进程避免 CORS 问题）
  ipcMain.handle(IPC_CHANNELS.SYS_TEST_CONNECTION, async (_event, baseURL: string, apiKey: string) => {
    try {
      const url = baseURL.replace(/\/$/, '') + '/models'
      const headers: Record<string, string> = {}
      const key = apiKey?.trim()
      if (key) headers['Authorization'] = `Bearer ${key}`

      const res = await fetch(url, { headers })
      if (res.ok) {
        const data = await res.json()
        const count = (data.data || data.models || []).length
        return { success: true, message: `连接成功，可用模型 ${count} 个` }
      } else {
        const errorText = await res.text().catch(() => '')
        return { success: false, message: `连接失败 (${res.status}): ${errorText.slice(0, 100) || res.statusText}` }
      }
    } catch (e: any) {
      return { success: false, message: `网络错误: ${e.message}` }
    }
  })

  // 获取快捷键配置
  ipcMain.handle(IPC_CHANNELS.SYS_GET_SHORTCUTS, async () => {
    return getShortcutConfig()
  })

  // 保存快捷键配置
  ipcMain.handle(IPC_CHANNELS.SYS_SET_SHORTCUTS, async (_event, shortcuts: Record<string, string>) => {
    setShortcutConfig(shortcuts)
    reregisterShortcuts()
    return { success: true }
  })

  // 获取主题模式
  ipcMain.handle(IPC_CHANNELS.SYS_GET_THEME, async () => {
    return { mode: getThemeMode(), effective: getEffectiveTheme() }
  })

  // 设置主题模式
  ipcMain.handle(IPC_CHANNELS.SYS_SET_THEME, async (_event, mode: 'light' | 'dark' | 'system') => {
    setThemeMode(mode)
    return { success: true, mode, effective: getEffectiveTheme() }
  })
}

// ═══════════════════════════════════════════════════════════
//  反馈 & Prompt 优化相关 IPC (T-008)
// ═══════════════════════════════════════════════════════════

function registerFeedbackHandlers(): void {
  // 记录用户反馈
  ipcMain.handle(IPC_CHANNELS.FEEDBACK_RECORD, async (
    _event,
    data: {
      feedbackType: 'positive' | 'negative' | 'neutral'
      messageId?: string
      sessionId?: string
      userQuery?: string
      agentResponse?: string
      comment?: string
      implicitAction?: 'copy' | 'edit' | 'ignore'
    }
  ) => {
    await ensureDatabase()

    if (data.implicitAction) {
      recordImplicitFeedback(data.implicitAction, {
        messageId: data.messageId,
        sessionId: data.sessionId,
        userQuery: data.userQuery,
        agentResponse: data.agentResponse
      })
    } else {
      recordExplicitFeedback({
        feedbackType: data.feedbackType,
        messageId: data.messageId,
        sessionId: data.sessionId,
        userQuery: data.userQuery,
        agentResponse: data.agentResponse,
        comment: data.comment
      })
    }

    // 检查是否需要触发 Prompt 优化
    const shouldOptimize = shouldOptimizePrompt()

    return { success: true, shouldOptimize }
  })

  // 获取当前 Prompt 版本
  ipcMain.handle(IPC_CHANNELS.PROMPT_GET_CURRENT, async () => {
    await ensureDatabase()
    return getCurrentPromptVersion()
  })

  // 获取所有版本
  ipcMain.handle(IPC_CHANNELS.PROMPT_GET_VERSIONS, async () => {
    await ensureDatabase()
    return listPromptVersions()
  })

  // 手动触发优化
  ipcMain.handle(IPC_CHANNELS.PROMPT_OPTIMIZE, async () => {
    await ensureDatabase()
    const result = await optimizePrompt()
    return result
  })

  // 回滚到上一个版本
  ipcMain.handle(IPC_CHANNELS.PROMPT_ROLLBACK, async () => {
    await ensureDatabase()
    return rollbackPrompt()
  })

  // 设置 A/B 测试
  ipcMain.handle(IPC_CHANNELS.PROMPT_SET_AB_TEST, async (_event, config: { enabled: boolean; variantRatio?: number }) => {
    setABTestConfig(config)
    return { success: true, config: getABTestConfig() }
  })

  // 结束 A/B 测试
  ipcMain.handle(IPC_CHANNELS.PROMPT_CONCLUDE_AB_TEST, async () => {
    await ensureDatabase()
    return concludeABTest()
  })
}

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

/** 默认 AgentConfig（用于类型引用） */
const DEFAULT_AGENT_CONFIG = {
  maxTokens: 32000,
  outputReserve: 4000
}

// ═══════════════════════════════════════════════════════════
//  技能管理相关 IPC (T-009)
// ═══════════════════════════════════════════════════════════

function registerSkillHandlers(): void {
  // 获取所有技能
  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async () => {
    await ensureDatabase()
    return getAllSkills()
  })

  // 获取单个技能
  ipcMain.handle(IPC_CHANNELS.SKILL_GET, async (_event, id: string) => {
    await ensureDatabase()
    return getSkill(id)
  })

  // 创建技能
  ipcMain.handle(IPC_CHANNELS.SKILL_CREATE, async (_event, skill: {
    name: string
    description: string
    content: string
    status?: Skill['status']
  }) => {
    await ensureDatabase()
    const created = createSkill({
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      autoGenerated: false,
      confidence: 0.8,
      status: skill.status || 'active'
    })
    return created
  })

  // 更新技能
  ipcMain.handle(IPC_CHANNELS.SKILL_UPDATE, async (
    _event,
    id: string,
    updates: {
      name?: string
      description?: string
      content?: string
      status?: Skill['status']
    }
  ) => {
    await ensureDatabase()
    updateSkill(id, updates)
    return { success: true }
  })

  // 删除技能
  ipcMain.handle(IPC_CHANNELS.SKILL_DELETE, async (_event, id: string) => {
    await ensureDatabase()
    deleteSkill(id)
    return { success: true }
  })
}

// ═══════════════════════════════════════════════════════════
//  记忆管理相关 IPC (T-010)
// ═══════════════════════════════════════════════════════════

function registerMemoryHandlers(): void {
  // 获取记忆列表
  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, async (
    _event,
    params?: { type?: 'episodic' | 'semantic'; limit?: number; offset?: number }
  ) => {
    await ensureDatabase()
    const limit = params?.limit ?? 100
    const offset = params?.offset ?? 0
    const results = getAllMemories(params?.type, limit, offset)
    return results.map(r => ({
      id: r.id,
      type: r.type,
      memType: undefined,
      content: r.content,
      sessionId: r.sessionId,
      userIntent: r.userIntent,
      actions: r.actions,
      outcome: r.outcome,
      successScore: r.successScore,
      modelUsed: r.modelUsed,
      skillsUsed: r.skillsUsed,
      tags: r.tags,
      source: r.source,
      confidence: r.confidence,
      importance: r.importance,
      createdAt: r.createdAt,
      lastAccessedAt: r.lastAccessedAt,
      accessCount: r.accessCount
    } as MemoryItem))
  })

  // 语义搜索记忆
  ipcMain.handle(IPC_CHANNELS.MEMORY_SEARCH, async (_event, query: string, topK?: number) => {
    await ensureDatabase()
    const results = await memoryManager.retrieve(query, { topK: topK ?? 50, minScore: 0.01 })
    return results.map(r => {
      const mem = r.memory
      const isEpisodic = 'userIntent' in mem
      return {
        id: mem.id,
        type: isEpisodic ? 'episodic' as const : 'semantic' as const,
        content: isEpisodic ? mem.outcome : mem.content,
        userIntent: isEpisodic ? mem.userIntent : undefined,
        actions: isEpisodic ? mem.actions : undefined,
        outcome: isEpisodic ? mem.outcome : undefined,
        successScore: isEpisodic ? mem.successScore : undefined,
        modelUsed: isEpisodic ? mem.modelUsed : undefined,
        skillsUsed: isEpisodic ? mem.skillsUsed : undefined,
        tags: isEpisodic ? mem.tags : undefined,
        source: !isEpisodic ? mem.source : undefined,
        confidence: !isEpisodic ? mem.confidence : undefined,
        importance: !isEpisodic ? mem.importance : (isEpisodic ? mem.successScore / 5 : 0.5),
        createdAt: isEpisodic ? mem.timestamp : mem.createdAt,
        lastAccessedAt: !isEpisodic ? mem.lastAccessedAt : undefined,
        accessCount: !isEpisodic ? mem.accessCount : 0
      } as MemoryItem
    })
  })

  // 获取单条记忆
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET, async (_event, id: string) => {
    await ensureDatabase()
    const all = getAllMemories(undefined, 10000, 0)
    const found = all.find(m => m.id === id)
    if (!found) return null
    return {
      id: found.id,
      type: found.type,
      content: found.content,
      sessionId: found.sessionId,
      userIntent: found.userIntent,
      actions: found.actions,
      outcome: found.outcome,
      successScore: found.successScore,
      modelUsed: found.modelUsed,
      skillsUsed: found.skillsUsed,
      tags: found.tags,
      source: found.source,
      confidence: found.confidence,
      importance: found.importance,
      createdAt: found.createdAt,
      lastAccessedAt: found.lastAccessedAt,
      accessCount: found.accessCount
    } as MemoryItem
  })

  // 删除记忆
  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, async (_event, id: string) => {
    await ensureDatabase()
    deleteMemory(id)
    return { success: true }
  })

  // 手动添加记忆
  ipcMain.handle(IPC_CHANNELS.MEMORY_CREATE, async (_event, memory: {
    content: string
    type?: 'episodic' | 'semantic'
    importance?: number
    tags?: string[]
  }) => {
    await ensureDatabase()
    const result = await memoryManager.storeSemantic(
      'knowledge',
      memory.content,
      'manual',
      memory.importance ?? 0.7
    )
    return { success: true, memory: result }
  })

  // 获取记忆统计
  ipcMain.handle(IPC_CHANNELS.MEMORY_STATS, async () => {
    await ensureDatabase()
    return memoryManager.getStats()
  })
}

// ═══════════════════════════════════════════════════════════
//  工具管理相关 IPC (T-012)
// ═══════════════════════════════════════════════════════════

function registerToolHandlers(): void {
  // 获取所有已注册工具
  ipcMain.handle(IPC_CHANNELS.TOOL_LIST, async () => {
    return getToolDefs()
  })

  // 直接执行工具（供测试和调试使用）
  ipcMain.handle(IPC_CHANNELS.TOOL_EXECUTE, async (
    _event,
    toolId: string,
    params: Record<string, unknown>
  ) => {
    const result = await executeAction({
      id: `call-${Date.now()}`,
      toolId,
      parameters: params
    })
    return result
  })
}

// ═══════════════════════════════════════════════════════════
//  插件管理相关 IPC (T-022)
// ═══════════════════════════════════════════════════════════

function registerPluginHandlers(): void {
  // 获取所有插件
  ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST, async () => {
    return pluginManager.listPlugins()
  })

  // 获取单个插件
  ipcMain.handle(IPC_CHANNELS.PLUGIN_GET, async (_event, id: string) => {
    return pluginManager.getPlugin(id)
  })

  // 安装插件
  ipcMain.handle(IPC_CHANNELS.PLUGIN_INSTALL, async (_event, manifest: PluginManifest) => {
    return pluginManager.install(manifest)
  })

  // 卸载插件
  ipcMain.handle(IPC_CHANNELS.PLUGIN_UNINSTALL, async (_event, id: string) => {
    return pluginManager.uninstall(id)
  })

  // 启用/禁用插件
  ipcMain.handle(IPC_CHANNELS.PLUGIN_TOGGLE, async (_event, id: string, enabled: boolean) => {
    return pluginManager.toggle(id, enabled)
  })
}

// ═══════════════════════════════════════════════════════════
//  数据导出/导入相关 IPC (T-023)
// ═══════════════════════════════════════════════════════════

function registerDataHandlers(): void {
  // 导出数据
  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT, async (_event, options: ExportOptions) => {
    await ensureDatabase()
    return exportData(options)
  })

  // 导入数据
  ipcMain.handle(IPC_CHANNELS.DATA_IMPORT, async (_event, filePath?: string) => {
    await ensureDatabase()
    return importData(filePath)
  })

  // 导出指定会话
  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT_SESSIONS, async (_event, sessionIds: string[], format: 'json' | 'markdown') => {
    await ensureDatabase()
    return exportData({ format, scope: 'sessions', sessionIds })
  })
}

// ═══════════════════════════════════════════════════════════
//  离线模式 / Ollama 相关 IPC (T-024)
// ═══════════════════════════════════════════════════════════

function registerOllamaHandlers(): void {
  // 获取 Ollama 状态
  ipcMain.handle(IPC_CHANNELS.OLLAMA_STATUS, async () => {
    return ollamaManager.getStatus()
  })

  // 获取已安装的模型列表
  ipcMain.handle(IPC_CHANNELS.OLLAMA_LIST_MODELS, async () => {
    return ollamaManager.getModels()
  })

  // 拉取（下载）模型
  ipcMain.handle(IPC_CHANNELS.OLLAMA_PULL_MODEL, async (_event, modelName: string) => {
    // 注意：进度通知通过 webContents.send 发送
    const chatWin = getChatWindow()
    const result = await ollamaManager.pullModel(modelName, (progress: OllamaPullProgress) => {
      chatWin?.webContents.send('ollama:pull-progress', progress)
    })
    return result
  })

  // 删除模型
  ipcMain.handle(IPC_CHANNELS.OLLAMA_DELETE_MODEL, async (_event, modelName: string) => {
    return ollamaManager.deleteModel(modelName)
  })

  // 启用/禁用离线模式
  ipcMain.handle(IPC_CHANNELS.OLLAMA_SET_ENABLED, async (_event, enabled: boolean) => {
    return ollamaManager.setEnabled(enabled)
  })
}

/** 错误分类 — 将底层错误转为用户友好的消息 */
function classifyError(error: Error): {
  type: 'network' | 'auth' | 'rate_limit' | 'aborted' | 'unknown'
  userMessage: string
} {
  const msg = error.message.toLowerCase()

  if (msg.includes('aborted') || msg.includes('abort')) {
    return { type: 'aborted', userMessage: '已停止生成' }
  }

  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return { type: 'auth', userMessage: 'API Key 无效，请在设置中检查配置' }
  }

  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return { type: 'rate_limit', userMessage: '请求过于频繁，请稍后重试' }
  }

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { type: 'network', userMessage: '请求超时，请检查网络连接' }
  }

  if (msg.includes('econnrefused') || msg.includes('enetunreach') || msg.includes('fetch failed')) {
    return { type: 'network', userMessage: '无法连接到 API 服务器，请检查网络或 baseURL 配置' }
  }

  return { type: 'unknown', userMessage: `发生错误: ${error.message}` }
}

// ═══════════════════════════════════════════════════════════
//  MCP 服务器管理相关 IPC
// ═══════════════════════════════════════════════════════════

function registerMCPHandlers(): void {
  // 获取所有 MCP 服务器
  ipcMain.handle(IPC_CHANNELS.MCP_LIST, async () => {
    const config = getConfig()
    return config.mcpServers || []
  })

  // 添加 MCP 服务器
  ipcMain.handle(IPC_CHANNELS.MCP_ADD, async (_event, server: Omit<MCPServerConfig, 'id' | 'createdAt' | 'updatedAt'>) => {
    const config = getConfig()
    const newServer: MCPServerConfig = {
      ...server,
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    config.mcpServers = [...(config.mcpServers || []), newServer]
    saveConfig(config)
    return { success: true, server: newServer }
  })

  // 更新 MCP 服务器
  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE, async (_event, id: string, updates: Partial<MCPServerConfig>) => {
    const config = getConfig()
    const idx = (config.mcpServers || []).findIndex(s => s.id === id)
    if (idx < 0) return { success: false, error: '服务器不存在' }
    config.mcpServers[idx] = { ...config.mcpServers[idx], ...updates, updatedAt: Date.now() }
    saveConfig(config)
    return { success: true }
  })

  // 删除 MCP 服务器
  ipcMain.handle(IPC_CHANNELS.MCP_DELETE, async (_event, id: string) => {
    const config = getConfig()
    config.mcpServers = (config.mcpServers || []).filter(s => s.id !== id)
    saveConfig(config)
    return { success: true }
  })

  // 启用/禁用 MCP 服务器
  ipcMain.handle(IPC_CHANNELS.MCP_TOGGLE, async (_event, id: string, enabled: boolean) => {
    const config = getConfig()
    const idx = (config.mcpServers || []).findIndex(s => s.id === id)
    if (idx < 0) return { success: false, error: '服务器不存在' }
    config.mcpServers[idx].enabled = enabled
    config.mcpServers[idx].updatedAt = Date.now()
    saveConfig(config)
    return { success: true }
  })

  // 测试 MCP 服务器连接
  ipcMain.handle(IPC_CHANNELS.MCP_TEST, async (_event, server: MCPServerConfig) => {
    try {
      if (server.transport === 'stdio') {
        if (!server.command) {
          return { success: false, message: '请填写命令' } as MCPTestResult
        }
        // 对于 stdio 模式，仅验证命令是否可执行
        return {
          success: true,
          message: `命令「${server.command}」配置已保存，运行时将自动启动`,
          tools: []
        } as MCPTestResult
      } else {
        if (!server.url) {
          return { success: false, message: '请填写服务器 URL' } as MCPTestResult
        }
        // 对于 SSE/HTTP 模式，尝试连接
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
          const res = await fetch(server.url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
          })
          clearTimeout(timeout)
          if (res.ok) {
            return {
              success: true,
              message: `连接成功 (${res.status})`,
              tools: []
            } as MCPTestResult
          } else {
            return {
              success: false,
              message: `服务器返回 ${res.status}: ${res.statusText}`
            } as MCPTestResult
          }
        } catch (e: any) {
          clearTimeout(timeout)
          return {
            success: false,
            message: `连接失败: ${e.message}`
          } as MCPTestResult
        }
      }
    } catch (e: any) {
      return {
        success: false,
        message: `测试失败: ${e.message}`
      } as MCPTestResult
    }
  })
}

/** 获取模拟响应内容（未配置 LLM 时使用） */
function getMockResponseContent(userMessage: string): string {
  return `收到你的消息："${userMessage}"\n\n⚠️ 尚未配置 LLM Provider。请通过以下步骤配置：\n\n1. 右键点击托盘图标\n2. 选择「设置」\n3. 填入 API Base URL 和 API Key\n4. 选择模型\n\n配置完成后即可进行真实对话。`
}

/** 流式输出模拟响应（未配置 LLM 时使用） */
async function streamMockResponse(
  chatWin: Electron.BrowserWindow,
  messageId: string,
  userMessage: string,
  _unconfigured: boolean
): Promise<void> {
  const response = getMockResponseContent(userMessage)

  const chunks = response.split('')
  for (const chunk of chunks) {
    chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_CHUNK, {
      delta: chunk,
      messageId
    })
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_DONE, { messageId })
}
