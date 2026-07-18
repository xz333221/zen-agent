/**
 * 模式检测器 — 检测重复的请求模式，触发技能生成
 *
 * 工作原理:
 * 1. 记录每次用户请求的意图和嵌入向量
 * 2. 新请求到来时，与历史记录计算相似度
 * 3. 当相似请求出现 N 次（默认 3 次）时，发出模式信号
 * 4. 模式信号传递给技能生成器，创建可复用技能
 *
 * 检测维度:
 * - 查询相似度: 语义相似的重复问题
 * - 动作序列: 相同的工具调用组合
 * - 意图分类: 相同的意图类型频繁出现
 */

import { generateEmbedding } from '../../memory/embeddings'
import { cosineSimilarity } from '../../utils/vector-math'
import type { PatternSignal } from '../../skills/types'

/** Embedding 生成函数签名（可注入，测试时用确定性实现替代） */
export type EmbedFn = (text: string, signal?: AbortSignal) => Promise<number[]>

/** 查询记录 */
interface QueryRecord {
  text: string
  embedding: number[]
  timestamp: number
  intent: string
  actions: string[]
  sessionId: string
}

/** 模式检测结果 */
export interface PatternDetectionResult {
  detected: boolean
  patterns: DetectedPattern[]
  totalQueries: number
}

/** 检测到的模式 */
export interface DetectedPattern {
  type: PatternSignal['type']
  occurrences: string[]
  similarity: number
  lastSeen: number
  exampleQuery: string
  suggestedSkillName: string
}

/** 配置 */
export interface PatternDetectorConfig {
  /** 触发阈值：相同模式出现的最小次数 */
  threshold: number
  /** 相似度阈值 */
  similarityThreshold: number
  /** 最大保留记录数 */
  maxRecords: number
}

const DEFAULT_CONFIG: PatternDetectorConfig = {
  threshold: 3,
  similarityThreshold: 0.75,
  maxRecords: 200
}

/**
 * 模式检测器
 *
 * 注意：查询历史与已检测模式均为实例状态（历史上是模块级共享，
 * 多个实例会互相污染，且无法在测试中隔离）。
 */
export class PatternDetector {
  private config: PatternDetectorConfig
  private embed: EmbedFn
  /** 查询历史记录（内存中） */
  private queryHistory: QueryRecord[] = []
  /** 已检测到的模式（避免重复触发） */
  private detectedPatterns = new Set<string>()

  constructor(
    config: Partial<PatternDetectorConfig> = {},
    embed: EmbedFn = generateEmbedding
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.embed = embed
  }

  /**
   * 记录一次用户查询
   *
   * @param text 用户输入
   * @param intent 意图分类
   * @param actions 执行的动作
   * @param sessionId 会话 ID
   * @param signal AbortSignal
   */
  async recordQuery(
    text: string,
    intent: string,
    actions: string[],
    sessionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const embedding = await this.embed(text, signal)

      this.queryHistory.push({
        text,
        embedding,
        timestamp: Date.now(),
        intent,
        actions,
        sessionId
      })

      // 限制记录数量
      if (this.queryHistory.length > this.config.maxRecords) {
        this.queryHistory.splice(0, this.queryHistory.length - this.config.maxRecords)
      }
    } catch (err) {
      console.error('[PatternDetector] Failed to record query:', err)
    }
  }

  /**
   * 检测重复模式
   *
   * 检查最近的查询是否与历史记录形成重复模式。
   * 当相似查询出现 threshold 次以上时，返回检测结果。
   *
   * @returns 检测结果
   */
  detect(): PatternDetectionResult {
    if (this.queryHistory.length < this.config.threshold) {
      return { detected: false, patterns: [], totalQueries: this.queryHistory.length }
    }

    const patterns: DetectedPattern[] = []
    const checked = new Set<string>()

    // 从最近的查询向前检查
    for (let i = this.queryHistory.length - 1; i >= 0; i--) {
      const current = this.queryHistory[i]
      if (checked.has(current.text)) continue

      // 找到所有相似的查询
      const similar: QueryRecord[] = [current]
      for (let j = 0; j < this.queryHistory.length; j++) {
        if (i === j || checked.has(this.queryHistory[j].text)) continue

        const sim = cosineSimilarity(current.embedding, this.queryHistory[j].embedding)
        if (sim >= this.config.similarityThreshold) {
          similar.push(this.queryHistory[j])
        }
      }

      // 标记已检查
      for (const s of similar) {
        checked.add(s.text)
      }

      // 如果相似查询数量达到阈值，生成模式
      if (similar.length >= this.config.threshold) {
        const patternKey = this.getPatternKey(current.text)
        if (this.detectedPatterns.has(patternKey)) continue

        this.detectedPatterns.add(patternKey)

        const avgSimilarity = this.calculateAvgSimilarity(similar)
        const lastSeen = Math.max(...similar.map(s => s.timestamp))

        patterns.push({
          type: 'query_similarity',
          occurrences: similar.map(s => s.text),
          similarity: avgSimilarity,
          lastSeen,
          exampleQuery: current.text,
          suggestedSkillName: this.suggestSkillName(current.text, current.intent)
        })
      }
    }

    return {
      detected: patterns.length > 0,
      patterns,
      totalQueries: this.queryHistory.length
    }
  }

  /**
   * 计算一组查询的平均相似度
   */
  private calculateAvgSimilarity(records: QueryRecord[]): number {
    if (records.length <= 1) return 1

    let totalSim = 0
    let count = 0

    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        totalSim += cosineSimilarity(records[i].embedding, records[j].embedding)
        count++
      }
    }

    return count > 0 ? totalSim / count : 1
  }

  /**
   * 生成模式键（用于去重）
   */
  private getPatternKey(text: string): string {
    return text.slice(0, 50).toLowerCase().trim()
  }

  /**
   * 根据查询内容建议技能名称
   */
  private suggestSkillName(query: string, intent: string): string {
    // 基于意图分类建议名称
    const intentNames: Record<string, string> = {
      coding: '代码助手',
      writing: '写作助手',
      analysis: '分析助手',
      translation: '翻译助手',
      question: '问答助手',
      planning: '规划助手',
      chat: '对话助手'
    }

    const baseName = intentNames[intent] || '通用助手'

    // 尝试从查询中提取关键词
    const keywords = query.match(/[\u4e00-\u9fa5]{2,4}|[a-zA-Z]{3,}/g)
    if (keywords && keywords.length > 0) {
      return `${keywords[0]}${baseName}`
    }

    return baseName
  }

  /**
   * 获取查询历史统计
   */
  getStats(): {
    totalQueries: number
    detectedPatterns: number
    uniqueIntents: number
  } {
    const intents = new Set(this.queryHistory.map(q => q.intent))
    return {
      totalQueries: this.queryHistory.length,
      detectedPatterns: this.detectedPatterns.size,
      uniqueIntents: intents.size
    }
  }

  /**
   * 清除历史记录
   */
  clear(): void {
    this.queryHistory.length = 0
    this.detectedPatterns.clear()
  }
}

// ── 单例 ──
export const patternDetector = new PatternDetector()
