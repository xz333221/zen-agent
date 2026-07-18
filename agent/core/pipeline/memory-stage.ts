/**
 * 记忆检索阶段 — 向量语义搜索相关历史记忆
 *
 * 使用 Embedding 向量搜索历史对话记忆，
 * 按相关度 + 时间衰减 + 重要性综合排序。
 * 检索到的记忆会注入到上下文中供 LLM 参考。
 */

import { countTextTokens } from '../../utils/token-counter'
import type { MemorySearchResult } from '../../memory/types'
import type { MemoryDetail } from '../../../src/shared/types'
import type { PipelineContext } from './context'

export async function runMemoryStage(ctx: PipelineContext): Promise<void> {
  const { agentContext, services, userInput } = ctx
  const topK = agentContext.settings.maxMemoriesRetrieved

  const memories = await services.memory.retrieve(
    userInput,
    { topK, minScore: 0.3, dedupThreshold: 0.92 },
    agentContext.sessionId  // 排除当前会话的记忆
  )
  ctx.memories = memories

  // 格式化记忆详情用于追踪展示
  const retrieved = memories.map(m => ({
    id: m.memory.id,
    content: 'content' in m.memory
      ? m.memory.content
      : ('outcome' in m.memory ? m.memory.outcome : ''),
    score: parseFloat(m.score.toFixed(4)),
    source: 'source' in m.memory ? m.memory.source : 'episodic',
    age: formatAge('timestamp' in m.memory ? m.memory.timestamp : m.memory.createdAt),
    confidence: m.vectorScore
  }))

  const totalTokens = retrieved.reduce(
    (sum, m) => sum + countTextTokens(m.content),
    0
  )

  const detail: MemoryDetail = {
    type: 'memory',
    searchParams: { topK, minScore: 0.3 },
    retrieved,
    totalTokens
  }
  ctx.trace.recordStep('memory', `记忆检索${memories.length > 0 ? ` (${memories.length})` : ''}`, '🧠', detail)

  // 将检索到的记忆注入上下文（作为 system 消息）
  if (memories.length > 0) {
    const memoryText = formatMemoriesForContext(memories)
    if (memoryText) {
      // 在系统提示之后插入记忆
      const systemIdx = agentContext.messages[0]?.role === 'system' ? 0 : -1
      if (systemIdx >= 0) {
        agentContext.messages.splice(1, 0, {
          role: 'system',
          content: memoryText
        })
      } else {
        agentContext.messages.unshift({
          role: 'system',
          content: memoryText
        })
      }
    }
  }
}

/** 格式化记忆为上下文文本 */
function formatMemoriesForContext(memories: MemorySearchResult[]): string {
  const lines = memories.map((m, i) => {
    const content = 'content' in m.memory
      ? m.memory.content
      : ('outcome' in m.memory ? m.memory.outcome : '')
    const intent = 'userIntent' in m.memory ? m.memory.userIntent : ''
    const score = (m.score * 100).toFixed(0)
    return `[${i + 1}] (相关度 ${score}%) ${intent ? 'Q: ' + intent + '\n' : ''}A: ${content.slice(0, 300)}`
  })
  return `[相关历史记忆]
以下是与你当前问题相关的历史对话记忆，供参考：

${lines.join('\n\n')}`
}

/** 格式化时间为人类可读的相对时间 */
function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (days > 0) return `${days}天前`
  if (hours > 0) return `${hours}小时前`
  if (minutes > 0) return `${minutes}分钟前`
  return '刚刚'
}
