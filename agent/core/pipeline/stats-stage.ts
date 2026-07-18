/**
 * 统计与完成阶段 — Token 统计 + 完成标记
 */

import { getSystemPrompt } from '../../providers/llm-config'
import { countTextTokens } from '../../utils/token-counter'
import type { PipelineContext } from './context'

/** Token 统计 */
export function runStatsStage(ctx: PipelineContext): void {
  const { agentContext, trace } = ctx

  // 优先使用上下文管理器的真实 token 分布
  const breakdown = ctx.managedContext?.breakdown
  const contextBreakdown = breakdown
    ? {
        systemPrompt: breakdown.systemPrompt,
        toolDefinitions: 0,
        memories: 0,
        skills: 0,
        history: breakdown.summary + breakdown.history,
        userInput: breakdown.userInput,
        outputReserve: breakdown.outputReserve,
        total: trace.totalInputTokens + trace.totalOutputTokens,
        budget: breakdown.budget
      }
    : {
        systemPrompt: countTextTokens(getSystemPrompt()),
        toolDefinitions: 0,
        memories: 0,
        skills: 0,
        history: countTextTokens(agentContext.messages.map(m => m.content).join('')),
        userInput: 0,
        outputReserve: agentContext.settings.outputReserve,
        total: trace.totalInputTokens + trace.totalOutputTokens,
        budget: agentContext.settings.maxTokens
      }

  trace.recordStep('stats', 'Token 统计', '📊', {
    type: 'stats',
    contextBreakdown
  })
}

/** 完成标记 */
export function runCompleteStage(ctx: PipelineContext): void {
  ctx.trace.recordStep('complete', '完成', '✅', {
    type: 'complete',
    totalDuration: Date.now() - ctx.trace.startTime,
    toolCalls: ctx.trace.steps.filter(s => s.type === 'act').length,
    llmCalls: ctx.llmCallCount
  })
}
