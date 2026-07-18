/**
 * 进化阶段 — 模式检测 + 自动技能生成 + Prompt 优化检测
 *
 * 1. 记录本次查询到模式检测器，检查是否出现重复模式
 * 2. 检测到重复模式（3+ 次相似请求）时自动生成可复用技能
 * 3. 负反馈达到阈值时自动优化系统 Prompt
 */

import { shouldOptimizePrompt } from '../../evolution/interaction/feedback-collector'
import { optimizePrompt as runPromptOptimization } from '../../evolution/interaction/prompt-optimizer'
import type { PipelineContext } from './context'

/** 模式检测 + 技能生成 */
export async function runEvolutionStage(ctx: PipelineContext): Promise<void> {
  const { agentContext, services, userInput, trace } = ctx
  const complexity = ctx.intent?.complexity ?? 'medium'

  // 记录查询到模式检测器
  await services.patterns.recordQuery(
    userInput,
    complexity,
    trace.steps.filter(s => s.type === 'act').map(s => s.name),
    agentContext.sessionId,
    ctx.signal
  )

  // 检测模式
  const detection = services.patterns.detect()

  if (!detection.detected || detection.patterns.length === 0) return

  // 对每个检测到的模式生成技能
  for (const pattern of detection.patterns) {
    const skillId = await services.skills.createFromPattern(pattern, ctx.signal)

    if (skillId) {
      // 触发宠物进化状态
      ctx.callbacks.onStateChange?.('evolving')

      // 记录进化事件到追踪
      trace.recordStep('store', `进化: ${pattern.suggestedSkillName}`, '🌟', {
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

/** Prompt 优化检测（负反馈阈值触发） */
export async function runPromptOptimizationStage(ctx: PipelineContext): Promise<void> {
  // 检查是否达到优化阈值
  if (!shouldOptimizePrompt()) return

  // 触发优化
  const result = await runPromptOptimization(ctx.signal)

  if (result.success) {
    // 触发宠物进化状态
    ctx.callbacks.onStateChange?.('evolving')

    // 记录到追踪步骤
    ctx.trace.recordStep('store', `Prompt 优化: v${result.oldVersion} → v${result.newVersion}`, '🔧', {
      type: 'store',
      episodicMemoryId: result.newVersionId ?? `prompt-v${result.newVersion}`,
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
