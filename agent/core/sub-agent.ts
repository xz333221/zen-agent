/**
 * 子 Agent — 执行协调器分配的子任务
 *
 * 每个 SubAgent 有自己的专长、系统提示词和工具集。
 * 执行子任务时，使用独立的 LLM 调用，结果返回给协调器。
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig } from '../providers/llm-config'
import type { SubAgentDef, TaskResult, PlanTask, Blackboard, AgentMessage } from './types'
import type { TraceStep } from '../../src/shared/types'
import { countTextTokens } from '../utils/token-counter'
import { executeAction, getToolNames } from './action-executor'

// ── 内置子 Agent 定义 ──

const BUILTIN_AGENTS: SubAgentDef[] = [
  {
    id: 'agent-coder',
    name: 'Code Agent',
    type: 'builtin',
    specialty: '编程、代码生成、调试、技术实现',
    systemPrompt: `你是一个专业的编程助手。你擅长编写代码、调试问题、解释技术概念、浏览器自动化。
回答规范：
- 提供清晰的代码示例
- 使用正确的语法高亮
- 解释关键逻辑和设计决策
- 关注代码质量和最佳实践
- 当需要操作浏览器时，使用 browser_navigate、browser_get_text、browser_click、browser_type、browser_screenshot 等工具`,
    tools: ['code_executor', 'file_reader', 'web_search', 'fetch_url', 'open_url', 'browser_navigate', 'browser_get_text', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_eval', 'browser_scroll', 'browser_close'],
    defaultModel: '',
    memoryScope: 'shared',
    maxTokens: 8000,
    status: 'active',
    executionCount: 0,
    successRate: 0.8,
    createdAt: Date.now(),
    lastUsedAt: 0
  },
  {
    id: 'agent-researcher',
    name: 'Research Agent',
    type: 'builtin',
    specialty: '研究、搜索、信息收集、事实核查',
    systemPrompt: `你是一个专业的研究助手。你擅长搜索信息、整理资料、提供客观全面的分析。
回答规范：
- 提供准确、有据可查的信息
- 区分事实和观点
- 列出关键发现
- 必要时引用来源`,
    tools: ['web_search', 'fetch_url'],
    defaultModel: '',
    memoryScope: 'shared',
    maxTokens: 6000,
    status: 'active',
    executionCount: 0,
    successRate: 0.8,
    createdAt: Date.now(),
    lastUsedAt: 0
  },
  {
    id: 'agent-writer',
    name: 'Writer Agent',
    type: 'builtin',
    specialty: '写作、文案、翻译、内容创作',
    systemPrompt: `你是一个专业的写作助手。你擅长撰写文章、文案、翻译和创意内容。
回答规范：
- 语言流畅、结构清晰
- 适应不同场景的写作风格
- 注重可读性和表达力
- 保持一致的语调和风格`,
    tools: [],
    defaultModel: '',
    memoryScope: 'shared',
    maxTokens: 6000,
    status: 'active',
    executionCount: 0,
    successRate: 0.8,
    createdAt: Date.now(),
    lastUsedAt: 0
  },
  {
    id: 'agent-analyst',
    name: 'Analyst Agent',
    type: 'builtin',
    specialty: '数据分析、逻辑推理、比较评估、决策支持',
    systemPrompt: `你是一个专业的分析助手。你擅长数据分析、逻辑推理、比较评估和决策支持。
回答规范：
- 结构化的分析框架
- 基于数据和逻辑的推理
- 清晰的结论和建议
- 考虑多种可能性和风险`,
    tools: ['calculator'],
    defaultModel: '',
    memoryScope: 'shared',
    maxTokens: 6000,
    status: 'active',
    executionCount: 0,
    successRate: 0.8,
    createdAt: Date.now(),
    lastUsedAt: 0
  },
  {
    id: 'agent-general',
    name: 'General Agent',
    type: 'builtin',
    specialty: '通用任务、问答、解释、指导',
    systemPrompt: `你是一个通用的 AI 助手。你能够处理各种类型的任务和问题。
回答规范：
- 简洁明了，直击要点
- 友好亲切的语调
- 必要时提供示例
- 坦诚面对不确定的问题
- 当需要打开网页或操作浏览器时，使用 open_url 或 browser_navigate 等工具`,
    tools: ['web_search', 'fetch_url', 'open_url', 'browser_navigate', 'browser_get_text', 'browser_screenshot', 'browser_close'],
    defaultModel: '',
    memoryScope: 'shared',
    maxTokens: 6000,
    status: 'active',
    executionCount: 0,
    successRate: 0.8,
    createdAt: Date.now(),
    lastUsedAt: 0
  }
]

export class SubAgent {
  def: SubAgentDef
  private blackboard: Blackboard

  constructor(def: SubAgentDef, blackboard: Blackboard) {
    this.def = def
    this.blackboard = blackboard
  }

  /**
   * 执行一个子任务
   */
  async execute(
    task: PlanTask,
    context: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> },
    signal?: AbortSignal
  ): Promise<TaskResult> {
    const startTime = Date.now()
    const config = getConfig()
    const modelKey = this.def.defaultModel || config.defaultModelKey

    // 从黑板收集依赖任务的输出
    const dependencyResults = this.collectDependencyResults(task)

    // 构建子任务的 prompt
    const taskPrompt = this.buildTaskPrompt(task, dependencyResults)

    // 构建 messages
    const messages = [
      { role: 'system' as const, content: this.def.systemPrompt },
      ...context.messages.filter(m => m.role !== 'system').slice(-5), // 保留最近 5 条历史
      { role: 'user' as const, content: taskPrompt }
    ]

    const steps: TraceStep[] = []

    if (!isLLMConfigured()) {
      // Mock 模式
      const mockOutput = this.getMockOutput(task)
      return {
        status: 'success',
        data: mockOutput,
        tokensUsed: countTextTokens(taskPrompt) + countTextTokens(mockOutput),
        modelUsed: modelKey,
        steps
      }
    }

    try {
      // 检查是否需要使用工具
      const availableTools = this.def.tools.filter(t => getToolNames().includes(t))

      if (availableTools.length > 0 && this.shouldUseTool(task)) {
        // 使用工具执行
        const result = await this.executeWithTool(task, availableTools, messages, modelKey, signal)
        return result
      }

      // 直接 LLM 调用
      const response = await llm.chat({
        messages,
        modelKey,
        temperature: 0.5,
        maxTokens: this.def.maxTokens,
        signal,
        timeoutMs: 30 * 1000
      })

      const inputTokens = countTextTokens(messages.map(m => m.content).join(''))
      const outputTokens = countTextTokens(response)

      // 发送结果消息到黑板
      this.sendMessage(task.id, 'broadcast', response, 'result')

      return {
        status: 'success',
        data: response,
        tokensUsed: inputTokens + outputTokens,
        modelUsed: modelKey,
        steps
      }
    } catch (err) {
      const error = err as Error
      return {
        status: 'failure',
        data: null,
        tokensUsed: 0,
        modelUsed: modelKey,
        steps,
        error: error.message
      }
    }
  }

  /**
   * 使用工具执行任务（支持多步 ReAct 循环）
   */
  private async executeWithTool(
    task: PlanTask,
    tools: string[],
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    modelKey: string,
    signal?: AbortSignal
  ): Promise<TaskResult> {
    const MAX_TOOL_STEPS = 8  // 子 Agent 最多 8 步工具调用
    const toolPrompt = `你需要完成以下任务。可用工具: ${tools.join(', ')}。

任务: ${task.description}

如果需要使用工具，请按以下格式回复：
THOUGHT: <分析>
ACTION: <工具名称>
ACTION_INPUT: <JSON 参数>

如果不需要工具或已完成所有步骤，直接回答：
THOUGHT: <分析>
ACTION: FINAL_ANSWER
CONTENT: <回答>

重要规则：
- 浏览器任务典型流程: browser_navigate → browser_get_text/browser_screenshot → browser_click/browser_type → ... → browser_close
- 每次只调用一个工具，等待结果后再决定下一步
- 完成所有步骤后，使用 FINAL_ANSWER 给出总结`

    let totalInputTokens = 0
    let totalOutputTokens = 0
    const conversationMessages = [...messages, { role: 'user' as const, content: toolPrompt }]
    totalInputTokens += countTextTokens(toolPrompt)

    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      if (signal?.aborted) {
        return {
          status: 'failure',
          data: '操作被中止',
          tokensUsed: totalInputTokens + totalOutputTokens,
          modelUsed: modelKey,
          steps: [],
          error: 'aborted'
        }
      }

      const response = await llm.chat({
        messages: conversationMessages,
        modelKey,
        temperature: 0.3,
        maxTokens: this.def.maxTokens,
        signal,
        timeoutMs: 30 * 1000
      })

      totalInputTokens += countTextTokens(conversationMessages.map(m => m.content).join(''))
      totalOutputTokens += countTextTokens(response)

      // 解析是否需要工具
      const actionMatch = response.match(/ACTION:\s*(\S+)/i)
      const action = actionMatch ? actionMatch[1].trim() : 'FINAL_ANSWER'

      if (action === 'FINAL_ANSWER' || !tools.includes(action)) {
        // 没有使用工具或已完成，直接返回 LLM 回答
        const contentMatch = response.match(/CONTENT:\s*([\s\S]*?)$/i)
        const finalOutput = contentMatch ? contentMatch[1].trim() : response

        this.sendMessage(task.id, 'broadcast', finalOutput, 'result')

        return {
          status: 'success',
          data: finalOutput,
          tokensUsed: totalInputTokens + totalOutputTokens,
          modelUsed: modelKey
        }
      }

      // 执行工具
      const actionInputMatch = response.match(/ACTION_INPUT:\s*([\s\S]*?)(?=\nTHOUGHT:|$)/i)
      let toolParams: Record<string, unknown> = {}
      try {
        toolParams = actionInputMatch ? JSON.parse(actionInputMatch[1].trim()) : {}
      } catch {
        const jsonMatch = actionInputMatch?.[1]?.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try {
            toolParams = JSON.parse(jsonMatch[0])
          } catch {
            toolParams = { raw: actionInputMatch?.[1]?.trim() || '' }
          }
        } else {
          toolParams = { raw: actionInputMatch?.[1]?.trim() || '' }
        }
      }

      const toolResult = await executeAction({
        id: `subcall-${Date.now()}-${step}`,
        toolId: action,
        parameters: toolParams
      }, signal)

      // 将 LLM 回复和工具结果加入对话，继续下一轮
      conversationMessages.push({ role: 'assistant', content: response })

      // 构建详细的工具结果观察文本（包含实际内容，不只是摘要）
      let observationText = toolResult.success
        ? toolResult.resultSummary
        : `失败: ${toolResult.error || toolResult.resultSummary}`
      if (toolResult.success && toolResult.result && typeof toolResult.result === 'object') {
        const result = toolResult.result as {
          content?: string
          url?: string
          results?: Array<{ index?: number; title?: string; url?: string; snippet?: string; content?: string }>
          stdout?: string
          stderr?: string
          exitCode?: number
        }
        // fetch_url 结果：包含 top-level content 字段
        if (typeof result.content === 'string' && result.url && !result.results) {
          observationText = `${toolResult.resultSummary}\n\n--- 抓取内容 ---\n${result.content}`
        }
        // web_search 结果
        else if (result.results && Array.isArray(result.results) && result.results.length > 0) {
          observationText = `${toolResult.resultSummary}\n\n搜索结果详情：`
          for (const r of result.results) {
            observationText += `\n[${r.index || '?'}] ${r.title || '(无标题)'}\n`
            observationText += `  链接: ${r.url || ''}\n`
            if (r.snippet) observationText += `  摘要: ${r.snippet}\n`
            if (r.content) observationText += `  内容: ${r.content}\n`
          }
        }
        // terminal 结果
        else if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
          if (result.stdout && result.stdout.trim()) {
            observationText += `\n--- stdout ---\n${result.stdout}`
          }
          if (result.stderr && result.stderr.trim()) {
            observationText += `\n--- stderr ---\n${result.stderr}`
          }
        }
      }

      conversationMessages.push({
        role: 'user',
        content: `工具 ${action} 执行结果:
${observationText}

请继续。如果已完成所有步骤，使用 FINAL_ANSWER 给出总结。如果搜索结果不包含需要的具体数据，可以换关键词再搜索或使用 fetch_url 抓取搜索结果中的页面。`
      })
      totalInputTokens += countTextTokens(observationText)
    }

    // 循环耗尽，生成总结
    const finalPrompt = `你已经使用了 ${MAX_TOOL_STEPS} 步工具调用。请基于以上所有结果，完成任务: ${task.description}`
    const finalResponse = await llm.chat({
      messages: [...conversationMessages, { role: 'user', content: finalPrompt }],
      modelKey,
      temperature: 0.5,
      maxTokens: this.def.maxTokens,
      signal,
      timeoutMs: 30 * 1000
    })

    totalInputTokens += countTextTokens(finalPrompt)
    totalOutputTokens += countTextTokens(finalResponse)

    this.sendMessage(task.id, 'broadcast', finalResponse, 'result')

    return {
      status: 'success',
      data: finalResponse,
      tokensUsed: totalInputTokens + totalOutputTokens,
      modelUsed: modelKey
    }
  }

  /**
   * 判断任务是否需要使用工具
   */
  private shouldUseTool(task: PlanTask): boolean {
    const desc = task.description.toLowerCase()
    // 计算类任务
    if (/计算|求值|算|calculate|compute|math/.test(desc)) return true
    // 搜索类任务
    if (/搜索|查找|search|find|look up|查询/.test(desc)) return true
    // 文件读取
    if (/读取|文件|read|file|打开/.test(desc)) return true
    // 代码执行
    if (/执行|运行|代码|execute|run|code/.test(desc)) return true
    // 浏览器自动化任务
    if (/浏览器|browser|网页|navigate|截图|screenshot|点击|click|输入框|type|滚动|scroll|网址|url/.test(desc)) return true
    return false
  }

  /** 从黑板收集依赖任务的结果 */
  private collectDependencyResults(task: PlanTask): string[] {
    const results: string[] = []
    for (const depId of task.dependencies) {
      const data = this.blackboard.data.get(depId)
      if (data) {
        results.push(`[${depId} 的结果]: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
      }
    }
    return results
  }

  /** 构建子任务 prompt */
  private buildTaskPrompt(task: PlanTask, dependencyResults: string[]): string {
    let prompt = `任务: ${task.name}\n描述: ${task.description}`

    if (dependencyResults.length > 0) {
      prompt += `\n\n前置任务的结果:\n${dependencyResults.join('\n\n')}`
    }

    prompt += `\n\n请完成以上任务，提供清晰的结果。`
    return prompt
  }

  /** 发送消息到黑板 */
  private sendMessage(from: string, to: string | 'broadcast', content: string, type: AgentMessage['type']): void {
    this.blackboard.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      to,
      content,
      timestamp: Date.now(),
      type
    })
  }

  /** Mock 输出（未配置 LLM 时） */
  private getMockOutput(task: PlanTask): string {
    return `[子Agent "${this.def.name}" 执行任务 "${task.name}"]\n\n任务描述: ${task.description}\n\n（当前为 Mock 模式，未配置 LLM。配置 LLM 后子 Agent 将提供真实回复。）`
  }
}

/**
 * 根据任务类型获取最合适的子 Agent
 */
export function selectSubAgent(agentType: string, blackboard: Blackboard): SubAgent {
  // 根据类型映射到 agent ID
  const typeToId: Record<string, string> = {
    'coder': 'agent-coder',
    'researcher': 'agent-researcher',
    'writer': 'agent-writer',
    'analyst': 'agent-analyst',
    'general': 'agent-general'
  }

  const agentId = typeToId[agentType] || 'agent-general'
  const def = BUILTIN_AGENTS.find(a => a.id === agentId) || BUILTIN_AGENTS[BUILTIN_AGENTS.length - 1]

  return new SubAgent(def, blackboard)
}

/**
 * 获取所有内置子 Agent 定义
 */
export function getBuiltinAgents(): SubAgentDef[] {
  return BUILTIN_AGENTS
}
