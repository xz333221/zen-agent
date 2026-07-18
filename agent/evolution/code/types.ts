/**
 * 自进化系统类型定义
 *
 * 定义了自进化编排器的核心数据结构，
 * 包括进化计划、代码修改、测试结果、进化记录等。
 */

// ── 进化阶段 ──

export type EvolutionPhase =
  | 'idle'           // 空闲，等待触发
  | 'analyzing'      // 分析日志和执行追踪
  | 'planning'       // LLM 生成改进计划
  | 'modifying'      // 修改代码
  | 'building'       // 编译
  | 'testing'        // 运行测试
  | 'evaluating'     // 评估改进效果
  | 'committing'     // 提交或回滚
  | 'done'           // 完成

// ── 改进计划 ──

export interface ImprovementPlan {
  id: string
  /** 触发原因（分析结果摘要） */
  trigger: string
  /** 改进目标描述 */
  goal: string
  /** 要修改的文件列表 */
  changes: FileChange[]
  /** 预期效果 */
  expectedOutcome: string
  /** 生成方式 */
  method: 'llm' | 'rule'
  /** 创建时间 */
  createdAt: number
}

export interface FileChange {
  /** 文件路径（相对于项目根目录） */
  filePath: string
  /** 修改类型 */
  type: 'create' | 'modify' | 'delete'
  /** 修改前的内容（modify 时有值） */
  oldContent?: string
  /** 修改后的内容 */
  newContent: string
  /** 修改说明 */
  description: string
}

// ── 测试结果 ──

export interface TestResult {
  /** 编译是否通过 */
  buildPassed: boolean
  /** 编译输出 */
  buildOutput: string
  /** 测试是否通过 */
  testPassed: boolean
  /** 测试输出 */
  testOutput: string
  /** 编译耗时（毫秒） */
  buildDuration: number
  /** 测试耗时（毫秒） */
  testDuration: number
  /** 错误信息 */
  errors: string[]
}

// ── 评估结果 ──

export interface EvaluationResult {
  /** 改进前测试问题回答的评分（1-5） */
  beforeScore: number
  /** 改进后测试问题回答的评分（1-5） */
  afterScore: number
  /** 是否有实质改进 */
  hasImprovement: boolean
  /** 评估理由 */
  reason: string
  /** 测试用的问题列表 */
  testQueries: string[]
  /** 改进前的回答 */
  beforeResponses: string[]
  /** 改进后的回答 */
  afterResponses: string[]
}

// ── 进化记录 ──

export type EvolutionOutcome = 'success' | 'partial' | 'failure' | 'rolled_back'

export interface EvolutionRecord {
  id: string
  /** 进化阶段（完成时为 'done'） */
  phase: EvolutionPhase
  /** 触发原因 */
  trigger: string
  /** 改进目标 */
  goal: string
  /** 修改的文件列表 */
  filesChanged: string[]
  /** 改进计划（JSON） */
  plan: ImprovementPlan | null
  /** 测试结果 */
  testResult: TestResult | null
  /** 评估结果 */
  evaluation: EvaluationResult | null
  /** 最终结果 */
  outcome: EvolutionOutcome
  /** Git commit hash（成功时） */
  commitHash: string | null
  /** 失败原因（失败时） */
  failureReason: string | null
  /** Token 消耗 */
  tokensUsed: {
    input: number
    output: number
  }
  /** 开始时间 */
  startedAt: number
  /** 结束时间 */
  finishedAt: number | null
  /** 进化日志（详细过程记录） */
  logs: EvolutionLogEntry[]
}

export interface EvolutionLogEntry {
  timestamp: number
  phase: EvolutionPhase
  message: string
  data?: unknown
}

// ── Token 预算 ──

export interface TokenBudget {
  /** 每个周期（5 小时）的总额度 */
  totalPerCycle: number
  /** 已使用额度 */
  used: number
  /** 当前周期开始时间 */
  cycleStart: number
  /** 周期长度（毫秒） */
  cycleDuration: number
  /** 预留给自进化的比例（0-1，默认 0.3） */
  evolutionRatio: number
  /** 已用于自进化的额度 */
  evolutionUsed: number
}

