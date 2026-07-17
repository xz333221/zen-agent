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
import { executeAction, getToolNames, getToolDefs, toActDetail } from './action-executor'
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
import type { ToolDef } from '../tools/types'

const MAX_ITERATIONS = 50  // 最大循环次数（大模型上下文充足，放宽限制）

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
  // 纠偏机制重试计数器（防止无限循环）
  private nudge1Count = 0  // 纠偏机制1：未使用工具就回答
  private nudge15Count = 0  // 纠偏机制1.5：复用旧数据
  private nudge2Count = 0  // 纠偏机制2：不信任工具结果
  private nudge3Count = 0  // 纠偏机制3：搜索结果不足
  private nudge4Count = 0  // 纠偏机制4：推卸工作给用户
  private nudge5Count = 0  // 纠偏机制5：声称"我不能/没有能力"但实际有工具可用
  private readonly NUDGE_MAX = 2  // 每个纠偏机制最多触发 2 次
  // 工具需求评估结果（在 ReAct 循环前通过 LLM 评估，供 nudge 和 Think prompt 使用）
  private toolAssessment: { needsTool: boolean; suggestedTools: string[]; reason: string } = { needsTool: false, suggestedTools: [], reason: '' }

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
    this.nudge1Count = 0
    this.nudge15Count = 0
    this.nudge2Count = 0
    this.nudge3Count = 0
    this.nudge4Count = 0
    this.nudge5Count = 0
    this.toolAssessment = { needsTool: false, suggestedTools: [], reason: '' }

    console.log(`\n${'═'.repeat(60)}`)
    console.log(`[AgentLoop] START — input="${userInput.slice(0, 80)}${userInput.length > 80 ? '...' : ''}"`)
    console.log(`[AgentLoop] sessionId=${context.sessionId}, msgCount=${context.messages.length}`)

    try {
      // ── Step 1: 意图识别 ──
      this.callbacks.onStateChange?.('thinking')
      const t1 = Date.now()
      const intentResult = await this.stepIntent(userInput, context)
      console.log(`[AgentLoop] Step 1 (Intent) ✓ ${Date.now() - t1}ms — complexity=${intentResult.complexity}, requiresPlanning=${intentResult.requiresPlanning}`)

      // ── Step 2: 记忆检索（向量语义搜索） ──
      const t2 = Date.now()
      this.retrievedMemories = await this.stepMemoryRetrieval(userInput, context)
      console.log(`[AgentLoop] Step 2 (Memory) ✓ ${Date.now() - t2}ms — retrieved=${this.retrievedMemories.length} memories`)

      // ── Step 3: 技能匹配 ──
      const t3 = Date.now()
      const skillStep = await this.stepSkillMatch(userInput, context)
      console.log(`[AgentLoop] Step 3 (Skill) ✓ ${Date.now() - t3}ms — matched=${this.matchedSkills.length} skills`)

      // ── Step 3.5: 上下文管理（Token 预算 + 滑动窗口 + 摘要压缩） ──
      const t35 = Date.now()
      this.managedContext = await this.stepContextManagement(userInput, context)
      console.log(`[AgentLoop] Step 3.5 (Context) ✓ ${Date.now() - t35}ms — compressed=${this.managedContext?.compressed || false}`)

      // ── Step 4-6: ReAct 循环 或 Coordinator 多 Agent 协作 ──
      const reactSteps: ReActStep[] = []
      let finalOutput = ''
      let llmCallCount = 0

      // 检测是否为浏览器自动化任务 — 浏览器任务必须走 ReAct 循环（有完整的浏览器工具和多步调用能力）
      const browserKeywords = [
        '浏览器', 'browser', '打开网页', '打开网站', 'navigate', '网页内容',
        '截图', 'screenshot', '点击按钮', '点击元素', 'click',
        '输入框', '输入文字', 'type', '滚动页面', 'scroll',
        'browser_navigate', 'browser_click', 'browser_get_text', 'browser_type',
        'browser_screenshot', 'browser_eval', 'browser_scroll', 'browser_close'
      ]
      const isBrowserTask = browserKeywords.some(kw =>
        userInput.toLowerCase().includes(kw.toLowerCase())
      )

      console.log(`[AgentLoop] Step 4 — isBrowserTask=${isBrowserTask}, requiresPlanning=${intentResult.requiresPlanning}, complexity=${intentResult.complexity}`)

      // 如果需要规划且复杂度高，且不是浏览器任务，使用 Coordinator 进行多 Agent 协作
      // 浏览器任务走 ReAct 循环，因为 Coordinator 的子 Agent 没有浏览器工具且不支持多步工具调用
      if (intentResult.requiresPlanning && intentResult.complexity === 'high' && !isBrowserTask) {
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

        // 检测 Coordinator 是否所有子任务都失败了（返回的是错误消息而非真实结果）
        const allTasksFailed = coordResult.plan && coordResult.plan.tasks.length > 0 &&
          coordResult.plan.tasks.every(t => t.status === 'failed' || t.status === 'skipped')

        if (coordResult.output && !allTasksFailed) {
          finalOutput = coordResult.output
          // 流式输出协调器结果
          const chunks = this.splitIntoChunks(finalOutput, 3)
          for (const chunk of chunks) {
            this.callbacks.onChunk?.(chunk)
            await new Promise(r => setTimeout(r, 10))
          }
          llmCallCount = 1 // 至少一次 LLM 调用
        } else {
          // 协调器未生成输出或所有子任务都失败，回退到 ReAct
          console.log(`[AgentLoop] Coordinator ${allTasksFailed ? 'all tasks failed' : 'no output'}, falling back to ReAct`)
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
        const t4 = Date.now()
        const result = await this.runReActLoop(userInput, context, reactSteps, intentResult.complexity)
        console.log(`[AgentLoop] Step 4 (ReAct) ✓ ${Date.now() - t4}ms — llmCalls=${result.llmCalls}, output=${result.output.length}chars`)
        finalOutput = result.output
        llmCallCount = result.llmCalls
      } else {
        // 未配置 LLM，直接返回 mock 响应
        finalOutput = this.getMockResponse(userInput)
        this.callbacks.onChunk?.(finalOutput)
      }

      // ── Step 7: 反思 ──
      this.callbacks.onStateChange?.('thinking')
      // 安全防护：确保 finalOutput 是字符串（防止上游返回 Promise/对象等非字符串类型）
      const safeFinalOutput = typeof finalOutput === 'string' ? finalOutput : String(finalOutput ?? '')
      const t7 = Date.now()
      await this.stepReflect(userInput, safeFinalOutput, reactSteps, context)
      console.log(`[AgentLoop] Step 7 (Reflect) ✓ ${Date.now() - t7}ms`)

      // ── Step 8: 记忆存储 ──
      const t8 = Date.now()
      await this.stepStore(userInput, safeFinalOutput, context)
      console.log(`[AgentLoop] Step 8 (Store) ✓ ${Date.now() - t8}ms`)

      // ── Step 8.5: 进化检测（模式检测 + 技能生成） ──
      await this.stepEvolution(userInput, safeFinalOutput, intentResult.complexity, context)

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

      const totalElapsed = Date.now() - this.startTime
      console.log(`[AgentLoop] DONE ✓ total=${totalElapsed}ms, inputTokens=${this.totalInputTokens}, outputTokens=${this.totalOutputTokens}, llmCalls=${llmCallCount}`)
      console.log(`${'═'.repeat(60)}\n`)

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
      const elapsed = Date.now() - this.startTime
      const error = err as Error
      console.error(`[AgentLoop] ERROR ✗ after ${elapsed}ms:`, error?.message || error)
      if (error?.stack) {
        console.error('[AgentLoop] stack:', error.stack.split('\n').slice(0, 8).join('\n'))
      }
      this.callbacks.onError?.(error)
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

    // ── 工具需求评估（LLM 驱动，替代关键词匹配）──
    // 在 ReAct 循环开始前，用 LLM 评估用户问题是否需要工具
    // 先用 shouldUseTool 快速预筛：关键词命中则跳过 LLM 评估（节省 API 调用）
    // 关键词未命中时，用 LLM 做语义级判断
    if (toolNames.length > 0) {
      const fastCheck = this.shouldUseTool(userInput, toolNames, historyMessages)
      if (fastCheck) {
        this.toolAssessment = { needsTool: true, suggestedTools: [], reason: '关键词快速匹配命中' }
        console.log('[AgentLoop] Tool assessment: fast-path match (skipped LLM call)')
      } else {
        console.log('[AgentLoop] Tool assessment: running LLM-based assessment...')
        const tAssess = Date.now()
        this.toolAssessment = await this.assessToolNeed(userInput, getToolDefs(), historyMessages)
        llmCalls++
        console.log(`[AgentLoop] Tool assessment ✓ ${Date.now() - tAssess}ms — needsTool=${this.toolAssessment.needsTool}`)
      }
    }

    console.log(`[AgentLoop] ReAct loop starting — complexity=${complexity}, maxIterations=${MAX_ITERATIONS}, tools=[${toolNames.join(', ')}]`)

    for (let i = 0; i < MAX_ITERATIONS && !isComplete; i++) {
      if (this.signal?.aborted) {
        console.warn('[AgentLoop] ReAct loop aborted by signal')
        throw new Error('aborted')
      }

      // ── Think 步骤 ──
      this.callbacks.onStateChange?.('thinking')

      const thinkPrompt = this.buildThinkPrompt(userInput, reactSteps, toolNames)
      llmCalls++
      this.modelsUsed.add(config.defaultModelKey)

      console.log(`[AgentLoop] ReAct iteration ${i + 1}/${MAX_ITERATIONS} — Think step starting...`)
      const thinkStart = Date.now()

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
        timeoutMs: 120 * 1000  // 120s — 之前 30s 太短导致超时被误判为 "已停止生成"
      })

      const thinkElapsed = Date.now() - thinkStart
      this.totalInputTokens += countTextTokens(finalSystemPrompt) + countTextTokens(thinkPrompt)
      this.totalOutputTokens += countTextTokens(thinkResponse)

      // 解析 ReAct 响应
      const parsed = this.parseReActResponse(thinkResponse)
      console.log(`[AgentLoop] ReAct iteration ${i + 1} — Think ✓ ${thinkElapsed}ms, action=${parsed.action}, response=${thinkResponse.length}chars`)

      // 创建 Think 步骤
      this.createThinkStep(
        parsed.thought,
        parsed.action,
        toolNames.length > 0 ? toolNames : undefined
      )

      // 检查是否完成
      if (parsed.action === 'FINAL_ANSWER' || parsed.action === 'DIRECT_ANSWER') {
        // ── 纠偏机制 1：未使用工具就回答 ──
        // 如果第一轮 LLM 就想直接回答（没用过任何工具），但用户的问题明显需要本地操作，
        // 注入强提醒让 LLM 使用 terminal/file_reader 等工具，然后重试
        if (i === 0 && reactSteps.length === 0 && this.nudge1Count < this.NUDGE_MAX && this.toolAssessment.needsTool) {
          this.nudge1Count++
          console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER without tools, but user input suggests tool use. Injecting nudge (${this.nudge1Count}/${this.NUDGE_MAX}) and retrying.`)

          const suggestedHint = this.toolAssessment.suggestedTools.length > 0
            ? `\n💡 系统评估建议使用的工具: ${this.toolAssessment.suggestedTools.join(', ')}（原因: ${this.toolAssessment.reason}）`
            : ''

          // 不输出给用户，直接注入一个观察结果让 LLM 重新思考
          reactSteps.push({
            think: parsed.thought,
            action: 'FINAL_ANSWER',
            actionInput: {},
            observation: `[系统提醒] 你直接给出了最终答案，但你还没有尝试使用工具。你运行在用户的本地电脑上（不是远程服务器），你有 terminal 工具可以执行命令。请重新思考：用户想要什么操作？你应该用哪个工具？${suggestedHint}\n请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用 terminal 或 file_reader 等工具完成用户的请求。`
          })

          // 移除刚创建的 Think 步骤（因为要重试）
          this.steps.pop()

          // 不标记完成，继续循环
          continue
        }

        // ── 纠偏机制 1.5：未搜索就输出具体数据（复用旧对话数据） ──
        // LLM 没有使用任何工具，但最终回答中包含具体数据（数字、时间戳、表格等），
        // 说明它直接复用了对话历史中的旧数据，而不是搜索获取最新数据。
        // 这种情况在 follow-up 请求中尤其常见（如用户说"给我准确的数据"）。
        const finalText = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
        const hasExecutedTools = reactSteps.some(s => s.action !== 'FINAL_ANSWER' && s.action !== 'DIRECT_ANSWER')
        const hasNotUsedTools = reactSteps.length === 0 || !hasExecutedTools
        if (hasNotUsedTools && i === 0 && this.nudge15Count < this.NUDGE_MAX && i < MAX_ITERATIONS - 2) {
          const answerText = (parsed.actionInput || parsed.content || thinkResponse || '')
          const answerLower = answerText.toLowerCase()

          // 检测回答中是否包含具体数据模式
          const hasSpecificData =
            // 包含具体数字（如 3993.33, -0.07%, 4027.26 等）
            /\d{3,}\.\d{2}/.test(answerText) ||
            // 包含时间戳（如 09:23, 11:40, 15:00 等）
            /\d{1,2}:\d{2}/.test(answerText) ||
            // 包含"数据未获取到"等放弃措辞
            answerLower.includes('数据未获取') || answerLower.includes('数据加载中') ||
            // 包含表格格式（markdown table）
            /\|.*\d.*\|/.test(answerText) ||
            // 包含具体价格/点数
            /点|元|港元|美元/.test(answerText) && /\d{3,}/.test(answerText)

          // 检测对话历史中是否包含实时数据话题
          let hasRealtimeContext = false
          if (historyMessages && historyMessages.length > 0) {
            const recentContext = historyMessages
              .slice(-6)
              .map(m => m.content)
              .join(' ')
              .toLowerCase()
            const realtimeTopics = [
              '股价', '大盘', '指数', '上证', '深证', '创业板', 'a股', '股票',
              '行情', '涨跌', '收盘', '开盘', '盘中', '天气', '气温', '汇率',
              '油价', '金价', '新闻', '今日行情',
            ]
            hasRealtimeContext = realtimeTopics.some(kw => recentContext.includes(kw))
          }

          if (hasSpecificData && hasRealtimeContext) {
            this.nudge15Count++
            console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER contains specific data without tool use. Likely reusing stale conversation data. Injecting nudge (${this.nudge15Count}/${this.NUDGE_MAX}).`)

            reactSteps.push({
              think: parsed.thought,
              action: 'FINAL_ANSWER',
              actionInput: {},
              observation: `[系统提醒] 你的回答中包含具体数据（数字、时间戳等），但你没有使用任何工具搜索获取最新数据。这些数据很可能来自之前对话中的旧信息，可能已经过时。

⚠️ 重要：不要直接复用对话历史中的数据来回答用户！当用户要求"准确的数据"或"更新"时，你必须使用 web_search 工具重新搜索获取最新数据。

请重新思考：
1. 用户想要什么数据？（如大盘指数、股价、天气等）
2. 你应该用什么搜索关键词？（简洁精准，如"上证指数 今日行情"）
3. 请使用 web_search 工具搜索，然后基于搜索结果回答。

请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用 web_search 工具获取最新数据。`
            })

            // 移除刚创建的 Think 步骤（因为要重试）
            this.steps.pop()

            // 不标记完成，继续循环
            continue
          }
        }

        // ── 纠偏机制 2：使用了工具但不信任结果 ──
        // LLM 成功执行了工具，但在最终回答中声称"结果不可信"、"在沙箱中"等。
        // 这种情况下，注入提醒让 LLM 信任工具结果。
        // （finalText 和 hasExecutedTools 已在纠偏机制 1.5 中声明）
        const distrustPatterns = [
          '沙箱', 'sandbox', '不可信', '并不真实', '不真实', '虚假',
          '无法访问', '不能真正', '不能访问', '无法真正',
          '我没有你的', '我无法替你', '本地 powershell',
          // 注意：'远程' 和 '容器' 单独匹配会误触发
          // （如"远程仓库"是 git 术语），改用更具体的短语
          '远程服务器', '远程容器', '远程环境', '远程机器',
          '容器中', 'container环境', 'docker容器',
          '不是真的', '不是真正', '并非真正', '模拟环境',
          '测试环境', 'mock', '假的', '不是实际',
        ]
        const hasDistrust = distrustPatterns.some(p => finalText.includes(p))

        if (hasExecutedTools && hasDistrust && this.nudge2Count < this.NUDGE_MAX && i < MAX_ITERATIONS - 2) {
          this.nudge2Count++
          console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER contains distrust after successful tool use. Injecting nudge (${this.nudge2Count}/${this.NUDGE_MAX}) and retrying.`)

          reactSteps.push({
            think: parsed.thought,
            action: 'FINAL_ANSWER',
            actionInput: {},
            observation: '[系统提醒] 你已经成功使用工具执行了命令，工具返回的结果是真实可信的。你运行在用户的本地电脑上（不是沙箱、不是远程容器），terminal 工具的 stdout 是命令在用户电脑上的实际输出。命令执行成功（exit 0）就代表操作真的完成了。请不要质疑工具结果，直接基于工具的输出向用户报告操作结果即可。'
          })

          // 移除刚创建的 Think 步骤（因为要重试）
          this.steps.pop()

          // 不标记完成，继续循环
          continue
        }

        // ── 纠偏机制 3：搜索结果不足就放弃 ──
        // LLM 执行了 web_search，但最终回答中包含"数据加载中""盘中""尚未稳定"等措辞，
        // 说明搜索结果没有获取到用户需要的具体数据，但 LLM 直接放弃了。
        // 此时注入提醒，让 LLM 换关键词再搜索或用 fetch_url 抓取具体页面。
        const searchNudgePatterns = [
          '数据加载中', '加载中', '尚未稳定', '尚未返回', '暂无数据',
          '盘中动态可查', '盘中实时刷新', '数据加载', '暂未返回',
          '未找到关于', '未找到', '无搜索结果', '搜索结果为空',
          '无法获取', '未能获取', '获取失败',
          '建议你', '建议查看', '建议你查看',  // 过度推卸给用户
        ]
        const hasSearchNudge = searchNudgePatterns.some(p => finalText.includes(p))
        const searchCount = reactSteps.filter(s => s.action === 'web_search').length
        const fetchCount = reactSteps.filter(s => s.action === 'fetch_url').length
        const hasSearchTool = toolNames.includes('web_search')
        const hasFetchTool = toolNames.includes('fetch_url')

        if (hasExecutedTools && hasSearchNudge && hasSearchTool && this.nudge3Count < this.NUDGE_MAX && i < MAX_ITERATIONS - 2) {
          // 限制纠偏次数：最多纠偏 NUDGE_MAX 次
          if (searchCount < 3) {
            this.nudge3Count++
            console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER contains "data not found" patterns after search. Injecting nudge (${this.nudge3Count}/${this.NUDGE_MAX}) to search again or fetch URL.`)

            // 收集搜索结果中的 URL，供 LLM 参考
            const searchUrls: string[] = []
            for (const step of reactSteps) {
              if (step.action === 'web_search' && step.observation) {
                const urlMatches = step.observation.match(/链接:\s*(https?:\/\/[^\s\n]+)/g)
                if (urlMatches) {
                  for (const m of urlMatches) {
                    const url = m.replace(/链接:\s*/, '').trim()
                    if (!searchUrls.includes(url)) searchUrls.push(url)
                  }
                }
              }
            }

            const urlList = searchUrls.length > 0
              ? `\n之前搜索结果中的 URL（可以用 fetch_url 抓取）：\n${searchUrls.slice(0, 5).map((u, idx) => `  ${idx + 1}. ${u}`).join('\n')}`
              : ''

            const fetchHint = hasFetchTool
              ? `\n或者使用 fetch_url 工具抓取之前搜索结果中的具体页面 URL，获取页面中的实时数据。`
              : ''

            reactSteps.push({
              think: parsed.thought,
              action: 'FINAL_ANSWER',
              actionInput: {},
              observation: `[系统提醒] 你的回答中包含"数据加载中"/"暂无数据"等措辞，说明你还没有获取到用户需要的具体数据。不要轻易放弃！请尝试以下策略：
1. 换不同关键词再搜索一次（用更短、更精准的关键词，如"上证指数 今日" 而不是 "2026年7月13日 A股大盘走势 上证指数"）
2. 如果之前搜索结果中有可能包含数据的页面 URL，使用 fetch_url 工具抓取该页面内容${fetchHint}
3. 尝试搜索数据源网站的页面（如东方财富 quote.eastmoney.com、雪球 xueqiu.com 等）

已搜索 ${searchCount} 次，已抓取 ${fetchCount} 个页面。${urlList}

请继续尝试，直到获取到实际数据或确认确实无法获取后再回答。`
            })

            // 移除刚创建的 Think 步骤（因为要重试）
            this.steps.pop()

            // 不标记完成，继续循环
            continue
          }
        }

        // ── 纠偏机制 4：推卸工作给用户 ──
        // LLM 没有使用工具（或使用后仍在回答中让用户自己去做），
        // 但回答中包含"告诉我你的 XX""你可以通过 XX 查看""你可以自己 XX"等措辞，
        // 说明它把本可以自己完成的工作推给了用户。
        // 此时注入提醒，让 LLM 使用工具自己完成。
        const lazyPatterns = [
          '告诉我你的', '告诉我你', '请告诉我', '可以告诉我',
          '你可以通过', '你可以查看', '你可以自己', '你可以用',
          '你可以导出', '你可以定位', '你可以找到', '你可以查看完整',
          '你可以直接定位', '你可以界面', '你可以在界面',
          '如果你需要我', '如果你需要', '可以告诉我你的操作系统',
          '告诉我你的操作系统', '告诉我你的系统',
          '你可以终端', '你可以命令', '你可以查看历史',
          '你可以右键', '你可以设置', '你可以打开',
          '请提供你的', '请告诉我你的', '需要你提供',
          '你需要告诉我', '需要你提供',
        ]
        const answerText4 = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
        const hasLazyPattern = lazyPatterns.some(p => answerText4.includes(p))
        const hasTools4 = toolNames.length > 0
        const hasNotUsedTools4 = reactSteps.length === 0 || !reactSteps.some(s => s.action !== 'FINAL_ANSWER' && s.action !== 'DIRECT_ANSWER')

        if (hasLazyPattern && hasTools4 && hasNotUsedTools4 && this.nudge4Count < this.NUDGE_MAX && i < MAX_ITERATIONS - 2) {
          this.nudge4Count++
          console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER contains "push work to user" patterns. Injecting nudge (${this.nudge4Count}/${this.NUDGE_MAX}) and retrying.`)

          reactSteps.push({
            think: parsed.thought,
            action: 'FINAL_ANSWER',
            actionInput: {},
            observation: `[系统提醒] 你的回答中包含"告诉我你的 XX""你可以通过 XX 查看"等措辞，把本可以自己完成的工作推给了用户。这是不允许的！

⚠️ 重要原则：你是运行在用户本地电脑上的 AI 助手，你有 terminal、file_reader、file_search 等工具。你应该主动使用这些工具帮用户完成任务，而不是让用户自己去做。

具体来说：
1. 你已经知道用户的操作系统（${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'}），不需要询问用户操作系统版本
2. 当用户问"存储位置""文件在哪""路径是什么"时，用 terminal 工具执行命令查找（如 dir /s 搜索文件，或查看应用数据目录）
3. 当用户问"有哪些项目"时，用 file_search 工具搜索
4. 当用户问"查看文件内容"时，用 file_reader 工具读取
5. 当用户问"执行命令"时，用 terminal 工具执行
6. 绝对不要说"你可以通过 XX 功能查看""你可以自己 XX""告诉我你的 XX" — 这些是你应该做的事！

请重新思考：用户想要什么？你应该用哪个工具来完成？请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，使用合适的工具。`
          })

          // 移除刚创建的 Think 步骤（因为要重试）
          this.steps.pop()

          // 不标记完成，继续循环
          continue
        }

        // ── 纠偏机制 5：声称"我不能/没有能力"但实际有工具可用 ──
        // LLM 没有使用工具就回答，且回答中包含"我没有能力""我无法""我做不到"等放弃措辞。
        // 这种情况下，LLM 可能不知道自己可以用工具解决这个问题。
        // 注入提醒，让 LLM 重新审视可用工具，尝试用工具完成任务。
        const giveUpPatterns = [
          '我没有能力', '我无法', '我做不到', '我不能', '我没有办法',
          '我没有gps', '没有gps', '没有定位', '无法定位', '无法获取',
          '无法访问', '不能访问', '无法真正', '不能真正',
          '没有访问', '不能获取', '无法知道', '不能知道',
          '我不知道你在哪', '不知道你在哪', '无法知道你的',
          '我没有你的', '我没有这个能力', '不具备',
          '没有这个功能', '没有这种能力', '无法提供',
          '无法精确', '不能精确', '无法确定', '不能确定',
          '我没有权限', '无法访问你的',
          'i don\'t have', 'i cannot', 'i can\'t', 'i don\'t know',
          'unable to', 'no access', 'no capability',
        ]
        const answerText5 = (parsed.actionInput || parsed.content || thinkResponse || '').toLowerCase()
        const hasGiveUp = giveUpPatterns.some(p => answerText5.includes(p))
        const hasTools5 = toolNames.length > 0
        const hasNotUsedTools5 = reactSteps.length === 0 || !reactSteps.some(s => s.action !== 'FINAL_ANSWER' && s.action !== 'DIRECT_ANSWER')

        if (hasGiveUp && hasTools5 && hasNotUsedTools5 && this.nudge5Count < this.NUDGE_MAX && i < MAX_ITERATIONS - 2) {
          this.nudge5Count++
          console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER contains "I can't" patterns. Injecting nudge (${this.nudge5Count}/${this.NUDGE_MAX}) and retrying.`)

          // 构建工具能力提示
          const toolDefs5 = getToolDefs()
          const toolCapabilities = toolDefs5.map(t => `- ${t.id}: ${t.description.slice(0, 120)}`).join('\n')

          reactSteps.push({
            think: parsed.thought,
            action: 'FINAL_ANSWER',
            actionInput: {},
            observation: `[系统提醒] 你的回答中包含"我没有能力""我无法""我做不到"等措辞，但你还没有尝试使用工具！

⚠️ 重要：你运行在用户的本地电脑上，你有以下工具：
${toolCapabilities}

在说"我不能"之前，请先思考：
1. 这个问题是否可以通过执行命令来解决？（如 curl 获取网络信息、dir 查找文件、系统命令获取硬件信息等）
2. 这个问题是否可以通过搜索网络来解决？（如查最新信息、查概念解释等）
3. 这个问题是否可以通过读取本地文件来解决？

常见例子：
- "你在哪/你的位置" → 用 terminal 执行 curl ipinfo.io 获取 IP 地理位置
- "你有什么文件/项目" → 用 file_search 搜索
- "文件内容是什么" → 用 file_reader 读取
- "最新信息" → 用 web_search 搜索
- "系统信息" → 用 terminal 执行系统命令（如 systeminfo、wmic 等）

请重新思考：你能用哪个工具来解决这个问题？请按照 THOUGHT/ACTION/ACTION_INPUT 格式回复，尝试使用工具。`
          })

          // 移除刚创建的 Think 步骤（因为要重试）
          this.steps.pop()

          // 不标记完成，继续循环
          continue
        }

        finalOutput = parsed.actionInput || parsed.content || thinkResponse
        console.log(`[AgentLoop] ReAct iteration ${i + 1} — FINAL_ANSWER, output=${finalOutput.length}chars`)

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
        console.log(`[AgentLoop] ReAct iteration ${i + 1} — executing tool: ${parsed.action}`)
        let toolParams: Record<string, unknown> = {}
        if (parsed.actionInput) {
          try {
            toolParams = JSON.parse(parsed.actionInput)
          } catch {
            // JSON 解析失败，尝试从文本中提取 JSON 对象
            const jsonMatch = parsed.actionInput.match(/\{[\s\S]*\}/)
            if (jsonMatch) {
              try {
                toolParams = JSON.parse(jsonMatch[0])
              } catch {
                // 仍然失败，尝试提取 query 字段
                const queryMatch = parsed.actionInput.match(/"query"\s*:\s*"([^"]+)"/i)
                if (queryMatch) {
                  toolParams = { query: queryMatch[1] }
                } else {
                  // 最后回退：将整个文本作为 query（适用于 web_search 等工具）
                  const cleaned = parsed.actionInput
                    .replace(/ACTION_INPUT:\s*/i, '')
                    .replace(/ACTION:\s*\S+/i, '')
                    .replace(/THOUGHT:[\s\S]*$/i, '')
                    .replace(/CONTENT:[\s\S]*$/i, '')
                    .replace(/[{}\[\]"]/g, '')
                    .trim()
                  if (cleaned) {
                    toolParams = { query: cleaned }
                  } else {
                    toolParams = { raw: parsed.actionInput }
                  }
                }
              }
            } else {
              // 没有 JSON 对象，尝试作为纯文本 query
              const cleaned = parsed.actionInput.trim()
              if (cleaned && !cleaned.includes('\n')) {
                toolParams = { query: cleaned }
              } else {
                toolParams = { raw: parsed.actionInput }
              }
            }
          }
        }

        const toolCall = {
          id: `call-${Date.now()}`,
          toolId: parsed.action,
          parameters: toolParams
        }

        const toolStart = Date.now()
        const toolResult = await executeAction(toolCall, this.signal)
        console.log(`[AgentLoop] ReAct iteration ${i + 1} — tool ${parsed.action} ✓ ${Date.now() - toolStart}ms, success=${toolResult.success}`)

        // 创建 Act 步骤
        this.createActStep(parsed.action, toolParams, toolResult)

        // 构建详细的观察结果（包含实际输出内容，供 LLM 后续推理使用）
        let observationText = toolResult.resultSummary
        if (toolResult.result && typeof toolResult.result === 'object') {
          const result = toolResult.result as {
            // 搜索结果
            engine?: string
            results?: Array<{ index?: number; title?: string; url?: string; snippet?: string; content?: string }>
            // terminal / file 操作结果
            stdout?: string
            stderr?: string
            exitCode?: number
            command?: string
            cwd?: string
            platform?: string
            shell?: string
            // fetch_url 结果
            url?: string
            finalUrl?: string
            contentType?: string
            content?: string
            length?: number
          }

          // ── terminal 命令输出 ──
          if (typeof result.stdout === 'string' || typeof result.stderr === 'string' || typeof result.exitCode === 'number') {
            observationText = toolResult.resultSummary
            if (result.command) {
              observationText += `\n命令: ${result.command}`
            }
            if (result.cwd) {
              observationText += `\n工作目录: ${result.cwd}`
            }
            if (typeof result.exitCode === 'number') {
              observationText += `\n退出码: ${result.exitCode}`
            }
            if (result.stdout && result.stdout.trim()) {
              observationText += `\n--- stdout ---\n${result.stdout}`
            }
            if (result.stderr && result.stderr.trim()) {
              observationText += `\n--- stderr ---\n${result.stderr}`
            }
          }

          // ── 搜索结果 ──
          else if (result.results && Array.isArray(result.results) && result.results.length > 0) {
            const engineInfo = result.engine ? `（来源: ${result.engine}）` : ''
            observationText = `${toolResult.resultSummary}${engineInfo}\n\n搜索结果详情：`
            for (const r of result.results) {
              observationText += `\n[${r.index || '?'}] ${r.title || '(无标题)'}\n`
              observationText += `  链接: ${r.url || ''}\n`
              if (r.snippet) {
                observationText += `  摘要: ${r.snippet}\n`
              }
              if (r.content) {
                observationText += `  内容: ${r.content}\n`
              }
            }
          }

          // ── fetch_url 网页抓取结果 ──
          else if (typeof result.content === 'string' && result.url) {
            observationText = `${toolResult.resultSummary}\n\n--- 抓取内容 ---\n${result.content}`
          }
        }

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
          observation: observationText
        })
      } else {
        // 未知动作，当作最终回答
        finalOutput = parsed.content || parsed.thought || thinkResponse
        console.log(`[AgentLoop] ReAct iteration ${i + 1} — unknown action "${parsed.action}", treating as final answer`)
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
      console.warn(`[AgentLoop] ReAct loop exhausted after ${MAX_ITERATIONS} iterations without completion`)
      finalOutput = this.getLoopExhaustedResponse(userInput, reactSteps)
      this.callbacks.onChunk?.(finalOutput)
    }

    return { output: finalOutput, llmCalls }
  }

  /** 构建 ReAct 系统提示词 */
  private buildReActSystemPrompt(toolNames: string[]): string {
    const basePrompt = getSystemPrompt()
    const hasWebSearch = toolNames.includes('web_search')
    const hasFetchUrl = toolNames.includes('fetch_url')
    const hasOpenUrl = toolNames.includes('open_url')
    const hasBrowser = toolNames.includes('browser_navigate')
    const hasTerminal = toolNames.includes('terminal')
    const hasFileReader = toolNames.includes('file_reader')
    const hasFileWriter = toolNames.includes('file_writer')

    // 包含工具描述（而非仅名称），让 LLM 理解每个工具的用途
    const toolDefs = getToolDefs()
    const toolsSection = toolDefs.length > 0
      ? `\n\n可用工具（含描述）:\n${this.formatToolDescriptions(toolDefs)}`
      : '\n\n当前没有可用工具，请直接回答用户问题。'

    const webSearchHint = hasWebSearch
      ? `\n\n⚠️ 重要规则 — 何时必须使用 web_search 工具：
- 当用户询问最新、当前、实时信息时（如"最新模型""当前价格""今天新闻""今天大盘"）
- 当你的训练数据可能过时，无法确保信息准确时
- 当用户明确要求搜索或查询外部信息时
- 当涉及版本号、发布日期、产品规格等可能变化的信息时
对于以上情况，必须先使用 web_search 搜索获取最新信息，再基于搜索结果回答。
不要凭记忆回答可能过时的信息，这比承认不确定更糟糕。

🔍 搜索策略 — 多步搜索，不要一次就放弃：
- 搜索关键词要简洁精准，不要在关键词中放完整日期和长描述
  ✓ 好的查询: "上证指数 今日行情" / "A股 大盘 今日" / "上证指数 实时"
  ✗ 差的查询: "2026年7月13日 A股大盘走势 上证指数" （太长太具体，搜索引擎匹配不到实时数据）
- 如果第一次搜索结果不包含用户需要的具体数据（如具体数值、价格等），不要直接放弃说"数据加载中"
  → 应该换不同关键词再搜索一次（如换更短的关键词、换同义词）
  → 或者用 fetch_url 工具抓取搜索结果中可能包含数据的页面 URL
  → 最多尝试 3 次不同关键词的搜索 + 2 次 fetch_url 抓取
- 对于金融/股票数据，搜索结果通常返回东方财富、雪球、新浪财经等网站入口页，
  这些页面的摘要不含实时数据，需要用 fetch_url 抓取具体页面内容才能获取数值
- 绝对不要在没有获取到实际数据的情况下编造或声称"数据加载中"，
  应该坦诚说未能获取到实时数据，并告知用户可以查看的数据源链接`
      : ''

    const fetchUrlHint = hasFetchUrl
      ? `\n\n📋 网页抓取工具 — 获取搜索结果中具体页面的详细内容：
当 web_search 返回的搜索结果摘要不包含用户需要的具体数据时，使用 fetch_url 工具抓取搜索结果中的页面。

典型场景：
- 用户询问实时数据（股价、天气、新闻等），但搜索结果只有网站入口页，没有具体数据
- 搜索结果摘要太短，需要更多上下文
- 需要验证搜索结果中的具体信息

使用方法：
- fetch_url: {"url": "https://quote.eastmoney.com/zs000001.html", "maxLength": 8000}
- 先用 web_search 找到相关页面 URL，再用 fetch_url 抓取具体内容
- 对于金融数据，可以尝试抓取 API 接口 URL 获取 JSON 数据

⚠️ 重要：当搜索结果的摘要中没有用户需要的具体数据时，不要直接说"数据加载中"或"暂无数据"，
应该主动使用 fetch_url 抓取搜索结果中可能包含数据的页面（如东方财富、雪球等）。`
      : ''

    const openUrlHint = hasOpenUrl
      ? `\n\n⚠️ 重要规则 — 何时使用 open_url 工具：
- 当用户要求你打开某个网站、网页或链接时（如"打开微信读书""帮我打开 GitHub"）
- 当用户要求在浏览器中打开某个网址时
- 使用 open_url 工具直接打开 URL，不要只告诉用户方法
- open_url 的参数是 {"url": "https://..."}，URL 必须包含 http:// 或 https:// 前缀`
      : ''

    const browserHint = hasBrowser
      ? `\n\n🌐 浏览器自动化工具 — 你可以完全控制浏览器：
当用户要求你浏览网页、操作网页、获取网页内容时，使用浏览器工具：
1. browser_navigate: 打开网页（如 {"url": "https://weread.qq.com/"}）
2. browser_get_text: 获取页面文本内容（如 {"selector": "#content"}，留空获取整页）
3. browser_click: 点击元素（如 {"selector": "button.submit"}）
4. browser_type: 输入文字（如 {"selector": "input#search", "text": "关键词", "submit": true}）
5. browser_screenshot: 截图保存（如 {"fullPage": false}）
6. browser_eval: 执行 JS（如 {"code": "document.title"}）
7. browser_scroll: 滚动页面（如 {"direction": "down", "amount": 500}）
8. browser_close: 关闭浏览器

典型工作流：browser_navigate → browser_get_text/browser_screenshot → browser_click/browser_type → ... → browser_close
重要：这些工具操作的是本地有头浏览器，用户可以看到浏览器窗口。完成操作后记得调用 browser_close。`
      : ''

    const terminalHint = hasTerminal
      ? `\n\n💻 终端工具 — 你可以直接在用户电脑上执行命令：
当用户要求你执行系统操作时，使用 terminal 工具。

关键规则：
- ⚠️ 设置了 cwd 参数后就不要在 command 里写 cd 命令！cwd 已经指定了工作目录。
  正确：{"command": "git status", "cwd": "e:\\project"}
  错误：{"command": "cd /e/project && git status", "cwd": "e:\\project"}  ← 多余的 cd
- 路径必须使用当前操作系统的格式（Windows 用反斜杠，Linux/macOS 用正斜杠）
- 执行多步操作时，每步都用 terminal 工具单独执行（如先 git add 再 git commit）
- 如果用户没有指定工作目录，优先询问用户或使用用户之前提到的项目路径
- 危险命令（如 rm -rf /, format, shutdown）会被自动拦截

常见用法：
- Git: {"command": "git status", "cwd": "e:\\project"}
- Git: {"command": "git add -A", "cwd": "e:\\project"}
- Git: {"command": "git commit -m \\"feat: xxx\\"", "cwd": "e:\\project"}
- Git: {"command": "git push", "cwd": "e:\\project"}
- npm: {"command": "npm install", "cwd": "e:\\project"}
- 列出文件: {"command": "dir", "cwd": "e:\\project"}  (Windows)
- 列出文件: {"command": "ls -la", "cwd": "/home/project"}  (Linux/macOS)`
      : ''

    const fileOpsHint = (hasFileReader || hasFileWriter)
      ? `\n\n📁 文件操作工具 — 你可以读写本地文件：
${hasFileReader ? '- file_reader: 读取文件内容（如 {"path": "e:\\project\\package.json"}）\n' : ''}${hasFileWriter ? '- file_writer: 写入文件（如 {"path": "e:\\project\\test.txt", "content": "内容", "mode": "write"}）\n  - mode: "write" 覆盖写入（默认）, "append" 追加\n  - 自动创建父目录\n' : ''}典型工作流：file_reader 读取 → 分析/修改 → file_writer 写入`
      : ''

    const hasFileSearch = toolNames.includes('file_search')
    const fileSearchHint = hasFileSearch
      ? `\n\n🔍 文件搜索工具 — 快速搜索本地文件和项目（基于预构建索引，秒级响应）：
当用户要求查找文件、项目、代码仓库时，优先使用 file_search 工具，不要用 terminal 的 dir/ls 扫描！

使用方法：
- 搜索项目: {"query": "zen-agent"} → 返回匹配的项目路径和 Git 远程地址
- 搜索文件: {"query": "package.json", "type": "file"}
- 列出所有项目: {"query": "", "type": "project"}
- 搜索类型: file（文件）/ directory（目录）/ project（项目）/ all（全部，默认）

⚠️ 重要：当用户说"找一下 xxx 项目"或"电脑上有没有 xxx"时，用 file_search 搜索，不要用 terminal 扫磁盘！`
      : ''

    return `${basePrompt}

你是一个 ReAct Agent，使用 Think-Act-Observe 模式处理问题。

⏰ 当前时间: ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}（${new Date().toLocaleDateString('en-US', { weekday: 'long' })}）
注意：搜索时请使用与当前时间匹配的关键词，不要用过时的年份。

请严格按照以下格式回复：

THOUGHT: <分析问题和推理过程>
ACTION: FINAL_ANSWER
CONTENT: <给用户的最终回答>

${toolNames.length > 0 ? `如果需要使用工具：
THOUGHT: <分析为什么需要工具>
ACTION: <工具名称>
ACTION_INPUT: <JSON 格式的工具参数>

重要：ACTION_INPUT 必须是纯 JSON，不要包含任何额外文字。
正确示例：ACTION_INPUT: {"query": "Claude 最新模型"}
错误示例：ACTION_INPUT: {"query": "Claude 最新模型"}\\nCONTENT: ...
错误示例：ACTION_INPUT: {raw: "..."} 

⚠️ 工具使用决策流程（每次回答前必须执行）：
1. 阅读上方「可用工具（含描述）」列表，理解每个工具能做什么
2. 思考：这个问题是否涉及本地文件/路径/项目/系统操作/实时信息？
3. 如果是 → 使用对应的工具（terminal/file_reader/file_search/web_search 等）
4. 如果纯粹是知识问答或计算 → 可以直接 FINAL_ANSWER
5. 当你不确定是否需要工具时，倾向于使用工具 — 宁可用了不需要，也不要需要却没用

关键：你运行在用户的本地电脑上，你有能力直接操作。不要把工作推给用户。` : ''}

规则：
- ⚠️ 主动性原则：你是运行在用户本地电脑上的 AI 助手，你的职责是用工具帮用户完成任务，而不是指导用户自己做。绝对不要说"你可以通过 XX 查看""告诉我你的 XX""如果你需要我可以帮你"这类推卸工作的措辞。
- ⚠️ 先想工具再说不能：在说"我没有能力""我无法""我做不到"之前，必须先检查可用工具能否解决。很多看似做不到的事可以通过命令行实现（如 curl ipinfo.io 查位置、systeminfo 查硬件、ipconfig 查网络等）。绝对不要在没尝试工具的情况下就说"我没有这个能力"。
- 你已经知道用户的操作系统（见运行环境），不要询问用户操作系统版本
- 当用户问"存储位置""文件在哪""路径是什么""数据库在哪"时，用 terminal 工具执行命令查找，不要让用户自己找
- 当用户问"有哪些项目""电脑上有什么"时，用 file_search 工具搜索
- 当用户问"查看文件内容"时，用 file_reader 工具读取
- 当用户问"你在哪""你知道我的位置吗""我的IP是什么"时，用 terminal 执行 curl ipinfo.io 获取网络和位置信息
- 涉及实时信息或可能过时的信息时，优先使用 web_search 工具搜索
- 搜索时使用当前年份（${new Date().getFullYear()}年）作为关键词，不要用旧年份
- ⚠️ 绝对不要直接复用对话历史中的旧数据来回答用户！当用户要求"准确的数据""最新数据""更新"时，必须使用 web_search 重新搜索获取最新数据
- 对话历史中的数据可能已经过时（特别是股价、天气、新闻等实时数据），不要直接拿来回答
- 当用户要求打开网站或链接时，使用 open_url 工具直接打开
- 当用户要求浏览网页内容、操作网页时，使用 browser_navigate 等浏览器工具
- 当用户要求执行命令、操作 git、运行代码时，使用 terminal 工具直接执行
- 当用户要求查看文件内容时，使用 file_reader 工具读取
- 当用户要求写入或修改文件时，使用 file_writer 工具写入
- 当用户要求查找文件、项目、代码仓库时，使用 file_search 工具搜索（秒级响应），不要用 terminal 扫描磁盘
- 执行多步操作时（如 git commit + push），每步单独调用工具，不要合并
- 简单的常识问题或计算问题直接用 FINAL_ANSWER 回答
- 复杂问题先思考再决定是否需要工具
- 如果搜索结果不足以回答问题，可以多次搜索不同关键词
- 搜索时使用简洁的关键词，中英文均可
- 回答要简洁、准确、有帮助${toolsSection}${webSearchHint}${fetchUrlHint}${openUrlHint}${browserHint}${terminalHint}${fileOpsHint}${fileSearchHint}`
  }

  /** 构建 Think 步骤的 prompt */
  private buildThinkPrompt(
    userInput: string,
    previousSteps: ReActStep[],
    toolNames: string[]
  ): string {
    let prompt = `用户问题: ${userInput}\n`

    // 首轮推理时，注入工具评估提示
    if (previousSteps.length === 0 && toolNames.length > 0 && this.toolAssessment.needsTool) {
      const suggested = this.toolAssessment.suggestedTools.length > 0
        ? this.toolAssessment.suggestedTools.join(', ')
        : '查看上方可用工具列表'
      prompt += `\n💡 系统工具评估: 这个问题可能需要使用工具。建议考虑: ${suggested}。原因: ${this.toolAssessment.reason}\n`
      prompt += `请先考虑是否有合适的工具可以帮助回答这个问题，再决定是否直接回答。\n`
    }

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

  /**
   * 格式化工具定义为带描述的列表（供 LLM 理解每个工具的用途）
   */
  private formatToolDescriptions(toolDefs: ToolDef[]): string {
    return toolDefs.map(t => {
      // 截取描述的前 150 字符，避免过长
      const desc = t.description.length > 150
        ? t.description.slice(0, 150) + '...'
        : t.description
      return `- ${t.id}: ${desc}`
    }).join('\n')
  }

  /**
   * LLM 驱动的工具需求评估
   *
   * 替代关键词匹配的 shouldUseTool，让 LLM 根据问题语义和工具描述
   * 判断是否需要使用工具、应该用哪个工具。
   *
   * 这是一种更智能、更可扩展的方式：
   * - 不需要维护无穷的关键词列表
   * - 能理解问题的语义意图
   * - 能根据工具的实际描述做匹配
   * - 能处理从未见过的新问题
   *
   * @returns { needsTool, suggestedTools, reason }
   */
  private async assessToolNeed(
    userInput: string,
    toolDefs: ToolDef[],
    historyMessages: Array<{ role: string; content: string }>
  ): Promise<{ needsTool: boolean; suggestedTools: string[]; reason: string }> {
    // 默认值：不需要工具
    const defaultResult = { needsTool: false, suggestedTools: [] as string[], reason: '' }

    if (toolDefs.length === 0) return defaultResult
    if (!isLLMConfigured()) return defaultResult

    // 构建对话历史摘要（最近 4 条，供 LLM 理解上下文）
    const recentHistory = historyMessages.slice(-4)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : ''}`)
      .join('\n')
    const historySection = recentHistory
      ? `\n\n最近对话上下文:\n${recentHistory}`
      : ''

    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'

    const prompt = `你是一个工具使用评估器。请判断以下用户问题是否需要使用工具来回答。

用户问题: "${userInput}"${historySection}

可用工具:
${this.formatToolDescriptions(toolDefs)}

判断原则:
- 你已知用户的操作系统是 ${platform}，不要建议询问用户操作系统
- 当用户问"在哪""路径""存储位置""数据库""配置文件"等位置类问题时，通常需要 terminal 工具查找
- 当用户问"有哪些项目""电脑上有什么""找一下"时，需要 file_search 工具
- 当用户问"最新""今天""现在""实时"等实时信息时，需要 web_search 工具
- 当用户问"查看文件""读取文件""看看代码"时，需要 file_reader 工具
- 当用户问"写入""修改""创建文件"时，需要 file_writer 工具
- 当用户问"打开网站""打开网页"时，需要 open_url 工具
- 当用户问"浏览器""点击按钮""输入文字""截图"时，需要 browser 工具
- ⚠️ 能力类问题（如"你知道我在哪吗""你能查到我的IP吗""你有什么信息"）通常需要工具：
  - "你在哪/你的位置" → terminal 执行 curl ipinfo.io 获取 IP 地理位置
  - "我的IP" → terminal 执行 curl ipinfo.io 或 ipconfig
  - "系统信息/硬件信息" → terminal 执行 systeminfo / wmic 等
  - "网络状态" → terminal 执行 ipconfig / netstat 等
  - 这类问题看似是问你的能力，实际上用户想要你用工具去获取信息
- 纯知识问答（如"什么是递归""解释一下概念"）不需要工具
- 纯计算问题（如"2+2等于几"）不需要工具（除非需要计算器工具）
- 如果不确定，倾向于需要工具（宁可多用工具也不要漏掉）
- follow-up 问题（如"具体的存储位置呢？"）需要结合上下文判断

请返回 JSON（不要其他文字）:
{"needsTool": true, "suggestedTools": ["terminal"], "reason": "用户询问存储位置，需要用terminal查找文件路径"}`

    try {
      const config = getConfig()
      const response = await llm.chat({
        messages: [
          { role: 'system', content: '你是工具使用评估助手，只返回 JSON。' },
          { role: 'user', content: prompt }
        ],
        modelKey: config.defaultModelKey,
        temperature: 0,
        maxTokens: 300,
        signal: this.signal,
        timeoutMs: 10000
      })

      this.totalInputTokens += countTextTokens(prompt)
      this.totalOutputTokens += countTextTokens(response)
      this.modelsUsed.add(config.defaultModelKey)

      // 解析 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[AgentLoop] assessToolNeed: no JSON in response, falling back')
        return defaultResult
      }

      const parsed = JSON.parse(jsonMatch[0])
      const result = {
        needsTool: !!parsed.needsTool,
        suggestedTools: Array.isArray(parsed.suggestedTools)
          ? parsed.suggestedTools.filter((t: unknown) => typeof t === 'string')
          : [],
        reason: typeof parsed.reason === 'string' ? parsed.reason : ''
      }

      console.log(`[AgentLoop] assessToolNeed: needsTool=${result.needsTool}, suggestedTools=[${result.suggestedTools.join(', ')}], reason="${result.reason}"`)
      return result
    } catch (err) {
      console.warn('[AgentLoop] assessToolNeed failed, falling back to shouldUseTool:', err)
      return defaultResult
    }
  }

  /**
   * 检测用户输入是否暗示需要使用工具
   *
   * 当用户要求执行本地操作（git, 运行代码, 提交, 推送等）时，
   * LLM 不应该直接回答"我做不到"，而应该尝试使用 terminal/file_reader 等工具。
   *
   * 也检查对话历史上下文 — 当用户发送 follow-up 消息（如"给我准确的数据"）
   * 且对话历史中包含实时数据相关话题时，也应触发工具使用。
   *
   * 注意：此方法现在作为 assessToolNeed 的快速预筛使用 —
   * 如果关键词命中，跳过 LLM 评估节省 API 调用；
   * 如果关键词未命中，由 assessToolNeed 做 LLM 评估。
   */
  private shouldUseTool(
    userInput: string,
    availableTools: string[],
    historyMessages?: Array<{ role: string; content: string }>
  ): boolean {
    if (availableTools.length === 0) return false

    const input = userInput.toLowerCase()

    // 终端操作关键词
    const terminalKeywords = [
      'git', 'commit', 'push', 'pull', 'merge', 'branch', '提交', '推送', '拉取',
      'npm', 'yarn', 'pnpm', 'pip', 'install', '安装', '运行', '执行',
      'node', 'python', 'go run', 'cargo', 'make',
      '命令行', '终端', 'terminal', 'cmd', 'shell',
      'build', '编译', '打包', 'deploy', '部署',
      '启动', '重启', 'start', 'restart', 'stop',
      'status', 'log', 'diff', '查看状态'
    ]

    // 文件操作关键词
    const fileKeywords = [
      '读取文件', '查看文件', '打开文件', '修改文件', '写入文件', '创建文件',
      'read file', 'write file', 'edit file', '看一下文件',
      'package.json', 'config', '配置文件', '.ts', '.js', '.py', '.vue',
      '代码', '源码', '看看这个文件'
    ]

    // 文件搜索关键词（file_search）
    const fileSearchKeywords = [
      '找', '查找文件', '查找项目', '搜索文件', '搜索项目', '找一下',
      '有没有', '在哪个', '在哪个目录', '项目在哪', '仓库在哪',
      '有哪些', '有哪些项目', '列出项目', '列出所有', '所有项目',
      'find file', 'find project', 'search file', 'locate', 'list project',
      '拉取代码', '拉代码', 'clone', '开源项目', '在做',
      '电脑上', '本机', '本地项目', '本地文件',
      '看一下项目', '看看项目', '什么项目', '几个项目'
    ]

    // 本地资源定位关键词（terminal / file_reader / file_search）
    // 当用户询问文件/数据存储位置、路径、数据库位置等时，应该用工具查找
    const localResourceKeywords = [
      '存储位置', '存储在哪', '存在哪', '保存在哪', '保存在', '数据存储',
      '数据库', 'sqlite', 'db文件', '数据文件', '数据库文件',
      '路径是', '路径在哪', '文件路径', '具体路径', '完整路径',
      '在哪呢', '在哪里', '在什么位置', '什么位置', '具体位置',
      '定位', '找到这个文件', '找到文件',
      '配置在哪', '配置文件在哪', '日志在哪', '日志文件',
      '安装在哪', '安装在', '安装位置',
      '数据目录', '数据文件夹', '应用数据', '应用目录',
      '数据在', '文件在', '目录在', '文件夹在',
      '在哪里可以找到', '在哪查看', '在哪看到',
    ]

    // 搜索关键词（web_search）
    const searchKeywords = [
      '搜索', '查找', '最新', 'search', 'google', '百度',
      '当前价格', '最新版本', '今天', '实时',
      // follow-up 请求中常见的需要重新搜索的关键词
      '准确', '更新', '重新', '正确', '最新数据', '实时数据',
      '现在', '当前', '目前', '刚刚', '-refresh', '刷新',
      '不对', '错了', '错误', '不对啊', '不太对',  // 用户指出数据有误
      '再搜', '重新搜', '再查', '重新查',  // 明确要求重新搜索
    ]

    const hasTerminal = availableTools.includes('terminal')
    const hasFileReader = availableTools.includes('file_reader')
    const hasFileWriter = availableTools.includes('file_writer')
    const hasWebSearch = availableTools.includes('web_search')
    const hasFileSearchTool = availableTools.includes('file_search')

    if (hasTerminal && terminalKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
    if ((hasFileReader || hasFileWriter) && fileKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
    if (hasWebSearch && searchKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
    if (hasFileSearchTool && fileSearchKeywords.some(kw => input.includes(kw.toLowerCase()))) return true
    // 本地资源定位 — terminal 或 file_search 都可以查找
    if ((hasTerminal || hasFileSearchTool || hasFileReader) && localResourceKeywords.some(kw => input.includes(kw.toLowerCase()))) return true

    // 检测路径模式（如 e:\, C:\, /home/ 等）
    if (hasTerminal || hasFileReader) {
      if (/[a-z]:\\/i.test(userInput) || /\/(home|usr|opt|var|tmp)\//.test(userInput)) return true
    }

    // ── 上下文感知：检查对话历史是否包含实时数据相关话题 ──
    // 当用户发送 follow-up 消息（如"给我准确的数据"），且对话历史中
    // 包含股价、天气、新闻等实时数据话题时，应该触发 web_search
    if (hasWebSearch && historyMessages && historyMessages.length > 0) {
      // 合并最近几条对话内容作为上下文
      const recentContext = historyMessages
        .slice(-6)  // 最近 6 条消息
        .map(m => m.content)
        .join(' ')
        .toLowerCase()

      // 实时数据话题关键词
      const realtimeTopics = [
        '股价', '大盘', '指数', '上证', '深证', '创业板', 'a股', '股票',
        '行情', '涨跌', '收盘', '开盘', '盘中',
        '天气', '气温', '温度',
        '新闻', '今日', '今天',
        '汇率', '油价', '金价',
        '数据', '实时', '最新',
      ]

      // 用户输入中包含要求更新/准确/重新获取的意图
      const updateIntentKeywords = [
        '准确', '更新', '重新', '最新', '正确', '现在', '当前',
        '不对', '错了', '再', '刷新', '实时',
      ]

      const hasRealtimeTopic = realtimeTopics.some(kw => recentContext.includes(kw))
      const hasUpdateIntent = updateIntentKeywords.some(kw => input.includes(kw))

      if (hasRealtimeTopic && hasUpdateIntent) {
        console.log(`[AgentLoop] shouldUseTool: follow-up request with realtime context detected`)
        return true
      }
    }

    // ── 上下文感知：检查对话历史是否包含本地资源相关话题 ──
    // 当用户发送 follow-up 消息（如"具体的存储位置呢？"），且对话历史中
    // 包含数据库、存储、路径等本地资源话题时，应该触发 terminal/file_search 工具
    if ((hasTerminal || hasFileSearchTool || hasFileReader) && historyMessages && historyMessages.length > 0) {
      const recentContext = historyMessages
        .slice(-6)
        .map(m => m.content)
        .join(' ')
        .toLowerCase()

      // 本地资源话题关键词
      const localResourceTopics = [
        '存储', '数据库', 'sqlite', '保存', '数据存', '数据持久',
        '路径', '文件在哪', '配置文件', '日志文件',
        '应用数据', '数据目录', '应用目录',
      ]

      // follow-up 中常见的追问位置/路径的意图
      const locationIntentKeywords = [
        '具体', '位置', '在哪', '路径', '哪个文件', '哪个目录',
        '哪里', '什么位置', '怎么找到', '怎么查看',
      ]

      const hasLocalTopic = localResourceTopics.some(kw => recentContext.includes(kw))
      const hasLocationIntent = locationIntentKeywords.some(kw => input.includes(kw))

      if (hasLocalTopic && hasLocationIntent) {
        console.log(`[AgentLoop] shouldUseTool: follow-up request with local resource context detected`)
        return true
      }
    }

    return false
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
