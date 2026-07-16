/**
 * 自进化编排器 — 核心调度引擎
 *
 * 工作循环:
 * 1. 检查触发条件（空闲时间 + Token 额度 + 最小间隔）
 * 2. 分析日志 → 发现改进点
 * 3. LLM 生成修改计划
 * 4. 应用修改 → 编译 → 测试
 * 5. 评估改进效果（对比改进前后的回答质量）
 * 6. 成功 → git commit；失败 → git revert
 * 7. 记录到进化日志
 *
 * 安全机制:
 * - Git stash + checkout 回滚
 * - 编译失败自动回滚
 * - 评估无改进自动回滚
 * - 白名单目录限制
 * - Token 预算限制
 */

import { exec } from 'child_process'
import { resolve } from 'path'
import { llm } from '../providers/llm'
import { isLLMConfigured, getConfig, getSystemPrompt } from '../providers/llm-config'
import { countTextTokens } from '../utils/token-counter'
import { TokenBudgetManager } from './token-budget'
import { CodeModifier } from './code-modifier'
import { BuildTester } from './build-tester'
import { analyzeLogs } from './log-analyzer'
import {
  initEvolutionTables,
  createEvolutionRecord,
  updateEvolutionRecord,
  getEvolutionStats,
  recordTokenUsage
} from './evolution-journal'
import type {
  SelfEvolutionConfig,
  EvolutionPhase,
  EvolutionRecord,
  ImprovementPlan,
  TestResult,
  EvaluationResult,
  EvolutionLogEntry,
  EvolutionOutcome
} from './types'
import { DEFAULT_EVOLUTION_CONFIG } from './types'

/** 项目根目录 */
const PROJECT_ROOT = resolve(__dirname, '..', '..')

/**
 * 进化事件回调
 */
export interface EvolutionCallbacks {
  onPhaseChange?: (phase: EvolutionPhase, message: string) => void
  onLog?: (entry: EvolutionLogEntry) => void
  onComplete?: (record: EvolutionRecord) => void
  onError?: (error: Error) => void
}

/**
 * 自进化编排器
 */
export class EvolutionOrchestrator {
  private config: SelfEvolutionConfig
  private tokenBudget: TokenBudgetManager
  private codeModifier: CodeModifier
  private buildTester: BuildTester
  private callbacks: EvolutionCallbacks

