/**
 * 反馈收集器 — 记录用户对 Agent 回复的隐式和显式反馈
 *
 * 支持两种反馈来源:
 * - 显式反馈: 👍/👎 按钮
 * - 隐式反馈: 复制回复、修改后重发、长时间忽略
 *
 * 当负反馈积累到阈值时，触发 Prompt 优化。
 */

import {
  recordFeedback,
  getCurrentPrompt,
  updatePromptFeedback,
  getRecentNegativeFeedbackCount,
  getAllFeedback
} from '../../../src/main/storage/repositories/prompts'
import { generateEmbedding } from '../../memory/embeddings'

/** 反馈类型 */
export type FeedbackType = 'positive' | 'negative' | 'neutral'

/** 反馈来源 */
export type FeedbackSource = 'explicit' | 'implicit'

/** 反馈记录 */
export interface FeedbackRecord {
  messageId?: string
  sessionId?: string
  feedbackType: FeedbackType
  feedbackSource: FeedbackSource
  userQuery?: string
  agentResponse?: string
  comment?: string
}

/** 优化触发阈值 */
const OPTIMIZATION_THRESHOLD = 3

/** 是否已初始化 */
let initialized = false

/** 初始化反馈收集器 */
export function initFeedbackCollector(): void {
  if (initialized) return
  initialized = true
  console.log('[FeedbackCollector] Initialized')
}

/**
 * 记录显式反馈（👍/👎）
 */
export function recordExplicitFeedback(feedback: {
  messageId?: string
  sessionId?: string
  feedbackType: FeedbackType
  userQuery?: string
  agentResponse?: string
  comment?: string
}): void {
  recordFeedback({
    messageId: feedback.messageId,
    sessionId: feedback.sessionId,
    feedbackType: feedback.feedbackType,
    feedbackSource: 'explicit',
    userQuery: feedback.userQuery,
    agentResponse: feedback.agentResponse,
    comment: feedback.comment
  })

  // 更新当前 Prompt 版本的反馈统计
  const currentPrompt = getCurrentPrompt('system')
  if (currentPrompt) {
    if (feedback.feedbackType === 'positive' || feedback.feedbackType === 'negative') {
      updatePromptFeedback(currentPrompt.id, feedback.feedbackType)
    }
  }

  console.log(
    `[FeedbackCollector] Explicit feedback recorded: ${feedback.feedbackType}`,
    { messageId: feedback.messageId }
  )
}

/**
 * 记录隐式反馈
 * - copy: 用户复制了回复 → 正反馈
 * - edit: 用户修改后重新发送 → 负反馈
 * - ignore: 用户长时间未回复 → 中性/轻微负反馈
 */
export function recordImplicitFeedback(
  action: 'copy' | 'edit' | 'ignore',
  context: {
    messageId?: string
    sessionId?: string
    userQuery?: string
    agentResponse?: string
  }
): void {
  let feedbackType: FeedbackType = 'neutral'

  switch (action) {
    case 'copy':
      feedbackType = 'positive'
      break
    case 'edit':
      feedbackType = 'negative'
      break
    case 'ignore':
      feedbackType = 'neutral'
      break
  }

  recordFeedback({
    messageId: context.messageId,
    sessionId: context.sessionId,
    feedbackType,
    feedbackSource: 'implicit',
    userQuery: context.userQuery,
    agentResponse: context.agentResponse
  })

  // 更新 Prompt 版本统计
  const currentPrompt = getCurrentPrompt('system')
  if (currentPrompt && (feedbackType === 'positive' || feedbackType === 'negative')) {
    updatePromptFeedback(currentPrompt.id, feedbackType)
  }

  console.log(
    `[FeedbackCollector] Implicit feedback recorded: ${action} → ${feedbackType}`,
    { messageId: context.messageId }
  )
}

/**
 * 检查是否应该触发 Prompt 优化
 * 直接从 feedback 表统计负反馈数量（更可靠）
 * @returns 是否达到优化阈值
 */
export function shouldOptimizePrompt(): boolean {
  // 直接从 feedback 表统计负反馈
  const allFeedback = getAllFeedback(100)
  const negativeCount = allFeedback.filter(f => f.feedbackType === 'negative').length
  return negativeCount >= OPTIMIZATION_THRESHOLD
}

/**
 * 获取优化阈值
 */
export function getOptimizationThreshold(): number {
  return OPTIMIZATION_THRESHOLD
}

/**
 * 收集用于优化的反馈上下文
 * 获取最近的负反馈样本，供 Prompt 优化器分析
 */
export async function collectFeedbackContext(): Promise<{
  negativeCount: number
  threshold: number
  shouldOptimize: boolean
  currentPromptContent: string | null
  currentPromptId: string | null
}> {
  const currentPrompt = getCurrentPrompt('system')
  // 直接从 feedback 表统计负反馈
  const allFeedback = getAllFeedback(100)
  const negativeCount = allFeedback.filter(f => f.feedbackType === 'negative').length

  return {
    negativeCount,
    threshold: OPTIMIZATION_THRESHOLD,
    shouldOptimize: negativeCount >= OPTIMIZATION_THRESHOLD,
    currentPromptContent: currentPrompt?.content ?? null,
    currentPromptId: currentPrompt?.id ?? null
  }
}
