/**
 * 向量存储 — 基于 SQLite + 余弦相似度的向量检索
 *
 * 存储方案:
 * - 向量以 JSON 字符串存储在 memories 表的 embedding 字段
 * - 检索时从数据库加载候选集，在内存中计算余弦相似度
 * - 适用于桌面应用的中小规模数据（数百到数千条记忆）
 *
 * 检索流程:
 * 1. 从数据库按条件（类型、时间）加载候选记忆及其嵌入
 * 2. 计算查询向量与每条记忆的余弦相似度
 * 3. 按相似度排序，返回 Top-K 结果
 * 4. 更新命中记忆的 access_count 和 last_accessed_at
 */

import { query, execute } from '../../src/main/storage/database'
import type { EpisodicMemory, SemanticMemory } from './types'

/** 存储中的记忆行 */
interface MemoryRow {
  id: string
  type: string
  mem_type: string | null
  content: string
  embedding: string | null
  session_id: string | null
  user_intent: string | null
  actions: string | null
  outcome: string | null
  success_score: number | null
  model_used: string | null
  skills_used: string | null
  tags: string | null
  source: string | null
  confidence: number | null
  importance: number | null
  created_at: number
  last_accessed_at: number | null
  access_count: number | null
}

/** 向量搜索结果 */
export interface VectorSearchResult {
  id: string
  type: 'episodic' | 'semantic'
  content: string
  embedding: number[]
  score: number  // 余弦相似度 [0, 1]
  sessionId?: string
  userIntent?: string
  actions?: string[]
  outcome?: string
  successScore?: number
  modelUsed?: string
  skillsUsed?: string[]
  tags?: string[]
  source?: string
  confidence?: number
  importance: number
  createdAt: number
  lastAccessedAt?: number
  accessCount: number
}

/** 搜索选项 */
export interface VectorSearchOptions {
  /** 记忆类型过滤 */
  type?: 'episodic' | 'semantic'
  /** 会话 ID 过滤（排除当前会话） */
  excludeSessionId?: string
  /** 最大候选集大小（从数据库加载） */
  candidateLimit?: number
  /** 最低相似度阈值 */
  minScore?: number
}

/** 默认搜索参数 */
const DEFAULT_OPTIONS: Required<Omit<VectorSearchOptions, 'type' | 'excludeSessionId'>> = {
  candidateLimit: 500,
  minScore: 0.0
}

/**
 * 存储情景记忆
 */
export function storeEpisodicMemory(mem: EpisodicMemory): void {
  execute(
    `INSERT OR REPLACE INTO memories
     (id, type, content, embedding, session_id, user_intent, actions, outcome,
      success_score, model_used, skills_used, tags, importance, created_at, last_accessed_at, access_count)
     VALUES (?, 'episodic', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mem.id,
      mem.outcome,  // content 存储结果摘要
      mem.embedding ? JSON.stringify(mem.embedding) : null,
      null,  // session_id (EpisodicMemory 没有此字段，后续扩展)
      mem.userIntent,
      JSON.stringify(mem.actions),
      mem.outcome,
      mem.successScore,
      mem.modelUsed,
      JSON.stringify(mem.skillsUsed),
      JSON.stringify(mem.tags),
      Math.min(1, mem.successScore / 5),  // importance 从 successScore 映射
      mem.timestamp,
      mem.timestamp,
      0
    ]
  )
}

/**
 * 存储语义记忆
 */
export function storeSemanticMemory(mem: SemanticMemory): void {
  execute(
    `INSERT OR REPLACE INTO memories
     (id, type, mem_type, content, embedding, source, confidence, importance,
      created_at, last_accessed_at, access_count)
     VALUES (?, 'semantic', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mem.id,
      mem.type,
      mem.content,
      mem.embedding ? JSON.stringify(mem.embedding) : null,
      mem.source,
      mem.confidence,
      mem.importance,
      mem.createdAt,
      mem.lastAccessedAt,
      mem.accessCount
    ]
  )
}

/**
 * 向量搜索 — 余弦相似度检索
 *
 * @param queryVector 查询向量
 * @param topK 返回前 K 条结果
 * @param options 搜索选项
 * @returns 排序后的搜索结果
 */
