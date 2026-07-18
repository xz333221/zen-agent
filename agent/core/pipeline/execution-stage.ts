/**
 * 执行阶段 — Coordinator 多 Agent 协作 或 ReAct 循环
 *
 * 路由逻辑:
 * - 高复杂度 + 需要规划 + 非浏览器任务 → Coordinator 多 Agent 协作
 *   （浏览器任务走 ReAct，因为 Coordinator 的子 Agent 没有浏览器工具）
 * - Coordinator 失败或无输出 → 回退 ReAct
 * - 其他任务 → ReAct 循环
 * - 未配置 LLM → mock 响应
 */

import { isLLMConfigured } from '../../providers/llm-config'
import { Coordinator } from '../coordinator'
import type { TraceStep } from '../../../src/shared/types'
import type { PipelineContext } from './context'
import { ReActLoop } from './react/react-loop'

/** 浏览器自动化任务关键词 */
const BROWSER_KEYWORDS = [
  '浏览器', 'browser', '打开网页', '打开网站', 'navigate', '网页内容',
  '截图', 'screenshot', '点击按钮', '点击元素', 'click',
  '输入框', '输入文字', 'type', '滚动页面', 'scroll',
  'browser_navigate', 'browser_click', 'browser_get_text', 'browser_type',
  'browser_screenshot', 'browser_eval', 'browser_scroll', 'browser_close'
]

export async function runExecutionStage(ctx: PipelineContext): Promise<void> {
  const { userInput, agentContext, intent } = ctx
  const complexity = intent?.complexity ?? 'medium'

  // 检测是否为浏览器自动化任务 — 浏览器任务必须走 ReAct 循环
  const isBrowserTask = BROWSER_KEYWORDS.some(kw =>
    userInput.toLowerCase().includes(kw.toLowerCase())
  )

  console.log(`[ExecutionStage] isBrowserTask=${isBrowserTask}, requiresPlanning=${intent?.requiresPlanning}, complexity=${complexity}`)

  // 如果需要规划且复杂度高，且不是浏览器任务，使用 Coordinator 进行多 Agent 协作
  if (intent?.requiresPlanning && complexity === 'high' && !isBrowserTask) {
    ctx.callbacks.onStateChange?.('working')
    const coordinator = new Coordinator(
      {
        onStepStart: (step: TraceStep) => {
          ctx.trace.recordExternalStep(step)
        },
        onStepComplete: (step: TraceStep) => {
          ctx.callbacks.onStepComplete?.(step)
        },
        onStateChange: (state: string) => {
          ctx.callbacks.onStateChange?.(state as Parameters<NonNullable<typeof ctx.callbacks.onStateChange>>[0])
        },
        onError: (error: Error) => {
          ctx.callbacks.onError?.(error)
        }
      },
      {
        maxTasks: 5,
        maxParallelTasks: 2,
        totalBudget: agentContext.settings.maxTokens
      }
    )

    const coordResult = await coordinator.coordinate(
      userInput,
      { messages: agentContext.messages },
      ctx.signal
    )

    // 检测 Coordinator 是否所有子任务都失败了（返回的是错误消息而非真实结果）
    const allTasksFailed = coordResult.plan && coordResult.plan.tasks.length > 0 &&
      coordResult.plan.tasks.every(t => t.status === 'failed' || t.status === 'skipped')

    if (coordResult.output && !allTasksFailed) {
      ctx.finalOutput = coordResult.output
      // 流式输出协调器结果
      await streamText(ctx, coordResult.output)
      ctx.llmCallCount = 1 // 至少一次 LLM 调用
      return
    }

    // 协调器未生成输出或所有子任务都失败，回退到 ReAct
    console.log(`[ExecutionStage] Coordinator ${allTasksFailed ? 'all tasks failed' : 'no output'}, falling back to ReAct`)
    if (isLLMConfigured()) {
      await runReAct(ctx, complexity)
    } else {
      ctx.finalOutput = getMockResponse(userInput)
      ctx.callbacks.onChunk?.(ctx.finalOutput)
    }
    return
  }

  if (isLLMConfigured()) {
    const t = Date.now()
    await runReAct(ctx, complexity)
    console.log(`[ExecutionStage] ReAct ✓ ${Date.now() - t}ms — llmCalls=${ctx.llmCallCount}, output=${ctx.finalOutput.length}chars`)
    return
  }

  // 未配置 LLM，直接返回 mock 响应
  ctx.finalOutput = getMockResponse(userInput)
  ctx.callbacks.onChunk?.(ctx.finalOutput)
}

async function runReAct(ctx: PipelineContext, complexity: 'low' | 'medium' | 'high'): Promise<void> {
  const loop = new ReActLoop(ctx)
  const result = await loop.run(ctx.reactSteps, complexity)
  ctx.finalOutput = result.output
  ctx.llmCallCount = result.llmCalls
}

/** 流式输出文本（分块模拟流式） */
async function streamText(ctx: PipelineContext, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += 3) {
    ctx.callbacks.onChunk?.(text.slice(i, i + 3))
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 未配置 LLM 时的 mock 响应 */
function getMockResponse(userInput: string): string {
  return `收到你的消息："${userInput}"\n\n⚠️ 尚未配置 LLM Provider。请通过以下步骤配置：\n\n1. 右键点击托盘图标\n2. 选择「设置」\n3. 填入 API Base URL 和 API Key\n4. 选择模型\n\n配置完成后即可进行真实对话。`
}
