/**
 * Agent 主循环 — Pipeline 编排器
 *
 * 流水线各阶段（本类只做编排，具体实现见 pipeline/ 目录）:
 * 1. intent-stage       意图识别 — 分析用户输入的复杂度和类型
 * 2. memory-stage       记忆检索 — 向量语义搜索相关历史记忆
 * 3. skill-stage        技能匹配 — 匹配已有技能
 * 4. context-stage      上下文管理 — Token 预算 + 滑动窗口 + 摘要压缩
 * 5. execution-stage    执行 — Coordinator 多 Agent 协作 或 ReAct 循环
 * 6. reflection-stage   反思 — 自评执行质量
 * 7. storage-stage      记忆存储 — 沉淀情景记忆（向量化 + 去重）
 * 8. evolution-stage    进化检测 — 模式检测 + 自动技能生成
 * 9. prompt-opt-stage   Prompt 优化 — 负反馈阈值触发
 * 10. stats/complete    统计与完成 — Token 统计、执行追踪
 *
 * 当 LLM 未配置时，所有步骤使用规则/mock 模式执行。
 *
 * 依赖注入:
 * 构造函数接收可选的 AgentServices（生产环境默认使用 getDefaultServices()，
 * 即历史单例；测试环境可注入 mock）。
 */

import { getDefaultServices, type AgentServices } from './services'
import { createPipelineContext, type PipelineContext } from './pipeline/context'
import { runIntentStage } from './pipeline/intent-stage'
import { runMemoryStage } from './pipeline/memory-stage'
import { runSkillStage } from './pipeline/skill-stage'
import { runContextStage } from './pipeline/context-stage'
import { runExecutionStage } from './pipeline/execution-stage'
import { runReflectionStage } from './pipeline/reflection-stage'
import { runStorageStage } from './pipeline/storage-stage'
import { runEvolutionStage, runPromptOptimizationStage } from './pipeline/evolution-stage'
import { runStatsStage, runCompleteStage } from './pipeline/stats-stage'
import type { AgentContext, AgentResult, AgentCallbacks } from './types'
import type { ExecutionTrace } from '../../src/shared/types'

export class AgentLoop {
  private callbacks: AgentCallbacks
  private services: AgentServices

  constructor(
    callbacks: AgentCallbacks = {},
    services: AgentServices = getDefaultServices()
  ) {
    this.callbacks = callbacks
    this.services = services
  }

