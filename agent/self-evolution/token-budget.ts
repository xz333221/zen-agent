/**
 * Token 预算管理器 — 追踪 Token 使用，计算可用额度
 *
 * 工作原理:
 * 1. 每个 Token 周期（默认 5 小时）有一个额度上限
 * 2. 追踪所有 LLM 调用的 Token 消耗（对话 + 进化 + 嵌入）
 * 3. 计算当前周期内可用于自进化的剩余额度
 * 4. 当剩余额度足够时，允许触发自进化循环
 *
 * Token 额度来源：用户的 LLM Token Plan（如 ChatGPT Plus 每 5 小时有额度）
 */

import { getTokenUsageSince, recordTokenUsage } from './evolution-journal'
import { countTextTokens } from '../utils/token-counter'
import type { SelfEvolutionConfig, TokenBudget, TokenUsageRecord } from './types'

/**
 * Token 预算管理器
 */
export class TokenBudgetManager {
  private config: SelfEvolutionConfig
  private cycleStart: number
  private estimatedTotalPerCycle: number

  constructor(config: SelfEvolutionConfig) {
    this.config = config
    this.cycleStart = Date.now()
    this.estimatedTotalPerCycle = 200000 // 默认估计 200K tokens/周期，用户可调整
  }

  /**
   * 设置每个周期的 Token 总额估计
   * 用户根据自己的 Plan 额度设置
   */
  setTotalPerCycle(total: number): void {
    this.estimatedTotalPerCycle = total
    console.log(`[TokenBudget] Total per cycle set to ${total}`)
  }

  /**
   * 获取当前 Token 预算状态
   */
  getBudget(): TokenBudget {
    // 获取当前周期内的 Token 使用量
    const usage = getTokenUsageSince(this.cycleStart)

    return {
      totalPerCycle: this.estimatedTotalPerCycle,
      used: usage.totalInput + usage.totalOutput,
      cycleStart: this.cycleStart,
      cycleDuration: this.config.tokenCycleDuration,
      evolutionRatio: this.config.evolutionTokenRatio,
      evolutionUsed: usage.evolutionInput + usage.evolutionOutput
    }
  }

  /**
   * 检查是否有足够的 Token 额度进行自进化
   */
  canEvolve(): { canEvolve: boolean; reason: string; availableTokens: number } {
    const budget = this.getBudget()

    // 预留给自进化的总额度
    const evolutionBudget = Math.floor(budget.totalPerCycle * budget.evolutionRatio)

    // 剩余额度
    const available = evolutionBudget - budget.evolutionUsed

    if (available < this.config.maxTokensPerEvolution * 0.3) {
      return {
        canEvolve: false,
        reason: `Token 额度不足：剩余 ${available}，需要至少 ${Math.floor(this.config.maxTokensPerEvolution * 0.3)}`,
        availableTokens: available
      }
    }

    // 检查是否在周期内已用完总额度
    if (budget.used >= budget.totalPerCycle) {
      return {
        canEvolve: false,
        reason: `Token 周期额度已用完：已用 ${budget.used}/${budget.totalPerCycle}`,
        availableTokens: 0
      }
    }

    return {
      canEvolve: true,
      reason: `Token 额度充足：剩余 ${available}/${evolutionBudget}（自进化预算）`,
      availableTokens: Math.min(available, this.config.maxTokensPerEvolution)
    }
  }

  /**
   * 检查是否应该开启新的 Token 周期
   */
  checkCycleReset(): boolean {
    const now = Date.now()
    if (now - this.cycleStart >= this.config.tokenCycleDuration) {
      console.log('[TokenBudget] Token cycle reset, starting new cycle')
      this.cycleStart = now
      return true
    }
    return false
  }

  /**
   * 记录一次 LLM 调用的 Token 消耗
   */
  recordUsage(
    inputTokens: number,
    outputTokens: number,
    purpose: 'chat' | 'evolution' | 'embedding' | 'other' = 'chat'
  ): void {
    recordTokenUsage(inputTokens, outputTokens, purpose)
  }

  /**
   * 估算文本的 Token 数量（使用已有的 token-counter）
   */
  estimateTokens(text: string): number {
    return countTextTokens(text)
  }

  /**
   * 获取预算摘要（供 UI 展示）
   */
  getSummary(): {
    cycleStart: string
    totalUsed: number
    totalBudget: number
    evolutionUsed: number
    evolutionBudget: number
    remainingForEvolution: number
    utilizationPercent: number
  } {
    const budget = this.getBudget()
    const evolutionBudget = Math.floor(budget.totalPerCycle * budget.evolutionRatio)

    return {
      cycleStart: new Date(budget.cycleStart).toLocaleString('zh-CN'),
      totalUsed: budget.used,
      totalBudget: budget.totalPerCycle,
      evolutionUsed: budget.evolutionUsed,
      evolutionBudget,
      remainingForEvolution: Math.max(0, evolutionBudget - budget.evolutionUsed),
      utilizationPercent: budget.totalPerCycle > 0
        ? Math.round((budget.used / budget.totalPerCycle) * 100)
        : 0
    }
  }
}
