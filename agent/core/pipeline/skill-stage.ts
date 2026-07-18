/**
 * 技能匹配阶段 — 根据用户查询匹配已有技能
 *
 * 使用向量相似度匹配最相关的技能，
 * 将匹配的技能内容注入 LLM 上下文。
 */

import { countTextTokens } from '../../utils/token-counter'
import type { SkillMatchDetail } from '../../../src/shared/types'
import type { PipelineContext } from './context'

export async function runSkillStage(ctx: PipelineContext): Promise<void> {
  const { agentContext, services, userInput, signal } = ctx
  const topK = agentContext.settings.maxSkillsLoaded

  const matches = await services.skills.match(userInput, { topK, minScore: 0.6 }, signal)
  ctx.matchedSkills = matches

  // 格式化匹配结果用于追踪展示
  const candidates = matches.map(m => ({
    id: m.skill.id,
    name: m.skill.name,
    description: m.skill.description,
    score: parseFloat(m.score.toFixed(4)),
    loaded: m.loaded,
    reason: m.reason
  }))

  const loadedTokens = matches.reduce(
    (sum, m) => sum + countTextTokens(m.skill.content),
    0
  )

  const detail: SkillMatchDetail = {
    type: 'skill_match',
    candidates,
    loadedTokens
  }
  ctx.trace.recordStep(
    'skill_match',
    `技能匹配${matches.length > 0 ? ` (${matches.length})` : ''}`,
    '🔧',
    detail
  )

  // 将匹配的技能注入上下文（作为 system 消息）
  if (matches.length > 0) {
    const skillText = services.skills.formatForContext(matches)
    if (skillText) {
      // 在最后一条 system 消息之后插入
      let lastSystemIdx = -1
      for (let i = 0; i < agentContext.messages.length; i++) {
        if (agentContext.messages[i].role === 'system') lastSystemIdx = i
      }
      agentContext.messages.splice(lastSystemIdx + 1, 0, {
        role: 'system',
        content: skillText
      })
    }
  }
}
