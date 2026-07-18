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

/** 需要使用本地工具的关键词（至少 medium 复杂度） */
const TOOL_REQUIRED_KEYWORDS = [
  '有哪些', '看一下', '看看', '找', '查找', '搜索',
  '电脑上', '本机', '本地', '项目', '仓库', '文件',
  '开源项目', '在做', '列出', '拉取', 'clone',
  'git', '提交', '推送', '运行', '执行', '安装',
  // 本地资源定位关键词
  '存储位置', '存储在哪', '存在哪', '保存在哪', '保存在', '数据存储',
  '数据库', 'sqlite', '数据文件', '数据库文件',
  '路径', '在哪呢', '在哪里', '什么位置', '具体位置',
  '定位', '配置在哪', '配置文件在哪', '日志在哪',
  '安装在哪', '安装位置', '数据目录', '应用数据', '应用目录',
  '数据在', '文件在', '目录在', '文件夹在',
  // 平台/产品操作类问题 — 需要搜索官方文档
  '怎么看', '怎么用', '如何查看', '如何使用', '怎么操作',
  '在哪看', '在哪里看', '怎么查看', '怎么找到',
  '怎么看自己', '怎么看我的', '怎么知道',
  '教程', '文档', '官方文档', '帮助文档',
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
复杂度判定规则:
- low: 纯知识问答（如"什么是递归"），不涉及本地文件/命令/项目，也不涉及特定平台/产品的操作
- medium: 需要查阅本地文件、搜索项目、执行命令、或查找本地资源；或者涉及特定平台/产品的操作问题（如"怎么看XX使用量""XX怎么用""如何查看XX"）——这类问题需要搜索官方文档
- high: 需要多步推理、任务分解、或组合多个工具完成
requiresPlanning: 是否需要任务分解和规划

重要：当用户提到"项目""文件""本地""电脑上""有哪些""查找""看一下""存储位置""数据库""路径""在哪"时，复杂度至少为 medium（因为需要使用工具查本地资源）。
当用户问"怎么看""怎么用""如何查看""如何使用""在哪看"等操作类问题时，复杂度至少为 medium（因为需要搜索官方文档或教程）。

只返回 JSON，不要其他文字。`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是意图分析助手，只返回 JSON。' },
      { role: 'user', content: prompt }
    ],
    // 优先使用 fastModel（轻量任务），fallback 到主模型
    modelKey: config.agent.fastModel || config.defaultModelKey,
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
  // 需要本地工具的请求至少是 medium
  if (complexity === 'low' && TOOL_REQUIRED_KEYWORDS.some(kw => userInput.includes(kw))) {
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
