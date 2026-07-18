/**
 * 进化日志 — 持久化进化记录到 SQLite
 *
 * 记录每次自进化循环的完整过程：
 * - 触发原因、改进目标
 * - 修改了哪些文件
 * - 编译/测试结果
 * - 评估结果
 * - 最终 outcome（成功/失败/回滚）
 * - Token 消耗
 *
 * 这些记录供后续进化参考，避免重复尝试已知失败的改进。
 */

import { query, execute } from '../../../src/main/storage/database'
import type { EvolutionRecord, EvolutionLogEntry, EvolutionOutcome } from './types'

// ── 数据库表行映射 ──

interface EvolutionRecordRow {
  id: string
  trigger_reason: string
  goal: string
  files_changed: string        // JSON array
  plan_json: string | null     // JSON ImprovementPlan
  test_result_json: string | null
  evaluation_json: string | null
  outcome: string              // EvolutionOutcome
  commit_hash: string | null
  failure_reason: string | null
  tokens_input: number
  tokens_output: number
  started_at: number
  finished_at: number | null
  logs_json: string            // JSON array of EvolutionLogEntry
}

/**
 * 初始化进化记录表
 * 在 database.ts 的 runMigrations 中调用
 */
export function initEvolutionTables(): void {
  const db = require('../../src/main/storage/database').getDatabase()
  if (!db) {
    console.warn('[EvolutionJournal] DB not ready, skipping table creation')
    return
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS evolution_records (
      id TEXT PRIMARY KEY,
      trigger_reason TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      files_changed TEXT NOT NULL DEFAULT '[]',
      plan_json TEXT,
      test_result_json TEXT,
      evaluation_json TEXT,
      outcome TEXT NOT NULL DEFAULT 'failure',
      commit_hash TEXT,
      failure_reason TEXT,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      logs_json TEXT NOT NULL DEFAULT '[]'
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_evolution_outcome
    ON evolution_records(outcome)
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_evolution_started
    ON evolution_records(started_at DESC)
  `)

  // ── Token 使用记录表 ──
  db.run(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'chat'
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_time
    ON token_usage(timestamp DESC)
  `)

  console.log('[EvolutionJournal] Tables initialized')
}

/**
 * 创建进化记录
 */
export function createEvolutionRecord(
  id: string,
  trigger: string,
  goal: string,
  startedAt: number
): void {
  execute(
    `INSERT INTO evolution_records
     (id, trigger_reason, goal, files_changed, outcome, tokens_input, tokens_output, started_at, logs_json)
     VALUES (?, ?, ?, '[]', 'failure', 0, 0, ?, '[]')`,
    [id, trigger, goal, startedAt]
  )
}

/**
 * 更新进化记录
 */
export function updateEvolutionRecord(
  id: string,
  updates: Partial<{
    trigger: string
    goal: string
    filesChanged: string[]
    planJson: string | null
    testResultJson: string | null
    evaluationJson: string | null
    outcome: EvolutionOutcome
    commitHash: string | null
    failureReason: string | null
    tokensInput: number
    tokensOutput: number
    finishedAt: number | null
    logsJson: string
  }>
): void {
  const sets: string[] = []
  const params: unknown[] = []

  if (updates.trigger !== undefined) {
    sets.push('trigger_reason = ?')
    params.push(updates.trigger)
  }
  if (updates.goal !== undefined) {
    sets.push('goal = ?')
    params.push(updates.goal)
  }
  if (updates.filesChanged !== undefined) {
    sets.push('files_changed = ?')
    params.push(JSON.stringify(updates.filesChanged))
  }
  if (updates.planJson !== undefined) {
    sets.push('plan_json = ?')
    params.push(updates.planJson)
  }
  if (updates.testResultJson !== undefined) {
    sets.push('test_result_json = ?')
    params.push(updates.testResultJson)
  }
  if (updates.evaluationJson !== undefined) {
    sets.push('evaluation_json = ?')
    params.push(updates.evaluationJson)
  }
  if (updates.outcome !== undefined) {
    sets.push('outcome = ?')
    params.push(updates.outcome)
  }
  if (updates.commitHash !== undefined) {
    sets.push('commit_hash = ?')
    params.push(updates.commitHash)
  }
  if (updates.failureReason !== undefined) {
    sets.push('failure_reason = ?')
    params.push(updates.failureReason)
  }
  if (updates.tokensInput !== undefined) {
    sets.push('tokens_input = ?')
    params.push(updates.tokensInput)
  }
  if (updates.tokensOutput !== undefined) {
    sets.push('tokens_output = ?')
    params.push(updates.tokensOutput)
  }
  if (updates.finishedAt !== undefined) {
    sets.push('finished_at = ?')
    params.push(updates.finishedAt)
  }
  if (updates.logsJson !== undefined) {
    sets.push('logs_json = ?')
    params.push(updates.logsJson)
  }

  if (sets.length === 0) return

  params.push(id)
  execute(`UPDATE evolution_records SET ${sets.join(', ')} WHERE id = ?`, params)
}

/**
 * 获取进化记录
 */
export function getEvolutionRecord(id: string): EvolutionRecord | null {
  const rows = query<EvolutionRecordRow>(
    'SELECT * FROM evolution_records WHERE id = ?',
    [id]
  )
  if (rows.length === 0) return null
  return rowToRecord(rows[0])
}

/**
 * 获取最近的进化记录
 */
export function getRecentEvolutionRecords(limit: number = 20): EvolutionRecord[] {
  const rows = query<EvolutionRecordRow>(
    'SELECT * FROM evolution_records ORDER BY started_at DESC LIMIT ?',
    [limit]
  )
  return rows.map(rowToRecord)
}

/**
 * 获取失败的进化记录（避免重复尝试）
 */
export function getFailedEvolutionRecords(limit: number = 50): EvolutionRecord[] {
  const rows = query<EvolutionRecordRow>(
    `SELECT * FROM evolution_records
     WHERE outcome IN ('failure', 'rolled_back')
     ORDER BY started_at DESC LIMIT ?`,
    [limit]
  )
  return rows.map(rowToRecord)
}

/**
 * 获取进化统计
 */
export function getEvolutionStats(): {
  total: number
  success: number
  failure: number
  rolledBack: number
  totalTokensInput: number
  totalTokensOutput: number
  lastEvolutionAt: number | null
} {
  const rows = query<{ count: number; outcome: string }>(
    'SELECT outcome, COUNT(*) as count FROM evolution_records GROUP BY outcome'
  )

  let total = 0
  let success = 0
  let failure = 0
  let rolledBack = 0

  for (const r of rows) {
    total += r.count
    if (r.outcome === 'success') success = r.count
    else if (r.outcome === 'failure') failure = r.count
    else if (r.outcome === 'rolled_back') rolledBack = r.count
  }

  const tokenRows = query<{ total_input: number; total_output: number }>(
    'SELECT SUM(tokens_input) as total_input, SUM(tokens_output) as total_output FROM evolution_records'
  )
  const lastRow = query<{ started_at: number }>(
    'SELECT started_at FROM evolution_records ORDER BY started_at DESC LIMIT 1'
  )

  return {
    total,
    success,
    failure,
    rolledBack,
    totalTokensInput: tokenRows[0]?.total_input ?? 0,
    totalTokensOutput: tokenRows[0]?.total_output ?? 0,
    lastEvolutionAt: lastRow[0]?.started_at ?? null
  }
}

// ── Token 使用记录 ──

/**
 * 记录 Token 使用
 */
export function recordTokenUsage(
  inputTokens: number,
  outputTokens: number,
  purpose: 'chat' | 'evolution' | 'embedding' | 'other' = 'chat'
): void {
  const id = `tu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  execute(
    `INSERT INTO token_usage (id, timestamp, input_tokens, output_tokens, purpose)
     VALUES (?, ?, ?, ?, ?)`,
    [id, Date.now(), inputTokens, outputTokens, purpose]
  )
}

/**
 * 获取指定时间范围内的 Token 使用量
 */
export function getTokenUsageSince(since: number): {
  totalInput: number
  totalOutput: number
  evolutionInput: number
  evolutionOutput: number
} {
  const rows = query<{ purpose: string; total_input: number; total_output: number }>(
    `SELECT purpose,
       SUM(input_tokens) as total_input,
       SUM(output_tokens) as total_output
     FROM token_usage
     WHERE timestamp >= ?
     GROUP BY purpose`,
    [since]
  )

  let totalInput = 0
  let totalOutput = 0
  let evolutionInput = 0
  let evolutionOutput = 0

  for (const r of rows) {
    totalInput += r.total_input ?? 0
    totalOutput += r.total_output ?? 0
    if (r.purpose === 'evolution') {
      evolutionInput += r.total_input ?? 0
      evolutionOutput += r.total_output ?? 0
    }
  }

  return { totalInput, totalOutput, evolutionInput, evolutionOutput }
}

// ── 辅助函数 ──

function rowToRecord(row: EvolutionRecordRow): EvolutionRecord {
  let logs: EvolutionLogEntry[] = []
  try {
    logs = JSON.parse(row.logs_json || '[]')
  } catch { /* ignore */ }

  return {
    id: row.id,
    phase: 'done',
    trigger: row.trigger_reason,
    goal: row.goal,
    filesChanged: JSON.parse(row.files_changed || '[]'),
    plan: row.plan_json ? JSON.parse(row.plan_json) : null,
    testResult: row.test_result_json ? JSON.parse(row.test_result_json) : null,
    evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json) : null,
    outcome: row.outcome as EvolutionOutcome,
    commitHash: row.commit_hash,
    failureReason: row.failure_reason,
    tokensUsed: {
      input: row.tokens_input,
      output: row.tokens_output
    },
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    logs
  }
}
