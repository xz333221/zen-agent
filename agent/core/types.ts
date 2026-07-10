/**
 * Agent 核心类型定义
 */

import type { TraceStep, ExecutionTrace } from '../../src/shared/types'

/** Agent 执行上下文 */
export interface AgentContext {
  sessionId: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  tokenBudget: number
  signal?: AbortSignal
  /** 上下文设置 */
  settings: {
    maxTokens: number
    outputReserve: number
    recentMessageWindow: number
    compressionThreshold: number
    maxMemoriesRetrieved: number
    maxSkillsLoaded: number
  }
}

/** Agent 执行结果 */
export interface AgentResult {
  content: string
  trace: ExecutionTrace
  tokensUsed: {
    input: number
    output: number
  }
  modelsUsed: string[]
  duration: number
}

/** Agent 事件回调 */
export interface AgentCallbacks {
  onChunk?: (delta: string) => void
  onStepStart?: (step: TraceStep) => void
  onStepComplete?: (step: TraceStep) => void
  onTraceComplete?: (trace: ExecutionTrace) => void
  onStateChange?: (state: string) => void
  onError?: (error: Error) => void
}

/** ReAct 循环的单步记录 */
export interface ReActStep {
  think: string        // 推理过程
  action: string       // 决定的动作
  actionInput: Record<string, unknown>  // 动作参数
  observation: string  // 观察结果
}

/** 多 Agent 执行计划 */
export interface ExecutionPlan {
  id: string
  userRequest: string
  tasks: PlanTask[]
  createdAt: number
  totalBudget: number
}

export interface PlanTask {
  id: string
  name: string
  description: string
  agentType: string
  inputs: string[]
  outputs: string[]
  dependencies: string[]
  canParallelize: boolean
  estimatedTokens: number
  allocatedTokens?: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result?: TaskResult
  error?: string
  startTime?: number
  endTime?: number
  actualTokens?: number
}

export interface TaskResult {
  status: 'success' | 'partial' | 'failure'
  data: unknown
  tokensUsed: number
  modelUsed: string
  steps?: TraceStep[]
  error?: string
}

/** 子 Agent 定义 */
export interface SubAgentDef {
  id: string
  name: string
  type: 'builtin' | 'custom' | 'auto-generated'
  specialty: string
  systemPrompt: string
  tools: string[]
  defaultModel: string
  memoryScope: 'shared' | 'domain' | 'private'
  maxTokens: number
  status: 'active' | 'dormant' | 'retired'
  executionCount: number
  successRate: number
  createdAt: number
  lastUsedAt: number
}

/** 共享黑板（子 Agent 间通信） */
export interface Blackboard {
  planId: string
  data: Map<string, unknown>
  messages: AgentMessage[]
}

export interface AgentMessage {
  id: string
  from: string
  to: string | 'broadcast'
  content: string
  timestamp: number
  type: 'result' | 'question' | 'handoff' | 'status' | 'data'
  data?: unknown
}