export function vectorSearch(
  queryVector: number[],
  topK: number,
  options: VectorSearchOptions = {}
): VectorSearchResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // 构建查询
  let sql = 'SELECT * FROM memories WHERE embedding IS NOT NULL'
  const params: unknown[] = []

  if (opts.type) {
    sql += ' AND type = ?'
    params.push(opts.type)
  }

  if (opts.excludeSessionId) {
    sql += ' AND (session_id IS NULL OR session_id != ?)'
    params.push(opts.excludeSessionId)
  }

  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(opts.candidateLimit)

  const rows = query<MemoryRow>(sql, params)

  if (rows.length === 0) return []

  // 计算余弦相似度
  const results: VectorSearchResult[] = []
  for (const row of rows) {
    let embedding: number[]
    try {
      embedding = JSON.parse(row.embedding!)
    } catch {
      continue
    }

    const score = cosineSimilarity(queryVector, embedding)
    if (score < opts.minScore) continue

    results.push(rowToSearchResult(row, embedding, score))
  }

  // 按相似度降序排序
  results.sort((a, b) => b.score - a.score)

  return results.slice(0, topK)
}

/**
 * 获取所有记忆（不含嵌入，用于列表展示）
 */
export function getAllMemories(
  type?: 'episodic' | 'semantic',
  limit = 100,
  offset = 0
): VectorSearchResult[] {
  let sql = 'SELECT * FROM memories'
  const params: unknown[] = []

  if (type) {
    sql += ' WHERE type = ?'
    params.push(type)
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = query<MemoryRow>(sql, params)
  return rows.map(row => rowToSearchResult(row, [], 0))
}

/**
 * 获取记忆总数
 */
export function getMemoryCount(type?: 'episodic' | 'semantic'): number {
  let sql = 'SELECT COUNT(*) as count FROM memories'
  const params: unknown[] = []

  if (type) {
    sql += ' WHERE type = ?'
    params.push(type)
  }

  const rows = query<{ count: number }>(sql, params)
  return rows[0]?.count ?? 0
}

/**
 * 更新记忆访问记录
 */
export function updateMemoryAccess(id: string): void {
  execute(
    `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
    [Date.now(), id]
  )
}

/**
 * 删除记忆
 */
export function deleteMemory(id: string): void {
  execute('DELETE FROM memories WHERE id = ?', [id])
}

/**
 * 删除会话的所有记忆
 */
export function deleteMemoriesBySession(sessionId: string): void {
  execute('DELETE FROM memories WHERE session_id = ?', [sessionId])
}

/**
 * 查找相似记忆（用于去重）
 *
 * @param embedding 目标嵌入向量
 * @param threshold 相似度阈值（大于此值认为是重复）
 * @returns 相似的记忆列表
 */
export function findSimilarMemories(
  embedding: number[],
  threshold = 0.85
): VectorSearchResult[] {
  return vectorSearch(embedding, 5, { minScore: threshold })
}

/**
 * 合并两条记忆（保留信息更丰富的）
 */
export function mergeMemories(keepId: string, removeId: string): void {
  // 将 removeId 的 access_count 加到 keepId 上
  const rows = query<{ access_count: number }>(
    'SELECT access_count FROM memories WHERE id = ?',
    [removeId]
  )
  const removeAccessCount = rows[0]?.access_count ?? 0

  execute(
    `UPDATE memories SET access_count = access_count + ? WHERE id = ?`,
    [removeAccessCount, keepId]
  )

  deleteMemory(removeId)
}

// ═══════════════════════════════════════════════════════════
//  向量数学
// ═══════════════════════════════════════════════════════════

/**
 * 计算余弦相似度
 *
 * cos(A, B) = (A · B) / (|A| * |B|)
 *
 * 结果范围 [-1, 1]，1 表示方向相同（最相似）
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

function rowToSearchResult(
  row: MemoryRow,
  embedding: number[],
  score: number
): VectorSearchResult {
  return {
    id: row.id,
    type: row.type as 'episodic' | 'semantic',
    content: row.content,
    embedding,
    score,
    sessionId: row.session_id ?? undefined,
    userIntent: row.user_intent ?? undefined,
    actions: row.actions ? safeParseArray(row.actions) : undefined,
    outcome: row.outcome ?? undefined,
    successScore: row.success_score ?? undefined,
    modelUsed: row.model_used ?? undefined,
    skillsUsed: row.skills_used ? safeParseArray(row.skills_used) : undefined,
    tags: row.tags ? safeParseArray(row.tags) : undefined,
    source: row.source ?? undefined,
    confidence: row.confidence ?? undefined,
    importance: row.importance ?? 0.5,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    accessCount: row.access_count ?? 0
  }
}

function safeParseArray(str: string): string[] {
  try {
    const parsed = JSON.parse(str)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
