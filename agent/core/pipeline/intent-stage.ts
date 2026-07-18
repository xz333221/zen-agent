/**
 * 意图识别阶段 — 分析用户输入的复杂度和类型
 */

import { parseIntent, toIntentDetail } from '../intent-parser'
import type { PipelineContext } from './context'

export async function runIntentStage(ctx: PipelineContext): Promise<void> {
  ctx.callbacks.onStateChange?.('thinking')
  const intentResult = await parseIntent(ctx.userInput, ctx.signal)
  const detail = toIntentDetail(ctx.userInput, intentResult)
  ctx.trace.recordStep('intent', '意图识别', '📝', detail)
  ctx.intent = {
    complexity: intentResult.complexity,
    requiresPlanning: intentResult.requiresPlanning
  }
}
