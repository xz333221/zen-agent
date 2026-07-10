/**
 * 上下文管理器 — Token 预算分配 + 滑动窗口 + 渐进式摘要
 *
 * 核心职责:
 * 1. Token 预算分配 — 将总预算分配给各组件（系统提示、历史、输出等）
 * 2. 滑动窗口 — 保留最近 N 条消息完整，旧消息进行摘要压缩
 * 3. 渐进式摘要 — 超出预算时自动触发摘要，并缓存结果避免重复计算
 *
 * 预算分配模型:
 * ┌──────────────────────────────────────────┐
 * │            Total Token Budget             │
 * ├──────────┬───────────┬───────────────────┤
 * │ Output   │ System +  │ Conversation      │
 * │ Reserve  │ Tools +   │ History           │
 * │          │ Memories  │ (Summary + Recent)│
 * └──────────┴───────────┴───────────────────┘
 *
 * 当 History 超出分配预算时:
 * 1. 保留最近 recentMessageWindow 条消息
 * 2. 将更早的消息生成摘要
 * 3. 摘要作为 system 消息插入
 * 4. 如果仍超预算，逐步缩小保留窗口
 */

import {
  countTextTokens,
  countMessageTokens,
  countMessagesTokens,
  fitMessagesToBudget,
  type CountableMessage
} from '../utils/token-counter'
import { summarizeMessages, updateSummary, type SummaryResult, type SummarizableMessage } from './summarizer'

/** 管理后的上下文 */
export interface ManagedContext {
  /** 最终发送给 LLM 的消息列表 */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  /** Token 预算分布 */
  breakdown: {
    systemPrompt: number
    summary: number
    history: number
    userInput: number
    outputReserve: number
    total: number
    budget: number
  }
  /** 是否触发了压缩 */
  compressed: boolean
  /** 摘要结果（如果触发了压缩） */
  summary?: SummaryResult
  /** 被压缩的原始消息数 */
  compressedMessageCount: number
}

/** 上下文管理器配置 */
export interface ContextManagerConfig {
  /** 最大 token 预算 */
  maxTokens: number
  /** 输出预留 token */
  outputReserve: number
  /** 最近 N 条消息始终保留 */
  recentMessageWindow: number
  /** 压缩阈值（历史 token 数超过此值时触发摘要） */
  compressionThreshold: number
  /** 摘要最大 token 数 */
  summaryMaxTokens?: number
}

/** 默认配置 */
const DEFAULT_CONFIG: ContextManagerConfig = {
  maxTokens: 32000,
  outputReserve: 4000,
  recentMessageWindow: 10,
  compressionThreshold: 16000,
  summaryMaxTokens: 500
}

// ── 会话级摘要缓存 ──
// key: sessionId, value: { summary, summarizedUpTo }
interface SummaryCache {
  summary: string
  summaryTokens: number
  /** 已摘要到第几条消息（索引，不含） */
  summarizedUpTo: number
  /** 摘要方法 */
  method: 'llm' | 'rule'
}

const summaryCache = new Map<string, SummaryCache>()

/**
 * 上下文管理器
 *
 * 使用方式:
 * ```ts
 * const manager = new ContextManager({
 *   maxTokens: 32000,
 *   outputReserve: 4000,
 *   recentMessageWindow: 10,
 *   compressionThreshold: 16000
 * })
 * const managed = await manager.manage(messages, userInput, sessionId, signal)
 * // 使用 managed.messages 发送给 LLM
 * ```
 */
export class ContextManager {
  private config: ContextManagerConfig

