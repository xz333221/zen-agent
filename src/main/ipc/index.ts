import { ipcMain, app, shell } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS, ChatMessage, type LLMProviderConfig, type TraceStep, type ExecutionTrace, type ImageAttachment } from '@shared/types'
import { getPetWindow, setPetState } from '../windows/pet-window'
import { getChatWindow, showChatWindow, hideChatWindow } from '../windows/chat-window'
import { llm } from '@agent/providers/llm'
import { loadConfig, getConfig, saveConfig, isLLMConfigured, getSystemPrompt, getSearchConfig, setSearchConfig, getBrowserConfig, setBrowserConfig } from '@agent/providers/llm-config'
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
import type { ExportOptions, OllamaPullProgress, MCPServerConfig, MCPTestResult, Skill, DataPaths, SearchConfig, BrowserConfig } from '@shared/types'
import { getShortcutConfig, setShortcutConfig, reregisterShortcuts } from '../shortcuts'
import { getThemeMode, setThemeMode, getEffectiveTheme } from '../theme'
import {
  initFeedbackCollector,
  recordExplicitFeedback,
  recordImplicitFeedback,
  shouldOptimizePrompt
} from '@agent/evolution/feedback-collector'
import {
  initOrchestrator,
  getOrchestrator
} from '@agent/self-evolution/orchestrator'
import {
  getRecentEvolutionRecords,
  getEvolutionRecord,
  getEvolutionStats
} from '@agent/self-evolution/evolution-journal'
import { DEFAULT_EVOLUTION_CONFIG } from '@agent/self-evolution/types'
import type { SelfEvolutionConfig } from '@agent/self-evolution/types'
import { registerBuiltinTools, initFileIndex } from '@agent/tools/tool-registry'
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

