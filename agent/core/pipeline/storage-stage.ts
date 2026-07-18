/**
 * 记忆存储阶段 — 将本次对话存储为情景记忆
 *
 * 自动生成 Embedding 并检测重复，
 * 将用户意图、Agent 回复和执行过程持久化到记忆库。
 */

import type { PipelineContext } from './context'

export async function runStorageStage(ctx: PipelineContext): Promise<void> {
  const { agentContext, services, trace } = ctx

  const actions = trace.steps
    .filter(s => s.type === 'act')
    .map(s => s.name)

  const reflectStep = trace.steps.find(s => s.type === 'reflect')
  const successScore = reflectStep
    ? ((reflectStep.detail as { selfScore?: number })?.selfScore || 3)
    : 3

  const episodicMemory = await services.memory.storeEpisodic(
    ctx.userInput,
    ctx.finalOutput,
    actions,
    successScore,
    {
      sessionId: agentContext.sessionId,
      modelUsed: Array.from(trace.modelsUsed).join(','),
      skillsUsed: ctx.matchedSkills.map(m => m.skill.name),
      tags: [],
      signal: ctx.signal
    }
  )

  trace.recordStep('store', '记忆存储', '💾', {
    type: 'store',
    episodicMemoryId: episodicMemory?.id || `ep-${Date.now()}`,
    newSemanticMemories: []
  })
}