  /** 执行 Agent 循环 */
  async run(userInput: string, context: AgentContext): Promise<AgentResult> {
    const ctx: PipelineContext = createPipelineContext(
      userInput,
      context,
      this.services,
      this.callbacks
    )

    console.log(`\n${'═'.repeat(60)}`)
    console.log(`[AgentLoop] START — input="${userInput.slice(0, 80)}${userInput.length > 80 ? '...' : ''}"`)
    console.log(`[AgentLoop] sessionId=${context.sessionId}, msgCount=${context.messages.length}`)

    try {
      // ── 1. 意图识别 ──
      const t1 = Date.now()
      await runIntentStage(ctx)
      console.log(`[AgentLoop] Step 1 (Intent) ✓ ${Date.now() - t1}ms — complexity=${ctx.intent?.complexity}, requiresPlanning=${ctx.intent?.requiresPlanning}`)

      // ── 2. 记忆检索 ──
      const t2 = Date.now()
      await runMemoryStage(ctx)
      console.log(`[AgentLoop] Step 2 (Memory) ✓ ${Date.now() - t2}ms — retrieved=${ctx.memories.length} memories`)

      // ── 3. 技能匹配 ──
      const t3 = Date.now()
      await runSkillStage(ctx)
      console.log(`[AgentLoop] Step 3 (Skill) ✓ ${Date.now() - t3}ms — matched=${ctx.matchedSkills.length} skills`)

      // ── 3.5 上下文管理 ──
      const t35 = Date.now()
      await runContextStage(ctx)
      console.log(`[AgentLoop] Step 3.5 (Context) ✓ ${Date.now() - t35}ms — compressed=${ctx.managedContext?.compressed || false}`)

      // ── 4-6. 执行（Coordinator 或 ReAct）──
      await runExecutionStage(ctx)

      // 安全防护：确保 finalOutput 是字符串（防止上游返回 Promise/对象等非字符串类型）
      ctx.finalOutput = typeof ctx.finalOutput === 'string' ? ctx.finalOutput : String(ctx.finalOutput ?? '')

      // ── 7. 反思 ──
      const t7 = Date.now()
      await runReflectionStage(ctx)
      console.log(`[AgentLoop] Step 7 (Reflect) ✓ ${Date.now() - t7}ms`)

      // ── 8. 记忆存储 ──
      const t8 = Date.now()
      await runStorageStage(ctx)
      console.log(`[AgentLoop] Step 8 (Store) ✓ ${Date.now() - t8}ms`)

      // ── 8.5 进化检测（模式检测 + 技能生成）──
      await runEvolutionStage(ctx)

      // ── 8.6 Prompt 优化检测（负反馈阈值触发）──
      await runPromptOptimizationStage(ctx)

      // ── 9. 统计 ──
      runStatsStage(ctx)

      // ── 10. 完成 ──
      runCompleteStage(ctx)

      // ── 构建执行追踪 ──
      const trace: ExecutionTrace = ctx.trace.buildTrace(context.sessionId, ctx.llmCallCount)

      this.callbacks.onTraceComplete?.(trace)
      this.callbacks.onStateChange?.('happy')

      const totalElapsed = Date.now() - ctx.trace.startTime
      console.log(`[AgentLoop] DONE ✓ total=${totalElapsed}ms, inputTokens=${ctx.trace.totalInputTokens}, outputTokens=${ctx.trace.totalOutputTokens}, llmCalls=${ctx.llmCallCount}`)
      console.log(`${'═'.repeat(60)}\n`)

      return {
        content: ctx.finalOutput || '（Agent 未能生成响应）',
        trace,
        tokensUsed: {
          input: ctx.trace.totalInputTokens,
          output: ctx.trace.totalOutputTokens
        },
        modelsUsed: Array.from(ctx.trace.modelsUsed),
        duration: Date.now() - ctx.trace.startTime
      }
    } catch (err) {
      const elapsed = Date.now() - ctx.trace.startTime
      const error = err as Error
      console.error(`[AgentLoop] ERROR ✗ after ${elapsed}ms:`, error?.message || error)
      if (error?.stack) {
        console.error('[AgentLoop] stack:', error.stack.split('\n').slice(0, 8).join('\n'))
      }

      // 即使出错/中止，也要发送已有的 trace steps 到前端，让用户看到思考过程
      if (ctx.trace.steps.length > 0) {
        const trace = ctx.trace.buildPartialTrace(context.sessionId)
        this.callbacks.onTraceComplete?.(trace)
        console.log(`[AgentLoop] Sent partial trace with ${ctx.trace.steps.length} steps on error/abort`)
      }

      this.callbacks.onError?.(error)
      // 不再设置 confused 状态 — abort 是用户主动操作，应该回到 idle
      if (!error?.message?.includes('abort')) {
        this.callbacks.onStateChange?.('confused')
      }
      throw err
    }
  }
}

/**
 * 创建 Agent 上下文
 */
export function createAgentContext(
  sessionId: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  settings?: Partial<AgentContext['settings']>
): AgentContext {
  return {
    sessionId,
    messages,
    tokenBudget: settings?.maxTokens || 32000,
    settings: {
      maxTokens: settings?.maxTokens || 32000,
      outputReserve: settings?.outputReserve || 4000,
      recentMessageWindow: settings?.recentMessageWindow || 10,
      compressionThreshold: settings?.compressionThreshold || 16000,
      maxMemoriesRetrieved: settings?.maxMemoriesRetrieved || 5,
      maxSkillsLoaded: settings?.maxSkillsLoaded || 3
    }
  }
}
