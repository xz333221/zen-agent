/**
 * 记忆管理器 — 长期记忆的存储、检索和管理
 *
 * 核心功能:
 * 1. 记忆存储 — 对话结束后自动生成 Embedding 并存储情景记忆
 * 2. 记忆检索 — 对话开始时检索相关记忆，按相关度+时间+重要性排序
 * 3. 记忆去重 — 检测高度相似的记忆并合并
 * 4. 记忆衰减 — 时间衰减函数影响记忆重要性
 *
 * 排序公式:
 * finalScore = vectorScore * 0.5 + recencyScore * 0.2 + importanceScore * 0.3
 *
 * 时间衰减:
 * - 半衰期默认 30 天（可配置）
 * - recencyScore = 0.5^(ageDays / halfLifeDays)
 */

import { generateEmbedding } from './embeddings'
import {
  vectorSearch,
  storeEpisodicMemory,
  storeSemanticMemory,
  findSimilarMemories,
  mergeMemories,
  updateMemoryAccess,
  deleteMemory,
  getMemoryCount,
  type VectorSearchResult
} from './vector-store'
import type {
  EpisodicMemory,
  SemanticMemory,
  MemorySearchResult,
  MemorySearchParams
} from './types'

/** 默认搜索参数 */
const DEFAULT_SEARCH_PARAMS: MemorySearchParams = {
  query: '',
  topK: 5,
  minScore: 0.3,
  dedupThreshold: 0.92,
  timeDecayHalfLifeDays: 30
}

/** 记忆存储选项 */
export interface StoreMemoryOptions {
  /** 会话 ID */
  sessionId?: string
  /** 使用的模型 */
  modelUsed?: string
  /** 使用的技能 */
  skillsUsed?: string[]
  /** 标签 */
  tags?: string[]
  /** AbortSignal */
  signal?: AbortSignal
}

/**
 * 记忆管理器
 */
export class MemoryManager {
  /**
   * 存储情景记忆
   *
   * 在对话结束后调用，将用户意图、Agent 行为和结果存储为情景记忆。
   * 自动生成 Embedding 并检测重复。
   *
   * @param userInput 用户输入
   * @param output Agent 回复
   * @param actions 执行的动作列表
   * @param successScore 成功评分 (1-5)
   * @param options 存储选项
   */
  async storeEpisodic(
    userInput: string,
    output: string,
    actions: string[],
    successScore: number,
    options: StoreMemoryOptions = {}
  ): Promise<EpisodicMemory | null> {
    try {
      // 安全防护：确保 output 和 userInput 是字符串
      const safeOutput = typeof output === 'string' ? output : String(output ?? '')
      const safeInput = typeof userInput === 'string' ? userInput : String(userInput ?? '')

      // 生成用于检索的文本（用户意图 + 回复摘要）
      const searchText = `${safeInput}\n${safeOutput.slice(0, 500)}`
      const embedding = await generateEmbedding(searchText, options.signal)

      // 检查是否已有高度相似的记忆（去重）
      const similar = findSimilarMemories(embedding, 0.92)
      if (similar.length > 0) {
        // 已有相似记忆，更新其访问记录而非新建
        updateMemoryAccess(similar[0].id)
        console.log('[Memory] Skipped duplicate memory, updated existing:', similar[0].id)
        return null
      }

      const memory: EpisodicMemory = {
        id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        userIntent: safeInput,
        actions,
        outcome: safeOutput.slice(0, 2000),  // 限制存储长度
        successScore,
        modelUsed: options.modelUsed || '',
        skillsUsed: options.skillsUsed || [],
        embedding,
        tags: options.tags || []
      }

      storeEpisodicMemory(memory)
      console.log('[Memory] Stored episodic memory:', memory.id)
      return memory
    } catch (err) {
      console.error('[Memory] Failed to store episodic memory:', err)
      return null
    }
  }

