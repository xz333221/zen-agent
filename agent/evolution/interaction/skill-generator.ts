/**
 * 技能生成器 — 从检测到的模式自动生成可复用技能
 *
 * 工作流程:
 * 1. 接收模式检测结果（重复的查询模式）
 * 2. 使用 LLM 分析模式并生成技能定义（名称、描述、Prompt 模板）
 * 3. LLM 不可用时使用规则生成基础技能定义
 * 4. 返回技能提议，由 skill-store 持久化
 *
 * 技能结构:
 * - name: 简洁的技能名称
 * - description: 技能适用场景描述
 * - content: Prompt 模板（含变量占位符）
 */

import { llm } from '../../providers/llm'
import { isLLMConfigured, getConfig } from '../../providers/llm-config'
import { generateEmbedding } from '../../memory/embeddings'
import type { SkillProposal } from '../../skills/types'
import type { DetectedPattern } from './pattern-detector'

/** 技能生成结果 */
export interface SkillGenerationResult {
  proposal: SkillProposal
  embedding: number[]
  method: 'llm' | 'rule'
}

/**
 * 从检测到的模式生成技能
 *
 * @param pattern 检测到的模式
 * @param signal AbortSignal
 * @returns 技能生成结果
 */
export async function generateSkill(
  pattern: DetectedPattern,
  signal?: AbortSignal
): Promise<SkillGenerationResult> {
  if (isLLMConfigured()) {
    try {
      return await generateSkillWithLLM(pattern, signal)
    } catch (err) {
      console.warn('[SkillGenerator] LLM generation failed, falling back to rules:', err)
    }
  }

  return generateSkillWithRules(pattern)
}

/**
 * 使用 LLM 生成技能
 */
async function generateSkillWithLLM(
  pattern: DetectedPattern,
  signal?: AbortSignal
): Promise<SkillGenerationResult> {
  const config = getConfig()

  const examples = pattern.occurrences.slice(0, 5).map((q, i) => `${i + 1}. ${q}`).join('\n')

  const systemPrompt = `你是一个技能生成助手。根据用户重复出现的问题模式，生成一个可复用的技能定义。

技能定义包含：
1. name: 简洁的中文名称（2-8字）
2. description: 技能适用场景的描述（一句话）
3. content: Prompt 模板，使用 {{user_input}} 作为用户输入占位符

返回 JSON 格式：
{"name": "技能名称", "description": "技能描述", "content": "Prompt模板"}`

  const userPrompt = `检测到以下重复问题模式（相似度 ${(pattern.similarity * 100).toFixed(0)}%，出现 ${pattern.occurrences.length} 次）：

${examples}

建议的技能名称: ${pattern.suggestedSkillName}

请生成技能定义。`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    modelKey: config.defaultModelKey,
    temperature: 0.4,
    maxTokens: 800,
    signal,
    timeoutMs: 20000
  })

  // 解析 LLM 返回的 JSON
  const jsonMatch = response.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return generateSkillWithRules(pattern)
  }

  let parsed: { name: string; description: string; content: string }
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return generateSkillWithRules(pattern)
  }

  // 生成嵌入向量（用于后续匹配）
  const embeddingText = `${parsed.name} ${parsed.description} ${parsed.content}`
  const embedding = await generateEmbedding(embeddingText, signal)

  const now = Date.now()
  const proposal: SkillProposal = {
    id: `skill-proposal-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: parsed.name || pattern.suggestedSkillName,
    description: parsed.description || `基于 ${pattern.occurrences.length} 次相似请求自动生成`,
    content: parsed.content || `请回答以下问题：{{user_input}}`,
    confidence: Math.min(0.9, 0.5 + pattern.similarity * 0.3),
    sourceEpisodes: pattern.occurrences,
    createdAt: now,
    status: 'pending'
  }

  return { proposal, embedding, method: 'llm' }
}

/**
 * 使用规则生成技能（LLM 不可用时的回退方案）
 */
function generateSkillWithRules(pattern: DetectedPattern): SkillGenerationResult {
  const now = Date.now()
  const name = pattern.suggestedSkillName
  const description = `当用户提出与"${pattern.exampleQuery.slice(0, 30)}"类似的问题时使用此技能`

  // 基础 Prompt 模板
  const content = `你是一个${name}。请根据以下用户输入提供专业、准确的回答。

用户输入: {{user_input}}

回答要求：
- 直接回答用户问题
- 提供清晰的结构
- 使用中文回答`

  // 伪嵌入（规则模式下无法生成真正的语义嵌入）
  const embedding = generatePseudoEmbedding(`${name} ${description}`)

  const proposal: SkillProposal = {
    id: `skill-proposal-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    content,
    confidence: Math.min(0.7, 0.4 + pattern.similarity * 0.2),
    sourceEpisodes: pattern.occurrences,
    createdAt: now,
    status: 'pending'
  }

  return { proposal, embedding, method: 'rule' }
}

/**
 * 生成伪嵌入向量（确定性哈希）
 */
function generatePseudoEmbedding(text: string): number[] {
  const dim = 384
  const vec = new Array(dim).fill(0)
  const chunkSize = Math.max(1, Math.ceil(text.length / 16))

  for (let i = 0; i < text.length; i += chunkSize) {
    const chunk = text.slice(i, i + chunkSize)
    let hash = 5381
    for (let j = 0; j < chunk.length; j++) {
      hash = ((hash << 5) + hash + chunk.charCodeAt(j)) & 0x7fffffff
    }
    const pos = hash % dim
    const value = ((hash % 1000) / 1000 - 0.5) * 2
    vec[pos] += value
  }

  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm
  }

  while (vec.length < 1536) vec.push(0)
  return vec
}
