/**
 * 日志分析器 — 分析执行追踪、反思记录、错误日志
 *
 * 数据来源:
 * 1. execution_traces — Agent 的执行追踪（存在 messages.trace 字段中）
 * 2. memories — 情景记忆（含 success_score、反思信息）
 * 3. feedback — 用户反馈记录
 * 4. evolution_records — 之前的进化记录（避免重复）
 * 5. 控制台日志 — Agent 运行时的 console 输出
 *
 * 输出:
 * - 改进点列表（bug/性能/质量/功能/重构）
 * - 反思汇总（常见弱点、改进建议）
 * - 错误模式统计
 * - 性能问题
 */

import { llm } from '../../providers/llm'
import { isLLMConfigured, getConfig } from '../../providers/llm-config'
import { query } from '../../../src/main/storage/database'
import { getFailedEvolutionRecords } from './evolution-journal'
import type {
  LogAnalysisResult,
  ImprovementPoint,
  ReflectionSummary,
  ErrorPattern,
  PerformanceIssue,
  EvolutionRecord
} from './types'

/** 反思数据行 */
interface ReflectDataRow {
  user_intent: string
  outcome: string
  success_score: number
  content: string
  actions: string
  created_at: number
}

/** 消息+追踪行 */
interface MessageTraceRow {
  role: string
  content: string
  trace: string | null
  timestamp: number
}

/**
 * 分析最近日志和执行记录
 */
export async function analyzeLogs(
  since: number = Date.now() - 24 * 60 * 60 * 1000,
  signal?: AbortSignal
): Promise<LogAnalysisResult> {
  // 收集反思数据
  const reflections = collectReflections(since)

  // 收集执行追踪中的错误
  const traces = collectTraces(since)

  // 收集用户反馈
  const feedback = collectFeedback(since)

  // 获取之前失败的进化记录（避免重复）
  const failedEvolutions = getFailedEvolutionRecords(30)

  // 如果配置了 LLM，使用 LLM 深度分析
  if (isLLMConfigured()) {
    try {
      return await analyzeWithLLM(reflections, traces, feedback, failedEvolutions, signal)
    } catch (err) {
      console.warn('[LogAnalyzer] LLM analysis failed, falling back to rules:', err)
    }
  }

  // 规则分析
  return analyzeWithRules(reflections, traces, feedback, failedEvolutions)
}

// ═══════════════════════════════════════════════════════════
//  数据收集
// ═══════════════════════════════════════════════════════════

/**
 * 从 memories 表收集反思数据
 */