  /**
   * 存储语义记忆
   *
   * 从对话中提取的事实、偏好等，存储为语义记忆。
   *
   * @param type 记忆子类型
   * @param content 记忆内容
   * @param source 来源
   * @param confidence 置信度 (0-1)
   * @param signal AbortSignal
   */
  async storeSemantic(
    type: 'fact' | 'preference' | 'pattern' | 'knowledge',
    content: string,
    source: string,
    confidence: number = 0.7,
    signal?: AbortSignal
  ): Promise<SemanticMemory | null> {
    try {
      const embedding = await generateEmbedding(content, signal)

      // 去重检查
      const similar = findSimilarMemories(embedding, 0.88)
      if (similar.length > 0) {
        // 合并：更新已有记忆的置信度
        const existing = similar[0]
        const newConfidence = Math.min(1, (existing.confidence || 0.5) + 0.1)
        updateMemoryAccess(existing.id)
        console.log('[Memory] Merged semantic memory with existing:', existing.id)
        return null
      }

      const now = Date.now()
      const memory: SemanticMemory = {
        id: `sm-${now}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        content,
        confidence,
        source,
        embedding,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        importance: confidence
      }

      storeSemanticMemory(memory)
      console.log('[Memory] Stored semantic memory:', memory.id)
      return memory
    } catch (err) {
      console.error('[Memory] Failed to store semantic memory:', err)
      return null
    }
  }

  /**
   * 检索相关记忆
   *
   * 在对话开始时调用，根据用户输入检索相关历史记忆。
   * 综合考虑向量相似度、时间衰减和重要性进行排序。
   *
   * @param query 用户查询文本
   * @param params 搜索参数
   * @returns 排序后的记忆列表
   */
  async retrieve(
    query: string,
    params?: Partial<MemorySearchParams>,
    excludeSessionId?: string
  ): Promise<MemorySearchResult[]> {
    const opts = { ...DEFAULT_SEARCH_PARAMS, ...params }

    if (!query.trim()) return []

    try {
      // 生成查询向量
      const queryEmbedding = await generateEmbedding(query)

      // 向量搜索
      const vectorResults = vectorSearch(queryEmbedding, opts.topK * 2, {
        excludeSessionId,
        minScore: opts.minScore
      })

      if (vectorResults.length === 0) return []

      // 综合评分
      const now = Date.now()
      const halfLifeMs = opts.timeDecayHalfLifeDays * 24 * 60 * 60 * 1000

      const scored: MemorySearchResult[] = vectorResults.map(result => {
        // 向量相似度评分 [0, 1]
        const vectorScore = Math.max(0, result.score)

        // 时间衰减评分 [0, 1]
        const ageMs = now - result.createdAt
        const recencyScore = Math.pow(0.5, ageMs / halfLifeMs)

        // 重要性评分 [0, 1]
        const importanceScore = result.importance

        // 综合评分
        const finalScore =
          vectorScore * 0.5 +
          recencyScore * 0.2 +
          importanceScore * 0.3

        // 转换为 MemorySearchResult 格式
        const memory: EpisodicMemory | SemanticMemory = result.type === 'episodic'
          ? {
              id: result.id,
              timestamp: result.createdAt,
              userIntent: result.userIntent || '',
              actions: result.actions || [],
              outcome: result.content,
              successScore: result.successScore || 3,
              modelUsed: result.modelUsed || '',
              skillsUsed: result.skillsUsed || [],
              tags: result.tags || [],
              embedding: result.embedding
            }
          : {
              id: result.id,
              type: 'fact' as const,
              content: result.content,
              confidence: result.confidence || 0.5,
              source: result.source || '',
              embedding: result.embedding,
              createdAt: result.createdAt,
              lastAccessedAt: result.lastAccessedAt || result.createdAt,
              accessCount: result.accessCount,
              importance: result.importance
            }

        return {
          memory,
          score: finalScore,
          vectorScore,
          recencyScore,
          importanceScore
        }
      })

      // 按综合评分排序
      scored.sort((a, b) => b.score - a.score)

      // 去重：移除高度相似的记忆
      const deduped = this.deduplicate(scored, opts.dedupThreshold)

      // 更新访问记录
      for (const result of deduped) {
        updateMemoryAccess(result.memory.id)
      }

      return deduped.slice(0, opts.topK)
    } catch (err) {
      console.error('[Memory] Retrieval failed:', err)
      return []
    }
  }

  /**
   * 记忆去重 — 移除内容高度相似的重复记忆
   */
  private deduplicate(
    results: MemorySearchResult[],
    threshold: number
  ): MemorySearchResult[] {
    if (results.length <= 1) return results

    const kept: MemorySearchResult[] = []
    const removed = new Set<string>()

    for (const result of results) {
      if (removed.has(result.memory.id)) continue

      kept.push(result)

      // 检查后续记忆是否与此重复
      for (const other of results) {
        if (other.memory.id === result.memory.id || removed.has(other.memory.id)) continue

        const mem1 = result.memory
        const mem2 = other.memory

        // 如果都有嵌入向量，用余弦相似度判断
        if (mem1.embedding && mem2.embedding) {
          const sim = this.cosineSim(mem1.embedding, mem2.embedding)
          if (sim > threshold) {
            removed.add(other.memory.id)
            // 合并到保留的记忆中
            mergeMemories(result.memory.id, other.memory.id)
          }
        }
      }
    }

    return kept
  }

  /**
   * 获取记忆统计信息
   */
  getStats(): {
    totalMemories: number
    episodicCount: number
    semanticCount: number
  } {
    return {
      totalMemories: getMemoryCount(),
      episodicCount: getMemoryCount('episodic'),
      semanticCount: getMemoryCount('semantic')
    }
  }

  /**
   * 删除指定记忆
   */
  delete(id: string): void {
    deleteMemory(id)
  }

  /**
   * 清除所有记忆
   */
  clearAll(): void {
    // 分批删除所有记忆
    const all = vectorSearch(new Array(1536).fill(0), 10000, { minScore: -1 })
    for (const mem of all) {
      deleteMemory(mem.id)
    }
  }

  /**
   * 计算余弦相似度
   */
  private cosineSim(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length)
    if (len === 0) return 0

    let dot = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    return denom === 0 ? 0 : dot / denom
  }
}

// ── 单例 ──
export const memoryManager = new MemoryManager()
