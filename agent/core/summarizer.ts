/**
 * 渐进式摘要 — 将旧消息压缩为摘要，释放上下文空间
 *
 * 工作原理:
 * 1. 当对话历史超过 token 预算时，将较早的消息传给摘要器
 * 2. 摘要器使用 LLM 生成简洁摘要（如果 LLM 可用）
 * 3. LLM 不可用时退化为规则提取（关键句、首尾消息）
 * 4. 摘要结果作为 system 消息插入，替代被压缩的原始消息
 *
 * 摘要策略:
 * - 保留用户的核心问题和 Agent 的关键回答
 * - 去除冗余的寒暄、重复内容
 * - 保留事实性信息（代码、数据、结论）
 * - 按时间顺序组织
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig } from '../providers/llm-config'
import { countTextTokens } from '../utils/token-counter'

/** 可摘要的消息 */
export interface SummarizableMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp?: number
}

/** 摘要结果 */
export interface SummaryResult {
  /** 摘要文本 */
  summary: string
  /** 摘要的 token 数 */
  summaryTokens: number
  /** 被摘要的原始消息数 */
  originalMessageCount: number
  /** 原始消息总 token 数 */
  originalTokens: number
  /** 压缩比 */
  compressionRatio: number
  /** 使用的摘要方法 */
  method: 'llm' | 'rule'
}

/** 摘要选项 */
export interface SummarizeOptions {
  /** 最大摘要 token 数（默认 500） */
  maxTokens?: number
  /** AbortSignal */
  signal?: AbortSignal
  /** 超时毫秒（默认 30s） */
  timeoutMs?: number
  /** 模型 key（默认使用 fastModel 或 defaultModel） */
  modelKey?: string
}

/**
 * 对消息列表生成摘要
 *
 * @param messages 要摘要的消息列表
 * @param options 摘要选项
 * @returns 摘要结果
 */
export async function summarizeMessages(
  messages: SummarizableMessage[],
  options: SummarizeOptions = {}
): Promise<SummaryResult> {
  if (messages.length === 0) {
    return {
      summary: '',
      summaryTokens: 0,
      originalMessageCount: 0,
      originalTokens: 0,
      compressionRatio: 0,
      method: 'rule'
    }
  }

  const originalTokens = messages.reduce(
    (sum, m) => sum + countTextTokens(m.content),
    0
  )

  if (isLLMConfigured()) {
    try {
      return await summarizeWithLLM(messages, options, originalTokens)
    } catch (err) {
      console.warn('[Summarizer] LLM summarization failed, falling back to rules:', err)
    }
  }

  return summarizeWithRules(messages, originalTokens)
}

/**
 * 使用 LLM 生成摘要
 */
async function summarizeWithLLM(
  messages: SummarizableMessage[],
  options: SummarizeOptions,
  originalTokens: number
): Promise<SummaryResult> {
  const config = getConfig()
  const maxTokens = options.maxTokens ?? 500
  const modelKey = options.modelKey || config.agent.fastModel || config.defaultModelKey

  // 构建对话文本
  const conversationText = messages.map(m => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '小禅' : '系统'
    return `[${role}]: ${m.content}`
  }).join('\n\n')

  const systemPrompt = `你是一个对话摘要助手。请将以下对话历史压缩为简洁的摘要。

要求：
1. 保留所有关键信息（事实、决策、代码片段、数据）
2. 去除寒暄和重复内容
3. 按时间顺序组织
4. 中文回复
5. 摘要应在 ${maxTokens} token 以内

格式：
## 对话摘要
- 要点1
- 要点2
...

## 关键信息
- 事实/数据/结论等`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `请摘要以下对话:\n\n${conversationText}` }
    ],
    modelKey,
    temperature: 0.3,
    maxTokens,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 30000
  })

  const summaryTokens = countTextTokens(response)
  return {
    summary: response,
    summaryTokens,
    originalMessageCount: messages.length,
    originalTokens,
    compressionRatio: originalTokens > 0 ? summaryTokens / originalTokens : 0,
    method: 'llm'
  }
}

/**
 * 使用规则生成摘要（LLM 不可用时的回退方案）
 *
 * 策略:
 * 1. 提取每条消息的前 1-2 句作为关键句
 * 2. 保留首条和末条消息
 * 3. 中间消息提取要点
 */
