/**
 * PipelineContext — Agent 执行流水线的共享上下文
 *
 * 设计动机:
 * 历史上 AgentLoop 用 20+ 个实例变量在各步骤方法间隐式传递状态，
 * 既无法测试，也存在跨 await 的竞态风险。Pipeline 模式下，
 * 所有阶段产物都显式挂在 PipelineContext 上，阶段函数签名即依赖声明。
 */

import type { AgentCallbacks, AgentContext, ReActStep } from '../types'
import type { AgentServices } from '../services'
import type { ManagedContext } from '../context-manager'
import type { MemorySearchResult } from '../../memory/types'
import type { SkillMatchResult } from '../../skills/types'
import type { TraceStep, ExecutionTrace, StepDetail } from '../../../src/shared/types'

/** 意图识别阶段产物 */
export interface IntentStageResult {
  complexity: 'low' | 'medium' | 'high'
  requiresPlanning: boolean
}

/**
 * 执行追踪记录器
 *
 * 集中管理 steps 序列、token 统计、模型使用记录，
 * 替代原来散落在 AgentLoop 实例上的状态。
 */
export class TraceRecorder {
  readonly steps: TraceStep[] = []
  private stepIndex = 0
  startTime = Date.now()
  totalInputTokens = 0
  totalOutputTokens = 0
  readonly modelsUsed = new Set<string>()

  constructor(private callbacks: AgentCallbacks) {}

  /** 记录一个追踪步骤（原 AgentLoop.createStep） */
  recordStep(
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

  /** 记录外部组件（如 Coordinator）产生的步骤，保持序号连续 */
  recordExternalStep(step: TraceStep): void {
    this.callbacks.onStepStart?.(step)
    this.steps.push(step)
    this.stepIndex++
  }

  /** 粗略成本估算: 输入 $0.01/1K + 输出 $0.03/1K */
  estimateCost(): number {
    return (
      (this.totalInputTokens / 1000) * 0.01 +
      (this.totalOutputTokens / 1000) * 0.03
    )
  }

  /** 构建最终执行追踪 */
  buildTrace(sessionId: string, llmCalls: number): ExecutionTrace {
    return {
      id: `trace-${Date.now()}`,
      sessionId,
      messageId: `msg-${Date.now()}`,
      startTime: this.startTime,
      endTime: Date.now(),
      steps: this.steps,
      stats: {
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        estimatedCost: this.estimateCost(),
        llmCalls,
        toolCalls: this.steps.filter(s => s.type === 'act').length,
        modelsUsed: Array.from(this.modelsUsed)
      }
    }
  }

  /** 出错/中止时构建部分追踪（llmCalls 用 think+intent 步骤数近似） */
  buildPartialTrace(sessionId: string): ExecutionTrace {
    return {
      id: `trace-${Date.now()}`,
      sessionId,
      messageId: `msg-${Date.now()}`,
      startTime: this.startTime,
      endTime: Date.now(),
      steps: this.steps,
      stats: {
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        estimatedCost: this.estimateCost(),
        llmCalls: this.steps.filter(s => s.type === 'think' || s.type === 'intent').length,
        toolCalls: this.steps.filter(s => s.type === 'act').length,
        modelsUsed: Array.from(this.modelsUsed)
      }
    }
  }
}

/** Pipeline 共享上下文 */
export interface PipelineContext {
  /** 当前用户输入 */
  userInput: string
  /** Agent 会话上下文（消息历史、设置、sessionId） */
  agentContext: AgentContext
  /** 注入的服务依赖 */
  services: AgentServices
  /** UI 回调 */
  callbacks: AgentCallbacks
  /** 中止信号 */
  signal?: AbortSignal
  /** 执行追踪记录器 */
  trace: TraceRecorder

  // ── 阶段产物（随流水线推进逐步填充） ──
  /** 意图识别结果 */
  intent?: IntentStageResult
  /** 检索到的记忆 */
  memories: MemorySearchResult[]
  /** 匹配到的技能 */
  matchedSkills: SkillMatchResult[]
  /** 上下文管理结果 */
  managedContext: ManagedContext | null
  /** ReAct 推理步骤 */
  reactSteps: ReActStep[]
  /** 最终输出文本 */
  finalOutput: string
  /** LLM 调用计数 */
  llmCallCount: number
}

/** 创建 PipelineContext */
export function createPipelineContext(
  userInput: string,
  agentContext: AgentContext,
  services: AgentServices,
  callbacks: AgentCallbacks
): PipelineContext {
  return {
    userInput,
    agentContext,
    services,
    callbacks,
    signal: agentContext.signal,
    trace: new TraceRecorder(callbacks),
    memories: [],
    matchedSkills: [],
    managedContext: null,
    reactSteps: [],
    finalOutput: '',
    llmCallCount: 0
  }
}
