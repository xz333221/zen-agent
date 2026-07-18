/**
 * 反思阶段 — 对执行结果进行自评，生成评分和改进建议
 */

import { reflect } from '../reflection'
import type { PipelineContext } from './context'

export async function runReflectionStage(ctx: PipelineContext): Promise<void> {
  ctx.callbacks.onStateChange?.('thinking')
  const reflectDetail = await reflect(ctx.userInput, ctx.finalOutput, ctx.reactSteps, ctx.signal)
  ctx.trace.recordStep('reflect', '反思', '🔄', reflectDetail)
}
