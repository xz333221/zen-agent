/**
 * 反思模块 — Agent 对自身执行过程进行自评
 *
 * 评估维度:
 * - 自评分数 (1-5)
 * - 优点和不足
 * - 改进建议
 * - 是否检测到重复模式（供技能生成系统使用）
 */

import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig } from '../providers/llm-config'
import type { ReflectDetail } from '../../src/shared/types'
import type { ReActStep } from './types'

/**
 * 执行反思
 * 优先使用 LLM，不可用时使用规则评估
 */
export async function reflect(
  userInput: string,
  finalOutput: string,
  reactSteps: ReActStep[],
  signal?: AbortSignal
): Promise<ReflectDetail> {
  if (isLLMConfigured()) {
    try {
      return await reflectWithLLM(userInput, finalOutput, reactSteps, signal)
    } catch (err) {
      console.warn('[Reflection] LLM reflection failed, falling back to rules:', err)
    }
  }

  return reflectWithRules(userInput, finalOutput, reactSteps)
}

/** 使用 LLM 进行反思 */
async function reflectWithLLM(
  userInput: string,
  finalOutput: string,
  reactSteps: ReActStep[],
  signal?: AbortSignal
): Promise<ReflectDetail> {
  const config = getConfig()
  const stepsSummary = reactSteps.map((s, i) =>
    `Step ${i + 1}: Think=${s.think.slice(0, 100)}, Action=${s.action}`
  ).join('\n')

  const prompt = `作为 AI 助手，反思你对以下问题的回答质量。返回 JSON 格式：

用户问题: "${userInput.slice(0, 500)}"
回答摘要: "${finalOutput.slice(0, 500)}"
推理步骤:
${stepsSummary}

返回格式:
{"selfScore": 1-5, "scoreReason": "评分理由", "strengths": ["优点1"], "weaknesses": ["不足1"], "improvements": ["改进1"]}

只返回 JSON。`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是反思评估助手，只返回 JSON。' },
      { role: 'user', content: prompt }
    ],
    modelKey: config.defaultModelKey,
    temperature: 0.3,
    maxTokens: 500,
    signal,
    timeoutMs: 15000
  })

  const jsonMatch = response.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return reflectWithRules(userInput, finalOutput, reactSteps)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      type: 'reflect',
      selfScore: Math.max(1, Math.min(5, parsed.selfScore || 3)),
      scoreReason: parsed.scoreReason || '',
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
      patternDetected: false
    }
  } catch {
    return reflectWithRules(userInput, finalOutput, reactSteps)
  }
}

/** 使用规则进行反思 */
function reflectWithRules(
  userInput: string,
  finalOutput: string,
  reactSteps: ReActStep[]
): ReflectDetail {
  const strengths: string[] = []
  const weaknesses: string[] = []
  const improvements: string[] = []
  let selfScore = 3

  // 评估回答长度
  if (finalOutput.length < 10) {
    weaknesses.push('回答过于简短')
    selfScore = Math.min(selfScore, 2)
  } else if (finalOutput.length > 50) {
    strengths.push('回答内容充实')
  }

  // 评估推理步骤
  if (reactSteps.length > 1) {
    strengths.push('进行了多步推理')
  }

  // 评估是否直接回答
  if (reactSteps.length === 1 && finalOutput.length > 20) {
    strengths.push('高效直接回答')
  }

  // 评估用户问题匹配度
  if (userInput.length > 0 && finalOutput.length > 0) {
    const userKeywords = userInput.split(/\s+/).filter(w => w.length > 2)
    const matchedKeywords = userKeywords.filter(kw =>
      finalOutput.toLowerCase().includes(kw.toLowerCase())
    )
    if (userKeywords.length > 0) {
      const matchRate = matchedKeywords.length / userKeywords.length
      if (matchRate > 0.5) {
        strengths.push('回答与问题高度相关')
        selfScore = Math.max(selfScore, 4)
      } else if (matchRate < 0.2) {
        weaknesses.push('回答可能与问题不够相关')
        selfScore = Math.min(selfScore, 2)
      }
    }
  }

  if (weaknesses.length === 0) {
    improvements.push('可以提供更详细的分析和示例')
  }

  return {
    type: 'reflect',
    selfScore,
    scoreReason: selfScore >= 4 ? '回答质量良好' : selfScore >= 3 ? '回答基本满足需求' : '回答质量有待提升',
    strengths,
    weaknesses,
    improvements,
    patternDetected: false
  }
}
