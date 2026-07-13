/**
 * Prompt 优化器 — 基于用户反馈自动优化系统 Prompt
 *
 * 当负反馈积累到阈值时，分析反馈模式，生成改进版 Prompt。
 * 支持:
 * - LLM 驱动的深度优化
 * - 规则兜底的快速优化
 * - A/B 测试（新旧版本并行使用，根据后续反馈决定保留哪个）
 * - 版本管理 + 回滚
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig, getSystemPrompt } from '../providers/llm-config'
import {
  createPromptVersion,
  getCurrentPrompt,
  getPromptVersions,
  rollbackToVersion,
  updatePromptPerformance
} from '../../src/main/storage/repositories/prompts'
import { getAllFeedback } from '../../src/main/storage/repositories/prompts'
import { collectFeedbackContext } from './feedback-collector'

/** 优化结果 */
export interface OptimizationResult {
  success: boolean
  newVersionId?: string
  newVersion?: number
  oldVersion?: number
  method: 'llm' | 'rule' | 'none'
  changes: string[]
  reason: string
}

/** A/B 测试配置 */
export interface ABTestConfig {
  enabled: boolean
  variantRatio: number  // 0-1，新版本使用比例
}

let abTestConfig: ABTestConfig = {
  enabled: false,
  variantRatio: 0.5
}

/** 是否已初始化 */
let initialized = false

/**
 * 初始化 Prompt 优化器
 * 如果数据库中没有 Prompt 版本，创建初始版本
 * 注意：数据库采用懒加载，如果 DB 未就绪则标记为待初始化
 */
export function initPromptOptimizer(): void {
  // 尝试初始化，如果 DB 未就绪则会在首次使用时重试
  tryInit()
}

/** 尝试初始化（DB 就绪后生效） */
function tryInit(): boolean {
  if (initialized) return true

  const current = getCurrentPrompt('system')
  if (!current) {
    // DB 可能未就绪，或确实没有版本
    // 尝试创建初始版本
    try {
      const defaultPrompt = getSystemPrompt()
      const result = createPromptVersion(defaultPrompt, 'system', 3)
      console.log('[PromptOptimizer] createPromptVersion returned:', result.id, 'v' + result.version)
      // 验证插入是否成功
      const verify = getCurrentPrompt('system')
      if (!verify) {
        console.error('[PromptOptimizer] Failed to verify created prompt version!')
        return false
      }
      initialized = true
      console.log('[PromptOptimizer] Initialized with default system prompt (v1)')
      return true
    } catch (err) {
      console.error('[PromptOptimizer] Init failed:', err)
      return false
    }
  } else {
    initialized = true
    console.log(`[PromptOptimizer] Initialized, current version: v${current.version}`)
    return true
  }
}

/**
 * 获取当前活跃的 Prompt
 * 如果数据库中没有，回退到默认系统 Prompt
 */
export function getActivePrompt(): string {
  // 确保已初始化（懒加载）
  if (!initialized) tryInit()

  const current = getCurrentPrompt('system')
  if (current) {
    // A/B 测试：根据配置决定使用哪个版本
    if (abTestConfig.enabled) {
      const versions = getPromptVersions('system')
      if (versions.length >= 2) {
        // 随机选择新版本或旧版本
        const useNew = Math.random() < abTestConfig.variantRatio
        const selected = useNew ? versions[0] : versions[1]
        console.log(`[PromptOptimizer] A/B test: using v${selected.version}`)
        return selected.content
      }
    }
    return current.content
  }
  return getSystemPrompt()
}

/**
 * 执行 Prompt 优化
 * 分析负反馈，生成改进版 Prompt
 */
export async function optimizePrompt(signal?: AbortSignal): Promise<OptimizationResult> {
  // 确保已初始化
  if (!initialized) tryInit()

  const ctx = await collectFeedbackContext()

  if (!ctx.shouldOptimize) {
    return {
      success: false,
      method: 'none',
      changes: [],
      reason: `负反馈数量 ${ctx.negativeCount} 未达到优化阈值`
    }
  }

  const oldContent = ctx.currentPromptContent ?? getSystemPrompt()

  // 尝试 LLM 优化
  if (isLLMConfigured()) {
    try {
      const result = await optimizeWithLLM(oldContent, signal)
      if (result.success) {
        return result
      }
    } catch (err) {
      console.warn('[PromptOptimizer] LLM optimization failed, falling back to rules:', err)
    }
  }

  // 规则兜底
  return optimizeWithRules(oldContent)
}