export interface TokenUsageRecord {
  timestamp: number
  inputTokens: number
  outputTokens: number
  purpose: 'chat' | 'evolution' | 'embedding' | 'other'
}

// ── 日志分析结果 ──

export interface LogAnalysisResult {
  /** 分析出的改进点 */
  improvementPoints: ImprovementPoint[]
  /** 最近对话的反思汇总 */
  recentReflections: ReflectionSummary[]
  /** 错误模式统计 */
  errorPatterns: ErrorPattern[]
  /** 性能问题 */
  performanceIssues: PerformanceIssue[]
  /** 分析摘要 */
  summary: string
}

export interface ImprovementPoint {
  type: 'bug' | 'performance' | 'quality' | 'feature' | 'refactor'
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
  suggestedAction: string
  /** 相关文件（如果知道） */
  targetFiles: string[]
  /** 来源（哪条日志/追踪） */
  source: string
}

export interface ReflectionSummary {
  averageScore: number
  commonWeaknesses: string[]
  commonImprovements: string[]
  sampleCount: number
}

export interface ErrorPattern {
  pattern: string
  occurrences: number
  example: string
  suggestedFix: string
}

export interface PerformanceIssue {
  metric: string
  currentValue: number
  threshold: number
  description: string
}

// ── 自进化配置 ──

export interface SelfEvolutionConfig {
  /** 是否启用自进化 */
  enabled: boolean
  /** 用户空闲多久后触发（毫秒，默认 5 分钟） */
  idleThreshold: number
  /** Token 周期长度（毫秒，默认 5 小时） */
  tokenCycleDuration: number
  /** 每周期预留给自进化的 Token 比例 */
  evolutionTokenRatio: number
  /** 单次进化最大 Token 消耗 */
  maxTokensPerEvolution: number
  /** 允许修改的目录（白名单） */
  allowedDirectories: string[]
  /** 禁止修改的文件（黑名单） */
  forbiddenFiles: string[]
  /** 是否需要编译通过才提交 */
  requireBuildPass: boolean
  /** 是否需要测试通过才提交 */
  requireTestPass: boolean
  /** 是否自动 git commit（false 则只生成 patch 不提交） */
  autoCommit: boolean
  /** 评估用测试问题列表 */
  evaluationQueries: string[]
  /** 最小进化间隔（毫秒，防止过于频繁） */
  minEvolutionInterval: number
}

export const DEFAULT_EVOLUTION_CONFIG: SelfEvolutionConfig = {
  enabled: false,
  idleThreshold: 5 * 60 * 1000,        // 5 分钟
  tokenCycleDuration: 5 * 60 * 60 * 1000, // 5 小时
  evolutionTokenRatio: 0.3,             // 30% 额度用于自进化
  maxTokensPerEvolution: 50000,         // 单次最多 50K tokens
  allowedDirectories: [
    'agent/',
    'src/main/ipc/',
    'src/main/storage/',
    'src/main/plugins/',
    'src/main/offline/',
    'src/shared/'
  ],
  forbiddenFiles: [
    'src/main/index.ts',         // 不修改主入口
    'src/main/windows/',         // 不修改窗口管理
    'package.json',              // 不修改依赖
    'electron-builder.yml',      // 不修改打包配置
  ],
  requireBuildPass: true,
  requireTestPass: false,         // 测试可选（E2E 太慢）
  autoCommit: true,
  evaluationQueries: [
    '你好，你是谁？',
    '帮我写一个快速排序的 JavaScript 实现',
    '今天天气怎么样？',
    '帮我分析一下这段代码有什么问题：function add(a, b) { return a - b }',
    '你能做什么？'
  ],
  minEvolutionInterval: 10 * 60 * 1000  // 最少间隔 10 分钟
}