function summarizeWithRules(
  messages: SummarizableMessage[],
  originalTokens: number
): SummaryResult {
  // 过滤掉 system 消息（通常不需要摘要）
  const dialogMessages = messages.filter(m => m.role !== 'system')

  if (dialogMessages.length === 0) {
    return {
      summary: '',
      summaryTokens: 0,
      originalMessageCount: messages.length,
      originalTokens,
      compressionRatio: 0,
      method: 'rule'
    }
  }

  const points: string[] = []

  // 首条消息完整保留（截取前 200 字符）
  const first = dialogMessages[0]
  const firstExcerpt = first.content.slice(0, 200)
  points.push(`${first.role === 'user' ? '用户' : '小禅'}: ${firstExcerpt}${first.content.length > 200 ? '...' : ''}`)

  // 中间消息提取首句
  for (let i = 1; i < dialogMessages.length - 1; i++) {
    const msg = dialogMessages[i]
    const firstSentence = extractFirstSentence(msg.content)
    if (firstSentence && firstSentence.length > 10) {
      const role = msg.role === 'user' ? '用户' : '小禅'
      points.push(`${role}: ${firstSentence}`)
    }
  }

  // 末条消息完整保留（截取前 200 字符）
  if (dialogMessages.length > 1) {
    const last = dialogMessages[dialogMessages.length - 1]
    const lastExcerpt = last.content.slice(0, 200)
    points.push(`${last.role === 'user' ? '用户' : '小禅'}: ${lastExcerpt}${last.content.length > 200 ? '...' : ''}`)
  }

  const summary = `## 对话摘要（规则提取）\n${points.map(p => `- ${p}`).join('\n')}`
  const summaryTokens = countTextTokens(summary)

  return {
    summary,
    summaryTokens,
    originalMessageCount: messages.length,
    originalTokens,
    compressionRatio: originalTokens > 0 ? summaryTokens / originalTokens : 0,
    method: 'rule'
  }
}

/**
 * 提取文本的首句
 */
function extractFirstSentence(text: string): string {
  if (!text) return ''

  // 匹配中英文句子结束符
  const match = text.match(/^[^。！？\n.!?]+[。！？\n.!?]?/)
  return match ? match[0].trim() : text.slice(0, 100).trim()
}

/**
 * 增量更新已有摘要
 *
 * 当有新的消息需要被摘要时，将新消息追加到已有摘要中，
 * 而不是重新摘要所有消息（提高效率）。
 *
 * @param existingSummary 已有的摘要文本
 * @param newMessages 新增的消息
 * @param options 摘要选项
 * @returns 更新后的摘要结果
 */
export async function updateSummary(
  existingSummary: string,
  newMessages: SummarizableMessage[],
  options: SummarizeOptions = {}
): Promise<SummaryResult> {
  if (newMessages.length === 0) {
    return {
      summary: existingSummary,
      summaryTokens: countTextTokens(existingSummary),
      originalMessageCount: 0,
      originalTokens: 0,
      compressionRatio: 0,
      method: 'rule'
    }
  }

  if (isLLMConfigured()) {
    try {
      const config = getConfig()
      const maxTokens = options.maxTokens ?? 500
      const modelKey = options.modelKey || config.agent.fastModel || config.defaultModelKey

      const newConversationText = newMessages.map(m => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '小禅' : '系统'
        return `[${role}]: ${m.content}`
      }).join('\n\n')

      const systemPrompt = `你是一个对话摘要助手。请将新的对话内容合并到已有摘要中。

要求：
1. 保留所有关键信息
2. 去除冗余和重复
3. 保持简洁
4. 中文回复

已有摘要:
${existingSummary}

新对话内容:
${newConversationText}

请输出更新后的完整摘要：`

      const response = await llm.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请更新摘要。' }
        ],
        modelKey,
        temperature: 0.3,
        maxTokens,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 30000
      })

      const summaryTokens = countTextTokens(response)
      const originalTokens = newMessages.reduce(
        (sum, m) => sum + countTextTokens(m.content),
        0
      )

      return {
        summary: response,
        summaryTokens,
        originalMessageCount: newMessages.length,
        originalTokens,
        compressionRatio: originalTokens > 0 ? summaryTokens / originalTokens : 0,
        method: 'llm'
      }
    } catch (err) {
      console.warn('[Summarizer] LLM update failed, falling back to rules:', err)
    }
  }

  // 规则回退：简单拼接
  const ruleResult = summarizeWithRules(newMessages, 0)
  const combined = `${existingSummary}\n\n---\n${ruleResult.summary}`
  const summaryTokens = countTextTokens(combined)

  return {
    summary: combined,
    summaryTokens,
    originalMessageCount: newMessages.length,
    originalTokens: 0,
    compressionRatio: 0,
    method: 'rule'
  }
}