// 初始化文件索引（后台异步扫描，不阻塞启动）
initFileIndex()

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
  registerDataPathHandlers()
  registerEvolutionHandlers()
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

    // 如果会话标题还是默认的"新对话"，根据第一条用户消息自动生成标题
    const existingSession = getSession(sid)
    if (existingSession && (existingSession.title === '新对话' || !existingSession.title)) {
      // 取用户消息前 30 个字符作为标题
      const autoTitle = message.trim().slice(0, 30) + (message.trim().length > 30 ? '...' : '')
      updateSessionTitle(sid, autoTitle)
    }

    // 保存用户消息到 SQLite
    addMessage(sid, {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
      images: images
    })

    // 更新消息计数
    incrementMessageCount(sid)

  // ── 通过 AgentLoop 执行（ReAct 循环 + 追踪步骤） ──
  // AgentLoop 内部会检测 LLM 是否配置，未配置时使用 mock 响应
  currentAbortController = new AbortController()

  // 通知自进化编排器：用户有活动（重置空闲计时器）
  getOrchestrator()?.notifyActivity()

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

      // 更新消息计数
      incrementMessageCount(sid)

      chatWin.webContents.send(IPC_CHANNELS.CHAT_RESPONSE_DONE, { messageId })
      setPetState('happy')

      // 短暂 happy 后回到 idle
      setTimeout(() => setPetState('idle'), 1500)

      currentAbortController = null
      return { success: true }
    } catch (err) {
      currentAbortController = null
      const error = err as Error
      console.error(`[IPC] CHAT_SEND error — messageId=${messageId}, name=${error?.name}, message=${error?.message}`)
      if (error?.stack) {
        console.error('[IPC] CHAT_SEND stack:', error.stack.split('\n').slice(0, 8).join('\n'))
      }
      const errorInfo = classifyError(error)
      console.error(`[IPC] CHAT_SEND classified — type=${errorInfo.type}, userMessage="${errorInfo.userMessage}"`)

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

  // 获取基于历史记录的推荐问题
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_SUGGESTIONS, async () => {
    if (!isLLMConfigured()) {
      // 未配置 LLM 时返回默认建议
      return getDefaultSuggestions()
    }

    try {
      // 获取所有会话的最近消息
      const sessions = getAllSessions()
      const recentMessages: Array<{ role: string; content: string }> = []

      for (const session of sessions.slice(0, 5)) {
        const msgs = getRecentMessages(session.id, 4)
        for (const msg of msgs) {
          if (msg.content && msg.content.trim()) {
            recentMessages.push({ role: msg.role, content: msg.content.slice(0, 200) })
          }
        }
      }

      if (recentMessages.length === 0) {
        return getDefaultSuggestions()
      }

      // 构建生成建议的 prompt
      const historyText = recentMessages
        .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
        .join('\n')

      // 使用 system + user 双消息结构，明确角色边界
      const systemPrompt = `你是一个问题生成助手。你的唯一任务是生成用户可能想问的问题。

严格要求：
1. 只输出问题本身，每行一个问题
2. 不要输出任何思考过程、推理、说明、编号或前缀
3. 不要输出 "Now I need to..." 或类似的中英文推理语句
4. 问题必须是中文，简洁明了，不超过 20 个字
5. 正好输出 4 个问题

正确输出示例：
帮我写一个 Python 脚本
今天 A 股大盘走势如何
推荐一本技术书籍
如何优化 React 性能`

      const userPrompt = `基于以下用户最近的对话历史，生成 4 个用户可能想问的问题。

对话历史：
${historyText}`

      const config = getConfig()
      const modelKey = config.fastModel || config.defaultModel
      const response = await llm.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        ...(modelKey ? { modelKey } : {}),
        temperature: 0.8,
        maxTokens: 300
      })

      // 过滤推理文本，只保留真正的问题
      const suggestions = response
        .split('\n')
        .map((s: string) => {
          // 剥离编号前缀（1. 2. 3) 等），保留后面的内容
          let cleaned = s.trim().replace(/^\d+[.)]\s*/, '')
          // 剥离 bullet 符号
          cleaned = cleaned.replace(/^[*\-+]\s+/, '')
          // 剥离引号
          cleaned = cleaned.replace(/^["'""'']+|["'""''']+$/g, '')
          return cleaned.trim()
        })
        .filter((s: string) => {
          // 基本长度检查
          if (s.length === 0 || s.length > 50) return false
          // 过滤 HTML/XML 标签格式的行（如 <answer>, </output> 等）
          if (/^<\/?[a-zA-Z]/.test(s)) return false
          // 过滤纯数字行
          if (/^\d+$/.test(s)) return false
          // 过滤英文推理文本（以 "Now I", "I need", "Let me", "Based on" 等开头）
          if (/^(now\s+i|i\s+(need|should|will|can)|let\s+me|based\s+on|first|next|then|so|i'll|i'll|i\s+will)\b/i.test(s)) return false
          // 过滤包含 "questions" "generate" 等元描述的行
          if (/\b(generate|question|requirement|constraint|instruction)\b/i.test(s)) return false
          // 过滤纯英文行（除非很短像缩写）
          if (/^[a-zA-Z\s,.!?;:'"\-()]+$/.test(s) && s.length > 10) return false
          // 过滤包含 < > 的行（可能是 XML 标签残留）
          if (/[<>]/.test(s) && !/<=|>=/.test(s)) return false
          // 过滤 "建议问题：" 等标签行
          if (/^(建议|推荐|生成|问题|输出)[：:]/.test(s)) return false
          return true
        })
        .slice(0, 4)

      // 如果过滤后有效建议不足 2 条，回退到默认建议
      return suggestions.length >= 2 ? suggestions : getDefaultSuggestions()
    } catch (err) {
      console.error('[IPC] Failed to generate suggestions:', err)
      return getDefaultSuggestions()
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
  ipcMain.handle(IPC_CHANNELS.SYS_SET_CONFIG, async (_event, data: { providers?: LLMProviderConfig[]; defaultModel?: string; embeddingModel?: string; agent?: Partial<typeof DEFAULT_AGENT_CONFIG>; mcpServers?: MCPServerConfig[]; search?: Partial<SearchConfig> }) => {
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
    if (data.search) {
      config.search = { ...config.search, ...data.search }
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
  type: 'network' | 'auth' | 'rate_limit' | 'aborted' | 'timeout' | 'unknown'
  userMessage: string
} {
  const msg = (error?.message || String(error ?? '')).toLowerCase()

  // ⚠ 先检查超时 — 超时的 error message 包含 "timed out"，必须优先于 abort 检查
  // 因为 withTimeout 超时后会 abort signal，OpenAI SDK 会报 "aborted" 但根本原因是超时
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return { type: 'timeout', userMessage: '请求超时，请稍后重试或检查网络连接' }
  }

  // 用户主动中止（点击停止按钮）— 仅匹配纯 abort，排除 timeout
  if (msg === 'aborted' || msg.includes('user abort') || msg.includes('request was aborted')) {
    // 进一步检查是否为超时导致的 abort
    if (msg.includes('timed out') || msg.includes('timeout')) {
      return { type: 'timeout', userMessage: '请求超时，请稍后重试或检查网络连接' }
    }
    return { type: 'aborted', userMessage: '已停止生成' }
  }

  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return { type: 'auth', userMessage: 'API Key 无效，请在设置中检查配置' }
  }

  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return { type: 'rate_limit', userMessage: '请求过于频繁，请稍后重试' }
  }

  if (msg.includes('econnrefused') || msg.includes('enetunreach') || msg.includes('fetch failed')) {
    return { type: 'network', userMessage: '无法连接到 API 服务器，请检查网络或 baseURL 配置' }
  }

  return { type: 'unknown', userMessage: `发生错误: ${error?.message || String(error ?? '未知错误')}` }
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

/**
 * 注册数据路径 & 缩放设置处理器
 */
function registerDataPathHandlers(): void {
  // 获取数据路径
  ipcMain.handle(IPC_CHANNELS.SYS_GET_DATA_PATHS, async (): Promise<DataPaths> => {
    const userDataPath = app.getPath('userData')
    return {
      configFile: join(userDataPath, 'config.json'),
      databaseFile: join(userDataPath, 'zen-agent.db'),
      dataDir: userDataPath,
      skillsDir: join(userDataPath, 'skills'),
      pluginsDir: join(userDataPath, 'plugins'),
      logsDir: join(userDataPath, 'logs')
    }
  })

  // 在文件管理器中打开
  ipcMain.handle(IPC_CHANNELS.SYS_OPEN_IN_FOLDER, async (_event, path: string) => {
    try {
      // 如果是目录，直接打开；如果是文件，显示文件在文件夹中
      await shell.openPath(path)
      return { success: true }
    } catch (e) {
      console.error('[IPC] Failed to open path:', e)
      return { success: false, error: String(e) }
    }
  })

  // 获取缩放比例
  ipcMain.handle(IPC_CHANNELS.SYS_GET_ZOOM, async () => {
    try {
      const win = getChatWindow()
      if (win && !win.isDestroyed()) {
        return win.webContents.getZoomFactor()
      }
      return 1.0
    } catch {
      return 1.0
    }
  })

  // 设置缩放比例（应用到所有窗口）
  ipcMain.handle(IPC_CHANNELS.SYS_SET_ZOOM, async (_event, zoom: number) => {
    try {
      const clampedZoom = Math.max(0.5, Math.min(3.0, zoom))

      // 应用到聊天窗口
      const chatWin = getChatWindow()
      if (chatWin && !chatWin.isDestroyed()) {
        chatWin.webContents.setZoomFactor(clampedZoom)
      }

      // 应用到设置窗口
      const settingsWin = settingsWindowModule.getSettingsWindow()
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.setZoomFactor(clampedZoom)
      }

      // 持久化到 config
      const config = getConfig()
      config.uiZoomFactor = clampedZoom
      saveConfig(config)

      return { success: true, zoom: clampedZoom }
    } catch (e) {
      console.error('[IPC] Failed to set zoom:', e)
      return { success: false, error: String(e) }
    }
  })

  // ── 搜索配置 (T-025) ──
  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_CONFIG, async () => {
    try {
      return getSearchConfig()
    } catch (e) {
      console.error('[IPC] Failed to get search config:', e)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_SET_CONFIG, async (_event, search: Partial<SearchConfig>) => {
    try {
      setSearchConfig(search)
      return { success: true }
    } catch (e) {
      console.error('[IPC] Failed to set search config:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SEARCH_TEST, async (_event, data: { query: string; config: SearchConfig }) => {
    try {
      const { performSearch } = await import('@agent/tools/web-search')
      const results = await performSearch(data.query, data.config)
      return { success: true, results }
    } catch (e: any) {
      console.error('[IPC] Search test failed:', e)
      return { success: false, error: e?.message || String(e) }
    }
  })

  // ── 浏览器配置 ──
  ipcMain.handle(IPC_CHANNELS.BROWSER_GET_CONFIG, async () => {
    try {
      return getBrowserConfig()
    } catch (e) {
      console.error('[IPC] Failed to get browser config:', e)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SET_CONFIG, async (_event, browser: Partial<BrowserConfig>) => {
    try {
      setBrowserConfig(browser)
      return { success: true }
    } catch (e) {
      console.error('[IPC] Failed to set browser config:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_SELECT_DIR, async () => {
    try {
      const { dialog } = await import('electron')
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择浏览器用户数据目录'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }
      return { success: true, path: result.filePaths[0] }
    } catch (e) {
      console.error('[IPC] Failed to select browser dir:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BROWSER_DETECT_USER_DATA_DIR, async () => {
    try {
      const { browserManager } = await import('@agent/tools/browser-manager')
      const result = browserManager.findChromeUserDataDir()
      if (result) {
        return { success: true, ...result }
      }
      return { success: false, error: '未找到 Chrome 用户数据目录，请手动选择' }
    } catch (e) {
      console.error('[IPC] Failed to detect browser user data dir:', e)
      return { success: false, error: String(e) }
    }
  })
}

/** 默认进化配置（用于初始化） */
const DEFAULT_EVOLUTION_SETTINGS = {
  ...DEFAULT_EVOLUTION_CONFIG,
  enabled: false
}

// ═══════════════════════════════════════════════════════════
//  自进化相关 IPC
// ═══════════════════════════════════════════════════════════

function registerEvolutionHandlers(): void {
  // 初始化自进化编排器
  const orch = initOrchestrator(
    { enabled: false },
    {
      onPhaseChange: (phase, message) => {
        console.log(`[Evolution IPC] Phase: ${phase} - ${message}`)
        // 通知宠物窗口
        const petWin = getPetWindow()
        if (petWin) {
          petWin.webContents.send(IPC_CHANNELS.PET_STATE_CHANGE, {
            state: phase === 'idle' ? 'idle' : 'evolving',
            bubble: phase !== 'idle' && phase !== 'done' ? {
              text: `自进化中: ${message}`,
              type: 'evolution' as const
            } : undefined
          })
        }
      },
      onComplete: (record) => {
        console.log(`[Evolution IPC] Complete: ${record.outcome}`)
        // 通知宠物窗口
        const petWin = getPetWindow()
        if (petWin) {
          const bubbleText = record.outcome === 'success'
            ? `自进化成功! ${record.goal.slice(0, 30)}`
            : record.outcome === 'partial'
              ? `自进化部分完成: ${record.goal.slice(0, 30)}`
              : `自进化已回滚: ${(record.failureReason || '').slice(0, 30)}`
          petWin.webContents.send(IPC_CHANNELS.PET_STATE_CHANGE, {
            state: record.outcome === 'success' ? 'happy' : 'idle',
            bubble: {
              text: bubbleText,
              type: 'evolution' as const
            }
          })
        }
      },
      onError: (error) => {
        console.error('[Evolution IPC] Error:', error)
      }
    }
  )

  // 获取自进化状态
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_GET_STATUS, () => {
    return orch.getStatus()
  })

  // 启用/禁用自进化
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_SET_ENABLED, (_event, enabled: boolean) => {
    orch.updateConfig({ enabled })
    if (enabled) {
      orch.start()
    } else {
      orch.stop()
    }
    return { success: true, enabled }
  })

  // 手动触发一次进化
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_RUN_ONCE, async () => {
    try {
      const record = await orch.runOnce()
      return { success: true, record }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 获取进化记录列表
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_GET_RECORDS, (_event, limit: number = 20) => {
    return getRecentEvolutionRecords(limit)
  })

  // 获取单条进化记录
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_GET_RECORD, (_event, id: string) => {
    return getEvolutionRecord(id)
  })

  // 获取进化统计
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_GET_STATS, () => {
    return getEvolutionStats()
  })

  // 获取进化配置
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_GET_CONFIG, () => {
    return DEFAULT_EVOLUTION_SETTINGS
  })

  // 更新进化配置
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_SET_CONFIG, (_event, config: Partial<SelfEvolutionConfig>) => {
    orch.updateConfig(config)
    return { success: true }
  })

  // 获取 Token 预算
  ipcMain.handle(IPC_CHANNELS.EVOLUTION_GET_TOKEN_BUDGET, () => {
    return orch.getStatus().tokenBudget
  })
}

/** 默认推荐问题（未配置 LLM 或无历史记录时使用） */
function getDefaultSuggestions(): string[] {
  return [
    '帮我写一个 Vue 组件',
    '写一篇技术文章',
    '搜索最新技术资讯',
    '分析一段数据'
  ]
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