/**
 * 使用 LLM 深度优化 Prompt
 */
async function optimizeWithLLM(
  currentPrompt: string,
  signal?: AbortSignal
): Promise<OptimizationResult> {
  const config = getConfig()

  // 获取最近的负反馈样本
  const allFeedback = getAllFeedback(20)
  const negativeFeedback = allFeedback.filter(f => f.feedbackType === 'negative')

  // 构建反馈摘要
  const feedbackSummary = negativeFeedback
    .slice(0, 5)
    .map((f, i) => {
      let desc = `${i + 1}. `
      if (f.userQuery) desc += `用户问: "${f.userQuery.slice(0, 100)}". `
      if (f.agentResponse) desc += `回复: "${f.agentResponse.slice(0, 100)}". `
      if (f.comment) desc += `反馈: ${f.comment}`
      return desc
    })
    .join('\n')

  const systemPrompt = `你是一个 Prompt 优化专家。根据用户反馈，改进以下系统提示词。

严格要求：
1. 保持核心角色设定不变（猫头鹰 AI 助手"小禅"）
2. 针对反馈中的问题进行改进
3. 保持简洁，不超过 500 字
4. 保留 Markdown 格式
5. 直接输出改进后的完整系统提示词，不要加额外说明
6. 不要输出任何思考过程、推理、分析或元描述
7. 不要输出 "Now I need to..." 等英文推理语句
8. 输出必须以 "你是小禅" 开头，以中文内容为主

当前系统提示词：
---
${currentPrompt}
---

用户负反馈样本（共 ${negativeFeedback.length} 条）：
${feedbackSummary || '（无具体反馈内容）'}`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请根据反馈优化系统提示词。' }
    ],
    modelKey: config.defaultModelKey,
    temperature: 0.4,
    maxTokens: 1000,
    signal,
    timeoutMs: 30000
  })

  if (!response || response.trim().length < 50) {
    return {
      success: false,
      method: 'llm',
      changes: [],
      reason: 'LLM 返回内容过短'
    }
  }

  // 验证并清洗 LLM 输出，防止推理文本污染系统提示词
  const cleanedResponse = validateAndCleanPrompt(response, currentPrompt)
  if (!cleanedResponse) {
    console.warn('[PromptOptimizer] LLM output failed validation, falling back to rules')
    return optimizeWithRules(currentPrompt)
  }

  // 记录变更点
  const changes = detectChanges(currentPrompt, cleanedResponse)

  // 创建新版本
  const oldVersion = getCurrentPrompt('system')
  const newVersion = createPromptVersion(cleanedResponse, 'system', 3)

  console.log(`[PromptOptimizer] Created v${newVersion.version} via LLM optimization`)

  return {
    success: true,
    newVersionId: newVersion.id,
    newVersion: newVersion.version,
    oldVersion: oldVersion?.version,
    method: 'llm',
    changes,
    reason: `基于 ${negativeFeedback.length} 条负反馈，使用 LLM 优化`
  }
}

/**
 * 规则兜底优化
 * 根据反馈模式自动调整 Prompt 的某些部分
 */
function optimizeWithRules(currentPrompt: string): OptimizationResult {
  const allFeedback = getAllFeedback(20)
  const negativeFeedback = allFeedback.filter(f => f.feedbackType === 'negative')

  let optimized = currentPrompt
  const changes: string[] = []

  // 规则 1: 如果反馈提到回复太长，添加简洁性指令
  const lengthComplaints = negativeFeedback.filter(f =>
    f.comment?.includes('长') || f.comment?.includes('啰嗦') || f.comment?.includes('简洁')
  )
  if (lengthComplaints.length > 0 && !optimized.includes('尽量简洁')) {
    optimized = optimized.replace(
      '回答规范：',
      '回答规范：\n- 回答尽量简洁，避免冗长的解释\n'
    )
    changes.push('添加简洁性要求指令')
  }

  // 规则 2: 如果反馈提到不够准确，添加准确性指令
  const accuracyComplaints = negativeFeedback.filter(f =>
    f.comment?.includes('不对') || f.comment?.includes('错误') || f.comment?.includes('不准确')
  )
  if (accuracyComplaints.length > 0 && !optimized.includes('确保准确')) {
    optimized = optimized.replace(
      '- 如果不确定，坦诚告知，不编造信息',
      '- 如果不确定，坦诚告知，不编造信息\n- 确保回答准确，引用可靠来源'
    )
    changes.push('添加准确性要求指令')
  }

  // 规则 3: 如果反馈提到代码问题，添加代码规范
  const codeComplaints = negativeFeedback.filter(f =>
    f.comment?.includes('代码') || f.comment?.includes('bug') || f.comment?.includes('运行')
  )
  if (codeComplaints.length > 0 && !optimized.includes('代码要完整可运行')) {
    optimized = optimized.replace(
      '- 代码块使用正确的语言标记',
      '- 代码块使用正确的语言标记\n- 代码要完整可运行，包含必要的导入语句'
    )
    changes.push('添加代码完整性要求指令')
  }

  // 规则 4: 默认优化 — 添加用户偏好关注
  if (changes.length === 0) {
    optimized += '\n\n改进注意：\n- 更加关注用户的隐含需求\n- 主动提供相关补充信息'
    changes.push('添加用户关注指令')
  }

  // 创建新版本
  const oldVersion = getCurrentPrompt('system')
  const newVersion = createPromptVersion(optimized, 'system', 3)

  console.log(`[PromptOptimizer] Created v${newVersion.version} via rule-based optimization`)

  return {
    success: true,
    newVersionId: newVersion.id,
    newVersion: newVersion.version,
    oldVersion: oldVersion?.version,
    method: 'rule',
    changes,
    reason: `基于 ${negativeFeedback.length} 条负反馈，使用规则优化`
  }
}

