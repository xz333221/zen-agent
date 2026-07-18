/**
 * 上下文管理阶段 — Token 预算分配 + 滑动窗口 + 摘要压缩
 *
 * 当对话历史超过预算时，自动将旧消息压缩为摘要，
 * 保留最近 N 条消息完整，确保上下文在 Token 限制内。
 */

import { ContextManager } from '../context-manager'
import type { PipelineContext } from './context'

export async function runContextStage(ctx: PipelineContext): Promise<void> {
  const { agentContext, userInput, signal } = ctx

  const manager = new ContextManager({
    maxTokens: agentContext.settings.maxTokens,
    outputReserve: agentContext.settings.outputReserve,
    recentMessageWindow: agentContext.settings.recentMessageWindow,
    compressionThreshold: agentContext.settings.compressionThreshold
  })

  const managed = await manager.manage(
    agentContext.messages,
    userInput,
    agentContext.sessionId,
    signal
  )
  ctx.managedContext = managed

  // 如果触发了压缩，在追踪中记录摘要信息
  if (managed.compressed && managed.summary) {
    ctx.trace.recordStep('stats', '上下文压缩', '🗜️', {
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
}
