/**
 * 意图解析器 — 分析用户输入的意图、复杂度和是否需要规划
 *
 * 使用 LLM 进行轻量级分类，当 LLM 不可用时退化为规则匹配。
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig } from '../providers/llm-config'
import type { IntentDetail } from '../../src/shared/types'

export interface IntentResult {
  classification: string
  complexity: 'low' | 'medium' | 'high'
  requiresPlanning: boolean
  /** 使用的解析方式 */
  method: 'llm' | 'rule'
}

/** 规则匹配的关键词 */
const COMPLEX_KEYWORDS = [
  '分析', '比较', '设计', '实现', '规划', '研究', '总结',
  '写一篇', '写一个', '创建一个', '构建', '开发', '重构',
  '多步', '步骤', '流程', '方案', '策略', '优化'
]

const MEDIUM_KEYWORDS = [
  '解释', '翻译', '转换', '格式化', '修复', '调试',
  '列表', '整理', '分类', '排序', '过滤'
]

const PLANNING_KEYWORDS = [
  '计划', '规划', '方案', '路线图', '里程碑', '排期',
  '项目管理', '任务分解', '步骤'
]

/**
 * 解析用户意图
 * 优先使用 LLM，不可用时退化为规则匹配
 */
export async function parseIntent(
  userInput: string,
  signal?: AbortSignal
): Promise<IntentResult> {
  if (isLLMConfigured()) {
    try {
      return await parseIntentWithLLM(userInput, signal)
    } catch (err) {
      // LLM 调用失败，退化为规则匹配
      console.warn('[IntentParser] LLM parsing failed, falling back to rules:', err)
    }
  }

  return parseIntentWithRules(userInput)
}

/** 使用 LLM 解析意图 */
async function parseIntentWithLLM(
  userInput: string,
  signal?: AbortSignal
): Promise<IntentResult> {
  const config = getConfig()
  const prompt = `分析以下用户输入的意图，返回 JSON 格式（不要其他内容）：

用户输入: "${userInput}"

返回格式:
{"classification": "分类标签", "complexity": "low|medium|high", "requiresPlanning": true|false}

分类标签参考: coding, writing, analysis, translation, question, chat, planning, other
复杂度: low=简单问答, medium=需要一些思考, high=需要多步推理或工具
requiresPlanning: 是否需要任务分解和规划

只返回 JSON，不要其他文字。`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是意图分析助手，只返回 JSON。' },
      { role: 'user', content: prompt }
    ],
    modelKey: config.defaultModelKey,
    temperature: 0,
    maxTokens: 200,
    signal,
    timeoutMs: 10000
  })

  // 解析 LLM 返回的 JSON
  const jsonMatch = response.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return parseIntentWithRules(userInput)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      classification: parsed.classification || 'general',
      complexity: ['low', 'medium', 'high'].includes(parsed.complexity) ? parsed.complexity : 'low',
      requiresPlanning: !!parsed.requiresPlanning,
      method: 'llm'
    }
  } catch {
    return parseIntentWithRules(userInput)
  }
}

/** 使用规则匹配解析意图 */
function parseIntentWithRules(userInput: string): IntentResult {
  const lowerInput = userInput.toLowerCase()

  // 检查复杂度
  let complexity: 'low' | 'medium' | 'high' = 'low'
  if (COMPLEX_KEYWORDS.some(kw => userInput.includes(kw))) {
    complexity = 'high'
  } else if (MEDIUM_KEYWORDS.some(kw => userInput.includes(kw))) {
    complexity = 'medium'
  }

  // 检查是否需要规划
  const requiresPlanning = PLANNING_KEYWORDS.some(kw => userInput.includes(kw))

  // 分类
  let classification = 'general'
  if (/代码|code|函数|function|bug|错误|编程|编程/.test(lowerInput) || /代码|函数|bug/.test(userInput)) {
    classification = 'coding'
  } else if (/写|文章|essay|write/.test(lowerInput) || /写一/.test(userInput)) {
    classification = 'writing'
  } else if (/分析|比较|对比/.test(userInput)) {
    classification = 'analysis'
  } else if (/翻译|translate/.test(lowerInput) || /翻译/.test(userInput)) {
    classification = 'translation'
  } else if (userInput.includes('?') || userInput.includes('？') || userInput.includes('什么是')) {
    classification = 'question'
  } else {
    classification = 'chat'
  }

  return { classification, complexity, requiresPlanning, method: 'rule' }
}

/** 将 IntentResult 转为 IntentDetail（用于 TraceStep） */
export function toIntentDetail(userInput: string, result: IntentResult): IntentDetail {
  return {
    type: 'intent',
    userInput,
    classification: result.classification,
    complexity: result.complexity,
    requiresPlanning: result.requiresPlanning
  }
}