/**
 * 验证并清洗 LLM 输出的系统提示词
 * 防止推理文本、思考过程等污染系统提示词
 *
 * @returns 清洗后的合法提示词，如果验证失败返回 null
 */
function validateAndCleanPrompt(raw: string, originalPrompt: string): string | null {
  let cleaned = raw.trim()

  // 1. 如果输出包含 <think> 标签（未闭合的情况），移除标签及内容
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // 移除未闭合的 <think> 标签后的所有内容
  cleaned = cleaned.replace(/<think>[\s\S]*$/i, '').trim()

  // 2. 检测并移除前导推理文本
  //    推理文本通常以英文开头，直到出现 "你是小禅" 或类似的角色定义
  const roleStartMatch = cleaned.match(/你是小禅/)
  if (roleStartMatch && roleStartMatch.index !== undefined && roleStartMatch.index > 0) {
    const beforeRole = cleaned.slice(0, roleStartMatch.index).trim()
    // 如果 "你是小禅" 之前有大量非中文内容，认为是推理文本
    const nonChineseRatio = (beforeRole.match(/[a-zA-Z]/g) || []).length / Math.max(beforeRole.length, 1)
    if (beforeRole.length > 20 && nonChineseRatio > 0.5) {
      console.warn('[PromptOptimizer] Detected reasoning text before role definition, stripping')
      cleaned = cleaned.slice(roleStartMatch.index).trim()
    }
  }

  // 3. 验证必须包含核心角色定义
  if (!cleaned.includes('小禅') && !cleaned.includes('Zen')) {
    console.warn('[PromptOptimizer] Output missing core role definition (小禅/Zen)')
    return null
  }

  // 4. 验证长度合理（系统提示词应该在 100-2000 字之间）
  if (cleaned.length < 50 || cleaned.length > 3000) {
    console.warn(`[PromptOptimizer] Output length abnormal: ${cleaned.length}`)
    return null
  }

  // 5. 检测英文推理文本占比过高
  const englishLines = cleaned.split('\n').filter(line => {
    const trimmed = line.trim()
    if (!trimmed) return false
    const englishChars = (trimmed.match(/[a-zA-Z]/g) || []).length
    return englishChars / trimmed.length > 0.7
  })
  // 原始提示词中的英文行数（运行环境等部分有英文）
  const originalEnglishLines = originalPrompt.split('\n').filter(line => {
    const trimmed = line.trim()
    if (!trimmed) return false
    const englishChars = (trimmed.match(/[a-zA-Z]/g) || []).length
    return englishChars / trimmed.length > 0.7
  })
  // 如果英文行数显著增加（超出原始 + 3 行容差），认为是推理文本
  if (englishLines.length > originalEnglishLines.length + 3) {
    console.warn(`[PromptOptimizer] Too many English lines: ${englishLines.length} vs original ${originalEnglishLines.length}`)
    return null
  }

  // 6. 检测典型的推理语句模式
  const reasoningPatterns = [
    /^(now|i\s+(need|should|will|can|must)|let\s+me|based\s+on|first|to\s+generate|the\s+user)\b/i,
    /^(step\s+\d|phase\s+\d|approach|strategy|analysis)/i,
    /^(我需要|首先|接下来|然后|基于以上|根据反馈|分析反馈|策略|步骤)/
  ]
  const reasoningLineCount = cleaned.split('\n').filter(line =>
    reasoningPatterns.some(p => p.test(line.trim()))
  ).length
  if (reasoningLineCount > 2) {
    console.warn(`[PromptOptimizer] Detected ${reasoningLineCount} reasoning-like lines`)
    return null
  }

  return cleaned
}