  private running = false
  private lastActivity: number = Date.now()
  private lastEvolutionTime: number = 0
  private currentPhase: EvolutionPhase = 'idle'
  private checkTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<SelfEvolutionConfig> = {}, callbacks: EvolutionCallbacks = {}) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config }
    this.tokenBudget = new TokenBudgetManager(this.config)
    this.codeModifier = new CodeModifier(this.config)
    this.buildTester = new BuildTester(this.config)
    this.callbacks = callbacks
  }

  /**
   * 启动编排器
   * 初始化数据库表 + 启动定期检查
   */
  start(): void {
    if (this.checkTimer) {
      console.warn('[Evolution] Orchestrator already running')
      return
    }

    // 初始化数据库表
    initEvolutionTables()

    // 启动定期检查（每 60 秒检查一次）
    this.checkTimer = setInterval(() => {
      this.checkTrigger().catch(err => {
        console.error('[Evolution] Check trigger error:', err)
      })
    }, 60 * 1000)

    // 设置不阻塞退出
    this.checkTimer.unref?.()

    console.log('[Evolution] Orchestrator started')
    console.log(`  Idle threshold: ${this.config.idleThreshold / 1000}s`)
    console.log(`  Token cycle: ${this.config.tokenCycleDuration / 3600000}h`)
    console.log(`  Evolution ratio: ${this.config.evolutionTokenRatio * 100}%`)
  }

  /**
   * 停止编排器
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    this.running = false
    this.setPhase('idle')
    console.log('[Evolution] Orchestrator stopped')
  }

  /**
   * 通知用户活动（重置空闲计时器）
   */
  notifyActivity(): void {
    this.lastActivity = Date.now()
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    running: boolean
    phase: EvolutionPhase
    enabled: boolean
    lastEvolutionTime: number
    idleSince: number
    tokenBudget: ReturnType<TokenBudgetManager['getSummary']>
    stats: ReturnType<typeof getEvolutionStats>
  } {
    return {
      running: this.running,
      phase: this.currentPhase,
      enabled: this.config.enabled,
      lastEvolutionTime: this.lastEvolutionTime,
      idleSince: Date.now() - this.lastActivity,
      tokenBudget: this.tokenBudget.getSummary(),
      stats: getEvolutionStats()
    }
  }

  /**
   * 更新配置
   */
  updateConfig(updates: Partial<SelfEvolutionConfig>): void {
    this.config = { ...this.config, ...updates }
    this.tokenBudget = new TokenBudgetManager(this.config)
    this.codeModifier = new CodeModifier(this.config)
    this.buildTester = new BuildTester(this.config)
    console.log('[Evolution] Config updated:', updates)
  }

  /**
   * 手动触发一次进化循环（不等待空闲）
   */
  async runOnce(signal?: AbortSignal): Promise<EvolutionRecord | null> {
    if (!isLLMConfigured()) {
      console.warn('[Evolution] LLM not configured, cannot run evolution')
      return null
    }

    // 检查 Token 预算
    const budgetCheck = this.tokenBudget.canEvolve()
    if (!budgetCheck.canEvolve) {
      console.warn(`[Evolution] Cannot evolve: ${budgetCheck.reason}`)
      return null
    }

    return this.runEvolutionCycle(signal)
  }

  // ═══════════════════════════════════════════════════════════
  //  触发检查
  // ═══════════════════════════════════════════════════════════

  /**
   * 定期检查是否应该触发进化
   */
  private async checkTrigger(): Promise<void> {
    if (!this.config.enabled) return
    if (this.running) return

    // 检查 Token 周期是否需要重置
    this.tokenBudget.checkCycleReset()

    // 检查空闲时间
    const idleTime = Date.now() - this.lastActivity
    if (idleTime < this.config.idleThreshold) return

    // 检查最小进化间隔
    const sinceLastEvolution = Date.now() - this.lastEvolutionTime
    if (sinceLastEvolution < this.config.minEvolutionInterval) return

    // 检查 Token 预算
    const budgetCheck = this.tokenBudget.canEvolve()
    if (!budgetCheck.canEvolve) {
      console.log(`[Evolution] Skipping: ${budgetCheck.reason}`)
      return
    }

    // 检查 LLM 是否可用
    if (!isLLMConfigured()) return

    // 触发进化
    console.log('[Evolution] Triggering evolution cycle')
    console.log(`  Idle: ${Math.round(idleTime / 1000)}s`)
    console.log(`  Since last evolution: ${Math.round(sinceLastEvolution / 60000)}min`)
    console.log(`  ${budgetCheck.reason}`)

    await this.runEvolutionCycle().catch(err => {
      console.error('[Evolution] Evolution cycle error:', err)
      this.callbacks.onError?.(err)
    })
  }

  // ═══════════════════════════════════════════════════════════
  //  进化循环核心
  // ═══════════════════════════════════════════════════════════

  /**
   * 运行一次完整的进化循环
   *
   * 6 步:
   * 1. 分析日志 → 改进点
   * 2. LLM 生成修改计划
   * 3. 应用修改
   * 4. 编译 + 测试
   * 5. 评估效果
   * 6. 提交或回滚
   */
  private async runEvolutionCycle(signal?: AbortSignal): Promise<EvolutionRecord | null> {
    this.running = true
    this.lastEvolutionTime = Date.now()

    const recordId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    const logs: EvolutionLogEntry[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let plan: ImprovementPlan | null = null
    let testResult: TestResult | null = null
    let evaluation: EvaluationResult | null = null
    let outcome: EvolutionOutcome = 'failure'
    let commitHash: string | null = null
    let failureReason: string | null = null

    const log = (phase: EvolutionPhase, message: string, data?: unknown) => {
      const entry: EvolutionLogEntry = { timestamp: Date.now(), phase, message, data }
      logs.push(entry)
      console.log(`[Evolution] [${phase}] ${message}`)
      this.callbacks.onLog?.(entry)
    }

    try {
      // 创建进化记录
      createEvolutionRecord(recordId, '自动触发', '待定', startedAt)
      this.setPhase('analyzing')
      log('analyzing', '开始分析日志和执行记录')

      // ── Step 1: 分析日志 ──
      const analysisResult = await analyzeLogs(
        Date.now() - 24 * 60 * 60 * 1000,
        signal
      )

      // 估算分析消耗的 Token
      const analysisTokens = countTextTokens(JSON.stringify(analysisResult))
      totalInputTokens += analysisTokens
      totalOutputTokens += analysisTokens

      if (analysisResult.improvementPoints.length === 0) {
        log('analyzing', '没有发现改进点，跳过本次进化')
        failureReason = '没有发现改进点'
        outcome = 'failure'
        // 更新触发原因
        updateEvolutionRecord(recordId, {
          trigger: analysisResult.summary,
          failureReason,
          outcome,
          finishedAt: Date.now(),
          tokensInput: totalInputTokens,
          tokensOutput: totalOutputTokens,
          logsJson: JSON.stringify(logs)
        })
        this.finishEvolution(recordId, logs, outcome)
        return this.getRecord(recordId)
      }

      log('analyzing', `发现 ${analysisResult.improvementPoints.length} 个改进点: ${analysisResult.improvementPoints.map(p => p.description.slice(0, 30)).join('; ')}`)

      // ── Step 2: 生成修改计划 ──
      this.setPhase('planning')
      log('planning', '使用 LLM 生成代码修改计划')

      plan = await this.codeModifier.planImprovement(
        analysisResult.improvementPoints,
        signal
      )

      if (!plan) {
        log('planning', 'LLM 未能生成有效的修改计划')
        failureReason = 'LLM 未能生成有效的修改计划'
        outcome = 'failure'
        updateEvolutionRecord(recordId, {
          trigger: analysisResult.summary,
          goal: '未能生成计划',
          failureReason,
          outcome,
          finishedAt: Date.now(),
          tokensInput: totalInputTokens,
          tokensOutput: totalOutputTokens,
          logsJson: JSON.stringify(logs)
        })
        this.finishEvolution(recordId, logs, outcome)
        return this.getRecord(recordId)
      }

      // 估算计划生成消耗的 Token
      const planTokens = countTextTokens(JSON.stringify(plan))
      totalInputTokens += planTokens
      totalOutputTokens += planTokens

      log('planning', `生成修改计划: ${plan.goal}`)
      log('planning', `将修改 ${plan.changes.length} 个文件: ${plan.changes.map(c => c.filePath).join(', ')}`)

      // 更新记录
      updateEvolutionRecord(recordId, {
        trigger: analysisResult.summary,
        goal: plan.goal,
        planJson: JSON.stringify(plan),
        filesChanged: plan.changes.map(c => c.filePath)
      })

      // ── Step 2.5: Git stash（保存当前状态） ──
      log('modifying', 'Git stash 保存当前工作区状态')
      await this.gitStash()

      // ── Step 3: 应用修改 ──
      this.setPhase('modifying')
      log('modifying', '应用代码修改')

      const applied = this.codeModifier.applyPlan(plan)
      if (!applied) {
        log('modifying', '部分文件写入失败')
        // 尝试回滚已写入的
        this.codeModifier.rollbackPlan(plan)
        await this.gitCheckout()
        failureReason = '文件写入失败'
        outcome = 'failure'
        updateEvolutionRecord(recordId, {
          failureReason,
          outcome,
          finishedAt: Date.now(),
          tokensInput: totalInputTokens,
          tokensOutput: totalOutputTokens,
          logsJson: JSON.stringify(logs)
        })
        this.finishEvolution(recordId, logs, outcome)
        return this.getRecord(recordId)
      }

      log('modifying', '所有文件修改已应用')

      // ── Step 4: 编译 + 测试 ──
      this.setPhase('building')
      log('building', '开始编译项目')

      testResult = await this.buildTester.runBuildAndTest(signal)

      // 记录 Token
      recordTokenUsage(0, 0, 'evolution') // 编译不消耗 LLM Token

      updateEvolutionRecord(recordId, {
        testResultJson: JSON.stringify(testResult)
      })

      if (!testResult.buildPassed && this.config.requireBuildPass) {
        log('building', `编译失败: ${testResult.errors.length} 个错误`)
        log('building', `错误: ${testResult.errors.slice(0, 3).join('; ')}`)

        // 回滚
        this.codeModifier.rollbackPlan(plan)
        await this.gitCheckout()
        await this.gitStashPop()

        failureReason = `编译失败: ${testResult.errors.length} 个错误`
        outcome = 'rolled_back'
        updateEvolutionRecord(recordId, {
          failureReason,
          outcome,
          finishedAt: Date.now(),
          tokensInput: totalInputTokens,
          tokensOutput: totalOutputTokens,
          logsJson: JSON.stringify(logs)
        })
        this.finishEvolution(recordId, logs, outcome)
        return this.getRecord(recordId)
      }

      if (!testResult.testPassed && this.config.requireTestPass) {
        log('building', `测试失败: ${testResult.errors.length} 个错误`)

        // 回滚
        this.codeModifier.rollbackPlan(plan)
        await this.gitCheckout()
        await this.gitStashPop()

        failureReason = `测试失败: ${testResult.errors.length} 个错误`
        outcome = 'rolled_back'
        updateEvolutionRecord(recordId, {
          failureReason,
          outcome,
          finishedAt: Date.now(),
          tokensInput: totalInputTokens,
          tokensOutput: totalOutputTokens,
          logsJson: JSON.stringify(logs)
        })
        this.finishEvolution(recordId, logs, outcome)
        return this.getRecord(recordId)
      }

      log('building', `编译${testResult.buildPassed ? '✓' : '✗'} 测试${testResult.testPassed ? '✓' : '✗'} (${testResult.buildDuration + testResult.testDuration}ms)`)

      // ── Step 5: 评估改进效果 ──
      this.setPhase('evaluating')
      log('evaluating', '评估改进前后的回答质量')

      // 用预设问题评估（简化版：只对比系统 prompt 的变化）
      // 完整版需要实际运行 Agent，这里用 LLM 对比代码差异来评估
      evaluation = await this.evaluateImprovement(plan, signal)

      if (evaluation) {
        const evalTokens = countTextTokens(JSON.stringify(evaluation))
        totalInputTokens += evalTokens
        totalOutputTokens += evalTokens

        updateEvolutionRecord(recordId, {
          evaluationJson: JSON.stringify(evaluation)
        })

        log('evaluating', `评估结果: 改进前 ${evaluation.beforeScore}/5 → 改进后 ${evaluation.afterScore}/5, ${evaluation.hasImprovement ? '有改进' : '无改进'}`)

        if (!evaluation.hasImprovement) {
          // 无改进 → 回滚
          log('evaluating', '未检测到实质改进，回滚修改')
          this.codeModifier.rollbackPlan(plan)
          await this.gitCheckout()
          await this.gitStashPop()

          failureReason = evaluation.reason || '未检测到实质改进'
          outcome = 'rolled_back'
          updateEvolutionRecord(recordId, {
            failureReason,
            outcome,
            finishedAt: Date.now(),
            tokensInput: totalInputTokens,
            tokensOutput: totalOutputTokens,
            logsJson: JSON.stringify(logs)
          })
          this.finishEvolution(recordId, logs, outcome)
          return this.getRecord(recordId)
        }
      }

      // ── Step 6: 提交 ──
      this.setPhase('committing')
      log('committing', '改进成功，提交 Git commit')

      if (this.config.autoCommit) {
        const commitMsg = `chore(self-evolution): ${plan.goal}

改进来源: ${analysisResult.summary}
修改文件: ${plan.changes.map(c => c.filePath).join(', ')}
评估: 改进前 ${evaluation?.beforeScore || '?'}/5 → 改进后 ${evaluation?.afterScore || '?'}/5
进化ID: ${recordId}`

        commitHash = await this.gitCommit(commitMsg)
        await this.gitStashPop() // 恢复之前 stash 的内容（如果有）

        if (commitHash) {
          log('committing', `已提交: ${commitHash.slice(0, 8)}`)
          outcome = 'success'
        } else {
          log('committing', 'Git commit 失败，但修改已应用')
          outcome = 'partial'
        }
      } else {
        log('committing', 'autoCommit 未启用，修改已应用但未提交')
        outcome = 'partial'
      }

      // 记录 Token 使用
      recordTokenUsage(totalInputTokens, totalOutputTokens, 'evolution')

      // 更新记录
      updateEvolutionRecord(recordId, {
        outcome,
        commitHash,
        finishedAt: Date.now(),
        tokensInput: totalInputTokens,
        tokensOutput: totalOutputTokens,
        logsJson: JSON.stringify(logs)
      })

      log('done', `进化完成: ${outcome}`)
      this.finishEvolution(recordId, logs, outcome)
      return this.getRecord(recordId)

    } catch (err) {
      const error = err as Error
      log('done', `进化循环异常: ${error.message}`)

      // 尝试回滚
      try {
        if (plan) {
          this.codeModifier.rollbackPlan(plan)
          await this.gitCheckout()
          await this.gitStashPop()
        }
      } catch { /* ignore */ }

      failureReason = error.message
      outcome = 'failure'

      updateEvolutionRecord(recordId, {
        failureReason,
        outcome,
        finishedAt: Date.now(),
        tokensInput: totalInputTokens,
        tokensOutput: totalOutputTokens,
        logsJson: JSON.stringify(logs)
      })

      this.finishEvolution(recordId, logs, outcome)
      this.callbacks.onError?.(error)
      return this.getRecord(recordId)
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  评估改进
  // ═══════════════════════════════════════════════════════════

  /**
   * 评估改进效果
   * 简化版：用 LLM 对比修改前后的代码，判断是否有改进
   */
  private async evaluateImprovement(
    plan: ImprovementPlan,
    signal?: AbortSignal
  ): Promise<EvaluationResult | null> {
    if (!isLLMConfigured()) return null

    const config = getConfig()

    // 构建代码差异摘要
    const diffs = plan.changes.map(c => {
      const oldLines = (c.oldContent || '').split('\n').length
      const newLines = c.newContent.split('\n').length
      return `- ${c.filePath} (${c.type}): ${oldLines}行 → ${newLines}行, ${c.description}`
    }).join('\n')

    const prompt = `你是 Zen Agent 的自进化评估器。评估以下代码修改是否有实质改进。

## 改进目标
${plan.goal}

## 预期效果
${plan.expectedOutcome}

## 代码变更摘要
${diffs}

## 变更详情（前 2000 字符）
${plan.changes.map(c => `### ${c.filePath}\n修改前:\n${(c.oldContent || '(新文件)').slice(0, 500)}\n\n修改后:\n${c.newContent.slice(0, 500)}`).join('\n\n---\n\n')}

请评估这次修改是否能实现预期目标。返回 JSON:
{"beforeScore": 1-5, "afterScore": 1-5, "hasImprovement": true/false, "reason": "评估理由"}

只返回 JSON。`

    try {
      const response = await llm.chat({
        messages: [
          { role: 'system', content: '你是代码改进评估助手，只返回 JSON。' },
          { role: 'user', content: prompt }
        ],
        modelKey: config.defaultModelKey,
        temperature: 0.3,
        maxTokens: 500,
        signal,
        timeoutMs: 20000
      })

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      return {
        beforeScore: Math.max(1, Math.min(5, parsed.beforeScore || 3)),
        afterScore: Math.max(1, Math.min(5, parsed.afterScore || 3)),
        hasImprovement: parsed.hasImprovement ?? (parsed.afterScore > parsed.beforeScore),
        reason: parsed.reason || 'LLM 评估',
        testQueries: this.config.evaluationQueries,
        beforeResponses: plan.changes.map(c => c.oldContent?.slice(0, 200) || ''),
        afterResponses: plan.changes.map(c => c.newContent.slice(0, 200))
      }
    } catch (err) {
      console.warn('[Evolution] Evaluation failed:', err)
      return null
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Git 操作
  // ═══════════════════════════════════════════════════════════

  private async gitStash(): Promise<void> {
    await this.gitExec('git stash')
  }

  private async gitStashPop(): Promise<void> {
    await this.gitExec('git stash pop 2>nul')
  }

  private async gitCheckout(): Promise<void> {
    await this.gitExec('git checkout -- .')
  }

  private async gitCommit(message: string): Promise<string | null> {
    try {
      await this.gitExec('git add -A')
      // 转义引号
      const escapedMsg = message.replace(/"/g, '\\"')
      const output = await this.gitExec(`git commit -m "${escapedMsg}"`)
      // 从输出中提取 commit hash
      const match = output.match(/\[[\w\W]+?([0-9a-f]{7,})\]/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  private gitExec(command: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      exec(
        command,
        {
          cwd: PROJECT_ROOT,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env },
          shell: process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash'
        },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            // git stash 等命令在无更改时返回非零，但不影响
            if (command.includes('stash') || command.includes('checkout')) {
              resolvePromise(stdout || '')
              return
            }
            reject(error)
            return
          }
          resolvePromise(stdout + (stderr ? '\n' + stderr : ''))
        }
      )
    })
  }

  // ═══════════════════════════════════════════════════════════
  //  辅助
  // ═══════════════════════════════════════════════════════════

  private setPhase(phase: EvolutionPhase): void {
    this.currentPhase = phase
    this.callbacks.onPhaseChange?.(phase, this.getPhaseDescription(phase))
  }

  private getPhaseDescription(phase: EvolutionPhase): string {
    const descriptions: Record<EvolutionPhase, string> = {
      idle: '空闲',
      analyzing: '分析日志中',
      planning: '生成改进计划中',
      modifying: '修改代码中',
      building: '编译测试中',
      testing: '运行测试中',
      evaluating: '评估改进效果中',
      committing: '提交中',
      done: '完成'
    }
    return descriptions[phase] || phase
  }

  private finishEvolution(
    recordId: string,
    logs: EvolutionLogEntry[],
    outcome: EvolutionOutcome
  ): void {
    this.running = false
    this.setPhase('done')

    // 获取完整记录
    const record = this.getRecord(recordId)
    if (record) {
      this.callbacks.onComplete?.(record)
    }

    // 回到 idle
    setTimeout(() => {
      if (!this.running) this.setPhase('idle')
    }, 5000)
  }

  private getRecord(recordId: string): EvolutionRecord | null {
    const { getEvolutionRecord } = require('./evolution-journal')
    return getEvolutionRecord(recordId)
  }
}

// ── 单例 ──
let orchestrator: EvolutionOrchestrator | null = null

export function getOrchestrator(): EvolutionOrchestrator | null {
  return orchestrator
}

export function initOrchestrator(
  config: Partial<SelfEvolutionConfig> = {},
  callbacks: EvolutionCallbacks = {}
): EvolutionOrchestrator {
  if (orchestrator) {
    orchestrator.updateConfig(config)
    return orchestrator
  }
  orchestrator = new EvolutionOrchestrator(config, callbacks)
  return orchestrator
}
