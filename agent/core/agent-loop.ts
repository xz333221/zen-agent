/**
 * Agent 主循环 — ReAct (Reason → Act → Observe) 模式
 *
 * 核心流程:
 * 1. 意图识别 — 分析用户输入的复杂度和类型
 * 2. 记忆检索 — 检索相关历史记忆（向量语义搜索）
 * 3. 技能匹配 — 匹配已有技能（当前为空实现，T-007 接入）
 * 3.5 上下文管理 — Token 预算分配 + 滑动窗口 + 摘要压缩
 * 4. ReAct 循环 — Think → Act → Observe，最多 MAX_ITERATIONS 轮
 * 5. 反思 — 自评执行质量
 * 6. 记忆存储 — 沉淀情景记忆（向量化 + 去重）
 * 7. 统计 — Token 使用量
 * 8. 完成 — 发送完整追踪
 *
 * 当 LLM 未配置时，所有步骤使用规则/mock 模式执行。
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig, getSystemPrompt } from '../providers/llm-config'
import { parseIntent, toIntentDetail } from './intent-parser'
import { executeAction, getToolNames, toActDetail } from './action-executor'
import { reflect } from './reflection'
import { ContextManager, type ManagedContext } from './context-manager'
import { countTextTokens } from '../utils/token-counter'
import { memoryManager } from '../memory/memory-manager'
import { skillStore } from '../evolution/skill-store'
import { patternDetector } from '../evolution/pattern-detector'
import { shouldOptimizePrompt } from '../evolution/feedback-collector'
import { optimizePrompt as runPromptOptimization } from '../evolution/prompt-optimizer'
import { Coordinator } from './coordinator'
import type { MemorySearchResult } from '../memory/types'
import type { SkillMatchResult } from '../skills/types'
import type { AgentContext, AgentResult, AgentCallbacks, ReActStep } from './types'
import type { TraceStep, ExecutionTrace, StepDetail, ThinkDetail, ObserveDetail, MemoryDetail, SkillMatchDetail } from '../../src/shared/types'

const MAX_ITERATIONS = 10  // 最大循环次数

// ── ReAct 解析正则 ──
const THOUGHT_RE = /THOUGHT:\s*([\s\S]*?)(?=\nACTION:|$)/i
const ACTION_RE = /ACTION:\s*(\S+)/i
const ACTION_INPUT_RE = /ACTION_INPUT:\s*([\s\S]*?)(?=\nTHOUGHT:|$)/i
const CONTENT_RE = /CONTENT:\s*([\s\S]*?)$/i

export class AgentLoop {
  private callbacks: AgentCallbacks
  private steps: TraceStep[] = []
  private stepIndex = 0
  private startTime = 0
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private modelsUsed = new Set<string>()
  private signal?: AbortSignal
  private managedContext: ManagedContext | null = null
  private retrievedMemories: MemorySearchResult[] = []
  private matchedSkills: SkillMatchResult[] = []

  constructor(callbacks: AgentCallbacks = {}) {
    this.callbacks = callbacks
  }

  /** 执行 Agent 循环 */
  async run(userInput: string, context: AgentContext): Promise<AgentResult> {
    this.startTime = Date.now()
    this.steps = []
    this.stepIndex = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.modelsUsed.clear()
    this.signal = context.signal

    try {
      // ── Step 1: 意图识别 ──
      this.callbacks.onStateChange?.('thinking')
      const intentResult = await this.stepIntent(userInput, context)

      // ── Step 2: 记忆检索（向量语义搜索） ──
      this.retrievedMemories = await this.stepMemoryRetrieval(userInput, context)

      // ── Step 3: 技能匹配 ──
      const skillStep = await this.stepSkillMatch(userInput, context)

      // ── Step 3.5: 上下文管理（Token 预算 + 滑动窗口 + 摘要压缩） ──
      this.managedContext = await this.stepContextManagement(userInput, context)

      // ── Step 4-6: ReAct 循环 或 Coordinator 多 Agent 协作 ──
      const reactSteps: ReActStep[] = []
      let finalOutput = ''
      let llmCallCount = 0

      // 如果需要规划且复杂度高，使用 Coordinator 进行多 Agent 协作
      if (intentResult.requiresPlanning && intentResult.complexity === 'high') {
        this.callbacks.onStateChange?.('working')
        const coordinator = new Coordinator(
          {
            onStepStart: (step: TraceStep) => {
              this.callbacks.onStepStart?.(step)
              this.steps.push(step)
              this.stepIndex++
            },
            onStepComplete: (step: TraceStep) => {
              this.callbacks.onStepComplete?.(step)
            },
            onStateChange: (state: string) => {
              this.callbacks.onStateChange?.(state as any)
            },
            onError: (error: Error) => {
              this.callbacks.onError?.(error)
            }
          },
          {
            maxTasks: 5,
            maxParallelTasks: 2,
            totalBudget: context.settings.maxTokens
          }
        )

        const coordResult = await coordinator.coordinate(
          userInput,
          { messages: context.messages },
          this.signal
        )

        if (coordResult.output) {
          finalOutput = coordResult.output
          // 流式输出协调器结果
          const chunks = this.splitIntoChunks(finalOutput, 3)
          for (const chunk of chunks) {
            this.callbacks.onChunk?.(chunk)
            await new Promise(r => setTimeout(r, 10))
          }
          llmCallCount = 1 // 至少一次 LLM 调用
        } else {
          // 协调器未生成输出，回退到 ReAct
          if (isLLMConfigured()) {
            const result = await this.runReActLoop(userInput, context, reactSteps, intentResult.complexity)
            finalOutput = result.output
            llmCallCount = result.llmCalls
          } else {
            finalOutput = this.getMockResponse(userInput)
            this.callbacks.onChunk?.(finalOutput)
          }
        }
      } else if (isLLMConfigured()) {
        // 使用 LLM 进行 ReAct 循环
        const result = await this.runReActLoop(userInput, context, reactSteps, intentResult.complexity)
        finalOutput = result.output
        llmCallCount = result.llmCalls
      } else {
        // 未配置 LLM，直接返回 mock 响应
        finalOutput = this.getMockResponse(userInput)
        this.callbacks.onChunk?.(finalOutput)
      }

      // ── Step 7: 反思 ──
      this.callbacks.onStateChange?.('thinking')
      await this.stepReflect(userInput, finalOutput, reactSteps, context)

      // ── Step 8: 记忆存储 ──
      await this.stepStore(userInput, finalOutput, context)

      // ── Step 8.5: 进化检测（模式检测 + 技能生成） ──
      await this.stepEvolution(userInput, finalOutput, intentResult.complexity, context)

      // ── Step 8.6: Prompt 优化检测（负反馈阈值触发） ──
      await this.stepPromptOptimization(context)

      // ── Step 9: 统计 ──
      await this.stepStats(context)

      // ── Step 10: 完成 ──
      this.stepComplete(llmCallCount)

      // ── 构建执行追踪 ──
      const trace: ExecutionTrace = {
        id: `trace-${Date.now()}`,
        sessionId: context.sessionId,
        messageId: `msg-${Date.now()}`,
        startTime: this.startTime,
        endTime: Date.now(),
        steps: this.steps,
        stats: {
          totalInputTokens: this.totalInputTokens,
          totalOutputTokens: this.totalOutputTokens,
          estimatedCost: this.estimateCost(),
          llmCalls: llmCallCount,
          toolCalls: this.steps.filter(s => s.type === 'act').length,
          modelsUsed: Array.from(this.modelsUsed)
        }
      }

      this.callbacks.onTraceComplete?.(trace)
      this.callbacks.onStateChange?.('happy')

      return {
        content: finalOutput || '（Agent 未能生成响应）',
        trace,
        tokensUsed: {
          input: this.totalInputTokens,
          output: this.totalOutputTokens
        },
        modelsUsed: Array.from(this.modelsUsed),
        duration: Date.now() - this.startTime
      }
    } catch (err) {
      this.callbacks.onError?.(err as Error)
      this.callbacks.onStateChange?.('confused')
      throw err
    }
  }

  // ═════════════════════════════════════════════════════════
  //  ReAct 循环核心
  // ═════════════════════════════════════════════════════════

  /**
   * 执行 ReAct 循环
   * 对于简单问题，直接流式输出回答
   * 对于复杂问题，使用 Think-Act-Observe 循环
   */
  private async runReActLoop(
    userInput: string,
    context: AgentContext,
    reactSteps: ReActStep[],
    complexity: 'low' | 'medium' | 'high'
  ): Promise<{ output: string; llmCalls: number }> {
    const config = getConfig()
    const toolNames = getToolNames()
    let llmCalls = 0

    // 构建系统提示词
    const systemPrompt = this.buildReActSystemPrompt(toolNames)

    // 使用上下文管理器处理后的消息（含摘要压缩）
    // managedContext 已在 run() 中通过 stepContextManagement 生成
    const managedMessages = this.managedContext?.messages ?? context.messages

    // 分离系统提示和历史消息（managedMessages 中第一条是 system prompt）
    const systemMsg = managedMessages[0]?.role === 'system' ? managedMessages[0] : null
    const historyMessages = systemMsg
      ? managedMessages.slice(1)
      : managedMessages

    // 用增强后的系统提示词替换（包含 ReAct 指令）
    const finalSystemPrompt = systemMsg
      ? systemPrompt  // 使用 ReAct 增强版系统提示词
      : systemPrompt

    // 对于简单问题，直接流式输出（跳过 ReAct 循环）
    if (complexity === 'low' && toolNames.length === 0) {
      llmCalls++
      this.modelsUsed.add(config.defaultModelKey)

      let output = ''
      await llm.chatStream(
        {
          messages: [
            { role: 'system', content: finalSystemPrompt },
            ...historyMessages,
            { role: 'user', content: userInput }
          ],
          modelKey: config.defaultModelKey,
          temperature: 0.7,
          maxTokens: config.agent.outputReserve,
          signal: this.signal,
          timeoutMs: 8 * 60 * 1000
        },
        {
          onChunk: (delta: string) => {
            output += delta
            this.callbacks.onChunk?.(delta)
          },
          onDone: () => {
            this.totalOutputTokens += countTextTokens(output)
          },
          onError: (error: Error) => {
            throw error
          }
        }
      )
      this.totalInputTokens += countTextTokens(finalSystemPrompt) + countTextTokens(userInput)

      // 添加一个 Think 步骤记录
      this.createThinkStep('问题简单，直接回答', 'DIRECT_ANSWER', [])

      return { output, llmCalls }
    }

    // 复杂问题：使用 ReAct 循环
    let isComplete = false
    let finalOutput = ''

    for (let i = 0; i < MAX_ITERATIONS && !isComplete; i++) {
      if (this.signal?.aborted) {
        throw new Error('aborted')
      }

      // ── Think 步骤 ──
      this.callbacks.onStateChange?.('thinking')

      const thinkPrompt = this.buildThinkPrompt(userInput, reactSteps, toolNames)
      llmCalls++
      this.modelsUsed.add(config.defaultModelKey)

      const thinkResponse = await llm.chat({
        messages: [
          { role: 'system', content: finalSystemPrompt },
          ...historyMessages,
          { role: 'user', content: thinkPrompt }
        ],
        modelKey: config.defaultModelKey,
        temperature: 0.3,
        maxTokens: Math.min(config.agent.outputReserve * 2, 8000),
        signal: this.signal,
        timeoutMs: 30 * 1000
      })

      this.totalInputTokens += countTextTokens(finalSystemPrompt) + countTextTokens(thinkPrompt)
      this.totalOutputTokens += countTextTokens(thinkResponse)

      // 解析 ReAct 响应
      const parsed = this.parseReActResponse(thinkResponse)

      // 创建 Think 步骤
      this.createThinkStep(
        parsed.thought,
        parsed.action,
        toolNames.length > 0 ? toolNames : undefined
      )

      // 检查是否完成
      if (parsed.action === 'FINAL_ANSWER' || parsed.action === 'DIRECT_ANSWER') {
        finalOutput = parsed.actionInput || parsed.content || thinkResponse

        // 流式输出最终回答
        if (finalOutput) {
          const chunks = this.splitIntoChunks(finalOutput, 3) // 每次发 3 个字符
          for (const chunk of chunks) {
            this.callbacks.onChunk?.(chunk)
            await new Promise(r => setTimeout(r, 10)) // 轻微延迟模拟流式
          }
        }

        reactSteps.push({
          think: parsed.thought,
          action: 'FINAL_ANSWER',
          actionInput: {},
          observation: finalOutput
        })

        isComplete = true
        break
      }

      // ── Act 步骤（工具调用） ──
      this.callbacks.onStateChange?.('working')

      if (parsed.action && toolNames.includes(parsed.action)) {
        let toolParams: Record<string, unknown> = {}
        try {
          toolParams = parsed.actionInput ? JSON.parse(parsed.actionInput) : {}
        } catch {
          toolParams = { raw: parsed.actionInput }
        }

        const toolCall = {
          id: `call-${Date.now()}`,
          toolId: parsed.action,
          parameters: toolParams
        }

        const toolResult = await executeAction(toolCall, this.signal)

        // 创建 Act 步骤
        this.createActStep(parsed.action, toolParams, toolResult)

        // 创建 Observe 步骤
        const observeDetail: ObserveDetail = {
          type: 'observe',
          analysis: toolResult.success
            ? `工具 ${parsed.action} 执行成功: ${toolResult.resultSummary}`
            : `工具 ${parsed.action} 执行失败: ${toolResult.error || toolResult.resultSummary}`,
          isComplete: false,
          remainingSteps: []
        }
        this.createStep('observe', `Observe #${i + 1}`, '👁', observeDetail)

        reactSteps.push({
          think: parsed.thought,
          action: parsed.action,
          actionInput: toolParams,
          observation: toolResult.resultSummary
        })
      } else {
        // 未知动作，当作最终回答
        finalOutput = parsed.content || parsed.thought || thinkResponse
        if (finalOutput) {
          const chunks = this.splitIntoChunks(finalOutput, 3)
          for (const chunk of chunks) {
            this.callbacks.onChunk?.(chunk)
            await new Promise(r => setTimeout(r, 10))
          }
        }

        reactSteps.push({
          think: parsed.thought,
          action: 'FINAL_ANSWER',
          actionInput: {},
          observation: finalOutput
        })

        isComplete = true
        break
      }
    }

    // 如果循环结束仍未完成，生成一个总结
    if (!isComplete) {
      finalOutput = this.getLoopExhaustedResponse(userInput, reactSteps)
      this.callbacks.onChunk?.(finalOutput)
    }

    return { output: finalOutput, llmCalls }
  }

  /** 构建 ReAct 系统提示词 */
  private buildReActSystemPrompt(toolNames: string[]): string {
    const basePrompt = getSystemPrompt()
    const toolsSection = toolNames.length > 0
      ? `\n\n可用工具: ${toolNames.join(', ')}`
      : '\n\n当前没有可用工具，请直接回答用户问题。'

    return `${basePrompt}

你是一个 ReAct Agent，使用 Think-Act-Observe 模式处理问题。

请严格按照以下格式回复：

THOUGHT: <分析问题和推理过程>
ACTION: FINAL_ANSWER
CONTENT: <给用户的最终回答>

${toolNames.length > 0 ? `如果需要使用工具：
THOUGHT: <分析为什么需要工具>
ACTION: <工具名称>
ACTION_INPUT: <JSON 格式的工具参数>` : ''}

规则：
- 简单问题直接用 FINAL_ANSWER 回答
- 复杂问题先思考再决定是否需要工具
- 回答要简洁、准确、有帮助${toolsSection}`
  }

  /** 构建 Think 步骤的 prompt */
  private buildThinkPrompt(
    userInput: string,
    previousSteps: ReActStep[],
    toolNames: string[]
  ): string {
    let prompt = `用户问题: ${userInput}\n`

    if (previousSteps.length > 0) {
      prompt += '\n之前的推理步骤:\n'
      previousSteps.forEach((step, i) => {
        prompt += `Step ${i + 1}:\n`
        prompt += `  Think: ${step.think}\n`
        prompt += `  Action: ${step.action}\n`
        if (step.observation) {
          prompt += `  Observe: ${step.observation}\n`
        }
      })
    }

    prompt += '\n请继续推理。如果已有足够信息回答问题，使用 FINAL_ANSWER。'

    return prompt
  }

  /** 解析 ReAct 格式响应 */
  private parseReActResponse(response: string): {
    thought: string
    action: string
    actionInput: string
    content: string
  } {
    // 尝试匹配标准 ReAct 格式
    const thoughtMatch = response.match(THOUGHT_RE)
    const actionMatch = response.match(ACTION_RE)
    const actionInputMatch = response.match(ACTION_INPUT_RE)
    const contentMatch = response.match(CONTENT_RE)

    const thought = thoughtMatch ? thoughtMatch[1].trim() : response.slice(0, 500)
    const action = actionMatch ? actionMatch[1].trim() : 'FINAL_ANSWER'
    const actionInput = actionInputMatch ? actionInputMatch[1].trim() : ''
    const content = contentMatch ? contentMatch[1].trim() : ''

    return { thought, action, actionInput, content }
  }

  /** 将文本分割为块（模拟流式输出） */
  private splitIntoChunks(text: string, size: number): string[] {
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size))
    }
    return chunks
  }

  /** 循环耗尽时的响应 */
  private getLoopExhaustedResponse(userInput: string, steps: ReActStep[]): string {
    return `我在处理"${userInput.slice(0, 50)}"时经过了 ${steps.length} 步推理，但未能得出完整结论。\n\n已完成的推理步骤:\n${steps.map((s, i) => `${i + 1}. ${s.think.slice(0, 100)}`).join('\n')}`
  }

  /** 未配置 LLM 时的 mock 响应 */
  private getMockResponse(userInput: string): string {
    return `收到你的消息："${userInput}"\n\n⚠️ 尚未配置 LLM Provider。请通过以下步骤配置：\n\n1. 右键点击托盘图标\n2. 选择「设置」\n3. 填入 API Base URL 和 API Key\n4. 选择模型\n\n配置完成后即可进行真实对话。`
  }

  // ═════════════════════════════════════════════════════════
  //  步骤实现
  // ═════════════════════════════════════════════════════════

  private async stepIntent(userInput: string, _context: AgentContext): Promise<{ complexity: 'low' | 'medium' | 'high'; requiresPlanning: boolean }> {
    const intentResult = await parseIntent(userInput, this.signal)
    const detail = toIntentDetail(userInput, intentResult)
    this.createStep('intent', '意图识别', '📝', detail)
    return { complexity: intentResult.complexity, requiresPlanning: intentResult.requiresPlanning }
  }

  /**
   * 记忆检索 — 向量语义搜索相关历史记忆
   *
   * 使用 Embedding 向量搜索历史对话记忆，
   * 按相关度 + 时间衰减 + 重要性综合排序。
   * 检索到的记忆会注入到上下文中供 LLM 参考。
   */
  private async stepMemoryRetrieval(
    query: string,
    context: AgentContext
  ): Promise<MemorySearchResult[]> {
    const topK = context.settings.maxMemoriesRetrieved

    const memories = await memoryManager.retrieve(
      query,
      { topK, minScore: 0.3, dedupThreshold: 0.92 },
      context.sessionId  // 排除当前会话的记忆
    )

    // 格式化记忆详情用于追踪展示
    const retrieved = memories.map(m => ({
      id: m.memory.id,
      content: 'content' in m.memory
        ? m.memory.content
        : ('outcome' in m.memory ? m.memory.outcome : ''),
      score: parseFloat(m.score.toFixed(4)),
      source: 'source' in m.memory ? m.memory.source : 'episodic',
      age: this.formatAge(m.memory.timestamp || m.memory.createdAt),
      confidence: m.vectorScore
    }))

    const totalTokens = retrieved.reduce(
      (sum, m) => sum + countTextTokens(m.content),
      0
    )

    const detail: MemoryDetail = {
      type: 'memory',
      searchParams: { topK, minScore: 0.3 },
      retrieved,
      totalTokens
    }
    this.createStep('memory', `记忆检索${memories.length > 0 ? ` (${memories.length})` : ''}`, '🧠', detail)

    // 将检索到的记忆注入上下文（作为 system 消息）
    if (memories.length > 0) {
      const memoryText = this.formatMemoriesForContext(memories)
      if (memoryText) {
        // 在系统提示之后插入记忆
        const systemIdx = context.messages[0]?.role === 'system' ? 0 : -1
        if (systemIdx >= 0) {
          context.messages.splice(1, 0, {
            role: 'system',
            content: memoryText
          })
        } else {
          context.messages.unshift({
            role: 'system',
            content: memoryText
          })
        }
      }
    }

    return memories
  }

  /** 格式化记忆为上下文文本 */
  private formatMemoriesForContext(memories: MemorySearchResult[]): string {
    const lines = memories.map((m, i) => {
      const content = 'content' in m.memory
        ? m.memory.content
        : ('outcome' in m.memory ? m.memory.outcome : '')
      const intent = 'userIntent' in m.memory ? m.memory.userIntent : ''
      const score = (m.score * 100).toFixed(0)
      return `[${i + 1}] (相关度 ${score}%) ${intent ? 'Q: ' + intent + '\n' : ''}A: ${content.slice(0, 300)}`
    })
    return `[相关历史记忆]
以下是与你当前问题相关的历史对话记忆，供参考：

${lines.join('\n\n')}`
  }

  /** 格式化时间为人类可读的相对时间 */
  private formatAge(timestamp: number): string {
    const diff = Date.now() - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (days > 0) return `${days}天前`
    if (hours > 0) return `${hours}小时前`
    if (minutes > 0) return `${minutes}分钟前`
    return '刚刚'
  }

  /**
   * 技能匹配 — 根据用户查询匹配已有技能
   *
   * 使用向量相似度匹配最相关的技能，
   * 将匹配的技能内容注入 LLM 上下文。
   */
  private async stepSkillMatch(
    query: string,
    context: AgentContext
  ): Promise<TraceStep> {
    const topK = context.settings.maxSkillsLoaded

    const matches = await skillStore.match(query, { topK, minScore: 0.6 }, this.signal)
    this.matchedSkills = matches

    // 格式化匹配结果用于追踪展示
    const candidates = matches.map(m => ({
      id: m.skill.id,
      name: m.skill.name,
      description: m.skill.description,
      score: parseFloat(m.score.toFixed(4)),
      loaded: m.loaded,
      reason: m.reason
    }))

    const loadedTokens = matches.reduce(
      (sum, m) => sum + countTextTokens(m.skill.content),
      0
    )

    const detail: SkillMatchDetail = {
      type: 'skill_match',
      candidates,
      loadedTokens
    }
    this.createStep(
      'skill_match',
      `技能匹配${matches.length > 0 ? ` (${matches.length})` : ''}`,
      '🔧',
      detail
    )

    // 将匹配的技能注入上下文（作为 system 消息）
    if (matches.length > 0) {
      const skillText = skillStore.formatForContext(matches)
      if (skillText) {
        // 在最后一条 system 消息之后插入
        let lastSystemIdx = -1
        for (let i = 0; i < context.messages.length; i++) {
          if (context.messages[i].role === 'system') lastSystemIdx = i
        }
        context.messages.splice(lastSystemIdx + 1, 0, {
          role: 'system',
          content: skillText
        })
      }
    }

    return this.steps[this.steps.length - 1]
  }

  /**
   * 上下文管理 — Token 预算分配 + 滑动窗口 + 摘要压缩
   *
   * 当对话历史超过预算时，自动将旧消息压缩为摘要，
   * 保留最近 N 条消息完整，确保上下文在 Token 限制内。
   */
  private async stepContextManagement(
    userInput: string,
    context: AgentContext
  ): Promise<ManagedContext> {
    const manager = new ContextManager({
      maxTokens: context.settings.maxTokens,
      outputReserve: context.settings.outputReserve,
      recentMessageWindow: context.settings.recentMessageWindow,
      compressionThreshold: context.settings.compressionThreshold
    })

    const managed = await manager.manage(
      context.messages,
      userInput,
      context.sessionId,
      this.signal
    )

    // 如果触发了压缩，在追踪中记录摘要信息
    if (managed.compressed && managed.summary) {
      this.createStep('stats', '上下文压缩', '🗜️', {
        type: 'stats',
        contextBreakdown: {
          systemPrompt: managed.breakdown.systemPrompt,
          toolDefinitions: 0,
          memories: 0,
          skills: 0,
          history: managed.breakdown.summary + managed.breakdown.history,
          userInput: managed.breakdown.userInput,
          outputReserve: managed.breakdown.outputReserve,
          total: managed.breakdown.total,
          budget: managed.breakdown.budget
        }
      })
    }

    return managed
  }

  private createThinkStep(reasoning: string, decision: string, toolsConsidered?: string[]): void {
    const detail: ThinkDetail = {
      type: 'think',
      reasoning,
      decision,
      toolsConsidered
    }
    this.createStep('think', `Think`, '💭', detail)
  }

  private createActStep(
    toolName: string,
    params: Record<string, unknown>,
    result: import('../tools/types').ToolResult
  ): void {
    const detail = toActDetail(toolName, params, result, false)
    this.createStep('act', `Act: ${toolName}`, '🔍', detail)
  }

  private async stepReflect(
    userInput: string,
    finalOutput: string,
    reactSteps: ReActStep[],
    _context: AgentContext
  ): Promise<void> {
    const reflectDetail = await reflect(userInput, finalOutput, reactSteps, this.signal)
    this.createStep('reflect', '反思', '🔄', reflectDetail)
  }

  /**
   * 记忆存储 — 将本次对话存储为情景记忆
   *
   * 自动生成 Embedding 并检测重复，
   * 将用户意图、Agent 回复和执行过程持久化到记忆库。
   */
  private async stepStore(
    input: string,
    output: string,
    context: AgentContext
  ): Promise<void> {
    const actions = this.steps
      .filter(s => s.type === 'act')
      .map(s => s.name)

    const successScore = this.steps.find(s => s.type === 'reflect')
      ? (() => {
          const reflectStep = this.steps.find(s => s.type === 'reflect')
          const detail = reflectStep?.detail as { selfScore?: number }
          return detail?.selfScore || 3
        })()
      : 3

    const episodicMemory = await memoryManager.storeEpisodic(
      input,
      output,
      actions,
      successScore,
      {
        sessionId: context.sessionId,
        modelUsed: Array.from(this.modelsUsed).join(','),
        skillsUsed: this.matchedSkills.map(m => m.skill.name),
        tags: [],
        signal: this.signal
      }
    )

    this.createStep('store', '记忆存储', '💾', {
      type: 'store',
      episodicMemoryId: episodicMemory?.id || `ep-${Date.now()}`,
      newSemanticMemories: []
    })
  }

  /**
   * 进化检测 — 模式检测 + 自动技能生成
   *
   * 记录本次查询到模式检测器，检查是否出现重复模式。
   * 如果检测到重复模式（3+ 次相似请求），自动生成可复用技能。
   */
  private async stepEvolution(
    userInput: string,
    finalOutput: string,
    complexity: 'low' | 'medium' | 'high',
    context: AgentContext
  ): Promise<void> {
    // 记录查询到模式检测器
    await patternDetector.recordQuery(
      userInput,
      complexity,
      this.steps.filter(s => s.type === 'act').map(s => s.name),
      context.sessionId,
      this.signal
    )

    // 检测模式
    const detection = patternDetector.detect()

    if (!detection.detected || detection.patterns.length === 0) return

    // 对每个检测到的模式生成技能
    for (const pattern of detection.patterns) {
      const skillId = await skillStore.createFromPattern(pattern, this.signal)

      if (skillId) {
        // 触发宠物进化状态
        this.callbacks.onStateChange?.('evolving')

        // 记录进化事件到追踪
        this.createStep('store', `进化: ${pattern.suggestedSkillName}`, '🌟', {
          type: 'store',
          episodicMemoryId: skillId,
          newSemanticMemories: [],
          skillProposal: {
            skillName: pattern.suggestedSkillName,
            confidence: pattern.similarity,
            sourceEpisodes: pattern.occurrences
          }
        })

        console.log(`[Evolution] Auto-generated skill: ${skillId} (${pattern.suggestedSkillName})`)
      }
    }
  }

  /**
   * Step 8.6: Prompt 优化检测
   * 检查负反馈是否达到阈值，如果是则自动优化系统 Prompt
   */
  private async stepPromptOptimization(context: AgentContext): Promise<void> {
    // 检查是否达到优化阈值
    if (!shouldOptimizePrompt()) return

    // 触发优化
    const result = await runPromptOptimization(this.signal)

    if (result.success) {
      // 触发宠物进化状态
      this.callbacks.onStateChange?.('evolving')

      // 记录到追踪步骤
      this.createStep('store', `Prompt 优化: v${result.oldVersion} → v${result.newVersion}`, '🔧', {
        type: 'store',
        episodicMemoryId: result.newVersionId,
        newSemanticMemories: [],
        skillProposal: {
          skillName: `Prompt v${result.newVersion}`,
          confidence: 1.0,
          sourceEpisodes: [result.reason]
        }
      })

      console.log(
        `[PromptOptimization] v${result.oldVersion} → v${result.newVersion} via ${result.method}:`,
        result.changes
      )
    }
  }

  private async stepStats(context: AgentContext): Promise<void> {
    // 优先使用上下文管理器的真实 token 分布
    const breakdown = this.managedContext?.breakdown
    const contextBreakdown = breakdown
      ? {
          systemPrompt: breakdown.systemPrompt,
          toolDefinitions: 0,
          memories: 0,
          skills: 0,
          history: breakdown.summary + breakdown.history,
          userInput: breakdown.userInput,
          outputReserve: breakdown.outputReserve,
          total: this.totalInputTokens + this.totalOutputTokens,
          budget: breakdown.budget
        }
      : {
          systemPrompt: countTextTokens(getSystemPrompt()),
          toolDefinitions: 0,
          memories: 0,
          skills: 0,
          history: countTextTokens(context.messages.map(m => m.content).join('')),
          userInput: 0,
          outputReserve: context.settings.outputReserve,
          total: this.totalInputTokens + this.totalOutputTokens,
          budget: context.settings.maxTokens
        }

    this.createStep('stats', 'Token 统计', '📊', {
      type: 'stats',
      contextBreakdown
    })
  }

  private stepComplete(llmCalls: number): void {
    this.createStep('complete', '完成', '✅', {
      type: 'complete',
      totalDuration: Date.now() - this.startTime,
      toolCalls: this.steps.filter(s => s.type === 'act').length,
      llmCalls
    })
  }

  // ═════════════════════════════════════════════════════════
  //  辅助方法
  // ═════════════════════════════════════════════════════════

  private createStep(
    type: TraceStep['type'],
    name: string,
    icon: string,
    detail: StepDetail
  ): TraceStep {
    const now = Date.now()
    const step: TraceStep = {
      id: `step-${this.stepIndex}-${now}`,
      index: this.stepIndex++,
      type,
      name,
      icon,
      startTime: now,
      endTime: now,
      duration: 0,
      status: 'completed',
      detail
    }
    this.steps.push(step)
    this.callbacks.onStepStart?.(step)
    this.callbacks.onStepComplete?.(step)
    return step
  }

  private estimateCost(): number {
    // 粗略估算: 输入 $0.01/1K + 输出 $0.03/1K
    return (
      (this.totalInputTokens / 1000) * 0.01 +
      (this.totalOutputTokens / 1000) * 0.03
    )
  }
}

/**
 * 创建 Agent 上下文
 */
export function createAgentContext(
  sessionId: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  settings?: Partial<AgentContext['settings']>
): AgentContext {
  return {
    sessionId,
    messages,
    tokenBudget: settings?.maxTokens || 32000,
    settings: {
      maxTokens: settings?.maxTokens || 32000,
      outputReserve: settings?.outputReserve || 4000,
      recentMessageWindow: settings?.recentMessageWindow || 10,
      compressionThreshold: settings?.compressionThreshold || 16000,
      maxMemoriesRetrieved: settings?.maxMemoriesRetrieved || 5,
      maxSkillsLoaded: settings?.maxSkillsLoaded || 3
    }
  }
}