/**
 * 检测新旧 Prompt 的变更点
 */
function detectChanges(oldPrompt: string, newPrompt: string): string[] {
  const changes: string[] = []

  const oldLines = oldPrompt.split('\n')
  const newLines = newPrompt.split('\n')

  // 检测新增的行
  for (const line of newLines) {
    if (line.trim() && !oldLines.includes(line)) {
      changes.push(`新增: "${line.trim().slice(0, 50)}"`)
    }
  }

  // 检测删除的行
  for (const line of oldLines) {
    if (line.trim() && !newLines.includes(line)) {
      changes.push(`移除: "${line.trim().slice(0, 50)}"`)
    }
  }

  return changes.slice(0, 10)  // 最多记录 10 条变更
}

/**
 * 回滚到上一个版本
 */
export function rollbackPrompt(): OptimizationResult {
  // 确保已初始化
  if (!initialized) tryInit()

  const versions = getPromptVersions('system')
  if (versions.length < 2) {
    return {
      success: false,
      method: 'none',
      changes: [],
      reason: '没有可回滚的历史版本'
    }
  }

  const current = versions.find(v => v.isCurrent) ?? versions[0]
  const previous = versions.find(v => v.id !== current.id)

  if (previous) {
    rollbackToVersion(previous.id)
    console.log(`[PromptOptimizer] Rolled back from v${current.version} to v${previous.version}`)

    return {
      success: true,
      method: 'none',
      newVersion: previous.version,
      oldVersion: current.version,
      changes: [],
      reason: `从 v${current.version} 回滚到 v${previous.version}`
    }
  }

  return {
    success: false,
    method: 'none',
    changes: [],
    reason: '找不到可回滚的版本'
  }
}

/**
 * 配置 A/B 测试
 */
export function setABTestConfig(config: Partial<ABTestConfig>): void {
  abTestConfig = { ...abTestConfig, ...config }
  console.log('[PromptOptimizer] A/B test config updated:', abTestConfig)
}

/**
 * 获取 A/B 测试配置
 */
export function getABTestConfig(): ABTestConfig {
  return { ...abTestConfig }
}

/**
 * 结束 A/B 测试，保留表现更好的版本
 */
export function concludeABTest(): OptimizationResult {
  // 确保已初始化
  if (!initialized) tryInit()

  const versions = getPromptVersions('system')
  if (versions.length < 2) {
    return {
      success: false,
      method: 'none',
      changes: [],
      reason: '不足两个版本，无法进行 A/B 测试'
    }
  }

  // 比较性能（正反馈率）
  const v1 = versions[0]
  const v2 = versions[1]

  const v1Score = v1.feedbackCount > 0
    ? v1.positiveCount / v1.feedbackCount
    : 0
  const v2Score = v2.feedbackCount > 0
    ? v2.positiveCount / v2.feedbackCount
    : 0

  const winner = v1Score >= v2Score ? v1 : v2
  const loser = v1Score >= v2Score ? v2 : v1

  // 设置获胜者为 current
  rollbackToVersion(winner.id)

  // 禁用 A/B 测试
  abTestConfig.enabled = false

  console.log(`[PromptOptimizer] A/B test concluded. Winner: v${winner.version} (score: ${v1Score.toFixed(2)} vs ${v2Score.toFixed(2)})`)

  return {
    success: true,
    method: 'none',
    newVersion: winner.version,
    oldVersion: loser.version,
    changes: [],
    reason: `A/B 测试完成，v${winner.version} 胜出 (正反馈率: ${(v1Score >= v2Score ? v1Score : v2Score) * 100}%)`
  }
}

/**
 * 获取当前 Prompt 版本（完整对象）
 */
export function getCurrentPromptVersion() {
  // 确保已初始化（懒加载）
  if (!initialized) tryInit()

  return getCurrentPrompt('system')
}

/**
 * 获取所有版本（供 UI 展示）
 */
export function listPromptVersions() {
  // 确保已初始化（懒加载）
  if (!initialized) tryInit()

  return getPromptVersions('system')
}
