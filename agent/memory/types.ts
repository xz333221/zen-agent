/**
 * 记忆系统类型定义
 */

/** 记忆类型 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural'

/** 情景记忆 — 一次完整的交互记录 */
export interface EpisodicMemory {
  id: string
  timestamp: number
  userIntent: string
  actions: string[]
  outcome: string
  successScore: number
  modelUsed: string
  skillsUsed: string[]
  embedding?: number[]
  tags: string[]
}

/** 语义记忆 — 提炼出的事实/偏好 */
export interface SemanticMemory {
  id: string
  type: 'fact' | 'preference' | 'pattern' | 'knowledge'
  content: string
  confidence: number
  source: string
  embedding?: number[]
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  importance: number
}

/** 程序记忆 — 技能的执行经验 */
export interface ProceduralMemory {
  skillId: string
  executionCount: number
  successRate: number
  avgDuration: number
  lastModified: number
  promptVersions: PromptVersion[]
  commonErrors: string[]
  optimizations: string[]
}

export interface PromptVersion {
  version: number
  content: string
  createdAt: number
  performance: number  // 1-5 评分
  isCurrent: boolean
}

/** 记忆检索结果 */
export interface MemorySearchResult {
  memory: EpisodicMemory | SemanticMemory
  score: number
  vectorScore: number
  recencyScore: number
  importanceScore: number
}

/** 记忆检索参数 */
export interface MemorySearchParams {
  query: string
  topK: number
  minScore: number
  dedupThreshold: number
  timeDecayHalfLifeDays: number
}
