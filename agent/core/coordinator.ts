/**
 * 协调器 — 负责任务分解和子 Agent 调度
 *
 * 核心流程:
 * 1. 分析任务复杂度，判断是否需要分解
 * 2. 将复杂任务分解为子任务（LLM 驱动或规则回退）
 * 3. 根据依赖关系调度子任务（支持并行执行）
 * 4. 分配子任务给合适的子 Agent
 * 5. 汇总子 Agent 结果
 *
 * 当 LLM 不可用时，使用规则分解策略。
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig } from '../providers/llm-config'
import { selectSubAgent } from './sub-agent'
import { countTextTokens } from '../utils/token-counter'
import type {
  ExecutionPlan,
  PlanTask,
  TaskResult,
  Blackboard,
  AgentMessage,
  AgentCallbacks
} from './types'
import type { TraceStep, StepDetail, PlanDetail, DelegateDetail } from '../../src/shared/types'

export interface CoordinatorOptions {
  maxTasks?: number
  maxParallelTasks?: number
  totalBudget?: number
}

export class Coordinator {
  private callbacks: AgentCallbacks
  private options: CoordinatorOptions
  private blackboard: Blackboard
  private steps: TraceStep[] = []
  private stepIndex = 0
  private signal?: AbortSignal

  constructor(callbacks: AgentCallbacks = {}, options: CoordinatorOptions = {}) {
    this.callbacks = callbacks
    this.options = {
      maxTasks: options.maxTasks ?? 5,
      maxParallelTasks: options.maxParallelTasks ?? 2,
      totalBudget: options.totalBudget ?? 20000
    }
    this.blackboard = {
      planId: '',
      data: new Map(),
      messages: []
    }
  }

  /**
   * 执行协调：分解任务 → 调度 → 汇总
   */
  async coordinate(
    userRequest: string,
    context: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> },
    signal?: AbortSignal
  ): Promise<{ output: string; plan: ExecutionPlan | null; steps: TraceStep[] }> {
    this.signal = signal
    this.steps = []
    this.stepIndex = 0

    // ── Step 1: 任务分解 ──
    const plan = await this.decompose(userRequest, context)

    if (!plan || plan.tasks.length === 0) {
      return { output: '', plan: null, steps: this.steps }
    }

    this.blackboard.planId = plan.id

    // ── Step 2: 执行计划 ──
    const results = await this.executePlan(plan, context)

      // ── Step 3: 汇总结果 ──
    const output = await this.aggregateResults(userRequest, plan, results, context)

    return { output, plan, steps: this.steps }
  }

  /**
   * 任务分解 — 将复杂任务分解为子任务
   */
  private async decompose(
    userRequest: string,
    context: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> }
  ): Promise<ExecutionPlan | null> {
    if (isLLMConfigured()) {
      try {
        return await this.decomposeWithLLM(userRequest)
      } catch (err) {
        console.warn('[Coordinator] LLM decomposition failed, using rules:', err)
      }
    }

    return this.decomposeWithRules(userRequest)
  }

  /**
   * 使用 LLM 进行任务分解
   */
  private async decomposeWithLLM(userRequest: string): Promise<ExecutionPlan> {
    const config = getConfig()
    const prompt = `分析以下用户请求，将其分解为 ${this.options.maxTasks} 个以内的子任务。

用户请求: "${userRequest}"

返回 JSON 格式（不要其他内容）:
{
  "tasks": [
    {
      "name": "任务名称",
      "description": "任务详细描述",
      "agentType": "coder|researcher|writer|analyst|general",
      "dependencies": ["依赖的任务名称（空数组表示无依赖）"],
      "canParallelize": true|false
    }
  ]
}

规则:
- 每个子任务应清晰明确，可独立执行
- agentType: coder=编程, researcher=搜索研究, writer=写作, analyst=分析, general=通用
- dependencies: 列出必须先完成的任务名称
- canParallelize: 是否可以与其他无依赖关系的任务并行执行
- 最多 ${this.options.maxTasks} 个子任务

只返回 JSON。`

    const response = await llm.chat({
      messages: [
        { role: 'system', content: '你是任务分解助手，只返回 JSON。' },
        { role: 'user', content: prompt }
      ],
      modelKey: config.defaultModelKey,
      temperature: 0.3,
      maxTokens: 2000,
      signal: this.signal,
      timeoutMs: 15000
    })

    // 解析 JSON
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return this.decomposeWithRules(userRequest)
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as { tasks: Array<{
        name: string
        description: string
        agentType: string
        dependencies: string[]
        canParallelize: boolean
      }> }

      const tasks: PlanTask[] = parsed.tasks.slice(0, this.options.maxTasks).map((t, i) => {
        const taskId = `task-${i + 1}`
        return {
          id: taskId,
          name: t.name,
          description: t.description,
          agentType: t.agentType || 'general',
          inputs: [],
          outputs: [],
          dependencies: [], // 将在下面解析
          canParallelize: t.canParallelize ?? false,
          estimatedTokens: 3000,
          allocatedTokens: 3000,
          status: 'pending' as const
        }
      })

      // 解析依赖关系（名称 → ID）
      parsed.tasks.forEach((t, i) => {
        if (t.dependencies && tasks[i]) {
          tasks[i].dependencies = t.dependencies
            .map(depName => {
              const depTask = tasks.find(tt => tt.name === depName)
              return depTask?.id || ''
            })
            .filter(id => id)
        }
      })

      const totalEstimated = tasks.reduce((sum, t) => sum + t.estimatedTokens, 0)

      const plan: ExecutionPlan = {
        id: `plan-${Date.now()}`,
        userRequest,
        tasks,
        createdAt: Date.now(),
        totalBudget: this.options.totalBudget || 20000
      }

      // 创建计划追踪步骤
      this.createPlanStep(plan, 'llm')

      return plan
    } catch {
      return this.decomposeWithRules(userRequest)
    }
  }

  /**
   * 使用规则进行任务分解（LLM 不可用时的回退策略）
   */
  private decomposeWithRules(userRequest: string): ExecutionPlan {
    const tasks: PlanTask[] = []
    const lowerRequest = userRequest.toLowerCase()

    // 根据请求内容生成子任务
    if (/搜索|查找|search|研究|调研/.test(userRequest)) {
      tasks.push({
        id: 'task-1',
        name: '信息搜索',
        description: `搜索与以下请求相关的信息: ${userRequest}`,
        agentType: 'researcher',
        inputs: [],
        outputs: ['search-results'],
        dependencies: [],
        canParallelize: false,
        estimatedTokens: 3000,
        allocatedTokens: 3000,
        status: 'pending'
      })
    }

    if (/分析|比较|评估|对比/.test(userRequest)) {
      tasks.push({
        id: `task-${tasks.length + 1}`,
        name: '分析评估',
        description: `分析以下内容: ${userRequest}`,
        agentType: 'analyst',
        inputs: tasks.length > 0 ? ['search-results'] : [],
        outputs: ['analysis-results'],
        dependencies: tasks.length > 0 ? ['task-1'] : [],
        canParallelize: tasks.length === 0,
        estimatedTokens: 3000,
        allocatedTokens: 3000,
        status: 'pending'
      })
    }

    if (/代码|编程|实现|code|function|程序/.test(lowerRequest) || /代码|编程|实现/.test(userRequest)) {
      tasks.push({
        id: `task-${tasks.length + 1}`,
        name: '代码实现',
        description: `编写代码实现: ${userRequest}`,
        agentType: 'coder',
        inputs: tasks.length > 0 ? ['analysis-results'] : [],
        outputs: ['code-results'],
        dependencies: tasks.map(t => t.id),
        canParallelize: false,
        estimatedTokens: 4000,
        allocatedTokens: 4000,
        status: 'pending'
      })
    }

    if (/写|文章|文案|翻译|write/.test(lowerRequest) || /写一/.test(userRequest)) {
      tasks.push({
        id: `task-${tasks.length + 1}`,
        name: '内容创作',
        description: `撰写内容: ${userRequest}`,
        agentType: 'writer',
        inputs: tasks.length > 0 ? ['analysis-results'] : [],
        outputs: ['content-results'],
        dependencies: tasks.map(t => t.id),
        canParallelize: false,
        estimatedTokens: 3000,
        allocatedTokens: 3000,
        status: 'pending'
      })
    }

    // 如果没有匹配到任何特定任务，创建一个通用任务
    if (tasks.length === 0) {
      tasks.push({
        id: 'task-1',
        name: '任务执行',
        description: userRequest,
        agentType: 'general',
        inputs: [],
        outputs: ['results'],
        dependencies: [],
        canParallelize: true,
        estimatedTokens: 4000,
        allocatedTokens: 4000,
        status: 'pending'
      })
    }

    // 添加总结任务
    if (tasks.length > 1) {
      tasks.push({
        id: `task-${tasks.length + 1}`,
        name: '结果汇总',
        description: '汇总所有子任务的结果，生成最终回复',
        agentType: 'general',
        inputs: tasks.map(t => t.outputs[0]).filter(Boolean),
        outputs: ['final-output'],
        dependencies: tasks.map(t => t.id),
        canParallelize: false,
        estimatedTokens: 2000,
        allocatedTokens: 2000,
        status: 'pending'
      })
    }

    const totalEstimated = tasks.reduce((sum, t) => sum + t.estimatedTokens, 0)

    const plan: ExecutionPlan = {
      id: `plan-${Date.now()}`,
      userRequest,
      tasks,
      createdAt: Date.now(),
      totalBudget: this.options.totalBudget || 20000
    }

    this.createPlanStep(plan, 'rule')

    return plan
  }

  /**
   * 执行计划 — 按依赖关系调度子任务
   */
  private async executePlan(
    plan: ExecutionPlan,
    context: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> }
  ): Promise<Map<string, TaskResult>> {
    const results = new Map<string, TaskResult>()
    const completed = new Set<string>()
    const failed = new Set<string>()

    while (completed.size + failed.size < plan.tasks.length) {
      // 找出可执行的任务（依赖已完成）
      const readyTasks = plan.tasks.filter(t =>
        t.status === 'pending' &&
        t.dependencies.every(dep => completed.has(dep)) &&
        !t.dependencies.some(dep => failed.has(dep))
      )

      if (readyTasks.length === 0) {
        // 检查是否有被跳过的任务（依赖失败）
        const skipped = plan.tasks.filter(t =>
          t.status === 'pending' &&
          t.dependencies.some(dep => failed.has(dep))
        )
        for (const task of skipped) {
          task.status = 'skipped'
          failed.add(task.id)
          this.createDelegateStep(task, 'skipped', undefined, '依赖任务失败，已跳过', 0)
        }

        if (completed.size + failed.size >= plan.tasks.length) break
        if (readyTasks.length === 0 && skipped.length === 0) break
        continue
      }

      // 按并行限制执行
      const batch = readyTasks.slice(0, this.options.maxParallelTasks || 2)

      // 并行执行当前批次
      const promises = batch.map(async (task) => {
        task.status = 'running'
        task.startTime = Date.now()

        const agent = selectSubAgent(task.agentType, this.blackboard)
        const result = await agent.execute(task, context, this.signal)

        task.endTime = Date.now()
        task.actualTokens = result.tokensUsed
        task.result = result

        if (result.status === 'success' || result.status === 'partial') {
          task.status = 'completed'
          completed.add(task.id)
          this.blackboard.data.set(task.id, result.data)
          this.createDelegateStep(task, 'completed', result, undefined, task.endTime - task.startTime)
        } else {
          task.status = 'failed'
          task.error = result.error || 'Unknown error'
          failed.add(task.id)
          this.createDelegateStep(task, 'failed', result, result.error, task.endTime - task.startTime)
        }

        return result
      })

      await Promise.all(promises)
    }

    return results
  }

  /**
   * 汇总子任务结果
   */
  private async aggregateResults(
    userRequest: string,
    plan: ExecutionPlan,
    _results: Map<string, TaskResult>,
    context: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> }
  ): Promise<string> {
    const completedTasks = plan.tasks.filter(t => t.status === 'completed' && t.result)

    if (completedTasks.length === 0) {
      return '抱歉，所有子任务都执行失败了。请检查配置后重试。'
    }

    // 如果只有一个任务，直接返回其结果
    if (completedTasks.length === 1) {
      const data = completedTasks[0].result?.data
      return typeof data === 'string' ? data : JSON.stringify(data)
    }

    // 如果 LLM 可用，使用 LLM 汇总
    if (isLLMConfigured()) {
      return await this.aggregateWithLLM(userRequest, completedTasks, context)
    }

    // 规则汇总
    return this.aggregateWithRules(userRequest, completedTasks)
  }

  /** 使用 LLM 汇总 */
  private async aggregateWithLLM(
    userRequest: string,
    tasks: PlanTask[],
    context: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> }
  ): string {
    try {
      const config = getConfig()

      const taskResults = tasks.map(t => {
        const data = t.result?.data
        return `### ${t.name}\n${typeof data === 'string' ? data : JSON.stringify(data)}`
      }).join('\n\n')

      const prompt = `用户请求: ${userRequest}

以下是多个子任务的执行结果:

${taskResults}

请基于以上结果，为用户生成一个连贯、完整的回复。整合各子任务的信息，避免重复，确保逻辑清晰。`

      const response = await llm.chat({
        messages: [
          { role: 'system', content: '你是结果汇总助手，将多个子任务的结果整合为连贯的回复。' },
          ...context.messages.filter(m => m.role !== 'system').slice(-3),
          { role: 'user', content: prompt }
        ],
        modelKey: config.defaultModelKey,
        temperature: 0.5,
        maxTokens: 4000,
        signal: this.signal,
        timeoutMs: 20 * 1000
      })

      return response
    } catch {
      return this.aggregateWithRules(userRequest, tasks)
    }
  }

  /** 使用规则汇总 */
  private aggregateWithRules(userRequest: string, tasks: PlanTask[]): string {
    const parts = tasks.map(t => {
      const data = t.result?.data
      const content = typeof data === 'string' ? data : JSON.stringify(data)
      return `## ${t.name}\n\n${content}`
    })

    return `针对您的请求「${userRequest}」，我通过多个子 Agent 协作完成了以下任务：\n\n${parts.join('\n\n---\n\n')}`
  }

  // ═════════════════════════════════════════════════════════
  //  追踪步骤创建
  // ═════════════════════════════════════════════════════════

  private createPlanStep(plan: ExecutionPlan, method: 'llm' | 'rule'): void {
    const detail: PlanDetail = {
      type: 'plan',
      userRequest: plan.userRequest,
      taskCount: plan.tasks.length,
      tasks: plan.tasks.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        agentType: t.agentType,
        dependencies: t.dependencies,
        canParallelize: t.canParallelize,
        status: t.status,
        estimatedTokens: t.estimatedTokens
      })),
      totalEstimatedTokens: plan.tasks.reduce((sum, t) => sum + t.estimatedTokens, 0),
      decompositionMethod: method
    }

    this.createStep('plan', `任务分解 (${plan.tasks.length} 个子任务)`, '📋', detail)
  }

  private createDelegateStep(
    task: PlanTask,
    status: 'running' | 'completed' | 'failed' | 'skipped',
    result?: TaskResult,
    error?: string,
    duration: number = 0
  ): void {
    const detail: DelegateDetail = {
      type: 'delegate',
      taskId: task.id,
      taskName: task.name,
      agentType: task.agentType,
      agentId: `agent-${task.agentType}`,
      status,
      result: result ? {
        status: result.status,
        data: result.data,
        tokensUsed: result.tokensUsed,
        modelUsed: result.modelUsed
      } : undefined,
      error,
      duration
    }

    const icon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : status === 'skipped' ? '⏭️' : '🔄'
    const name = `委派: ${task.name} (${task.agentType})`

    this.createStep('delegate', name, icon, detail)
  }

  private createStep(
    type: TraceStep['type'],
    name: string,
    icon: string,
    detail: StepDetail
  ): TraceStep {
    const now = Date.now()
    const step: TraceStep = {
      id: `coord-step-${this.stepIndex}-${now}`,
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
}
