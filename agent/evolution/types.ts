/**
 * 进化系统类型定义
 */

/** 进化事件 */
export interface EvolutionEvent {
  id: string
  type: 'skill_proposed' | 'skill_improved' | 'prompt_optimized' | 'pattern_detected' | 'knowledge_extracted'
  description: string
  confidence: number
  timestamp: number
  data: EvolutionEventData
  status: 'pending' | 'applied' | 'rejected' | 'archived'
}

export type EvolutionEventData =
  | SkillProposalData
  | PromptOptimizationData
  | PatternDetectionData
  | KnowledgeExtractionData

export interface SkillProposalData {
  type: 'skill_proposed'
  skillName: string
  skillDescription: string
  sourceEpisodes: string[]
}

export interface PromptOptimizationData {
  type: 'prompt_optimized'
  target: string
  oldPrompt: string
  newPrompt: string
  improvementScore: number
}

export interface PatternDetectionData {
  type: 'pattern_detected'
  patternType: string
  occurrences: number
  similarity: number
  examples: string[]
}

export interface KnowledgeExtractionData {
  type: 'knowledge_extracted'
  facts: Array<{ content: string; confidence: number }>
  preferences: Array<{ content: string; confidence: number }>
}

/** 反馈循环 */
export interface FeedbackLoop {
  episodeId: string
  userFeedback?: 'positive' | 'negative' | 'neutral'
  implicitFeedback: {
    responseAccepted: boolean
    followUpQuestion: boolean
    editingRequired: boolean
    executionTime: number
  }
  agentSelfScore: number
  improvementNotes: string[]
}

/** 进化配置 */
export interface EvolutionConfig {
  enableSkillAutoGeneration: boolean
  enablePromptOptimization: boolean
  patternDetectionThreshold: number  // 触发模式检测的最小出现次数
  patternSimilarityThreshold: number  // 模式相似度阈值
  promptOptimizationInterval: number  // prompt 优化检查间隔（执行次数）
  maxEvolutionEvents: number  // 保留的最大进化事件数
}