  constructor(config: Partial<ContextManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 管理上下文 — 执行预算分配和压缩
   *
   * @param allMessages 所有消息（含系统提示词作为第一条）
   * @param userInput 当前用户输入
   * @param sessionId 会话 ID（用于摘要缓存）
   * @param signal AbortSignal
   * @returns 管理后的上下文
   */
  async manage(
    allMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userInput: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<ManagedContext> {
    // ── 1. 分离系统提示和历史消息 ──
    const systemPrompt = allMessages[0]?.role === 'system'
      ? allMessages[0].content
      : ''
    const historyMessages = allMessages[0]?.role === 'system'
      ? allMessages.slice(1)
      : allMessages

    // ── 2. 计算各部分 token ──
    const systemTokens = countTextTokens(systemPrompt)
    const userInputTokens = countTextTokens(userInput)
    const historyTokens = countMessagesTokens(historyMessages)

    // ── 3. 计算历史可用预算 ──
    const availableForHistory = this.config.maxTokens
      - this.config.outputReserve
      - systemTokens
      - userInputTokens

    // ── 4. 判断是否需要压缩 ──
    const needsCompression =
      historyTokens > this.config.compressionThreshold ||
      historyTokens > availableForHistory

    if (!needsCompression) {
      // 无需压缩，直接返回
      return this.buildUncompressedResult(
        systemPrompt,
        historyMessages,
        userInput,
        systemTokens,
        historyTokens,
        userInputTokens
      )
    }

    // ── 5. 执行压缩 ──
    const result = await this.compressHistory(
      historyMessages,
      sessionId,
      availableForHistory,
      signal
    )

    // ── 6. 组装最终消息列表 ──
    const finalMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

    // 系统提示
    if (systemPrompt) {
      finalMessages.push({ role: 'system', content: systemPrompt })
    }

    // 摘要（作为 system 消息插入）
    if (result.summary && result.summary.summary) {
      finalMessages.push({
        role: 'system',
        content: `[对话摘要]\n${result.summary.summary}`
      })
    }

    // 保留的最近消息
    for (const msg of result.retainedMessages) {
      finalMessages.push(msg)
    }

    // 用户当前输入
    if (userInput) {
      finalMessages.push({ role: 'user', content: userInput })
    }

    // ── 7. 计算最终 token 分布 ──
    const summaryTokens = result.summary?.summaryTokens ?? 0
    const retainedTokens = countMessagesTokens(result.retainedMessages)
    const totalTokens = systemTokens + summaryTokens + retainedTokens + userInputTokens

    return {
      messages: finalMessages,
      breakdown: {
        systemPrompt: systemTokens,
        summary: summaryTokens,
        history: retainedTokens,
        userInput: userInputTokens,
        outputReserve: this.config.outputReserve,
        total: totalTokens,
        budget: this.config.maxTokens
      },
      compressed: true,
      summary: result.summary ?? undefined,
      compressedMessageCount: result.compressedCount
    }
  }

  /**
   * 压缩历史消息
   *
   * 策略:
   * 1. 保留最近 recentMessageWindow 条消息
   * 2. 将更早的消息与缓存摘要合并
   * 3. 如果仍超预算，逐步减少保留窗口
   */
  private async compressHistory(
    historyMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    sessionId: string,
    availableBudget: number,
    signal?: AbortSignal
  ): Promise<{
    retainedMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    summary: SummaryResult | null
    compressedCount: number
  }> {
    const windowSize = Math.min(this.config.recentMessageWindow, historyMessages.length)

    // 分割为待摘要部分和保留部分
    const toSummarize = historyMessages.slice(0, historyMessages.length - windowSize)
    const retained = historyMessages.slice(historyMessages.length - windowSize)

    if (toSummarize.length === 0) {
      // 窗口已覆盖全部消息，但仍然超预算
      // 尝试逐步缩小窗口
      return this.shrinkWindow(historyMessages, availableBudget)
    }

    // ── 生成/更新摘要 ──
    const cache = summaryCache.get(sessionId)
    let summaryResult: SummaryResult | null = null

    if (cache && cache.summarizedUpTo <= toSummarize.length) {
      // 有缓存，只需增量更新
      const newMessages = toSummarize.slice(cache.summarizedUpTo)
      if (newMessages.length > 0) {
        const summarizableNew: SummarizableMessage[] = newMessages.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content
        }))
        summaryResult = await updateSummary(cache.summary, summarizableNew, {
          maxTokens: this.config.summaryMaxTokens,
          signal
        })

        // 更新缓存
        summaryCache.set(sessionId, {
          summary: summaryResult.summary,
          summaryTokens: summaryResult.summaryTokens,
          summarizedUpTo: toSummarize.length,
          method: summaryResult.method
        })
      } else {
        // 无新消息，使用缓存
        summaryResult = {
          summary: cache.summary,
          summaryTokens: cache.summaryTokens,
          originalMessageCount: toSummarize.length,
          originalTokens: 0,
          compressionRatio: 0,
          method: cache.method
        }
      }
    } else {
      // 无缓存或缓存过期，重新生成完整摘要
      const summarizable: SummarizableMessage[] = toSummarize.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content
      }))
      summaryResult = await summarizeMessages(summarizable, {
        maxTokens: this.config.summaryMaxTokens,
        signal
      })

      // 存入缓存
      summaryCache.set(sessionId, {
        summary: summaryResult.summary,
        summaryTokens: summaryResult.summaryTokens,
        summarizedUpTo: toSummarize.length,
        method: summaryResult.method
      })
    }

    // ── 检查压缩后是否仍在预算内 ──
    const summaryTokens = summaryResult.summaryTokens
    const retainedTokens = countMessagesTokens(retained)

    if (summaryTokens + retainedTokens <= availableBudget) {
      return { retainedMessages: retained, summary: summaryResult, compressedCount: toSummarize.length }
    }

    // 仍然超预算，进一步缩小保留窗口
    const maxRetained = fitMessagesToBudget(retained, availableBudget - summaryTokens)
    const shrunkRetained = retained.slice(retained.length - maxRetained)

    return {
      retainedMessages: shrunkRetained,
      summary: summaryResult,
      compressedCount: toSummarize.length + (retained.length - maxRetained)
    }
  }

  /**
   * 当窗口已覆盖全部消息但仍然超预算时，逐步缩小窗口
   */
  private async shrinkWindow(
    historyMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    availableBudget: number
  ): Promise<{
    retainedMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    summary: SummaryResult | null
    compressedCount: number
  }> {
    // 计算可以保留多少条
    const maxRetained = fitMessagesToBudget(historyMessages, availableBudget)

    if (maxRetained >= historyMessages.length) {
      // 全部都能放下
      return { retainedMessages: historyMessages, summary: null, compressedCount: 0 }
    }

    // 保留最近的，摘要前面的
    const toSummarize = historyMessages.slice(0, historyMessages.length - maxRetained)
    const retained = historyMessages.slice(historyMessages.length - maxRetained)

    // 简单截取摘要（不调用 LLM，因为预算已经很紧张）
    const summaryText = toSummarize
      .map(m => `${m.role}: ${m.content.slice(0, 100)}...`)
      .join('\n')

    const summaryTokens = countTextTokens(summaryText)

    return {
      retainedMessages: retained,
      summary: {
        summary: summaryText,
        summaryTokens,
        originalMessageCount: toSummarize.length,
        originalTokens: countMessagesTokens(toSummarize),
        compressionRatio: 0,
        method: 'rule'
      },
      compressedCount: toSummarize.length
    }
  }

  /**
   * 构建未压缩的结果
   */
  private buildUncompressedResult(
    systemPrompt: string,
    historyMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userInput: string,
    systemTokens: number,
    historyTokens: number,
    userInputTokens: number
  ): ManagedContext {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    for (const msg of historyMessages) {
      messages.push(msg)
    }
    if (userInput) {
      messages.push({ role: 'user', content: userInput })
    }

    return {
      messages,
      breakdown: {
        systemPrompt: systemTokens,
        summary: 0,
        history: historyTokens,
        userInput: userInputTokens,
        outputReserve: this.config.outputReserve,
        total: systemTokens + historyTokens + userInputTokens,
        budget: this.config.maxTokens
      },
      compressed: false,
      compressedMessageCount: 0
    }
  }

  /**
   * 清除会话的摘要缓存
   */
  static clearCache(sessionId: string): void {
    summaryCache.delete(sessionId)
  }

  /**
   * 清除所有摘要缓存
   */
  static clearAllCache(): void {
    summaryCache.clear()
  }
}

/**
 * 创建上下文管理器（便捷工厂函数）
 */
export function createContextManager(
  config: Partial<ContextManagerConfig> = {}
): ContextManager {
  return new ContextManager(config)
}