function collectReflections(since: number): ReflectionDataRow[] {
  try {
    const rows = query<ReflectDataRow>(
      `SELECT user_intent, outcome, success_score, content, actions, created_at
       FROM memories
       WHERE type = 'episodic' AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [since]
    )
    return rows.map(r => ({
      userIntent: r.user_intent || '',
      outcome: r.outcome || '',
      successScore: r.success_score ?? 3,
      content: r.content || '',
      actions: r.actions || '',
      createdAt: r.created_at
    }))
  } catch {
    return []
  }
}

interface ReflectionDataRow {
  userIntent: string
  outcome: string
  successScore: number
  content: string
  actions: string
  createdAt: number
}

/**
 * 从 messages 表收集执行追踪
 */
function collectTraces(since: number): CollectedTrace[] {
  try {
    const rows = query<MessageTraceRow>(
      `SELECT role, content, trace, timestamp
       FROM messages
       WHERE timestamp >= ? AND trace IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT 30`,
      [since]
    )

    const traces: CollectedTrace[] = []
    for (const row of rows) {
      if (!row.trace) continue
      try {
        const parsed = JSON.parse(row.trace)
        traces.push({
          role: row.role,
          content: row.content?.slice(0, 200) || '',
          trace: parsed,
          timestamp: row.timestamp
        })
      } catch { /* skip invalid JSON */ }
    }
    return traces
  } catch {
    return []
  }
}

interface CollectedTrace {
  role: string
  content: string
  trace: {
    steps?: Array<{
      type: string
      name: string
      status: string
      detail?: unknown
      duration?: number
    }>
    stats?: {
      totalInputTokens: number
      totalOutputTokens: number
      llmCalls: number
      toolCalls: number
    }
  }
  timestamp: number
}

/**
 * 收集用户反馈
 */
function collectFeedback(since: number): FeedbackDataRow[] {
  try {
    return query<FeedbackDataRow>(
      `SELECT feedback_type, feedback_source, user_query, agent_response, comment, created_at
       FROM feedback
       WHERE created_at >= ?
       ORDER BY created_at DESC
       LIMIT 30`,
      [since]
    )
  } catch {
    return []
  }
}

interface FeedbackDataRow {
  feedback_type: string
  feedback_source: string
  user_query: string | null
  agent_response: string | null
  comment: string | null
  created_at: number
}

// ═══════════════════════════════════════════════════════════
//  LLM 分析
// ═══════════════════════════════════════════════════════════

/**
 * 使用 LLM 深度分析日志和执行记录
 */
async function analyzeWithLLM(
  reflections: ReflectionDataRow[],
  traces: CollectedTrace[],
  feedback: FeedbackDataRow[],
  failedEvolutions: EvolutionRecord[],
  signal?: AbortSignal
): Promise<LogAnalysisResult> {
  const config = getConfig()

  // 构建反思摘要
  const reflectionSummary = buildReflectionSummary(reflections)

  // 构建错误模式
  const errorPatterns = extractErrorPatterns(traces)

  // 构建性能问题
  const perfIssues = extractPerformanceIssues(traces)

  // 构建反馈摘要
  const negativeFeedback = feedback
    .filter(f => f.feedback_type === 'negative')
    .slice(0, 5)
    .map(f => {
      let s = `- 用户问: "${(f.user_query || '').slice(0, 80)}"`
      if (f.comment) s += ` 反馈: ${f.comment.slice(0, 80)}`
      return s
    })
    .join('\n')

  // 构建失败进化摘要
  const failedSummary = failedEvolutions
    .slice(0, 5)
    .map(e => `- 目标: ${e.goal.slice(0, 80)} 原因: ${(e.failureReason || '').slice(0, 80)}`)
    .join('\n')

  const prompt = `你是 Zen Agent 的自进化分析模块。分析以下运行数据，找出可以改进的点。

## 反思汇总
- 样本数: ${reflectionSummary.sampleCount}
- 平均自评: ${reflectionSummary.averageScore.toFixed(1)}/5
- 常见弱点: ${reflectionSummary.commonWeaknesses.join('; ') || '无'}
- 常见改进建议: ${reflectionSummary.commonImprovements.join('; ') || '无'}

## 错误模式
${errorPatterns.map(e => `- ${e.pattern}: ${e.occurrences}次, 示例: ${e.example.slice(0, 80)}`).join('\n') || '无明显错误模式'}

## 性能问题
${perfIssues.map(p => `- ${p.metric}: ${p.currentValue} (阈值 ${p.threshold}), ${p.description}`).join('\n') || '无明显性能问题'}

## 负反馈
${negativeFeedback || '无负反馈'}

## 之前失败的改进尝试（避免重复）
${failedSummary || '无'}

## 最近对话样本
${reflections.slice(0, 3).map(r => `用户: ${r.userIntent.slice(0, 60)}\n回答: ${r.outcome.slice(0, 100)}\n自评: ${r.successScore}/5`).join('\n---\n') || '无'}

请分析以上数据，输出 JSON 格式的改进点列表。改进点应该是可以通过修改代码来解决的问题。

返回格式:
{"improvementPoints": [
  {
    "type": "bug|performance|quality|feature|refactor",
    "severity": "critical|high|medium|low",
    "description": "具体问题描述",
    "suggestedAction": "建议的修改方案",
    "targetFiles": ["agent/xxx.ts"]
  }
], "summary": "整体分析摘要"}

只返回 JSON，不要加额外说明。最多输出 5 个改进点。优先输出严重度高、可操作性强的改进点。`

  const response = await llm.chat({
    messages: [
      { role: 'system', content: '你是自进化分析助手，只返回 JSON。' },
      { role: 'user', content: prompt }
    ],
    modelKey: config.defaultModelKey,
    temperature: 0.3,
    maxTokens: 2000,
    signal,
    timeoutMs: 30000
  })

  // 解析 JSON
  const jsonMatch = response.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return analyzeWithRules(reflections, traces, feedback, failedEvolutions)
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      improvementPoints: Array<{
        type: string
        severity: string
        description: string
        suggestedAction: string
        targetFiles: string[]
      }>
      summary: string
    }

    const points: ImprovementPoint[] = (parsed.improvementPoints || []).map((p, i) => ({
      type: (['bug', 'performance', 'quality', 'feature', 'refactor'].includes(p.type)
        ? p.type : 'quality') as ImprovementPoint['type'],
      severity: (['critical', 'high', 'medium', 'low'].includes(p.severity)
        ? p.severity : 'medium') as ImprovementPoint['severity'],
      description: p.description || '',
      suggestedAction: p.suggestedAction || '',
      targetFiles: Array.isArray(p.targetFiles) ? p.targetFiles : [],
      source: 'LLM 分析'
    }))

    // 过滤掉之前已失败的改进
    const filteredPoints = filterFailedAttempts(points, failedEvolutions)

    return {
      improvementPoints: filteredPoints,
      recentReflections: [reflectionSummary],
      errorPatterns,
      performanceIssues: perfIssues,
      summary: parsed.summary || `LLM 分析发现 ${filteredPoints.length} 个改进点`
    }
  } catch {
    return analyzeWithRules(reflections, traces, feedback, failedEvolutions)
  }
}

// ═══════════════════════════════════════════════════════════
//  规则分析（LLM 不可用时的回退）
// ═══════════════════════════════════════════════════════════

function analyzeWithRules(
  reflections: ReflectionDataRow[],
  traces: CollectedTrace[],
  feedback: FeedbackDataRow[],
  failedEvolutions: EvolutionRecord[]
): LogAnalysisResult {
  const points: ImprovementPoint[] = []
  const reflectionSummary = buildReflectionSummary(reflections)
  const errorPatterns = extractErrorPatterns(traces)
  const perfIssues = extractPerformanceIssues(traces)

  // 规则 1: 平均自评低 → 质量改进
  if (reflectionSummary.sampleCount >= 3 && reflectionSummary.averageScore < 3) {
    points.push({
      type: 'quality',
      severity: 'high',
      description: `Agent 平均自评 ${reflectionSummary.averageScore.toFixed(1)}/5，回答质量偏低`,
      suggestedAction: '优化系统 Prompt 或 ReAct 循环策略，提高回答质量',
      targetFiles: ['agent/providers/llm-config.ts', 'agent/core/agent-loop.ts'],
      source: '规则分析: 自评偏低'
    })
  }

  // 规则 2: 负反馈多 → 改进相关领域
  const negativeCount = feedback.filter(f => f.feedback_type === 'negative').length
  if (negativeCount >= 3) {
    points.push({
      type: 'quality',
      severity: 'high',
      description: `收到 ${negativeCount} 条负反馈，用户满意度偏低`,
      suggestedAction: '分析负反馈模式，改进对应领域的回答质量',
      targetFiles: ['agent/evolution/interaction/prompt-optimizer.ts'],
      source: '规则分析: 负反馈多'
    })
  }

  // 规则 3: 错误模式 → bug 修复
  for (const pattern of errorPatterns) {
    if (pattern.occurrences >= 2) {
      points.push({
        type: 'bug',
        severity: pattern.occurrences >= 3 ? 'high' : 'medium',
        description: `检测到错误模式: ${pattern.pattern} (${pattern.occurrences} 次)`,
        suggestedAction: pattern.suggestedFix,
        targetFiles: [],
        source: `规则分析: ${pattern.example.slice(0, 60)}`
      })
    }
  }

  // 规则 4: 性能问题
  for (const issue of perfIssues) {
    points.push({
      type: 'performance',
      severity: issue.currentValue > issue.threshold * 2 ? 'high' : 'medium',
      description: `${issue.metric}: ${issue.currentValue} (阈值 ${issue.threshold})`,
      suggestedAction: `优化 ${issue.metric}，当前值 ${issue.currentValue} 超过阈值 ${issue.threshold}`,
      targetFiles: [],
      source: '规则分析: 性能问题'
    })
  }

  // 规则 5: 反思中的常见弱点
  for (const weakness of reflectionSummary.commonWeaknesses.slice(0, 2)) {
    points.push({
      type: 'quality',
      severity: 'medium',
      description: `Agent 反思发现的弱点: ${weakness}`,
      suggestedAction: `针对"${weakness}"进行改进`,
      targetFiles: [],
      source: '规则分析: 反思弱点'
    })
  }

  // 过滤掉之前已失败的改进
  const filteredPoints = filterFailedAttempts(points, failedEvolutions)

  return {
    improvementPoints: filteredPoints,
    recentReflections: [reflectionSummary],
    errorPatterns,
    performanceIssues: perfIssues,
    summary: `规则分析发现 ${filteredPoints.length} 个改进点（共 ${points.length} 个，过滤 ${points.length - filteredPoints.length} 个已失败尝试）`
  }
}

// ═══════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════

/**
 * 构建反思汇总
 */
function buildReflectionSummary(reflections: ReflectionDataRow[]): ReflectionSummary {
  if (reflections.length === 0) {
    return {
      averageScore: 3,
      commonWeaknesses: [],
      commonImprovements: [],
      sampleCount: 0
    }
  }

  const scores = reflections.map(r => r.successScore)
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length

  // 从反思内容中提取弱点和改进（简化版：基于内容关键词）
  const weaknesses: string[] = []
  const improvements: string[] = []

  for (const r of reflections) {
    const content = r.content.toLowerCase()
    // 简单的关键词匹配
    if (content.includes('简短') || content.includes('过于简短')) {
      if (!weaknesses.includes('回答过于简短')) weaknesses.push('回答过于简短')
    }
    if (content.includes('相关') && content.includes('不够')) {
      if (!weaknesses.includes('回答与问题相关性不足')) weaknesses.push('回答与问题相关性不足')
    }
    if (content.includes('多步') || content.includes('推理')) {
      if (!improvements.includes('增强多步推理能力')) improvements.push('增强多步推理能力')
    }
    if (content.includes('简洁') || content.includes('精简')) {
      if (!improvements.includes('提高回答简洁性')) improvements.push('提高回答简洁性')
    }
  }

  return {
    averageScore: avgScore,
    commonWeaknesses: weaknesses,
    commonImprovements: improvements,
    sampleCount: reflections.length
  }
}

/**
 * 从执行追踪中提取错误模式
 */
function extractErrorPatterns(traces: CollectedTrace[]): ErrorPattern[] {
  const patterns = new Map<string, { count: number; example: string }>()

  for (const t of traces) {
    const steps = t.trace.steps || []
    for (const step of steps) {
      if (step.status === 'error' || step.type === 'observe' && step.name.includes('失败')) {
        const pattern = step.name
        const existing = patterns.get(pattern) || { count: 0, example: '' }
        existing.count++
        if (!existing.example) existing.example = step.name
        patterns.set(pattern, existing)
      }
    }
  }

  return Array.from(patterns.entries()).map(([pattern, data]) => ({
    pattern,
    occurrences: data.count,
    example: data.example,
    suggestedFix: `检查 ${pattern} 相关代码`
  }))
}

/**
 * 从执行追踪中提取性能问题
 */
function extractPerformanceIssues(traces: CollectedTrace[]): PerformanceIssue[] {
  const issues: PerformanceIssue[] = []

  // 检查 LLM 调用次数
  const llmCalls = traces
    .map(t => t.trace.stats?.llmCalls || 0)
    .filter(c => c > 0)

  if (llmCalls.length > 0) {
    const avgCalls = llmCalls.reduce((a, b) => a + b, 0) / llmCalls.length
    if (avgCalls > 10) {
      issues.push({
        metric: '平均 LLM 调用次数',
        currentValue: Math.round(avgCalls),
        threshold: 10,
        description: `平均每次对话调用 LLM ${Math.round(avgCalls)} 次，可能存在推理效率问题`
      })
    }
  }

  // 检查 Token 消耗
  const tokenUsage = traces
    .map(t => (t.trace.stats?.totalInputTokens || 0) + (t.trace.stats?.totalOutputTokens || 0))
    .filter(t => t > 0)

  if (tokenUsage.length > 0) {
    const avgTokens = tokenUsage.reduce((a, b) => a + b, 0) / tokenUsage.length
    if (avgTokens > 20000) {
      issues.push({
        metric: '平均 Token 消耗',
        currentValue: Math.round(avgTokens),
        threshold: 20000,
        description: `平均每次对话消耗 ${Math.round(avgTokens)} tokens，可能存在上下文冗余`
      })
    }
  }

  return issues
}

/**
 * 过滤掉之前已失败的改进尝试
 */
function filterFailedAttempts(
  points: ImprovementPoint[],
  failedEvolutions: EvolutionRecord[]
): ImprovementPoint[] {
  // 获取之前失败的改进目标
  const failedGoals = new Set(
    failedEvolutions.map(e => e.goal.slice(0, 50).toLowerCase())
  )

  return points.filter(p => {
    const desc = p.description.slice(0, 50).toLowerCase()
    // 如果描述与之前失败的目标高度相似，则过滤掉
    for (const goal of failedGoals) {
      if (desc.includes(goal) || goal.includes(desc)) {
        return false
      }
    }
    return true
  })
}
