/**
 * Prompt 版本管理 Repository — CRUD 操作
 *
 * 管理系统提示词的版本历史，支持回滚和 A/B 测试。
 */

import { query, execute } from '../database'

/** Prompt 版本 */
export interface PromptVersion {
  id: string
  version: number
  content: string
  target: string  // 'system' | 'react' | 'intent' 等
  isCurrent: boolean
  performance: number  // 1-5 评分
  createdAt: number
  feedbackCount: number
  negativeCount: number
  positiveCount: number
}

interface PromptVersionRow {
  id: string
  version: number
  content: string
  target: string
  is_current: number
  performance: number
  created_at: number
  feedback_count: number
  negative_count: number
  positive_count: number
}

/** 创建新的 Prompt 版本 */
export function createPromptVersion(
  content: string,
  target: string = 'system',
  performance: number = 3
): PromptVersion {
  const now = Date.now()

  // 获取当前最大版本号
  const versionRows = query<{ max_version: number }>(
    'SELECT COALESCE(MAX(version), 0) as max_version FROM prompt_versions WHERE target = ?',
    [target]
  )
  const nextVersion = (versionRows[0]?.max_version ?? 0) + 1

  // 取消之前的 current 状态
  execute(
    'UPDATE prompt_versions SET is_current = 0 WHERE target = ?',
    [target]
  )

  const id = `prompt-${target}-${now}-${Math.random().toString(36).slice(2, 8)}`

  execute(
    `INSERT INTO prompt_versions
     (id, version, content, target, is_current, performance, created_at, feedback_count, negative_count, positive_count)
     VALUES (?, ?, ?, ?, 1, ?, ?, 0, 0, 0)`,
    [id, nextVersion, content, target, performance, now]
  )

  return {
    id,
    version: nextVersion,
    content,
    target,
    isCurrent: true,
    performance,
    createdAt: now,
    feedbackCount: 0,
    negativeCount: 0,
    positiveCount: 0
  }
}

/** 获取当前活跃的 Prompt 版本 */
export function getCurrentPrompt(target: string = 'system'): PromptVersion | null {
  const rows = query<PromptVersionRow>(
    "SELECT * FROM prompt_versions WHERE target = ? AND is_current = 1 LIMIT 1",
    [target]
  )
  if (rows.length === 0) return null
  return rowToPromptVersion(rows[0])
}

/** 获取所有版本 */
export function getPromptVersions(target?: string): PromptVersion[] {
  const sql = target
    ? 'SELECT * FROM prompt_versions WHERE target = ? ORDER BY version DESC'
    : 'SELECT * FROM prompt_versions ORDER BY created_at DESC'
  const params = target ? [target] : []
  const rows = query<PromptVersionRow>(sql, params)
  return rows.map(rowToPromptVersion)
}

/** 回滚到指定版本 */
export function rollbackToVersion(id: string): void {
  const rows = query<PromptVersionRow>(
    'SELECT target FROM prompt_versions WHERE id = ?',
    [id]
  )
  if (rows.length === 0) return

  const target = rows[0].target

  // 取消所有 current
  execute(
    'UPDATE prompt_versions SET is_current = 0 WHERE target = ?',
    [target]
  )

  // 设置指定版本为 current
  execute(
    'UPDATE prompt_versions SET is_current = 1 WHERE id = ?',
    [id]
  )
}

/** 更新反馈统计 */
export function updatePromptFeedback(
  id: string,
  feedbackType: 'positive' | 'negative'
): void {
  if (feedbackType === 'positive') {
    execute(
      `UPDATE prompt_versions SET positive_count = positive_count + 1, feedback_count = feedback_count + 1 WHERE id = ?`,
      [id]
    )
  } else {
    execute(
      `UPDATE prompt_versions SET negative_count = negative_count + 1, feedback_count = feedback_count + 1 WHERE id = ?`,
      [id]
    )
  }
}

/** 更新性能评分 */
export function updatePromptPerformance(id: string, performance: number): void {
  execute(
    'UPDATE prompt_versions SET performance = ? WHERE id = ?',
    [Math.max(1, Math.min(5, performance)), id]
  )
}

/** 删除版本 */
export function deletePromptVersion(id: string): void {
  execute('DELETE FROM prompt_versions WHERE id = ?', [id])
}

// ── 反馈记录 ──

interface FeedbackRow {
  id: string
  message_id: string | null
  session_id: string | null
  feedback_type: string
  feedback_source: string
  user_query: string | null
  agent_response: string | null
  comment: string | null
  created_at: number
}

/** 记录用户反馈 */
export function recordFeedback(feedback: {
  messageId?: string
  sessionId?: string
  feedbackType: 'positive' | 'negative' | 'neutral'
  feedbackSource?: 'explicit' | 'implicit'
  userQuery?: string
  agentResponse?: string
  comment?: string
}): void {
  const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  execute(
    `INSERT INTO feedback (id, message_id, session_id, feedback_type, feedback_source, user_query, agent_response, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      feedback.messageId ?? null,
      feedback.sessionId ?? null,
      feedback.feedbackType,
      feedback.feedbackSource ?? 'explicit',
      feedback.userQuery ?? null,
      feedback.agentResponse ?? null,
      feedback.comment ?? null,
      Date.now()
    ]
  )
}

/** 获取最近的负反馈数量 */
export function getRecentNegativeFeedbackCount(target: string = 'system'): number {
  const current = getCurrentPrompt(target)
  if (!current) return 0
  return current.negativeCount
}

/** 获取所有反馈 */
export function getAllFeedback(limit = 100): Array<{
  id: string
  feedbackType: string
  feedbackSource: string
  userQuery?: string
  agentResponse?: string
  comment?: string
  createdAt: number
}> {
  const rows = query<FeedbackRow>(
    'SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?',
    [limit]
  )
  return rows.map(r => ({
    id: r.id,
    feedbackType: r.feedback_type,
    feedbackSource: r.feedback_source,
    userQuery: r.user_query ?? undefined,
    agentResponse: r.agent_response ?? undefined,
    comment: r.comment ?? undefined,
    createdAt: r.created_at
  }))
}

// ── 辅助 ──

function rowToPromptVersion(row: PromptVersionRow): PromptVersion {
  return {
    id: row.id,
    version: row.version,
    content: row.content,
    target: row.target,
    isCurrent: !!row.is_current,
    performance: row.performance,
    createdAt: row.created_at,
    feedbackCount: row.feedback_count,
    negativeCount: row.negative_count,
    positiveCount: row.positive_count
  }
}
